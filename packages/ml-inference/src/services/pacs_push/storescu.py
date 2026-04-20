# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Async DICOM C-STORE client (T261).

Plain-English:
    C-STORE is the DICOM network verb for "here is a file, please keep
    it". We use it to push our SEG + SR into the hospital PACS right
    after a Report is finalized. Transport: a single TCP Association
    per ``push_artifacts()`` call — per research §B.6 we require the
    SEG and SR to be shipped in the same Association so a half-push
    never leaves a hospital with measurements but no mask (or vice
    versa).

    :func:`push_artifacts` is purely the effect. The retry state
    machine in ``retry_state_machine.py`` owns "should we try again?"
    + when. This file never touches Postgres.

Dependencies:
    ``pynetdicom>=2.1`` (MIT), ``pydicom>=3.0`` (MIT).
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

try:  # pragma: no cover — available in production containers
    from pynetdicom import AE, evt  # type: ignore[import-not-found]
    from pynetdicom.sop_class import (  # type: ignore[import-not-found]
        ComprehensiveSRStorage,
        SegmentationStorage,
        Verification,
    )
    from pynetdicom.status import Status  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    AE = None  # type: ignore[assignment,misc]
    evt = None  # type: ignore[assignment]
    ComprehensiveSRStorage = "1.2.840.10008.5.1.4.1.1.88.33"  # type: ignore[assignment]
    SegmentationStorage = "1.2.840.10008.5.1.4.1.1.66.4"  # type: ignore[assignment]
    Verification = "1.2.840.10008.1.1"  # type: ignore[assignment]
    Status = object  # type: ignore[assignment,misc]

logger = logging.getLogger(__name__)

# DICOM C-STORE status codes we special-case. Everything outside these is
# treated as a transient failure and left to the retry FSM.
STATUS_SUCCESS: int = 0x0000
STATUS_COERCION_WARNING: int = 0xB000  # "Data Set does not match SOP Class"
STATUS_DATA_ELEMENT_WARNING: int = 0xB007


@dataclass(frozen=True)
class PACSDestination:
    """Remote PACS target (an entry in ``tenant.pacs_destination``)."""

    ae_title: str
    host: str
    port: int
    caller_ae_title: str = "LIVERRA"
    connect_timeout_s: float = 10.0
    dimse_timeout_s: float = 60.0


@dataclass
class ArtifactPushResult:
    """Per-artifact outcome for one push attempt."""

    artifact_type: str  # "seg" or "sr"
    sop_instance_uid: str
    status_code: int | None = None
    acknowledged: bool = False
    error_message: str | None = None


@dataclass
class PushResult:
    """What :func:`push_artifacts` returns to the caller (FSM)."""

    association_success: bool
    artifacts: list[ArtifactPushResult] = field(default_factory=list)
    error_message: str | None = None

    @property
    def all_acknowledged(self) -> bool:
        """True iff every artifact got a ``0x0000`` C-STORE response.

        The retry state machine only flips ``ReportDelivery.status`` to
        ``acknowledged`` when this is True — partial pushes are failures.
        """
        return (
            self.association_success
            and bool(self.artifacts)
            and all(a.acknowledged for a in self.artifacts)
        )


def _sop_class_for(artifact_type: str) -> str:
    if artifact_type == "seg":
        return str(SegmentationStorage)
    if artifact_type == "sr":
        return str(ComprehensiveSRStorage)
    raise ValueError(f"unknown artifact_type={artifact_type!r}; expected 'seg' or 'sr'")


def _push_artifacts_sync(
    destination: PACSDestination,
    artifacts: Sequence[tuple[str, Any]],
) -> PushResult:
    """Blocking implementation run inside :func:`push_artifacts` on a worker thread."""
    if AE is None:  # pragma: no cover
        raise RuntimeError(
            "PACS push requires pynetdicom; install via `pip install 'pynetdicom>=2.1'`"
        )

    ae = AE(ae_title=destination.caller_ae_title)
    ae.connection_timeout = destination.connect_timeout_s
    ae.dimse_timeout = destination.dimse_timeout_s

    # Unique list of SOP classes we need to negotiate.
    for sop in {_sop_class_for(t) for t, _ in artifacts}:
        ae.add_requested_context(sop)

    result = PushResult(association_success=False)
    assoc = None
    try:
        assoc = ae.associate(
            destination.host,
            destination.port,
            ae_title=destination.ae_title,
        )
    except Exception as exc:  # noqa: BLE001 — keep transport error as-is
        result.error_message = f"associate-exception:{type(exc).__name__}"
        logger.warning(
            "C-STORE associate failed host=%s ae_title=%s err=%s",
            destination.host, destination.ae_title, type(exc).__name__,
        )
        return result

    if assoc is None or not getattr(assoc, "is_established", False):
        result.error_message = "associate-not-established"
        logger.warning(
            "C-STORE association not established host=%s ae=%s",
            destination.host, destination.ae_title,
        )
        return result

    try:
        for artifact_type, dataset in artifacts:
            sop_uid = str(getattr(dataset, "SOPInstanceUID", "unknown"))
            artifact_result = ArtifactPushResult(
                artifact_type=artifact_type,
                sop_instance_uid=sop_uid,
            )
            try:
                status = assoc.send_c_store(dataset)
                status_code = int(getattr(status, "Status", 0xFFFF))
                artifact_result.status_code = status_code
                artifact_result.acknowledged = status_code in (
                    STATUS_SUCCESS,
                    STATUS_COERCION_WARNING,
                    STATUS_DATA_ELEMENT_WARNING,
                )
                if not artifact_result.acknowledged:
                    artifact_result.error_message = f"c-store-status:{status_code:#06x}"
            except Exception as exc:  # noqa: BLE001 — per-artifact errors survive the loop
                artifact_result.error_message = f"c-store-exception:{type(exc).__name__}"
                logger.warning(
                    "C-STORE send failed artifact=%s sop=%s err=%s",
                    artifact_type, sop_uid, type(exc).__name__,
                )
            result.artifacts.append(artifact_result)

        result.association_success = True
    finally:
        try:
            assoc.release()
        except Exception:  # noqa: BLE001 — release errors are advisory
            logger.debug("association release raised; best-effort ignored")

    return result


async def push_artifacts(
    destination: PACSDestination,
    artifacts: Iterable[tuple[str, Any]],
) -> PushResult:
    """Transactional C-STORE push of SEG + SR on one Association.

    ``artifacts`` is an iterable of ``(artifact_type, dataset)`` tuples
    in the order the caller wants them negotiated + sent. For a normal
    finalize that's ``[("seg", seg_ds), ("sr", sr_ds)]``.

    Returns a :class:`PushResult`; callers (FSM) should check
    :attr:`PushResult.all_acknowledged` before updating DB state.
    """
    pairs = list(artifacts)
    if not pairs:
        raise ValueError("push_artifacts called with zero artifacts")
    # pynetdicom is thread-safe but not async-native; run the blocking
    # Association on a worker thread so we don't tie up the event loop.
    return await asyncio.to_thread(_push_artifacts_sync, destination, pairs)


__all__ = [
    "PACSDestination",
    "ArtifactPushResult",
    "PushResult",
    "push_artifacts",
    "STATUS_SUCCESS",
    "STATUS_COERCION_WARNING",
    "STATUS_DATA_ELEMENT_WARNING",
]
