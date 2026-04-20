# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Analysis Server-Sent Events stream (T168, T169).

Plain-English:
    The frontend wants to watch a pipeline finish stage-by-stage
    without polling every second. SSE (Server-Sent Events) is a one-way
    HTTP stream — the browser opens a long-lived GET and the server
    writes ``event: stage-complete\\ndata: {...}\\n\\n`` chunks as each
    Celery stage checkpoint is committed.

Implementation notes:

- The loop polls ``pipeline_checkpoint`` every second for rows with
  ``stage_no > last_seen_stage``. Postgres LISTEN/NOTIFY would be
  faster, but polling keeps the dependency surface small and matches
  our p95 latency budget (< 2 s).
- Keep-alives (``: keep-alive\\n\\n``) are emitted every 15 s so that
  nginx / CloudFront idle timeouts don't drop the connection.
- Clients can reconnect using ``Last-Event-ID`` — we parse it as a
  stage_no integer and resume from there.
- Response header ``X-Accel-Buffering: no`` disables nginx buffering
  (otherwise nginx would queue up stage events into the default 8 KB
  buffer and the UI would stutter).

Permission: ``analysis.view`` (T169). The route is wrapped by
``@require_permission`` which also enforces tenant isolation via
``request.state.resource_tenant_id``.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.session import get_db
from ..middleware.require_permission import require_permission
from ..services.errors.catalog import ErrorSlug, ProblemDetailException

logger = logging.getLogger(__name__)


router = APIRouter()


SSE_MEDIA_TYPE = "text/event-stream"
POLL_INTERVAL_SECONDS = 1.0
KEEPALIVE_INTERVAL_SECONDS = 15.0
# Give up after this wall-clock duration even if the analysis never finishes.
# The frontend will automatically reconnect with Last-Event-ID.
MAX_STREAM_DURATION_SECONDS = 15 * 60


_TERMINAL_STATES = {"completed", "complete", "failed", "cancelled"}


def _sse_event(event: str, data: dict[str, Any], *, event_id: Optional[int] = None) -> str:
    """Render a single SSE frame (trailing blank line included)."""
    lines: list[str] = []
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {event}")
    lines.append(f"data: {json.dumps(data, default=str)}")
    lines.append("")  # blank line terminates the frame
    lines.append("")
    return "\n".join(lines)


def _parse_last_event_id(raw: Optional[str]) -> int:
    """Decode the ``Last-Event-ID`` header; fall back to 0 on any error."""
    if not raw:
        return 0
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return 0


async def _load_analysis_status(
    session: AsyncSession, analysis_id: UUID, tenant_id: UUID
) -> Optional[dict[str, Any]]:
    """Return current status + tenant for the analysis, or ``None``."""
    result = await session.execute(
        text(
            """
            SELECT id, tenant_id, status, completed_at, error_slug
            FROM analysis
            WHERE id = :id AND tenant_id = :tid
            """
        ),
        {"id": str(analysis_id), "tid": str(tenant_id)},
    )
    row = result.mappings().first()
    return dict(row) if row else None


async def _poll_new_checkpoints(
    session: AsyncSession, analysis_id: UUID, after_stage: int
) -> list[dict[str, Any]]:
    """Fetch ``pipeline_checkpoint`` rows with ``stage_no > after_stage``."""
    result = await session.execute(
        text(
            """
            SELECT stage_no, stage, output_uri, written_at,
                   model_version, model_license_hash
            FROM pipeline_checkpoint
            WHERE analysis_id = :id AND stage_no > :after
            ORDER BY stage_no ASC
            """
        ),
        {"id": str(analysis_id), "after": after_stage},
    )
    return [dict(r) for r in result.mappings()]


@router.get(
    "/{analysis_id}/stream",
    summary="Realtime stage-complete stream (Server-Sent Events)",
    responses={
        200: {"content": {SSE_MEDIA_TYPE: {}}, "description": "SSE stream"},
        404: {"description": "Analysis not found or cross-tenant"},
    },
)
@require_permission("analysis.view")
async def stream_analysis(
    analysis_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """Open a Server-Sent Events stream for one analysis.

    Event types:
        - ``stage-complete``  one per new pipeline_checkpoint row
        - ``status-change``   when ``analysis.status`` transitions
        - ``terminal``        final event before close; payload includes
                               the final status + error_slug (if any)
    """
    tenant_id: UUID = request.state.tenant_id

    # Verify access BEFORE starting the generator — we want to reject
    # unauthorized callers with a synchronous 404, not inside the stream.
    initial = await _load_analysis_status(session, analysis_id, tenant_id)
    if initial is None:
        raise ProblemDetailException(
            ErrorSlug.NOT_FOUND,
            status.HTTP_404_NOT_FOUND,
            "Analysis not found.",
            instance=str(uuid4()),
        )

    last_event_header = request.headers.get("Last-Event-ID")
    initial_last_seen = _parse_last_event_id(last_event_header)

    async def event_generator() -> AsyncIterator[str]:
        last_seen_stage = initial_last_seen
        last_status: Optional[str] = initial["status"]
        started = datetime.now(timezone.utc)
        last_keepalive = started

        # Emit a ``hello`` frame so the client knows the connection is open.
        yield _sse_event(
            "hello",
            {
                "analysis_id": str(analysis_id),
                "status": last_status,
                "resumed_from": last_seen_stage,
            },
        )

        while True:
            # Bail if the client dropped.
            if await request.is_disconnected():
                logger.debug("SSE client disconnected (analysis=%s)", analysis_id)
                return

            # Bail on server-side hard cap (client will reconnect).
            now = datetime.now(timezone.utc)
            if (now - started).total_seconds() > MAX_STREAM_DURATION_SECONDS:
                yield _sse_event(
                    "timeout",
                    {
                        "reason": "max-stream-duration",
                        "resume_with_last_event_id": last_seen_stage,
                    },
                    event_id=last_seen_stage,
                )
                return

            # New checkpoints since last tick?
            try:
                new_cps = await _poll_new_checkpoints(
                    session, analysis_id, last_seen_stage
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("SSE checkpoint poll failed: %s", exc)
                # A transient DB hiccup shouldn't kill the stream; wait + retry.
                await asyncio.sleep(POLL_INTERVAL_SECONDS)
                continue

            for cp in new_cps:
                yield _sse_event(
                    "stage-complete",
                    {
                        "stage": cp["stage"],
                        "stage_no": cp["stage_no"],
                        "output_uri": cp["output_uri"],
                        "written_at": cp["written_at"].isoformat()
                        if isinstance(cp["written_at"], datetime)
                        else str(cp["written_at"]),
                        "model_version": cp["model_version"],
                        "model_license_hash": cp["model_license_hash"],
                    },
                    event_id=cp["stage_no"],
                )
                last_seen_stage = cp["stage_no"]

            # Status transition?
            current = await _load_analysis_status(session, analysis_id, tenant_id)
            if current is None:
                # Row vanished (GDPR erasure, test teardown, …).
                yield _sse_event("terminal", {"status": "vanished"})
                return

            if current["status"] != last_status:
                yield _sse_event(
                    "status-change",
                    {"status": current["status"]},
                    event_id=last_seen_stage,
                )
                last_status = current["status"]

            if current["status"] in _TERMINAL_STATES:
                yield _sse_event(
                    "terminal",
                    {
                        "status": current["status"],
                        "error_slug": current.get("error_slug"),
                        "completed_at": (
                            current["completed_at"].isoformat()
                            if current.get("completed_at")
                            else None
                        ),
                    },
                    event_id=last_seen_stage,
                )
                return

            # Keep-alive comment — important for proxies with idle timeouts.
            if (now - last_keepalive).total_seconds() >= KEEPALIVE_INTERVAL_SECONDS:
                yield ": keep-alive\n\n"
                last_keepalive = now

            await asyncio.sleep(POLL_INTERVAL_SECONDS)

    headers = {
        # Disable nginx proxy buffering so frames flush to the client promptly.
        "X-Accel-Buffering": "no",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
    }
    return StreamingResponse(
        event_generator(), media_type=SSE_MEDIA_TYPE, headers=headers
    )


__all__ = ["router"]
