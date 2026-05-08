# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Celery application factory (T164).

Single process-wide :class:`~celery.Celery` instance that all cascade
tasks bind to. Configuration honours NFR-009 (retry policy) and the
cascade budgets from :mod:`src.orchestrator.cascade`.

Plain-English analogy:
    Celery is the cafeteria conveyor belt. This module sets the belt's
    speed, buffer size, and what to do when a tray falls off — so every
    task module (``parenchyma``, ``flr_default``, …) only has to write
    the *recipe*, not configure the kitchen.

Key choices:

- **broker = Redis**, **result_backend = Postgres (db+postgresql)** so
  state survives broker reboots. Connection strings come from
  ``CELERY_BROKER_URL`` and ``CELERY_RESULT_BACKEND`` env vars (research §A.7).
- ``task_acks_late=True`` + ``task_reject_on_worker_lost=True``: if a
  GPU worker OOMs mid-task, the task is requeued once, not lost.
- ``worker_prefetch_multiplier=1``: each worker holds exactly one task
  in flight because stages are GPU-bound and cannot share VRAM.
- ``task_default_retry_delay=60`` + ``task_max_retries=3``: exponential
  backoff is applied per-task via ``Task.retry(countdown=2 ** attempt * 60)``.
- Hard process-level cap ``task_time_limit=180`` (3 × parenchyma budget)
  to catch pathological hangs outside the per-stage soft limit.
"""
from __future__ import annotations

import os

try:
    from celery import Celery  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - dev env without celery
    Celery = None  # type: ignore[assignment]


BROKER_URL_DEFAULT = "redis://localhost:6379/0"
RESULT_BACKEND_DEFAULT = (
    "db+postgresql://liverra:liverra@localhost:5432/liverra"
)


def create_celery_app() -> "Celery":
    """Instantiate the Celery app with LiverRa conventions."""
    if Celery is None:  # pragma: no cover
        raise RuntimeError(
            "celery is not installed; add `celery[redis]` to "
            "packages/ml-inference/requirements.txt"
        )

    app = Celery("liverra")
    app.conf.update(
        broker_url=os.environ.get("CELERY_BROKER_URL", BROKER_URL_DEFAULT),
        result_backend=os.environ.get(
            "CELERY_RESULT_BACKEND", RESULT_BACKEND_DEFAULT
        ),
        # NFR-009 retry policy — exponential backoff applied per-task.
        task_default_retry_delay=60,
        task_max_retries=3,
        # At-least-once delivery for GPU recovery (research §A.7).
        task_acks_late=True,
        task_reject_on_worker_lost=True,
        # One task per worker — GPU stages do not share VRAM.
        worker_prefetch_multiplier=1,
        # Hard process ceiling (cascade-wide safety net).
        # When LIVERRA_CASCADE_BUDGET_MULT > 1 (real Triton over remote
        # network), per-stage budgets in src.orchestrator.cascade scale up
        # too — bump the Celery global ceiling proportionally.
        task_time_limit=int(180 * float(os.environ.get("LIVERRA_CASCADE_BUDGET_MULT", "1"))),
        task_soft_time_limit=int(150 * float(os.environ.get("LIVERRA_CASCADE_BUDGET_MULT", "1"))),
        # Celery 6 requirement for resilient broker reconnects.
        broker_connection_retry_on_startup=True,
        # Keep results for 24 h so the API can look up retry chains.
        result_expires=86_400,
        # Task routing + serialization.
        task_serializer="json",
        result_serializer="json",
        accept_content=["json"],
        timezone="UTC",
        enable_utc=True,
    )

    return app


# Module-level singleton — Celery's CLI imports this attribute.
app = create_celery_app() if Celery is not None else None  # pragma: no branch


# ---------------------------------------------------------------------------
# Triton warmup (Phase 2)
# ---------------------------------------------------------------------------
# Cold first-inference per Triton model takes 2-3× warm latency. Over
# Tailscale DERP relay (laptop dev), this combined with the ~1 s/packet
# overhead can blow past parenchyma's 35 s soft budget on the very
# first analysis after a worker restart. Pre-loading every model on
# worker start eliminates that cold-start bill at the cost of ~30 s of
# extra startup time. Gate behind LIVERRA_TRITON_WARMUP because uvicorn
# --reload restarts make the wait painful during active development.

_WARMUP_MODELS = (
    "liverra-stunet-parenchyma",
    "liverra-stunet-lesions",
    "liverra-couinaud-segments",
    "liverra-vista3d-refine",
    "liverra-lilnet-classify",
    "liverra-medsam2-track",
)


def _warmup_triton_models() -> None:
    """Pre-load all 6 cascade models. Called from the worker_ready signal."""
    import asyncio
    import logging as _logging

    _log = _logging.getLogger(__name__)
    triton_url = os.environ.get("TRITON_URL", "100.124.94.29:8001")

    async def _run() -> None:
        from src.services.triton import TritonClient

        client = TritonClient(triton_url)
        try:
            for model in _WARMUP_MODELS:
                try:
                    await client.ensure_loaded(model)
                    _log.info("Triton warmup: %s ready", model)
                except Exception as exc:  # noqa: BLE001 — warmup is best-effort
                    _log.warning("Triton warmup failed for %s: %s", model, exc)
        finally:
            await client.close()

    asyncio.run(_run())


if app is not None:
    try:
        from celery.signals import worker_ready  # type: ignore[import-not-found]

        @worker_ready.connect
        def _on_worker_ready(sender, **_kwargs):  # type: ignore[no-untyped-def]
            if os.environ.get("LIVERRA_TRITON_WARMUP", "").lower() not in {"1", "true", "yes"}:
                return
            _warmup_triton_models()
    except ImportError:  # pragma: no cover — celery not installed in unit tests
        pass


# Eagerly import task modules so @app.task decorators register on import.
# Done AFTER `app` is bound to avoid circular imports — the task modules
# do `from src.workers.app import app`, which only resolves once this
# module's namespace has `app` defined.
if app is not None:
    import importlib as _importlib
    import logging as _logging

    _logger = _logging.getLogger(__name__)
    for _mod in (
        "src.tasks.cascade",
        "src.tasks.demo_cascade",
        "src.tasks.real_cascade_task",
        "src.tasks.ingest",
        "src.tasks.anonymization",
        "src.tasks.parenchyma",
        "src.tasks.lesion_detection",
        "src.tasks.couinaud",
        "src.tasks.vessels",
        "src.tasks.classification",
        "src.tasks.flr_default",
        "src.tasks.finalize_report",
        "src.tasks.push_to_pacs",
        "src.tasks.daily_merkle_root",
        "src.tasks.recalibrate_temperature",
        "src.orchestrator.cascade",
    ):
        try:
            _importlib.import_module(_mod)
        except Exception as _exc:  # noqa: BLE001 — best-effort registration
            _logger.warning("failed to import task module %s: %s", _mod, _exc)


__all__ = ["app", "create_celery_app"]
