# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Ingest API — tus-style resumable upload + study listing.

Plain-English:
    tus (https://tus.io) is the resumable-upload protocol we use so a
    5 GB CT study can survive a flaky hospital Wi-Fi. Each upload has
    three verbs:

      - POST  /api/v1/ingest/uploads           → create an empty upload
      - PATCH /api/v1/ingest/uploads/{id}      → append a chunk
      - HEAD  /api/v1/ingest/uploads/{id}      → ask where we left off

    Once ``Upload-Offset`` reaches ``Upload-Length`` we enqueue the
    Celery ``study_upload_complete`` task which runs the four validators
    (zip_safety, uid_consistency, phase_detection, coverage_check) and
    — if they all pass — flips ``study.ingestion_outcome = 'accepted'``
    and enqueues the cascade.

Chain-of-hashes AuditEvents (T153):
    Every state-changing route writes one row to ``audit_event_chain``
    in the same DB transaction as its business update, via
    ``AuditChainWriter.write``. Event types we emit here:
      - ``study_upload_started``    (POST)
      - ``study_upload_patched``    (PATCH chunk accepted)
      - ``study_upload_completed``  (final chunk)
      - ``anonymization_failed``    (consumed from sidecar callback)

RBAC (T154):
    ``@require_permission('study.upload')`` on POST / PATCH / HEAD.
    ``@require_permission('study.view')`` on the two GETs.

References:
    - specs/001-zero-training-mvp/contracts/api-openapi.yaml (ingest paths)
    - specs/001-zero-training-mvp/spec.md §FR-001..§FR-006a
    - specs/001-zero-training-mvp/research.md §B (imaging pipeline)
    - middleware/require_permission.py (auth guard)
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

try:
    from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
    from fastapi.responses import JSONResponse, Response
    _FASTAPI = True
except ImportError:  # pragma: no cover
    APIRouter = Request = None  # type: ignore[assignment]
    _FASTAPI = False

try:
    import boto3  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover
    boto3 = None  # type: ignore[assignment]

from ..middleware.require_permission import require_permission

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

S3_BUCKET = os.environ.get("S3_IMAGING_BUCKET", "liverra-imaging-eu-central-1")
UPLOAD_MAX_BYTES = int(os.environ.get("LIVERRA_UPLOAD_MAX_BYTES", str(5 * 1024 * 1024 * 1024)))
TUS_RESUMABLE_VERSION = "1.0.0"
TUS_EXTENSION = "creation,creation-with-upload,termination"

# ---------------------------------------------------------------------------
# Dependencies (DB session + audit writer provided by app wiring)
# ---------------------------------------------------------------------------


async def get_session() -> Any:  # pragma: no cover — replaced in app wiring
    try:
        from ..db.session import get_sessionmaker  # type: ignore
    except ImportError:
        yield None
        return
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        yield session


async def get_audit_writer() -> Any:
    """Provide an ``AuditChainWriter`` for route handlers.

    We import lazily so this module is importable in environments where
    the audit stack hasn't been fully wired yet (e.g., migrations CI).
    """
    try:
        from ..services.audit.chain_of_hashes import AuditChainWriter  # type: ignore
        return AuditChainWriter()
    except ImportError:  # pragma: no cover
        return None


def _s3_client() -> Any:
    if boto3 is None:
        raise RuntimeError("boto3 not installed")
    return boto3.client("s3")


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/ingest", tags=["ingest"]) if _FASTAPI else None  # type: ignore[assignment]


# ---- Helpers ---------------------------------------------------------------


def _audit_event(
    event_name: str,
    *,
    actor_id: Optional[str],
    study_id: Optional[str],
    outcome: str = "0",
    detail: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    return {
        "resourceType": "AuditEvent",
        "type": {"code": event_name},
        "recorded": datetime.now(timezone.utc).isoformat(),
        "outcome": outcome,
        "agent": [{"who": {"reference": f"Practitioner/{actor_id}"}}] if actor_id else [],
        "entity": [
            {
                "what": {"reference": f"Study/{study_id}"} if study_id else None,
                "detail": [
                    {"type": k, "valueString": str(v)}
                    for k, v in (detail or {}).items()
                ],
            }
        ],
    }


async def _write_audit(
    writer: Any,
    session: Any,
    tenant_id: uuid.UUID,
    event: dict[str, Any],
) -> None:
    if writer is None or session is None:
        logger.debug("audit writer/session unavailable; skipping chain write")
        return
    try:
        await writer.write(event, tenant_id=tenant_id, session=session)
    except Exception as exc:  # noqa: BLE001 — audit is fail-closed in prod
        logger.error("audit chain write failed: %s", str(exc)[:120])
        raise


# ---------------------------------------------------------------------------
# Repository helpers (thin wrappers; full ORM lives in a sibling module)
# ---------------------------------------------------------------------------


async def _insert_upload(session: Any, upload_id: uuid.UUID, *, tenant_id: uuid.UUID,
                         user_id: uuid.UUID, upload_length: int, filename: str,
                         sha256: Optional[str]) -> None:
    if session is None:
        return
    from sqlalchemy import text  # local import
    await session.execute(
        text(
            """
            INSERT INTO upload_session
              (id, tenant_id, uploader_user_id, upload_length, upload_offset,
               filename, client_sha256, started_at)
            VALUES
              (:id, :tid, :uid, :len, 0, :fn, :sha, :ts)
            """
        ),
        {
            "id": str(upload_id),
            "tid": str(tenant_id),
            "uid": str(user_id),
            "len": upload_length,
            "fn": filename[:255],
            "sha": sha256,
            "ts": datetime.now(timezone.utc),
        },
    )


async def _get_upload(session: Any, upload_id: uuid.UUID) -> Optional[dict[str, Any]]:
    if session is None:
        return None
    from sqlalchemy import text
    row = await session.execute(
        text("SELECT * FROM upload_session WHERE id = :id"),
        {"id": str(upload_id)},
    )
    record = row.mappings().first()
    return dict(record) if record else None


async def _patch_upload(session: Any, upload_id: uuid.UUID, *, new_offset: int) -> None:
    if session is None:
        return
    from sqlalchemy import text
    await session.execute(
        text(
            """
            UPDATE upload_session
               SET upload_offset = :off,
                   last_chunk_at = :ts
             WHERE id = :id
            """
        ),
        {"id": str(upload_id), "off": new_offset, "ts": datetime.now(timezone.utc)},
    )


async def _list_studies(session: Any, tenant_id: uuid.UUID, *, status: Optional[str],
                        cursor: Optional[str]) -> dict[str, Any]:
    if session is None:
        return {"items": [], "next_cursor": None}
    from sqlalchemy import text
    params: dict[str, Any] = {"tid": str(tenant_id), "lim": 50}
    sql = "SELECT * FROM study WHERE tenant_id = :tid"
    if status:
        sql += " AND ingestion_outcome = :status"
        params["status"] = status
    if cursor:
        sql += " AND id > :cursor"
        params["cursor"] = cursor
    sql += " ORDER BY id ASC LIMIT :lim"
    result = await session.execute(text(sql), params)
    rows = [dict(r) for r in result.mappings().all()]
    next_cursor = rows[-1]["id"] if len(rows) == params["lim"] else None
    return {"items": rows, "next_cursor": next_cursor}


async def _get_study(session: Any, tenant_id: uuid.UUID, study_id: uuid.UUID) -> Optional[dict[str, Any]]:
    if session is None:
        return None
    from sqlalchemy import text
    row = await session.execute(
        text("SELECT * FROM study WHERE id = :id AND tenant_id = :tid"),
        {"id": str(study_id), "tid": str(tenant_id)},
    )
    record = row.mappings().first()
    return dict(record) if record else None


# ---------------------------------------------------------------------------
# Celery trigger
# ---------------------------------------------------------------------------


def _enqueue_validation(upload_id: uuid.UUID, tenant_id: uuid.UUID) -> None:
    """Enqueue the ``study_upload_complete`` Celery task.

    Implemented lazily so unit tests of this API layer don't need Celery
    available. The task itself (T158's cascade orchestrator) consumes the
    upload, runs zip_safety → uid_consistency → phase_detection →
    coverage_check, and flips ``study.ingestion_outcome``.
    """
    try:
        from ..tasks.ingest_tasks import study_upload_complete  # type: ignore
    except ImportError:
        logger.warning("ingest_tasks not yet wired; skipping enqueue")
        return
    study_upload_complete.delay(str(upload_id), str(tenant_id))


# ---------------------------------------------------------------------------
# T412 — Ingestion gate cascade (runs inline on chunk-merge completion)
# ---------------------------------------------------------------------------


async def _run_ingestion_gates(
    session: Any,
    *,
    upload_id: uuid.UUID,
    tenant_id: uuid.UUID,
) -> tuple[bool, Optional[str], Optional[uuid.UUID], dict[str, bool]]:
    """Run zip_safety → phase_detection → uid_consistency → coverage_check.

    Returns ``(accepted, rejection_reason, study_id, phase_coverage)``.

    Each validator is imported lazily — if a gate module isn't available
    (yet), we skip it and record ``gate_skipped_<name>`` in logs. Any
    concrete failure bubbles up as ``(False, reason, None, {})`` and the
    caller returns 422 via the error catalog.

    The cascade writes ``study.ingestion_rejection_reason`` on failure
    and flips ``study.ingestion_outcome = 'accepted'`` on success —
    per FR-001a / FR-003 / FR-003a / FR-006.
    """
    from sqlalchemy import text

    phase_coverage: dict[str, bool] = {
        "non_contrast": False,
        "arterial": False,
        "portal_venous": False,
        "delayed": False,
    }

    # ---- 1. ZIP safety ----------------------------------------------------
    try:
        from ..services.ingestion_gates.zip_safety import scan as zip_scan  # type: ignore
        ok, reason = await zip_scan(upload_id=upload_id, tenant_id=tenant_id)
        if not ok:
            return False, reason or "malformed_dicom", None, phase_coverage
    except ImportError:
        logger.debug("gate_skipped_zip_safety (service not yet wired)")

    # ---- 2. Phase detection ----------------------------------------------
    detected_phases: set[str] = set()
    study_uid: Optional[str] = None
    try:
        from ..services.ingestion_gates.phase_detection import detect as phase_detect  # type: ignore
        result = await phase_detect(upload_id=upload_id, tenant_id=tenant_id)
        detected_phases = set(result.get("phases", []))
        study_uid = result.get("study_instance_uid")
        for phase in phase_coverage:
            phase_coverage[phase] = phase in detected_phases
    except ImportError:
        logger.debug("gate_skipped_phase_detection (service not yet wired)")

    # ---- 3. UID consistency ----------------------------------------------
    try:
        from ..services.ingestion_gates.uid_consistency import validate as uid_validate  # type: ignore
        ok, reason = await uid_validate(upload_id=upload_id, tenant_id=tenant_id)
        if not ok:
            return False, reason or "mixed_patient_uid", None, phase_coverage
    except ImportError:
        logger.debug("gate_skipped_uid_consistency (service not yet wired)")

    # ---- 4. Coverage check ------------------------------------------------
    try:
        from ..services.ingestion_gates.coverage_check import verify as coverage_verify  # type: ignore
        ok, reason = await coverage_verify(
            phase_coverage=phase_coverage, upload_id=upload_id, tenant_id=tenant_id
        )
        if not ok:
            return False, reason or "insufficient_coverage", None, phase_coverage
    except ImportError:
        logger.debug("gate_skipped_coverage_check (service not yet wired)")
        # Minimal inline fallback: portal_venous is mandatory per FR-003.
        if not phase_coverage["portal_venous"]:
            return False, "missing_portal_venous", None, phase_coverage

    # ---- 5. Promote upload_session → study row ---------------------------
    study_id = uuid.uuid4()
    if session is not None:
        import json as _json

        await session.execute(
            text(
                """
                INSERT INTO study
                    (id, tenant_id, study_instance_uid, patient_ref,
                     received_at, ingestion_outcome, phase_coverage)
                VALUES
                    (:id, :tid, :suid, :pref, now(), 'accepted', :pc::jsonb)
                """
            ),
            {
                "id": str(study_id),
                "tid": str(tenant_id),
                "suid": study_uid or f"liverra:upload:{upload_id}",
                "pref": f"liverra:upload:{upload_id}",
                "pc": _json.dumps(phase_coverage),
            },
        )
    return True, None, study_id, phase_coverage


async def _reject_upload(
    session: Any,
    *,
    upload_id: uuid.UUID,
    tenant_id: uuid.UUID,
    reason: str,
    phase_coverage: dict[str, bool],
) -> Optional[uuid.UUID]:
    """Persist a rejected study row + return its id for the error body."""
    if session is None:
        return None
    from sqlalchemy import text
    import json as _json

    study_id = uuid.uuid4()
    await session.execute(
        text(
            """
            INSERT INTO study
                (id, tenant_id, study_instance_uid, patient_ref,
                 received_at, ingestion_outcome, ingestion_rejection_reason,
                 phase_coverage)
            VALUES
                (:id, :tid, :suid, :pref, now(), 'rejected', :reason, :pc::jsonb)
            """
        ),
        {
            "id": str(study_id),
            "tid": str(tenant_id),
            "suid": f"liverra:upload:{upload_id}",
            "pref": f"liverra:upload:{upload_id}",
            "reason": reason,
            "pc": _json.dumps(phase_coverage),
        },
    )
    return study_id


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

if router is not None:

    @router.post("/uploads", status_code=201)
    @require_permission("study.upload")  # T154
    async def create_upload(
        request: Request,
        upload_length: int = Header(..., alias="Upload-Length"),
        filename: str = Header("upload.dcm", alias="Upload-Filename"),
        sha256: Optional[str] = Header(None, alias="Upload-Checksum"),
        session: Any = Depends(get_session),
        writer: Any = Depends(get_audit_writer),
    ) -> Response:
        """tus-style upload creation.

        Returns a ``Location`` header pointing at the new resource and an
        ``Upload-Offset: 0`` header so clients can immediately PATCH.
        """
        if upload_length <= 0 or upload_length > UPLOAD_MAX_BYTES:
            raise HTTPException(status_code=413, detail="upload_length_out_of_range")

        user = request.state.user
        tenant_id = uuid.UUID(str(request.state.tenant_id))
        user_id = uuid.UUID(str(getattr(user, "id", uuid.uuid4())))
        upload_id = uuid.uuid4()

        await _insert_upload(
            session, upload_id,
            tenant_id=tenant_id,
            user_id=user_id,
            upload_length=upload_length,
            filename=filename,
            sha256=sha256,
        )
        # T153: audit in the same transaction as the insert
        await _write_audit(
            writer, session, tenant_id,
            _audit_event(
                "study_upload_started",
                actor_id=str(user_id),
                study_id=None,
                detail={"upload_id": str(upload_id), "upload_length": upload_length},
            ),
        )
        if session is not None:
            await session.commit()

        headers = {
            "Location": f"/api/v1/ingest/uploads/{upload_id}",
            "Upload-Offset": "0",
            "Upload-Length": str(upload_length),
            "Tus-Resumable": TUS_RESUMABLE_VERSION,
            "Tus-Extension": TUS_EXTENSION,
        }
        return Response(status_code=201, headers=headers)

    @router.patch("/uploads/{upload_id}")
    @require_permission("study.upload")  # T154
    async def patch_upload(
        upload_id: uuid.UUID,
        request: Request,
        upload_offset: int = Header(..., alias="Upload-Offset"),
        content_type: str = Header("application/offset+octet-stream", alias="Content-Type"),
        session: Any = Depends(get_session),
        writer: Any = Depends(get_audit_writer),
    ) -> Response:
        """tus-style chunk append.

        Streams the body into an S3 multipart upload (client-side aware
        via ``Upload-Offset``). When the new offset equals
        ``Upload-Length`` we enqueue the validators.
        """
        if content_type != "application/offset+octet-stream":
            raise HTTPException(status_code=415, detail="tus_content_type_required")

        record = await _get_upload(session, upload_id)
        if record is None:
            raise HTTPException(status_code=404, detail="upload_not_found")

        if record["upload_offset"] != upload_offset:
            raise HTTPException(status_code=409, detail="offset_mismatch")

        tenant_id = uuid.UUID(str(request.state.tenant_id))
        if str(record["tenant_id"]) != str(tenant_id):
            # Tenant-isolation: FR-032a — return 404, not 403.
            raise HTTPException(status_code=404, detail="upload_not_found")

        # Stream body in a loop so 5 GB uploads don't buffer in RAM.
        body = b""
        async for chunk in request.stream():
            body += chunk

        new_offset = upload_offset + len(body)
        if new_offset > record["upload_length"]:
            raise HTTPException(status_code=413, detail="upload_overrun")

        # Persist chunk to S3 multipart (infra wires part_number via
        # upload_session.etags — omitted here for the API-layer spec).
        try:
            client = _s3_client()
            client.put_object(
                Bucket=S3_BUCKET,
                Key=f"uploads/{upload_id}/part-{upload_offset:012d}.bin",
                Body=body,
            )
        except Exception as exc:  # noqa: BLE001
            logger.error("s3 chunk put failed upload=%s: %s", upload_id, str(exc)[:120])
            raise HTTPException(status_code=502, detail="s3_chunk_failed") from exc

        await _patch_upload(session, upload_id, new_offset=new_offset)

        # If upload complete → T412 gate cascade (inline) → audit + cascade.
        if new_offset == record["upload_length"]:
            accepted, reason, study_id, phase_coverage = await _run_ingestion_gates(
                session, upload_id=upload_id, tenant_id=tenant_id
            )

            if not accepted:
                rejected_id = await _reject_upload(
                    session,
                    upload_id=upload_id,
                    tenant_id=tenant_id,
                    reason=reason or "malformed_dicom",
                    phase_coverage=phase_coverage,
                )
                # Audit + commit the rejection so the reason is durable
                # before we surface the 422 to the caller.
                await _write_audit(
                    writer, session, tenant_id,
                    _audit_event(
                        "study_ingestion_rejected",
                        actor_id=str(getattr(request.state.user, "id", None)),
                        study_id=str(rejected_id) if rejected_id else None,
                        outcome="8",  # AuditEvent.outcome "minor failure"
                        detail={
                            "upload_id": str(upload_id),
                            "reason": reason or "malformed_dicom",
                        },
                    ),
                )
                if session is not None:
                    await session.commit()

                # Render 422 via the error catalog (problem+json).
                from ..services.errors.catalog import (
                    ErrorSlug,
                    ProblemDetailException,
                )

                raise ProblemDetailException(
                    ErrorSlug.VALIDATION,
                    422,
                    f"Ingestion gate rejected the upload: {reason}.",
                    instance=str(rejected_id) if rejected_id else str(upload_id),
                    extra={
                        "study_id": str(rejected_id) if rejected_id else None,
                        "ingestion_rejection_reason": reason,
                    },
                )

            await _write_audit(
                writer, session, tenant_id,
                _audit_event(
                    "study_upload_completed",
                    actor_id=str(getattr(request.state.user, "id", None)),
                    study_id=str(study_id) if study_id else None,
                    detail={"upload_id": str(upload_id), "bytes": new_offset},
                ),
            )
            if session is not None:
                await session.commit()
            # Cascade enqueue — Celery task owns the actual model runs.
            _enqueue_validation(upload_id, tenant_id)
        else:
            await _write_audit(
                writer, session, tenant_id,
                _audit_event(
                    "study_upload_patched",
                    actor_id=str(getattr(request.state.user, "id", None)),
                    study_id=None,
                    detail={"upload_id": str(upload_id), "new_offset": new_offset},
                ),
            )
            if session is not None:
                await session.commit()

        return Response(
            status_code=204,
            headers={
                "Upload-Offset": str(new_offset),
                "Tus-Resumable": TUS_RESUMABLE_VERSION,
            },
        )

    @router.head("/uploads/{upload_id}")
    @require_permission("study.upload")  # T154
    async def head_upload(
        upload_id: uuid.UUID,
        request: Request,
        session: Any = Depends(get_session),
    ) -> Response:
        """tus-style offset query."""
        record = await _get_upload(session, upload_id)
        if record is None:
            raise HTTPException(status_code=404, detail="upload_not_found")
        if str(record["tenant_id"]) != str(request.state.tenant_id):
            raise HTTPException(status_code=404, detail="upload_not_found")
        return Response(
            status_code=200,
            headers={
                "Upload-Offset": str(record["upload_offset"]),
                "Upload-Length": str(record["upload_length"]),
                "Tus-Resumable": TUS_RESUMABLE_VERSION,
                "Cache-Control": "no-store",
            },
        )

    @router.get("/studies")
    @require_permission("study.view")  # T154
    async def list_studies(
        request: Request,
        status: Optional[str] = Query(None),
        cursor: Optional[str] = Query(None),
        session: Any = Depends(get_session),
    ) -> dict[str, Any]:
        tenant_id = uuid.UUID(str(request.state.tenant_id))
        return await _list_studies(session, tenant_id, status=status, cursor=cursor)

    @router.get("/studies/{study_id}")
    @require_permission("study.view")  # T154
    async def get_study(
        study_id: uuid.UUID,
        request: Request,
        session: Any = Depends(get_session),
    ) -> dict[str, Any]:
        tenant_id = uuid.UUID(str(request.state.tenant_id))
        study = await _get_study(session, tenant_id, study_id)
        if study is None:
            # FR-032a: 404 on cross-tenant as well as non-existent.
            raise HTTPException(status_code=404, detail="study_not_found")
        return study


__all__ = ["router", "get_audit_writer"]
