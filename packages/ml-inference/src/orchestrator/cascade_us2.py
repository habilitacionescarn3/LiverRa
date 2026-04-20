# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""US2 cascade extensions — Couinaud + vein-trunk fan-out (T199).

Plain-English analogy:
    Stage 1 (parenchyma) is the "draw the outline of the liver" step.
    Stage 3 (this module) runs two sub-tasks in parallel that BOTH
    read Stage 1's output:

        parenchyma ─► ┬─ couinaud (8 segment masks)
                      └─ vessels  (portal + hepatic vein trunks)

    Celery's ``chord`` primitive expresses exactly this: a group of
    tasks that run in parallel, with a callback that fires once ALL
    of them have completed successfully. The callback is the gate that
    lets the cascade continue to Stage 4 (lesion detection).

    Both sub-tasks happen to call the same Triton model
    (``liverra-couinaud-segments``) — in production we could optimise
    by running the inference once and fanning out the output tensors,
    but for MVP simplicity we let Celery schedule them as two tasks
    and the Triton client takes care of any de-duplication.

This module is intentionally a **side-file**. It was written before
``cascade.py`` (T158) lands so that the US1 orchestrator agent can
import the two helper symbols below when wiring the full DAG:

    from src.orchestrator.cascade_us2 import (
        build_stage3_chord,
        run_stage3_sanity,
    )

Once T158 ships, a small edit in ``cascade.py`` replaces the existing
linear ``parenchyma → lesion_detection`` link with
``parenchyma → chord([couinaud, vessels]) → lesion_detection``.

Spec refs:

- ``specs/001-zero-training-mvp/spec.md`` §US2, §FR-008, §FR-009, §FR-014a
- ``specs/001-zero-training-mvp/contracts/triton-stages.md`` §Stage 3
"""
from __future__ import annotations

import logging
from typing import Any, Callable

from src.orchestrator.sanity import SanityFailure

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Celery chord builder
# ---------------------------------------------------------------------------


def build_stage3_chord(
    celery_app: Any,
    analysis_id: str,
    *,
    couinaud_task_name: str = "src.tasks.couinaud.segment_couinaud",
    vessels_task_name: str = "src.tasks.vessels.segment_vessels",
    callback_task_name: str = "src.tasks.lesion_detection.detect_lesions",
) -> Any:
    """Return a Celery ``chord`` that runs couinaud + vessels in parallel.

    Plain-English: hand me the Celery app and an analysis id, and I'll
    hand back the ready-to-schedule "run these two in parallel, then
    proceed to lesions" unit of work.

    Parameters
    ----------
    celery_app:
        The Celery application instance. We signature-lookup tasks by
        name so this module does not import the task modules directly
        (keeps the cascade module light).
    analysis_id:
        Stringified ``Analysis.id`` — both sub-tasks take it as their
        sole positional argument (they pull the rest from Postgres).
    couinaud_task_name / vessels_task_name / callback_task_name:
        Override hooks for unit tests. Default names match the task
        modules created in T197 / T198 and the Stage-4 task from T164.
    """
    try:
        # Local import so unit tests without Celery installed can still
        # import this module for the pure helpers below.
        from celery import chord  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover — dev env
        raise RuntimeError(
            "celery is required to build the Stage-3 chord; add to "
            "packages/ml-inference/requirements.txt."
        ) from exc

    couinaud_sig = celery_app.signature(couinaud_task_name, args=(analysis_id,))
    vessels_sig = celery_app.signature(vessels_task_name, args=(analysis_id,))
    callback_sig = celery_app.signature(callback_task_name, args=(analysis_id,))

    logger.info(
        "stage3 chord: analysis=%s couinaud=%s vessels=%s callback=%s",
        analysis_id,
        couinaud_task_name,
        vessels_task_name,
        callback_task_name,
    )
    return chord([couinaud_sig, vessels_sig])(callback_sig)


# ---------------------------------------------------------------------------
# Aggregate sanity checks (called by the chord's header aggregator)
# ---------------------------------------------------------------------------


def run_stage3_sanity(
    *,
    segment_volumes_ml: dict[str, float],
    parenchyma_volume_ml: float,
    portal_containment_ratio: float,
    hepatic_containment_ratio: float,
    sum_tolerance_pct: float = 0.02,
    vessel_containment_min: float = 0.90,
) -> None:
    """Cross-task Stage-3 sanity checks (FR-014a + contract §Stage 3).

    Runs AFTER both child tasks have written their rows — catches
    cross-task invariants that neither sub-task can check alone:

    - Σ(segment_volumes) ≈ parenchyma_volume ± 2%  (FR-008)
    - Portal + hepatic vein containment ≥90%       (FR-009)

    Raises
    ------
    SanityFailure
        ``reason`` one of:
          - ``sum_mismatch`` (segment sum out of tolerance)
          - ``sum_mismatch`` (vessel containment below threshold; slug
            re-used since no vessel-specific one exists yet)
    """
    if parenchyma_volume_ml <= 0:
        raise SanityFailure(
            reason="segment_zero_volume",
            stage="couinaud",
            detail="parenchyma volume must be positive",
        )

    segment_sum = sum(segment_volumes_ml.values())
    drift = abs(segment_sum - parenchyma_volume_ml) / parenchyma_volume_ml
    if drift >= sum_tolerance_pct:
        raise SanityFailure(
            reason="sum_mismatch",
            stage="couinaud",
            detail=(
                f"Σsegments {segment_sum:.1f} mL vs parenchyma "
                f"{parenchyma_volume_ml:.1f} mL drift {drift:.2%} exceeds "
                f"{sum_tolerance_pct:.2%} tolerance"
            ),
        )

    if portal_containment_ratio < vessel_containment_min:
        raise SanityFailure(
            reason="sum_mismatch",
            stage="vessels",
            detail=(
                f"portal vein containment {portal_containment_ratio:.2%} "
                f"below {vessel_containment_min:.0%}"
            ),
        )
    if hepatic_containment_ratio < vessel_containment_min:
        raise SanityFailure(
            reason="sum_mismatch",
            stage="vessels",
            detail=(
                f"hepatic vein containment {hepatic_containment_ratio:.2%} "
                f"below {vessel_containment_min:.0%}"
            ),
        )


# ---------------------------------------------------------------------------
# Patch hook for cascade.py (T158)
# ---------------------------------------------------------------------------


def extend_cascade_with_stage3(existing_chain: Callable[..., Any]) -> Callable[..., Any]:
    """Decorator-style hook so ``cascade.py`` can do::

        from .cascade_us2 import extend_cascade_with_stage3

        @extend_cascade_with_stage3
        def build_cascade(analysis_id: str, ...): ...

    The decorator is the sanctioned insertion point — it fans out
    Stage 3 between ``parenchyma`` and ``lesion_detection`` without the
    cascade owner needing to know the internal task names.

    Implementation is deferred until cascade.py lands (T158); today we
    simply return the wrapped function unchanged and log that the
    wiring is pending.
    """
    logger.info(
        "cascade_us2.extend_cascade_with_stage3 registered — will wire on "
        "cascade.py (T158) landing"
    )
    return existing_chain


__all__ = [
    "build_stage3_chord",
    "extend_cascade_with_stage3",
    "run_stage3_sanity",
]
