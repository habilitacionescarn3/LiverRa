# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Per-tenant temperature-scaling calibration (T215).

Research §C.7: raw LiLNet softmax is over-confident on OOD CTs, so we
divide the pre-softmax logits by a learned temperature T before
computing probabilities. T is fit per tenant from a held-out validation
set; until a tenant accumulates enough reviewed cases to fit its own T,
we fall back to the conservative model-family default (T=1.5).

Plain-English analogy:
    Temperature scaling is like adjusting the contrast on a TV — the
    picture (which class wins) stays the same, but over-saturated
    confidence is toned down so "I'm 99% sure" becomes "I'm 75% sure."
    That calibrated confidence is what drives the abstention decision:
    if no class clears the tenant's threshold, we refuse to guess
    (FR-011) and ask the reviewer to call it.

The scaler is stateless aside from its cached ``temperature`` value;
callers load one per classification invocation, apply it pre-softmax,
then discard it.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import UUID

import numpy as np

if TYPE_CHECKING:  # pragma: no cover - import only for typing
    from sqlalchemy.ext.asyncio import AsyncSession


logger = logging.getLogger(__name__)


#: Model-family default per research §C.7 (conservative cool-down).
DEFAULT_TEMPERATURE: float = 1.5

#: Tenant-configurable abstention threshold per FR-011 + spec §US3.
#: Per agent brief: default 0.65 (tenant may override to 0.50 per the
#: contract table, but our MVP default is 0.65 to keep first-pass
#: reports conservative).
DEFAULT_ABSTENTION_THRESHOLD: float = 0.65


@dataclass
class TemperatureScaler:
    """Divides raw logits by a learned per-tenant temperature.

    Parameters
    ----------
    tenant_id:
        Scoping UUID (audit + observability labels).
    temperature:
        Learned calibration parameter T. Loaded from
        ``tenant_calibration`` (migration 0008). Defaults to
        :data:`DEFAULT_TEMPERATURE` when no row exists for the tenant.
    """

    tenant_id: UUID
    temperature: float = DEFAULT_TEMPERATURE

    def __post_init__(self) -> None:
        # Guard against degenerate values that would explode or zero
        # the logits. The DB CHECK constraint enforces the same range
        # but in-memory construction (e.g. tests) may bypass it.
        if not np.isfinite(self.temperature) or self.temperature <= 0.0:
            raise ValueError(
                f"temperature must be positive and finite, got {self.temperature!r}"
            )

    # ------------------------------------------------------------------
    # Core operation
    # ------------------------------------------------------------------

    def apply(self, logits: np.ndarray) -> np.ndarray:
        """Return ``logits / T`` ready for softmax.

        The scaling is argmax-preserving (monotonic transform), so the
        top-1 prediction never changes; only the spread of the softmax
        distribution does. Out-of-distribution inputs produce flatter
        distributions after scaling, which lets the abstention
        threshold correctly refuse low-confidence cases.
        """
        arr = np.asarray(logits, dtype=np.float64)
        return arr / float(self.temperature)

    def softmax(self, logits: np.ndarray) -> np.ndarray:
        """Apply temperature scaling then a numerically stable softmax.

        Convenience helper for callers that do not need the scaled
        logits themselves. Uses the max-shift trick to avoid overflow
        when the un-scaled logits carry large magnitudes.
        """
        scaled = self.apply(logits)
        shifted = scaled - np.max(scaled, axis=-1, keepdims=True)
        exp = np.exp(shifted)
        denom = np.sum(exp, axis=-1, keepdims=True)
        return exp / denom

    # ------------------------------------------------------------------
    # Persistence helpers
    # ------------------------------------------------------------------

    @classmethod
    async def load_for_tenant(
        cls,
        tenant_id: UUID,
        session: "AsyncSession",
    ) -> "TemperatureScaler":
        """Read the learned temperature for ``tenant_id`` from Postgres.

        Falls back to :data:`DEFAULT_TEMPERATURE` when no row exists
        (tenants begin life un-calibrated). Any DB error also falls
        back to the default with a warning log — an uncalibrated
        prediction is recoverable, a failed prediction is not.
        """
        from sqlalchemy import text as sa_text

        try:
            result = await session.execute(
                sa_text(
                    """
                    SELECT temperature
                    FROM tenant_calibration
                    WHERE tenant_id = :tenant_id
                    """
                ),
                {"tenant_id": str(tenant_id)},
            )
            row = result.first()
        except Exception as exc:  # pragma: no cover - fall-soft path
            logger.warning(
                "tenant_calibration lookup failed for tenant %s: %s",
                tenant_id,
                exc,
            )
            return cls(tenant_id=tenant_id, temperature=DEFAULT_TEMPERATURE)

        if row is None:
            logger.info(
                "no calibration row for tenant %s; using default T=%.3f",
                tenant_id,
                DEFAULT_TEMPERATURE,
            )
            return cls(tenant_id=tenant_id, temperature=DEFAULT_TEMPERATURE)

        temperature = float(row[0])
        return cls(tenant_id=tenant_id, temperature=temperature)


__all__ = [
    "DEFAULT_ABSTENTION_THRESHOLD",
    "DEFAULT_TEMPERATURE",
    "TemperatureScaler",
]
