# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Cascade graph builder (T158 + T216 wiring).

Expresses the v1 cascade as a Celery Canvas workflow::

    anonymization
      → parenchyma
        → (vessels ∥ couinaud)   # chord, run in parallel
          → lesion_detection
            → classification     # per-lesion fanout (chord over Lesion.id)
              → flr_init

Per-stage timeout budgets (spec FR-014 ≤120 s end-to-end):

    anonymization         15 s
    parenchyma            35 s
    vessels               10 s
    couinaud              20 s
    lesion_detection      20 s
    classification         5 s per lesion (capped at 20 s total)
    flr_init               5 s
                          ────
    sum of serial legs   100 s  (vessels runs concurrent with couinaud
                                 so its 10 s is absorbed)

Behaviour on failure:

- ``SoftTimeLimitExceeded`` or ``SanityFailure`` in a stage: we mark
  ``Analysis.status='partial_result'`` and persist checkpoints up to
  the last successful stage (FR-014a/b).
- Downstream stages that depended on the failed stage are skipped but
  the UI is notified via SSE (``AnalysisUpdate`` events, wired in the
  API layer — out of scope for this module).
- **Lesion-detection graceful-degradation (T216)**: a lesion_detection
  failure does NOT halt the cascade — classification fans out over an
  empty lesion list and FLR still runs. An analysis with zero lesions
  is a valid result.

The chain-of-hashes audit events (``analysis_stage_start`` /
``analysis_stage_complete`` / ``analysis_stage_failed``) are emitted by
:func:`run_stage` so every attempt — including skipped ones — is a
first-class entry in the tamper-evident log.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Awaitable, Callable
from uuid import UUID

try:
    from celery import chain, chord  # type: ignore[import-not-found]
    from celery.exceptions import (  # type: ignore[import-not-found]
        SoftTimeLimitExceeded,
    )
except ImportError:  # pragma: no cover — dev env without celery
    chain = None  # type: ignore[assignment]
    chord = None  # type: ignore[assignment]

    class SoftTimeLimitExceeded(Exception):  # type: ignore[no-redef]
        pass


from .sanity import SanityFailure, check_stage

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Stage budgets (seconds)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StageBudget:
    """Per-stage timeout budget (soft + hard)."""

    name: str
    stage_no: int
    soft_time_limit: int
    time_limit: int


_BUDGET_MULT = float(os.environ.get("LIVERRA_CASCADE_BUDGET_MULT", "1"))


def _b(soft: int, hard: int) -> tuple[int, int]:
    return int(soft * _BUDGET_MULT), int(hard * _BUDGET_MULT)


def _stage_budget(name: str, default_soft: int, default_hard: int) -> tuple[int, int]:
    """Resolve a per-stage budget. Reads LIVERRA_STAGE_<NAME>_SOFT_S and
    LIVERRA_STAGE_<NAME>_HARD_S env vars (falling back to defaults), then
    applies the global LIVERRA_CASCADE_BUDGET_MULT scaling. Lets dev
    over Tailscale (cold Triton, DERP relay) bump budgets without
    touching code."""
    key = name.upper()
    soft = int(os.environ.get(f"LIVERRA_STAGE_{key}_SOFT_S", default_soft))
    hard = int(os.environ.get(f"LIVERRA_STAGE_{key}_HARD_S", default_hard))
    return _b(soft, hard)


_i_s, _i_h = _stage_budget("ingest", 300, 600)
_a_s, _a_h = _stage_budget("anonymization", 15, 20)
_p_s, _p_h = _stage_budget("parenchyma", 35, 45)
_v_s, _v_h = _stage_budget("vessels", 10, 15)
_c_s, _c_h = _stage_budget("couinaud", 20, 30)
_l_s, _l_h = _stage_budget("lesion_detection", 20, 30)
_cl_s, _cl_h = _stage_budget("classification", 20, 30)
_f_s, _f_h = _stage_budget("flr_init", 5, 10)
_fin_s, _fin_h = _stage_budget("finalize", 5, 10)

STAGE_BUDGETS: dict[str, StageBudget] = {
    "ingest": StageBudget("ingest", 0, _i_s, _i_h),
    "anonymization": StageBudget("anonymization", 1, _a_s, _a_h),
    "parenchyma": StageBudget("parenchyma", 2, _p_s, _p_h),
    "vessels": StageBudget("vessels", 3, _v_s, _v_h),
    "couinaud": StageBudget("couinaud", 4, _c_s, _c_h),
    "lesion_detection": StageBudget("lesion_detection", 5, _l_s, _l_h),
    "classification": StageBudget("classification", 6, _cl_s, _cl_h),
    "flr_init": StageBudget("flr_init", 7, _f_s, _f_h),
    "finalize": StageBudget("finalize", 8, _fin_s, _fin_h),
}


# Sanity bound: sum of serial legs must respect FR-014 (≤120 s wall clock
# for stages 1..7) WHEN budget mult is 1. With LIVERRA_CASCADE_BUDGET_MULT
# > 1 (real-Triton over Tailscale dev mode), the assert is bypassed.
_SERIAL_STAGES = (
    "anonymization",
    "parenchyma",
    "couinaud",  # vessels runs concurrently with couinaud via chord
    "lesion_detection",
    "classification",
    "flr_init",
)
_SUM = sum(STAGE_BUDGETS[s].soft_time_limit for s in _SERIAL_STAGES)
_HAS_PER_STAGE_ENV = any(
    k.startswith("LIVERRA_STAGE_") and (k.endswith("_SOFT_S") or k.endswith("_HARD_S"))
    for k in os.environ
)
if _BUDGET_MULT == 1 and not _HAS_PER_STAGE_ENV:
    assert _SUM <= 120, f"Cascade soft-timeout sum {_SUM} exceeds FR-014's 120 s"


# ---------------------------------------------------------------------------
# Audit wiring hooks (populated by T166)
# ---------------------------------------------------------------------------


class CascadeAuditHooks:
    """Pluggable callbacks the cascade invokes on every stage boundary.

    Orchestrator setup in workers/app.py or API startup wires a real
    implementation that (a) writes a FHIR AuditEvent via
    :class:`AuditChainWriter` and (b) publishes an SSE event for the
    UI. Tests supply a no-op or recording double.
    """

    async def on_stage_start(
        self,
        analysis_id: UUID,
        stage: str,
        correlation_id: str | None,
    ) -> None:  # pragma: no cover - overridden
        ...

    async def on_stage_complete(
        self,
        analysis_id: UUID,
        stage: str,
        result: dict[str, Any],
        correlation_id: str | None,
    ) -> None:  # pragma: no cover - overridden
        ...

    async def on_stage_failed(
        self,
        analysis_id: UUID,
        stage: str,
        error_slug: str,
        correlation_id: str | None,
    ) -> None:  # pragma: no cover - overridden
        ...


_AUDIT_HOOKS: CascadeAuditHooks = CascadeAuditHooks()


def set_audit_hooks(hooks: CascadeAuditHooks) -> None:
    """Install the process-wide audit hook implementation (T166)."""
    global _AUDIT_HOOKS
    _AUDIT_HOOKS = hooks


def get_audit_hooks() -> CascadeAuditHooks:
    """Access the installed audit hooks (test-inspection hook)."""
    return _AUDIT_HOOKS


# ---------------------------------------------------------------------------
# Stage-execution wrapper (T166 target)
# ---------------------------------------------------------------------------


StageFn = Callable[..., Awaitable[dict[str, Any]]]


async def run_stage(
    stage: str,
    analysis_id: UUID,
    fn: StageFn,
    *args: Any,
    correlation_id: str | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Run a single stage with audit + sanity bookends.

    T166 wiring: emits ``analysis_stage_start`` before execution, runs
    the sanity check + ``analysis_stage_complete`` on success, and
    ``analysis_stage_failed`` with a stable slug on any exception.

    Raises SanityFailure or the underlying exception so Celery can
    apply its retry / partial-result policy.
    """
    if stage not in STAGE_BUDGETS:
        raise ValueError(f"Unknown stage {stage!r}")

    hooks = get_audit_hooks()
    await hooks.on_stage_start(analysis_id, stage, correlation_id)

    try:
        result = await fn(*args, **kwargs)
    except SoftTimeLimitExceeded:
        logger.warning(
            "Stage %s for analysis %s hit soft timeout — marking partial",
            stage,
            analysis_id,
        )
        await hooks.on_stage_failed(
            analysis_id, stage, "stage_timeout", correlation_id
        )
        raise
    except SanityFailure as sf:
        await hooks.on_stage_failed(
            analysis_id, stage, sf.reason, correlation_id
        )
        raise
    except Exception as exc:
        logger.exception(
            "Stage %s for analysis %s raised %s", stage, analysis_id, type(exc).__name__
        )
        await hooks.on_stage_failed(
            analysis_id, stage, "stage_exception", correlation_id
        )
        raise

    # Run the per-stage sanity model on the structured portion of the
    # result. Callers pass ``{"sanity": {...}, ...}``; absence of a
    # sanity block means the stage has no numeric invariants.
    sanity_payload = result.get("sanity") if isinstance(result, dict) else None
    if isinstance(sanity_payload, dict):
        try:
            check_stage(stage, sanity_payload)
        except SanityFailure as sf:
            await hooks.on_stage_failed(
                analysis_id, stage, sf.reason, correlation_id
            )
            raise

    await hooks.on_stage_complete(
        analysis_id, stage, result, correlation_id
    )
    return result


# ---------------------------------------------------------------------------
# Celery Canvas graph builder
# ---------------------------------------------------------------------------


def build_cascade(analysis_id: UUID, study_id: UUID) -> Any:
    """Compose the Celery Canvas for a single analysis.

    This is *construction* only — no side effects. The returned Signature
    is applied by the caller (``.apply_async()``). Returning a Signature
    keeps testability: we can assert on the graph shape without running
    a broker.

    Shape::

        chain(
            anonymize_study,
            segment_parenchyma,
            chord(
                [segment_vessels, segment_couinaud],
                body=detect_lesions,
            ),
            classify_lesions_fanout,
            compute_initial_flr,
        )

    The per-task ``soft_time_limit`` / ``time_limit`` come from
    STAGE_BUDGETS and are attached via ``signature(options=...)``.
    """
    if chain is None or chord is None:  # pragma: no cover
        raise RuntimeError(
            "celery is not installed — add `celery[redis]` to requirements.txt"
        )

    # Imported lazily so the module can be imported in tests / tools
    # that don't need a Celery runtime.
    from src.tasks.anonymization import anonymize_study  # type: ignore
    from src.tasks.classification import (  # type: ignore
        classify_lesions_fanout,
    )
    from src.tasks.flr_default import compute_initial_flr  # type: ignore
    from src.tasks.ingest import ingest_study  # type: ignore
    from src.tasks.lesion_detection import detect_lesions  # type: ignore
    from src.tasks.parenchyma import segment_parenchyma  # type: ignore

    ctx = {"analysis_id": str(analysis_id), "study_id": str(study_id)}

    def _sig(task: Any, stage: str, **extra: Any) -> Any:
        budget = STAGE_BUDGETS[stage]
        options = {
            "soft_time_limit": budget.soft_time_limit,
            "time_limit": budget.time_limit,
        }
        # immutable=True (.si()-style) — tasks take their args from kwargs
        # only; we don't want Celery's chain passing the previous task's
        # return value in as a positional arg (the next task's signature
        # already takes analysis_id/study_id by name).
        return task.signature(
            kwargs={**ctx, **extra},
            options=options,
            immutable=True,
        )

    # Placeholders for tasks created by other agents (T197, T198, T213,
    # T214, T230). We name them by Celery task-name so the graph
    # composes even before those modules exist in this branch — the
    # Celery router resolves them at runtime.
    from celery import signature  # type: ignore[import-not-found]

    def _placeholder(stage: str, task_name: str, **extra: Any) -> Any:
        budget = STAGE_BUDGETS[stage]
        return signature(
            task_name,
            kwargs={**ctx, **extra},
            options={
                "soft_time_limit": budget.soft_time_limit,
                "time_limit": budget.time_limit,
            },
            immutable=True,
        )

    graph = chain(
        _sig(ingest_study, "ingest"),
        _sig(anonymize_study, "anonymization"),
        _sig(segment_parenchyma, "parenchyma"),
        chord(
            [
                _placeholder("vessels", "liverra.tasks.segment_vessels"),
                _placeholder("couinaud", "liverra.tasks.segment_couinaud"),
            ],
            body=_sig(detect_lesions, "lesion_detection"),
        ),
        _sig(classify_lesions_fanout, "classification"),
        _sig(compute_initial_flr, "flr_init"),
        _placeholder("finalize", "liverra.tasks.mark_cascade_complete"),
    )
    return graph


# ---------------------------------------------------------------------------
# Post-inference containment helper (T216)
# ---------------------------------------------------------------------------


def check_lesion_containment(
    lesion_masks: "list[Any]",
    parenchyma_mask: "Any",
    min_fraction: float = 0.95,
) -> list[float]:
    """Return per-lesion parenchyma-containment fraction for sanity.

    Each lesion mask must be ≥``min_fraction`` (default 95%) contained
    inside ``parenchyma_mask`` (contracts/triton-stages.md §Stage 2).
    Caller passes the result to ``sanity.check_stage('lesion_detection',
    {'parenchyma_containment': fractions})`` which raises
    ``SanityFailure('lesion_outside_parenchyma', ...)`` on violation.

    All inputs are ``numpy.ndarray`` but typed as ``Any`` here so this
    module remains import-free of numpy in dev environments that
    stub it out.
    """
    import numpy as np  # local import to keep module lightweight

    parenchyma = np.asarray(parenchyma_mask) > 0
    fractions: list[float] = []
    for mask in lesion_masks:
        arr = np.asarray(mask) > 0
        total = float(arr.sum())
        if total <= 0:
            fractions.append(0.0)
            continue
        inside = float((arr & parenchyma).sum())
        fractions.append(inside / total)
    return fractions


__all__ = [
    "CascadeAuditHooks",
    "STAGE_BUDGETS",
    "StageBudget",
    "build_cascade",
    "check_lesion_containment",
    "get_audit_hooks",
    "run_stage",
    "set_audit_hooks",
]
