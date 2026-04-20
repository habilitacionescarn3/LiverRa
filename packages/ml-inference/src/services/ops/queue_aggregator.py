# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Cross-tenant queue aggregator for the ops dashboard (T313, US8).

Plain-English:
    Imagine a single air-traffic-control screen that shows every flight
    (case) in the sky across every airline (tenant). The ops engineer
    can see which flights are queued, which are running, which are
    stuck, and how busy the runway (GPU) is — without learning anything
    about the passengers (PHI).

    This module builds that view by JOINing the ``analysis`` + ``study``
    + ``pipeline_checkpoint`` tables with Prometheus gauges for GPU
    utilisation and cold-start rate. **Everything that goes into the
    returned dict is PHI-free by construction**: we only select
    machine-generated identifiers (UUIDs, pipeline_version, stage,
    error_slug), never free-text fields like ``patient_name``,
    ``accession_number``, or raw error messages.

    A second guard in the HTTP route (see ``src/api/ops.py``) runs the
    serialized response through the central ``PHIScrubber`` and
    refuses to send if it detects anything that looks like PHI
    (fail-closed per NFR-007 + FR-033c).

Contract fields (api-openapi.yaml §ops):
    queued, running, stuck_over_15min,
    gpu_utilization_pct, cold_start_rate_last_hour

Spec refs:
    - spec.md §FR-033c (ops view, never PHI)
    - plan.md §RBAC (AccessPolicy hides PHI)
    - research.md §X.3 (cross-tenant observability)
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# FR-033c: "a live list of stuck cases (>15 minutes in queued or running)".
STUCK_THRESHOLD = timedelta(minutes=15)

# Prometheus query fallbacks when the metrics endpoint is unavailable.
_GPU_UTILIZATION_FALLBACK = 0.0
_COLD_START_RATE_FALLBACK = 0.0

# Only these columns are ever SELECTed — keeps PHI out by construction.
# Any schema evolution MUST keep this list PHI-free.
_SAFE_ANALYSIS_COLUMNS = (
    "a.id AS analysis_id",
    "a.study_id",
    "a.tenant_id",
    "a.status",
    "a.queued_at",
    "a.started_at",
    "a.pipeline_version",
    "a.model_versions",
    "a.error_slug",
)


@dataclass(frozen=True)
class AnalysisSummary:
    """PHI-free projection of an analysis row for the ops dashboard.

    Every field here is either a UUID, a machine-generated slug, a
    timestamp, or a structural dict (``model_versions``). None of these
    can carry a patient name, MRN, or accession number.
    """

    analysis_id: UUID
    study_id: UUID
    tenant_id: UUID
    status: str
    queued_at: datetime
    started_at: Optional[datetime]
    pipeline_version: str
    model_versions: dict[str, Any]
    error_slug: Optional[str]
    last_stage: Optional[str]
    last_stage_at: Optional[datetime]
    stuck_minutes: Optional[float]

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-friendly mapping — no custom types, no PHI."""
        return {
            "analysis_id": str(self.analysis_id),
            "study_id": str(self.study_id),
            "tenant_id": str(self.tenant_id),
            "status": self.status,
            "queued_at": self.queued_at.isoformat() if self.queued_at else None,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "pipeline_version": self.pipeline_version,
            "model_versions": self.model_versions or {},
            "error_slug": self.error_slug,
            "last_stage": self.last_stage,
            "last_stage_at": (
                self.last_stage_at.isoformat() if self.last_stage_at else None
            ),
            "stuck_minutes": self.stuck_minutes,
        }


@dataclass
class QueueView:
    """Aggregated queue telemetry returned to the ops dashboard."""

    queued: list[AnalysisSummary] = field(default_factory=list)
    running: list[AnalysisSummary] = field(default_factory=list)
    stuck_over_15min: list[AnalysisSummary] = field(default_factory=list)
    gpu_utilization_pct: float = 0.0
    cold_start_rate_last_hour: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "queued": [a.to_dict() for a in self.queued],
            "running": [a.to_dict() for a in self.running],
            "stuck_over_15min": [a.to_dict() for a in self.stuck_over_15min],
            "gpu_utilization_pct": self.gpu_utilization_pct,
            "cold_start_rate_last_hour": self.cold_start_rate_last_hour,
        }


# ---------------------------------------------------------------------------
# Prometheus scrape helpers (best-effort — missing metrics fall back to 0.0)
# ---------------------------------------------------------------------------


async def _scrape_gpu_utilization() -> float:
    """Return the latest GPU utilization percentage across all workers.

    The production Triton + DCGM exporter publishes
    ``dcgm_gpu_utilization{gpu="0"}``. In the tests we patch this
    function wholesale; in dev environments without Prometheus we
    return the fallback.
    """
    try:
        from prometheus_client import REGISTRY  # type: ignore

        # We use the local collector registry as a proxy — in production the
        # real scrape happens server-side and is pushed to a Gauge by the
        # observability sidecar. The Gauge is named ``gpu_utilization_pct``.
        for metric in REGISTRY.collect():
            if metric.name == "gpu_utilization_pct":
                for sample in metric.samples:
                    if sample.name == "gpu_utilization_pct":
                        return float(sample.value)
    except Exception as exc:  # noqa: BLE001
        logger.debug("GPU utilization scrape fallback: %s", exc)
    return _GPU_UTILIZATION_FALLBACK


async def _scrape_cold_start_rate() -> float:
    """Return cold-start events per hour (last 60 min, all tenants)."""
    try:
        from prometheus_client import REGISTRY  # type: ignore

        for metric in REGISTRY.collect():
            if metric.name == "inference_cold_starts_per_hour":
                for sample in metric.samples:
                    if sample.name == "inference_cold_starts_per_hour":
                        return float(sample.value)
    except Exception as exc:  # noqa: BLE001
        logger.debug("Cold-start rate scrape fallback: %s", exc)
    return _COLD_START_RATE_FALLBACK


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------


async def _load_analyses_by_status(
    session: AsyncSession,
    statuses: tuple[str, ...],
    *,
    tenant_filter: Optional[UUID] = None,
) -> list[AnalysisSummary]:
    """Load cross-tenant analyses in ``statuses`` — PHI-free projection only.

    Parameters
    ----------
    tenant_filter:
        ``None`` = cross-tenant (ops default). When set, restricts to
        one tenant (unused in v1 but kept for admin drill-down).
    """
    select_cols = ", ".join(_SAFE_ANALYSIS_COLUMNS)
    tenant_clause = "AND a.tenant_id = :tid" if tenant_filter else ""
    # ``pipeline_checkpoint`` LATERAL join is used to surface the latest
    # stage name WITHOUT pulling any free-text DICOM descriptor fields.
    sql = f"""
        SELECT {select_cols},
               cp.stage AS last_stage,
               cp.written_at AS last_stage_at
        FROM analysis a
        LEFT JOIN LATERAL (
            SELECT stage, written_at
            FROM pipeline_checkpoint
            WHERE analysis_id = a.id
            ORDER BY stage_no DESC
            LIMIT 1
        ) cp ON TRUE
        WHERE a.status = ANY(:statuses)
          {tenant_clause}
        ORDER BY a.queued_at ASC
    """
    params: dict[str, Any] = {"statuses": list(statuses)}
    if tenant_filter:
        params["tid"] = str(tenant_filter)

    result = await session.execute(text(sql), params)
    now = datetime.now(timezone.utc)

    out: list[AnalysisSummary] = []
    for row in result.mappings():
        queued_at = row["queued_at"]
        started_at = row.get("started_at")
        anchor = started_at or queued_at
        stuck_minutes: Optional[float] = None
        if anchor is not None:
            # Normalize to UTC-aware.
            if anchor.tzinfo is None:
                anchor = anchor.replace(tzinfo=timezone.utc)
            stuck_minutes = (now - anchor).total_seconds() / 60.0
        out.append(
            AnalysisSummary(
                analysis_id=row["analysis_id"],
                study_id=row["study_id"],
                tenant_id=row["tenant_id"],
                status=row["status"],
                queued_at=queued_at,
                started_at=started_at,
                pipeline_version=row["pipeline_version"],
                model_versions=row.get("model_versions") or {},
                error_slug=row.get("error_slug"),
                last_stage=row.get("last_stage"),
                last_stage_at=row.get("last_stage_at"),
                stuck_minutes=stuck_minutes,
            )
        )
    return out


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def build_view(
    session: AsyncSession,
    *,
    tenant_filter: Optional[UUID] = None,
) -> QueueView:
    """Build the cross-tenant queue view for the ops dashboard.

    Returns a :class:`QueueView` whose fields are all PHI-free by
    construction. The caller (``src/api/ops.py``) MUST still run the
    serialized payload through :class:`PHIScrubber` as a defence-in-depth
    check before returning it over the wire (T443).
    """
    queued = await _load_analyses_by_status(
        session, ("queued",), tenant_filter=tenant_filter
    )
    running = await _load_analyses_by_status(
        session, ("running",), tenant_filter=tenant_filter
    )
    # "Stuck" = queued OR running for >15 min. We derive from the two
    # lists we already fetched rather than doing a third query.
    stuck: list[AnalysisSummary] = []
    for pool in (queued, running):
        for a in pool:
            if a.stuck_minutes is not None and a.stuck_minutes >= (
                STUCK_THRESHOLD.total_seconds() / 60.0
            ):
                stuck.append(a)
    stuck.sort(key=lambda x: x.stuck_minutes or 0.0, reverse=True)

    gpu = await _scrape_gpu_utilization()
    cold_start = await _scrape_cold_start_rate()

    return QueueView(
        queued=queued,
        running=running,
        stuck_over_15min=stuck,
        gpu_utilization_pct=gpu,
        cold_start_rate_last_hour=cold_start,
    )


__all__ = [
    "AnalysisSummary",
    "QueueView",
    "STUCK_THRESHOLD",
    "build_view",
]
