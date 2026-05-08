# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Per-stage sanity checks for the cascade orchestrator (T159).

Each stage output passes through a Pydantic model that encodes the
numeric bounds declared in spec §FR-007a and the per-stage sanity rules
in ``contracts/triton-stages.md``. On failure, we raise
:class:`SanityFailure` carrying a machine-readable ``reason`` slug that
the orchestrator writes into ``Analysis.implausible_output_reason``
(data-model §5) and surfaces to the UI.

Plain-English analogy:
    Think of these as airport security checks for model outputs. A
    bag (output) that fails a scan (bounds check) is refused — we do
    not let it fly to the next stage. The slug is the label the
    inspector writes on the rejection tag.

The module exposes one function, :func:`check_stage`, so callers can
stay decoupled from the specific Pydantic class per stage::

    from src.orchestrator import sanity
    sanity.check_stage("parenchyma", {"total_volume_ml": 1800,
                                      "nonzero_voxel_count": 41_000_000})

Reasons emitted (stable slugs — do not rename without spec update):

- ``parenchyma_out_of_range``
- ``parenchyma_empty``
- ``segment_zero_volume``
- ``sum_mismatch``
- ``lesion_outside_parenchyma``
- ``classification_nonnormal``
- ``flr_negative``
- ``flr_exceeds_total``
- ``unknown_stage``
- ``schema_error``  (generic Pydantic validation failures)
"""
from __future__ import annotations

import os
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator


class SanityFailure(Exception):
    """Raised when a stage output violates its sanity contract.

    Parameters
    ----------
    reason:
        Machine-readable slug written to
        ``Analysis.implausible_output_reason``.
    stage:
        The stage name that produced the bad output.
    detail:
        Optional human-readable context; never contains PHI.
    """

    def __init__(self, reason: str, stage: str, detail: str | None = None) -> None:
        super().__init__(f"[{stage}] {reason}: {detail or ''}".strip())
        self.reason = reason
        self.stage = stage
        self.detail = detail


# ---------------------------------------------------------------------------
# Stage: parenchyma
# ---------------------------------------------------------------------------


class ParenchymaSanity(BaseModel):
    """Stage-1 output contract.

    Bounds per FR-007a: adult livers span roughly 300–3500 mL. Anything
    outside that range is almost certainly a segmentation bug and must
    not propagate downstream.
    """

    model_config = ConfigDict(extra="ignore")

    total_volume_ml: float = Field(
        ge=float(os.environ.get("LIVERRA_PARENCHYMA_MIN_ML", "200")),
        le=float(os.environ.get("LIVERRA_PARENCHYMA_MAX_ML", "5500")),
    )
    nonzero_voxel_count: int = Field(gt=0)


# ---------------------------------------------------------------------------
# Stage: couinaud
# ---------------------------------------------------------------------------


class SegmentSanity(BaseModel):
    model_config = ConfigDict(extra="ignore")

    segment: str  # "I".."VIII"
    volume_ml: float


class CouinaudSanity(BaseModel):
    """Stage-3 output contract.

    - All 8 segments must have non-zero volume (absence of a segment
      means the topology failed).
    - Σ(segment_volumes) must match the parenchyma volume within
      ``sum_to_parenchyma_tolerance`` (default 2%, per contract §Stage 3).
    """

    model_config = ConfigDict(extra="ignore")

    segments: list[SegmentSanity]
    expected_parenchyma_ml: float = Field(gt=0)
    sum_to_parenchyma_tolerance: float = Field(default=0.02, ge=0.0, le=0.5)

    @model_validator(mode="after")
    def _sum_check(self) -> "CouinaudSanity":
        if any(s.volume_ml <= 0 for s in self.segments):
            raise SanityFailure(
                reason="segment_zero_volume",
                stage="couinaud",
                detail="one or more Couinaud segments report volume_ml<=0",
            )
        total = sum(s.volume_ml for s in self.segments)
        expected = self.expected_parenchyma_ml
        if expected <= 0:
            raise SanityFailure(
                reason="segment_zero_volume",
                stage="couinaud",
                detail="expected_parenchyma_ml must be positive",
            )
        if abs(total - expected) / expected >= self.sum_to_parenchyma_tolerance:
            raise SanityFailure(
                reason="sum_mismatch",
                stage="couinaud",
                detail=(
                    f"segment sum {total:.1f} mL vs parenchyma {expected:.1f} mL "
                    f"exceeds {self.sum_to_parenchyma_tolerance * 100:.1f}% tolerance"
                ),
            )
        return self


# ---------------------------------------------------------------------------
# Stage: lesion_detection
# ---------------------------------------------------------------------------


class LesionDetectionSanity(BaseModel):
    """Stage-5 output contract.

    Every lesion's voxels must be ≥``parenchyma_containment_min`` (95%
    by default, per contracts/triton-stages.md §Stage 2) inside the
    parenchyma mask. The T213 task pre-enforces this by cropping to the
    parenchyma bbox, but we re-verify here so a buggy model that
    escapes the crop is surfaced instead of silently polluting
    downstream stages.
    """

    model_config = ConfigDict(extra="ignore")

    parenchyma_containment: list[float] = Field(default_factory=list)
    parenchyma_containment_min: float = Field(default=0.95, ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _containment_check(self) -> "LesionDetectionSanity":
        for idx, frac in enumerate(self.parenchyma_containment):
            if frac < self.parenchyma_containment_min:
                raise SanityFailure(
                    reason="lesion_outside_parenchyma",
                    stage="lesion_detection",
                    detail=(
                        f"lesion index {idx} containment {frac:.3f} "
                        f"< {self.parenchyma_containment_min:.2f}"
                    ),
                )
        return self


# ---------------------------------------------------------------------------
# Stage: classification
# ---------------------------------------------------------------------------


class ClassificationSanity(BaseModel):
    """Stage-4 output contract (per-lesion).

    Post-temperature-scaling probabilities MUST sum to 1.0 ± 1e-2.
    """

    model_config = ConfigDict(extra="ignore")

    probs: dict[str, float]

    @model_validator(mode="after")
    def _prob_sum_check(self) -> "ClassificationSanity":
        if not self.probs:
            raise SanityFailure(
                reason="classification_nonnormal",
                stage="classification",
                detail="empty probability distribution",
            )
        if any(p < 0.0 or p > 1.0 for p in self.probs.values()):
            raise SanityFailure(
                reason="classification_nonnormal",
                stage="classification",
                detail="probability outside [0, 1]",
            )
        total = sum(self.probs.values())
        if abs(total - 1.0) >= 0.01:
            raise SanityFailure(
                reason="classification_nonnormal",
                stage="classification",
                detail=f"probs sum to {total:.4f}, not 1.0 ± 0.01",
            )
        return self


# ---------------------------------------------------------------------------
# Stage: flr_init
# ---------------------------------------------------------------------------


class FLRSanity(BaseModel):
    """Stage-7 output contract — default FLR.

    Invariants: ``flr_ml`` is non-negative AND ≤ ``total_ml``.
    """

    model_config = ConfigDict(extra="ignore")

    flr_ml: float = Field(ge=0.0)
    total_ml: float = Field(gt=0.0)

    @model_validator(mode="after")
    def _flr_le_total(self) -> "FLRSanity":
        if self.flr_ml > self.total_ml:
            raise SanityFailure(
                reason="flr_exceeds_total",
                stage="flr_init",
                detail=f"FLR {self.flr_ml:.1f} mL exceeds total {self.total_ml:.1f} mL",
            )
        return self


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------


_STAGE_MODELS: dict[str, type[BaseModel]] = {
    "parenchyma": ParenchymaSanity,
    "couinaud": CouinaudSanity,
    "lesion_detection": LesionDetectionSanity,
    "classification": ClassificationSanity,
    "flr_init": FLRSanity,
}


def check_stage(stage: str, data: dict[str, Any]) -> None:
    """Validate ``data`` against the sanity model for ``stage``.

    Raises :class:`SanityFailure` on violation. Stages with no explicit
    sanity model (e.g. ``anonymization``, ``vessels``, ``lesion_detection``)
    pass through — their sanity is enforced by upstream contracts.
    """
    model_cls = _STAGE_MODELS.get(stage)
    if model_cls is None:
        # Not an error; only a subset of stages have numeric bounds.
        return

    # Special-case parenchyma / flr so the Field-level bounds translate
    # to domain-level slugs, not generic "schema_error".
    try:
        model_cls.model_validate(data)
    except ValidationError as exc:
        if stage == "parenchyma":
            # Which bound tripped? Re-check manually to emit a stable slug.
            volume = data.get("total_volume_ml")
            count = data.get("nonzero_voxel_count")
            if isinstance(count, int) and count <= 0:
                raise SanityFailure(
                    reason="parenchyma_empty",
                    stage="parenchyma",
                    detail="nonzero_voxel_count must be > 0",
                ) from exc
            raise SanityFailure(
                reason="parenchyma_out_of_range",
                stage="parenchyma",
                detail=(
                    f"total_volume_ml={volume!r} outside [300, 3500]"
                    if volume is not None
                    else "missing total_volume_ml"
                ),
            ) from exc
        if stage == "flr_init":
            flr = data.get("flr_ml")
            total = data.get("total_ml")
            if isinstance(flr, (int, float)) and flr < 0:
                raise SanityFailure(
                    reason="flr_negative",
                    stage="flr_init",
                    detail=f"flr_ml={flr!r} is negative",
                ) from exc
            raise SanityFailure(
                reason="schema_error",
                stage="flr_init",
                detail=f"validation failure: flr_ml={flr!r} total_ml={total!r}",
            ) from exc
        # For composite stages, the @model_validator already raised
        # SanityFailure — if we got here it was a schema issue.
        raise SanityFailure(
            reason="schema_error",
            stage=stage,
            detail=str(exc.errors()[:3]),
        ) from exc


__all__ = [
    "ClassificationSanity",
    "CouinaudSanity",
    "FLRSanity",
    "LesionDetectionSanity",
    "ParenchymaSanity",
    "SanityFailure",
    "SegmentSanity",
    "check_stage",
]
