# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Reviewer-seat manager (T233).

Plain-English analogy:
    Think of an analysis as a piano with only one bench. At most one
    reviewer can sit on the bench at a time; they hold it by checking
    in (heartbeat) every 60 seconds. If they stop checking in, the
    bench clears automatically. A second reviewer may politely ask
    the current player to get up ("takeover request") — the current
    player is notified in real time (via SSE / Redis pub-sub) and
    decides whether to accept or finish first.

Implements FR-017a (reviewer seat) and the takeover flow from
spec.md §Edge Cases ("Two users open the same case"):

- One open review per analysis, enforced by the UNIQUE partial index
  ``surgeon_review_open_unique`` installed by migration 0004 (T055).
- Seat TTL is 60 seconds (``seat_held_until = now() + 60s``). The
  client heartbeats every 60 s to extend.
- Background cleanup marks expired seats as released (the UNIQUE
  index only cares about ``finalized_at IS NULL``, so we finalize on
  expiry to release the bench).
- Takeover: when a second reviewer requests a transfer, we publish
  a ``takeover-requested`` event on a Redis pub/sub channel keyed by
  analysis id; the SSE endpoint in ``src.api.review`` consumes it
  and forwards to the current holder's browser.

All mutations happen inside the caller's transaction so the audit
chain-of-hashes stays atomic with the state change (FR-029b).

Spec / research refs:
    - spec.md §FR-017a, §Edge Cases (two users).
    - research.md §A.3 (audit chain), §C.6 (refinement UX offline mirror).
    - data-model.md §SurgeonReview.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Seat TTL (FR-017a heartbeat window).
SEAT_TTL = timedelta(seconds=60)

#: Redis pub/sub channel prefix for takeover events. One channel per
#: analysis so an SSE listener only hears its own case.
TAKEOVER_CHANNEL_PREFIX = "liverra:review:takeover:"


class SeatUnavailable(Exception):
    """Raised when another user already holds an open review seat.

    Carries the holder's user id and display name so the handler can
    surface them in the 409 problem+json body (per OpenAPI §review).
    """

    def __init__(
        self,
        holder_user_id: UUID,
        holder_display_name: Optional[str] = None,
        seat_held_until: Optional[datetime] = None,
    ) -> None:
        super().__init__(
            f"Seat held by user {holder_user_id}"
            + (f" ({holder_display_name})" if holder_display_name else "")
        )
        self.holder_user_id = holder_user_id
        self.holder_display_name = holder_display_name
        self.seat_held_until = seat_held_until


class ReviewNotFound(Exception):
    """Raised when the review id does not exist for the caller's tenant."""


# ---------------------------------------------------------------------------
# DTO
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ReviewSeat:
    review_id: UUID
    analysis_id: UUID
    user_id: UUID
    seat_held_until: datetime
    finalized_at: Optional[datetime]


# ---------------------------------------------------------------------------
# Redis pub/sub protocol
# ---------------------------------------------------------------------------


class RedisPublisher:
    """Tiny protocol shim: anything with an async ``publish(channel, msg)``.

    The production wire-up uses ``redis.asyncio.Redis`` from ``redis>=5``;
    unit tests pass an in-memory fake.
    """

    async def publish(self, channel: str, message: str) -> int:  # pragma: no cover
        raise NotImplementedError


# ---------------------------------------------------------------------------
# Manager
# ---------------------------------------------------------------------------


class SeatManager:
    """Acquire / heartbeat / release / takeover reviewer seats.

    All methods accept the caller's ``AsyncSession`` — we never open
    our own transaction, so the audit write and the seat mutation live
    or die together.
    """

    def __init__(self, redis_publisher: Optional[RedisPublisher] = None) -> None:
        self._redis = redis_publisher

    # ------------------------------------------------------------------
    # Acquire
    # ------------------------------------------------------------------

    async def acquire(
        self,
        analysis_id: UUID,
        user_id: UUID,
        session: AsyncSession,
    ) -> ReviewSeat:
        """Open a new SurgeonReview row (=> acquire the seat).

        Behaviour:
            1. If there is an existing open review AND ``seat_held_until``
               is still in the future => raise :class:`SeatUnavailable`.
            2. If an existing open review is past TTL, auto-expire it
               (set ``finalized_at = now()``) and proceed — this keeps
               the UNIQUE partial idx happy.
            3. Insert the new row with ``seat_held_until = now() + 60s``.

        The UNIQUE partial index
        ``surgeon_review_open_unique (analysis_id) WHERE finalized_at IS NULL``
        (migration 0004) is the belt to our suspenders — concurrent
        acquires will race and exactly one will win.
        """
        now = datetime.now(timezone.utc)
        seat_until = now + SEAT_TTL

        # 1. Look for an open review.
        existing = (
            await session.execute(
                text(
                    """
                    SELECT sr.id, sr.user_id, sr.seat_held_until,
                           u.display_name
                    FROM surgeon_review sr
                    LEFT JOIN "user" u ON u.id = sr.user_id
                    WHERE sr.analysis_id = :aid AND sr.finalized_at IS NULL
                    ORDER BY sr.created_at DESC
                    LIMIT 1
                    FOR UPDATE
                    """
                ),
                {"aid": str(analysis_id)},
            )
        ).mappings().first()

        if existing:
            seat_held_until = existing["seat_held_until"]
            # (a) If same user reclaims their own open seat, just refresh it.
            if str(existing["user_id"]) == str(user_id):
                await session.execute(
                    text(
                        """
                        UPDATE surgeon_review
                        SET seat_held_until = :until
                        WHERE id = :rid
                        """
                    ),
                    {"until": seat_until, "rid": str(existing["id"])},
                )
                return ReviewSeat(
                    review_id=existing["id"],
                    analysis_id=analysis_id,
                    user_id=user_id,
                    seat_held_until=seat_until,
                    finalized_at=None,
                )

            # (b) Seat still valid => refuse.
            if seat_held_until and seat_held_until > now:
                raise SeatUnavailable(
                    holder_user_id=existing["user_id"],
                    holder_display_name=existing.get("display_name"),
                    seat_held_until=seat_held_until,
                )

            # (c) Seat expired => auto-finalize it and fall through.
            await session.execute(
                text(
                    """
                    UPDATE surgeon_review
                    SET finalized_at = now()
                    WHERE id = :rid AND finalized_at IS NULL
                    """
                ),
                {"rid": str(existing["id"])},
            )

        # 2. Insert new open seat.
        inserted = (
            await session.execute(
                text(
                    """
                    INSERT INTO surgeon_review
                        (analysis_id, user_id, seat_held_until)
                    VALUES (:aid, :uid, :until)
                    RETURNING id, analysis_id, user_id, seat_held_until, finalized_at
                    """
                ),
                {
                    "aid": str(analysis_id),
                    "uid": str(user_id),
                    "until": seat_until,
                },
            )
        ).mappings().one()

        return ReviewSeat(
            review_id=inserted["id"],
            analysis_id=inserted["analysis_id"],
            user_id=inserted["user_id"],
            seat_held_until=inserted["seat_held_until"],
            finalized_at=inserted["finalized_at"],
        )

    # ------------------------------------------------------------------
    # Heartbeat
    # ------------------------------------------------------------------

    async def heartbeat(self, review_id: UUID, session: AsyncSession) -> datetime:
        """Extend ``seat_held_until`` by another 60 s.

        Raises :class:`ReviewNotFound` if the review is not open.
        """
        now = datetime.now(timezone.utc)
        seat_until = now + SEAT_TTL
        result = await session.execute(
            text(
                """
                UPDATE surgeon_review
                SET seat_held_until = :until
                WHERE id = :rid AND finalized_at IS NULL
                RETURNING seat_held_until
                """
            ),
            {"until": seat_until, "rid": str(review_id)},
        )
        row = result.first()
        if not row:
            raise ReviewNotFound(f"Review {review_id} not open")
        return row[0]

    # ------------------------------------------------------------------
    # Release
    # ------------------------------------------------------------------

    async def release(self, review_id: UUID, session: AsyncSession) -> None:
        """Finalize the review (clears the seat for the next user).

        Idempotent — releasing an already-finalized review is a no-op.
        """
        await session.execute(
            text(
                """
                UPDATE surgeon_review
                SET finalized_at = now()
                WHERE id = :rid AND finalized_at IS NULL
                """
            ),
            {"rid": str(review_id)},
        )

    # ------------------------------------------------------------------
    # Takeover request
    # ------------------------------------------------------------------

    async def request_takeover(
        self,
        analysis_id: UUID,
        requester_id: UUID,
        session: AsyncSession,
    ) -> dict[str, Any]:
        """Ask the current holder to release the seat.

        Returns a dict with the holder's id + display name (for the
        requester's UI) and publishes a ``takeover-requested`` event to
        the Redis channel the holder's SSE is listening on.

        If no open review exists, raises :class:`ReviewNotFound` — the
        caller should retry ``acquire`` which will then succeed.
        """
        existing = (
            await session.execute(
                text(
                    """
                    SELECT sr.id, sr.user_id, sr.seat_held_until,
                           u.display_name
                    FROM surgeon_review sr
                    LEFT JOIN "user" u ON u.id = sr.user_id
                    WHERE sr.analysis_id = :aid AND sr.finalized_at IS NULL
                    ORDER BY sr.created_at DESC
                    LIMIT 1
                    """
                ),
                {"aid": str(analysis_id)},
            )
        ).mappings().first()
        if not existing:
            raise ReviewNotFound(f"No open review for analysis {analysis_id}")

        payload: dict[str, Any] = {
            "type": "takeover-requested",
            "review_id": str(existing["id"]),
            "analysis_id": str(analysis_id),
            "holder_user_id": str(existing["user_id"]),
            "holder_display_name": existing.get("display_name"),
            "requester_user_id": str(requester_id),
            "requested_at": datetime.now(timezone.utc).isoformat(),
        }

        # Append to the timeline JSON column so the event survives
        # even if the SSE subscriber was offline at publish time.
        await session.execute(
            text(
                """
                UPDATE surgeon_review
                SET timeline_events =
                    COALESCE(timeline_events, '[]'::jsonb)
                    || CAST(:event AS jsonb)
                WHERE id = :rid
                """
            ),
            {
                "event": json.dumps(payload),
                "rid": str(existing["id"]),
            },
        )

        # Best-effort pub/sub so live SSE subscribers hear about it
        # immediately. Persistence already happened above, so a
        # publisher outage is recoverable via GET takeover-events SSE
        # replay.
        if self._redis is not None:
            try:
                await self._redis.publish(
                    TAKEOVER_CHANNEL_PREFIX + str(analysis_id),
                    json.dumps(payload),
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("takeover pub/sub publish failed: %s", exc)

        return payload

    # ------------------------------------------------------------------
    # Background cleanup
    # ------------------------------------------------------------------

    async def expire_stale_seats(self, session: AsyncSession) -> int:
        """Finalize any open review whose ``seat_held_until < now()``.

        Intended to be driven by a Celery beat schedule (e.g. every
        15 s). Returns the number of expired rows — emit a metric
        ``liverra_review_seats_expired_total`` per row at the call
        site.
        """
        result = await session.execute(
            text(
                """
                UPDATE surgeon_review
                SET finalized_at = now()
                WHERE finalized_at IS NULL
                  AND seat_held_until IS NOT NULL
                  AND seat_held_until < now()
                """
            )
        )
        # SQLAlchemy's rowcount is -1 on some drivers; treat <0 as 0.
        return max(0, int(result.rowcount or 0))


__all__ = [
    "SEAT_TTL",
    "TAKEOVER_CHANNEL_PREFIX",
    "ReviewNotFound",
    "ReviewSeat",
    "RedisPublisher",
    "SeatManager",
    "SeatUnavailable",
]
