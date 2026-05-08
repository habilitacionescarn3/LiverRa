# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Triton gRPC inference client wrapper (T157).

Implements the "Tier-A / Tier-B" VRAM policy from research §C.1:

    Plain-English analogy:
        Tier-A models are the kitchen staples that live on the counter
        (always within arm's reach). Tier-B models are the specialty
        gadgets that live in the cupboard — we pull them out only when
        a recipe calls for them, and put them away after 10 idle
        minutes so the counter stays uncluttered.

- **Tier-A** (`liverra-stunet-parenchyma`, `liverra-couinaud-segments`)
  stays loaded on GPU for the life of the Triton server. ``ensure_loaded``
  is a no-op for these.
- **Tier-B** (LiLNet, VISTA3D, MedSAM-2, STU-Net-lesions) is lazy-loaded
  on first use. ``ensure_loaded`` explicitly calls
  ``load_model(name)`` via Triton's repository control API. A periodic
  sweep (``evict_lru_tier_b``) unloads the least-recently-used Tier-B
  models beyond ``keep_n``, freeing VRAM for the next lazy-load.

Prometheus metrics exposed:

- ``triton_inference_latency_seconds{model}`` — histogram per call.
- ``triton_model_load_seconds{model}`` — histogram per lazy load.
- ``triton_gpu_active_models{tier}`` — current count (``tier`` = ``a`` | ``b``).

Notes:

- gRPC asyncio client (``tritonclient.grpc.aio``) is used so Celery
  tasks can ``await`` inference without tying up a worker.
- FP16 inputs are converted from caller-supplied ``numpy.ndarray`` of
  any float dtype. Outputs are returned as ``numpy.ndarray`` in the
  dtype Triton reports.
- No PHI ever crosses this module — only tensors + model names.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np

try:
    from tritonclient.grpc.aio import (  # type: ignore[import-not-found]
        InferenceServerClient,
        InferInput,
        InferRequestedOutput,
    )
    from tritonclient.utils import np_to_triton_dtype  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover — dev env without tritonclient
    InferenceServerClient = None  # type: ignore[assignment]
    InferInput = None  # type: ignore[assignment]
    InferRequestedOutput = None  # type: ignore[assignment]
    np_to_triton_dtype = None  # type: ignore[assignment]

try:
    from prometheus_client import Gauge, Histogram  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    Gauge = None  # type: ignore[assignment]
    Histogram = None  # type: ignore[assignment]


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Prometheus metrics (module-level so duplicate instantiation is avoided)
# ---------------------------------------------------------------------------

if Histogram is not None:  # pragma: no branch
    _INFER_LATENCY = Histogram(
        "triton_inference_latency_seconds",
        "End-to-end Triton inference latency, excluding tensor prep.",
        labelnames=("model",),
        buckets=(0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 20.0, 45.0),
    )
    _MODEL_LOAD_LATENCY = Histogram(
        "triton_model_load_seconds",
        "Time to lazy-load a Tier-B Triton model into GPU memory.",
        labelnames=("model",),
        buckets=(0.5, 1.0, 2.5, 5.0, 10.0, 20.0, 45.0, 120.0),
    )
    _ACTIVE_MODELS = Gauge(
        "triton_gpu_active_models",
        "Number of Triton models currently resident on GPU.",
        labelnames=("tier",),
    )
else:  # pragma: no cover
    _INFER_LATENCY = None
    _MODEL_LOAD_LATENCY = None
    _ACTIVE_MODELS = None


# Tier membership defaults (research §C.1 + contracts/triton-stages.md)
DEFAULT_TIER_A_MODELS: tuple[str, ...] = (
    "liverra-stunet-parenchyma",
    "liverra-couinaud-segments",
)
DEFAULT_TIER_B_MODELS: tuple[str, ...] = (
    "liverra-stunet-lesions",
    "liverra-lilnet-classify",
    "liverra-vista3d-refine",
    "liverra-medsam2-track",
)


class TritonInferenceError(RuntimeError):
    """Raised when Triton returns a non-OK response or a tensor shape
    does not match the declared contract."""


@dataclass
class _ModelState:
    """Tracks lazy-load + recency state for a Tier-B model.

    Tier-A entries are represented with ``loaded=True`` at init and
    never evicted.
    """

    tier: str  # "a" or "b"
    loaded: bool = False
    last_used_ts: float = field(default_factory=time.monotonic)


class TritonClient:
    """Async wrapper around :class:`tritonclient.grpc.aio.InferenceServerClient`.

    Parameters
    ----------
    url:
        gRPC host:port, e.g. ``"triton:8001"``.
    tier_a_models:
        Always-loaded set. Defaults to :data:`DEFAULT_TIER_A_MODELS`.
    tier_b_models:
        Lazy-loaded set. Defaults to :data:`DEFAULT_TIER_B_MODELS`.
    """

    def __init__(
        self,
        url: str,
        tier_a_models: list[str] | tuple[str, ...] | None = None,
        tier_b_models: list[str] | tuple[str, ...] | None = None,
    ) -> None:
        if InferenceServerClient is None:  # pragma: no cover
            raise RuntimeError(
                "tritonclient is not installed; add `tritonclient[grpc]` "
                "to packages/ml-inference/requirements.txt."
            )
        self._url = url
        self._client = InferenceServerClient(url=url, verbose=False)

        tier_a = tuple(tier_a_models or DEFAULT_TIER_A_MODELS)
        tier_b = tuple(tier_b_models or DEFAULT_TIER_B_MODELS)
        if set(tier_a) & set(tier_b):
            raise ValueError("A model cannot be both Tier-A and Tier-B")

        self._models: dict[str, _ModelState] = {
            name: _ModelState(tier="a", loaded=True) for name in tier_a
        }
        for name in tier_b:
            self._models[name] = _ModelState(tier="b", loaded=False)

        self._lock = asyncio.Lock()

        if _ACTIVE_MODELS is not None:  # pragma: no branch
            _ACTIVE_MODELS.labels(tier="a").set(len(tier_a))
            _ACTIVE_MODELS.labels(tier="b").set(0)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def infer(
        self,
        model_name: str,
        inputs: list[np.ndarray],
        input_names: list[str] | None = None,
        output_names: list[str] | None = None,
    ) -> list[np.ndarray]:
        """Run a single inference and return the decoded output tensors.

        FP32 inputs are cast to FP16 if the model was configured with
        FP16 inputs (Stage 1 contract). Callers may pre-cast and pass
        FP16 directly — we leave already-FP16 ndarrays alone.

        Parameters
        ----------
        model_name:
            Fully qualified Triton model name (``liverra-*``).
        inputs:
            List of ndarrays in the order declared in ``config.pbtxt``.
        input_names:
            Override the default ``INPUT__0``, ``INPUT__1`` naming if a
            model uses custom names.
        output_names:
            Override the default ``OUTPUT__0``, ``OUTPUT__1`` naming.

        Raises
        ------
        TritonInferenceError
            For any non-OK Triton response or tensor-shape mismatch.
        """
        if model_name not in self._models:
            raise TritonInferenceError(
                f"Unknown model {model_name!r}; add it to Tier-A or Tier-B."
            )
        await self.ensure_loaded(model_name)

        in_names = input_names or [f"INPUT__{i}" for i in range(len(inputs))]
        if len(in_names) != len(inputs):
            raise TritonInferenceError(
                "input_names length does not match inputs length"
            )

        infer_inputs: list[Any] = []
        for name, arr in zip(in_names, inputs, strict=True):
            # Contiguous layout is required by tritonclient.
            if not arr.flags["C_CONTIGUOUS"]:
                arr = np.ascontiguousarray(arr)
            triton_dtype = np_to_triton_dtype(arr.dtype)  # type: ignore[misc]
            tin = InferInput(name, list(arr.shape), triton_dtype)
            tin.set_data_from_numpy(arr)
            infer_inputs.append(tin)

        if output_names is None:
            # Triton model config pins output count in OUTPUT__N order.
            # We request a generous pair by default; extra names are
            # silently dropped by Triton.
            output_names = ["OUTPUT__0"]
        infer_outputs = [InferRequestedOutput(n) for n in output_names]

        start = time.monotonic()
        try:
            # Bump gRPC client timeout for slower remote-GPU paths (Tailscale).
            # Default tritonclient timeout is too tight (~60s) for the 1.4B
            # parameter Pictorial-Couinaud model when streamed across the
            # Tailscale tunnel — 600s gives generous headroom.
            client_timeout_s = float(os.environ.get("LIVERRA_TRITON_CLIENT_TIMEOUT_S", "600"))
            response = await self._client.infer(
                model_name=model_name,
                inputs=infer_inputs,
                outputs=infer_outputs,
                client_timeout=client_timeout_s,
            )
        except Exception as exc:  # pragma: no cover — surfaces network errors
            raise TritonInferenceError(
                f"Triton inference failed for {model_name}: {exc}"
            ) from exc
        finally:
            latency = time.monotonic() - start
            if _INFER_LATENCY is not None:
                _INFER_LATENCY.labels(model=model_name).observe(latency)

        # Touch recency *after* success so a timed-out call does not
        # keep a Tier-B model loaded indefinitely.
        self._models[model_name].last_used_ts = time.monotonic()

        return [response.as_numpy(n) for n in output_names]

    async def ensure_loaded(self, model_name: str) -> None:
        """Guarantee that ``model_name`` is resident on GPU.

        Tier-A: no-op.
        Tier-B: ``load_model`` via Triton control API if not already loaded.
        """
        state = self._models.get(model_name)
        if state is None:
            raise TritonInferenceError(f"Unknown model {model_name!r}")
        if state.loaded:
            return

        async with self._lock:
            # Re-check after acquiring the lock to avoid double-load.
            if state.loaded:
                return
            logger.info("Lazy-loading Tier-B model %s", model_name)
            start = time.monotonic()
            try:
                await self._client.load_model(model_name)
            except Exception as exc:  # pragma: no cover
                raise TritonInferenceError(
                    f"Failed to load model {model_name}: {exc}"
                ) from exc
            load_secs = time.monotonic() - start
            state.loaded = True
            state.last_used_ts = time.monotonic()
            if _MODEL_LOAD_LATENCY is not None:
                _MODEL_LOAD_LATENCY.labels(model=model_name).observe(load_secs)
            if _ACTIVE_MODELS is not None:
                _ACTIVE_MODELS.labels(tier="b").inc()

    async def evict_lru_tier_b(self, keep_n: int = 2) -> list[str]:
        """Unload all but the ``keep_n`` most-recently-used Tier-B models.

        Returns the list of models that were evicted. Tier-A is never
        touched.
        """
        if keep_n < 0:
            raise ValueError("keep_n must be non-negative")

        tier_b_loaded = [
            (name, state)
            for name, state in self._models.items()
            if state.tier == "b" and state.loaded
        ]
        if len(tier_b_loaded) <= keep_n:
            return []

        # Sort oldest-first.
        tier_b_loaded.sort(key=lambda item: item[1].last_used_ts)
        victims = tier_b_loaded[: len(tier_b_loaded) - keep_n]

        evicted: list[str] = []
        for name, state in victims:
            async with self._lock:
                if not state.loaded:
                    continue
                logger.info("Evicting LRU Tier-B model %s", name)
                try:
                    await self._client.unload_model(name)
                except Exception as exc:  # pragma: no cover
                    logger.warning(
                        "Failed to unload %s (continuing): %s", name, exc
                    )
                    continue
                state.loaded = False
                evicted.append(name)
                if _ACTIVE_MODELS is not None:
                    _ACTIVE_MODELS.labels(tier="b").dec()
        return evicted

    async def close(self) -> None:
        """Close the underlying gRPC channel."""
        close = getattr(self._client, "close", None)
        if close is None:
            return
        maybe_coro = close()
        if asyncio.iscoroutine(maybe_coro):
            await maybe_coro


__all__ = [
    "DEFAULT_TIER_A_MODELS",
    "DEFAULT_TIER_B_MODELS",
    "TritonClient",
    "TritonInferenceError",
]
