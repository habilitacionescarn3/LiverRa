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
        task_time_limit=180,
        task_soft_time_limit=150,
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

    # Discover tasks defined under both packages.
    app.autodiscover_tasks(["src.tasks", "src.orchestrator"])
    return app


# Module-level singleton — Celery's CLI imports this attribute.
app = create_celery_app() if Celery is not None else None  # pragma: no branch


__all__ = ["app", "create_celery_app"]
