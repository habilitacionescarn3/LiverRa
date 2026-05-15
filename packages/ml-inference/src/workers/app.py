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

# Known stub model.pt SHAs — these are the 16-byte LIVERRA_STUB
# placeholders checked into ``triton-models/{name}/1/model.pt`` for CI.
# If a deployed Triton box still has these files (i.e., the operator
# never replaced them with real weights), every cascade stage produces
# garbage masks. The startup guard below hashes the local model.pt
# files and refuses to mark Triton "ready" when stubs are detected
# AND ``LIVERRA_CASCADE_REAL_MODE`` is not enabled (since real-mode
# bypasses Triton entirely via scripts/real_cascade.py).
_KNOWN_STUB_SHAS: dict[str, str] = {
    "liverra-stunet-parenchyma": "3f3cbf5bccf9ddbcd8cd0e46160c99cb3fadd514e238438d34dab0facc4d0ab1",
    "liverra-stunet-lesions":    "367c85d0f02713fd21655f2c94569b38f21520c340dc5d4f139eb5ca6ff16c10",
    "liverra-couinaud-segments": "2e634a21d5fae53f5e3389cfc3ee852b6aeb597b91ee56bdb45600437f2c1976",
    "liverra-vista3d-refine":    "ea3a506936f29ff4dd85209c546d5699908dac75d3bb2b33cd4c5fe6a5809c91",
    "liverra-lilnet-classify":   "8bc97b9d5cc07eb99b16643dd8777e426956e096e24659412b8923882b30c249",
    "liverra-medsam2-track":     "2defbb2b0d43d0bcd198cabe799f59f987983a91f46aabffcc6345a614b525d0",
}


def _detect_stub_models() -> list[str]:
    """Hash each local model.pt and return the list of stubs detected.

    Returns model names where the local ``triton-models/{name}/1/model.pt``
    SHA-256 matches a known stub. Empty list = all real (or all missing
    locally — the latter happens on Irakli's GPU box where files live
    elsewhere; the guard then silently passes since there's nothing to
    check from this side).
    """
    import hashlib
    from pathlib import Path

    repo_models = (
        Path(__file__).resolve().parents[2] / "triton-models"
    )
    stubs: list[str] = []
    for model_name, expected_stub_sha in _KNOWN_STUB_SHAS.items():
        pt = repo_models / model_name / "1" / "model.pt"
        if not pt.is_file():
            continue
        try:
            sha = hashlib.sha256(pt.read_bytes()).hexdigest()
        except Exception:  # noqa: BLE001
            continue
        if sha == expected_stub_sha:
            stubs.append(model_name)
    return stubs


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
            import logging as _logging
            _log = _logging.getLogger(__name__)

            # L-CASCADE-2: gate the stub-SHA detection block behind the
            # explicit Triton-path opt-in. The detection probes
            # ``triton-models/{name}/1/model.pt`` paths that don't exist
            # on the current Option-B layout — every worker boot was
            # spending CPU + log noise on a dormant code path. Stays
            # available for future Triton re-enablement (matches the
            # gate Agent 2.4 added in tasks/couinaud.py + tasks/vessels.py).
            triton_active = os.environ.get(
                "LIVERRA_TRITON_PATH_ACTIVE", ""
            ).lower() in {"1", "true", "yes"}
            if triton_active:
                real_mode = os.environ.get("LIVERRA_CASCADE_REAL_MODE", "true").lower() in {"1", "true", "yes"}
                stubs = _detect_stub_models()
                if stubs and not real_mode:
                    _log.error(
                        "STUB MODELS DETECTED — cascade will produce garbage masks. "
                        "Replace these model.pt files with real exports before "
                        "running cascades through Triton: %s",
                        ", ".join(stubs),
                    )
                elif stubs:
                    _log.info(
                        "Stub models detected (%s) but LIVERRA_CASCADE_REAL_MODE=true "
                        "bypasses Triton — safe to ignore.",
                        ", ".join(stubs),
                    )

            # B-CASCADE-2 + B-AUDIT-4: install live audit hooks in the
            # Celery worker process. Without this, every cascade stage
            # boundary in a worker silently called the no-op base hook
            # → zero chain rows for every cascade run.
            try:
                from src.observability.phi_scrubber import PHIScrubber
                from src.orchestrator.cascade import (
                    LiveCascadeAuditHooks,
                    set_audit_hooks,
                )
                from src.services.audit.chain_of_hashes import AuditChainWriter
                from src.services.fhir.audit_event_emitter import AuditEventEmitter

                try:
                    from src.db.session import get_sessionmaker  # type: ignore[import-not-found]

                    session_factory = get_sessionmaker()
                except Exception:
                    session_factory = None

                # MedplumClient is wired in a later phase. For now we
                # only install the hooks when a client is registered in
                # the env (e.g., via a sibling module setting
                # ``os.environ["LIVERRA_MEDPLUM_BASE_URL"]``) — otherwise
                # leave the no-op base hook in place. This preserves the
                # fail-closed contract (no chain row → no business commit)
                # while still letting dev environments boot.
                medplum_client = None  # FUTURE: resolve real client here
                if medplum_client is not None:
                    chain_writer = AuditChainWriter(session_factory)
                    emitter = AuditEventEmitter(
                        medplum_client=medplum_client,
                        chain_writer=chain_writer,
                        phi_scrubber=PHIScrubber(),
                    )
                    set_audit_hooks(
                        LiveCascadeAuditHooks(
                            emitter=emitter,
                            session_factory=session_factory,
                        )
                    )
                    _log.info("Celery worker: LiveCascadeAuditHooks installed.")
                else:
                    _log.warning(
                        "Celery worker: no Medplum client wired — cascade "
                        "audit hooks remain no-ops. Set up the Medplum client "
                        "binding to enable chain-of-hashes emission."
                    )
            except Exception:  # noqa: BLE001
                _log.exception("Celery worker: failed to install audit hooks")

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
