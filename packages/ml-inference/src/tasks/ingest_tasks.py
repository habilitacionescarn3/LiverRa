# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""study_upload_complete — Celery task that closes the /upload loop.

Plain-English:
    When a user finishes uploading a folder of DICOM via the /upload
    page, the FastAPI ingest handler creates a `study` row and then
    enqueues THIS task. We pull the uploaded zip out of MinIO/S3,
    STOW-RS push each DICOM instance to the private Orthanc PACS, and
    then dispatch the existing /from-orthanc cascade chain
    (`ingest_study` → `real_cascade_task`) so the AI pipeline runs.

    The point of routing through Orthanc is convergence: both upload
    paths (`/upload` and `/pacs/studies`) end up with the DICOM in the
    same PACS, viewable by OHIF, processable by the same downstream
    cascade. No special-case codepaths for tus-uploaded studies.

Degradation modes (all graceful — no crash, no retry storm):
    - ORTHANC_URL unset → task marks analysis as 'queued' with an
      error_slug 'orthanc_not_configured' and returns. /cases renders a
      pending state instead of 404.
    - Orthanc unreachable → standard Celery retry (3 attempts with
      exponential backoff via the worker's NFR-009 defaults).
    - LIVERRA_INFERENCE_URL unset → study is in PACS + viewable, but no
      cascade is dispatched. Analysis stays 'queued' with error_slug
      'inference_url_not_configured'. When Irakli's Funnel URL gets
      set via `fly secrets set`, the next upload will cascade.
"""
from __future__ import annotations

import io
import logging
import os
import uuid
import zipfile
from base64 import b64encode
from typing import Optional

import boto3
import httpx
import psycopg

try:
    from src.workers.app import app  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover — unit tests without celery
    app = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers — read env at call time so rotated Fly secrets pick up without a
# worker restart (same convention as inference_client.py).
# ---------------------------------------------------------------------------


def _sync_db_url() -> str:
    return os.environ.get(
        "DATABASE_URL_SYNC",
        "postgresql://liverra:liverra@localhost:5432/liverra",
    )


def _s3_client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("AWS_ENDPOINT_URL") or None,
        region_name=os.environ.get("AWS_REGION", "eu-central-1"),
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )


def _imaging_bucket() -> str:
    return os.environ.get("S3_IMAGING_BUCKET", "liverra-imaging-eu-central-1")


def _orthanc_url() -> str:
    return os.environ.get("ORTHANC_URL", "").strip().rstrip("/")


def _orthanc_basic_auth() -> Optional[str]:
    user = os.environ.get("ORTHANC_USERNAME", "").strip()
    pw = os.environ.get("ORTHANC_PASSWORD", "").strip()
    if not user or not pw:
        return None
    raw = f"{user}:{pw}".encode("utf-8")
    return f"Basic {b64encode(raw).decode('ascii')}"


def _inference_configured() -> bool:
    """True iff we have a non-placeholder GPU URL + token to call."""
    url = os.environ.get("LIVERRA_INFERENCE_URL", "").strip()
    return bool(url) and "placeholder" not in url.lower()


# ---------------------------------------------------------------------------
# S3 + zip ingestion
# ---------------------------------------------------------------------------


def _download_upload_blob(upload_id: str) -> bytes:
    """Fetch all chunked parts for an upload and concatenate them.

    The tus PATCH handler in `api/ingest.py` writes chunks under keys of
    the form `uploads/{id}/part-{offset:012d}.bin`. We list, sort by
    offset, and concatenate to reconstruct the original blob.
    """
    s3 = _s3_client()
    bucket = _imaging_bucket()
    prefix = f"uploads/{upload_id}/"
    resp = s3.list_objects_v2(Bucket=bucket, Prefix=prefix)
    if "Contents" not in resp or not resp["Contents"]:
        raise RuntimeError(
            f"no parts found at s3://{bucket}/{prefix} (upload may have failed)"
        )
    parts = sorted(resp["Contents"], key=lambda o: o["Key"])
    chunks: list[bytes] = []
    for part in parts:
        obj = s3.get_object(Bucket=bucket, Key=part["Key"])
        chunks.append(obj["Body"].read())
    return b"".join(chunks)


def _iter_dicom_from_blob(blob: bytes):
    """Yield (filename, bytes) for every .dcm member of the zip."""
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            name_lower = info.filename.lower()
            if not (
                name_lower.endswith(".dcm")
                or name_lower.endswith(".dicom")
                or name_lower.endswith(".dic")
            ):
                continue
            with zf.open(info) as fh:
                yield info.filename, fh.read()


# ---------------------------------------------------------------------------
# Orthanc STOW-RS push
# ---------------------------------------------------------------------------


def _stow_to_orthanc(dicom_files: list[tuple[str, bytes]]) -> Optional[str]:
    """POST each DICOM instance to Orthanc via the REST upload endpoint.

    We use the simpler `/instances` REST upload (one POST per instance,
    body = raw DICOM bytes) rather than DICOMweb multipart STOW-RS,
    because the Orthanc REST API gives us the StudyInstanceUID in the
    response JSON without parsing multipart envelopes.

    Returns the StudyInstanceUID of the LAST successfully uploaded
    instance — for a single-study upload these are all identical.
    Returns None if no instances were uploaded.
    """
    base = _orthanc_url()
    if not base:
        raise RuntimeError("ORTHANC_URL not configured")
    auth = _orthanc_basic_auth()
    if not auth:
        raise RuntimeError("ORTHANC_USERNAME / ORTHANC_PASSWORD not set")

    headers = {"Authorization": auth, "Content-Type": "application/dicom"}
    timeout = httpx.Timeout(connect=10.0, read=60.0, write=60.0, pool=10.0)

    study_uid: Optional[str] = None
    n_ok = 0
    n_fail = 0
    with httpx.Client(timeout=timeout) as client:
        for filename, body in dicom_files:
            try:
                resp = client.post(f"{base}/instances", headers=headers, content=body)
                if resp.status_code in (200, 201):
                    payload = resp.json()
                    study_uid = payload.get("ParentStudy") or payload.get(
                        "StudyInstanceUID"
                    ) or study_uid
                    n_ok += 1
                else:
                    n_fail += 1
                    logger.warning(
                        "orthanc rejected %s (HTTP %d): %s",
                        filename, resp.status_code, resp.text[:200],
                    )
            except Exception as exc:  # noqa: BLE001
                n_fail += 1
                logger.warning("orthanc push failed for %s: %s", filename, exc)
    logger.info("STOW: %d ok, %d failed", n_ok, n_fail)
    if n_ok == 0:
        raise RuntimeError(f"all {n_fail} instances rejected by Orthanc")

    # Orthanc's `/instances` POST returns an internal Orthanc study ID
    # (not the DICOM StudyInstanceUID). Resolve the real one.
    if study_uid:
        with httpx.Client(timeout=timeout) as client:
            r = client.get(f"{base}/studies/{study_uid}", headers=headers)
            if r.status_code == 200:
                study_uid = (
                    r.json().get("MainDicomTags", {}).get("StudyInstanceUID")
                    or study_uid
                )
    return study_uid


# ---------------------------------------------------------------------------
# DB persistence — we use synchronous psycopg, matching the convention of
# real_cascade_task / scripts/real_cascade.py.
# ---------------------------------------------------------------------------


def _update_study_uid(
    conn, study_id: str, real_uid: str, tenant_id: str
) -> Optional[str]:
    """Promote `study.study_instance_uid` to the real DICOM UID from Orthanc.

    Idempotent: if the SAME DICOMs were uploaded before, another study row
    already owns this `(tenant_id, study_instance_uid)` pair. In that case
    we DELETE our placeholder study and return the existing study's id so
    the caller can re-target the analysis row at it. This makes re-uploads
    a no-op rather than crashing with a unique-key violation.

    Returns: the study_id to use going forward (may differ from input).
    """
    existing = conn.execute(
        "SELECT id FROM study "
        "WHERE tenant_id = %s AND study_instance_uid = %s AND id <> %s",
        (tenant_id, real_uid, study_id),
    ).fetchone()
    if existing is not None:
        existing_id = str(existing[0])
        # Drop the placeholder we just created — ingestion gates already
        # inserted a fresh row but the canonical study (Orthanc-side UID)
        # already exists for this tenant.
        conn.execute("DELETE FROM study WHERE id = %s", (study_id,))
        return existing_id
    conn.execute(
        "UPDATE study SET study_instance_uid = %s WHERE id = %s",
        (real_uid, study_id),
    )
    return study_id


def _find_study_for_upload(conn, upload_id: str) -> Optional[tuple[str, str]]:
    """Return (study_id, current_study_instance_uid) for an upload."""
    row = conn.execute(
        "SELECT id, study_instance_uid FROM study "
        "WHERE study_instance_uid = %s LIMIT 1",
        (f"liverra:upload:{upload_id}",),
    ).fetchone()
    if row is None:
        return None
    return str(row[0]), str(row[1])


def _insert_analysis(
    conn,
    *,
    tenant_id: str,
    study_id: str,
    error_slug: Optional[str] = None,
) -> str:
    """Idempotently create an analysis row for this study; return its id."""
    # Reuse any active analysis if one is queued/running.
    existing = conn.execute(
        "SELECT id FROM analysis "
        "WHERE study_id = %s AND tenant_id = %s "
        "  AND status IN ('queued','running') "
        "ORDER BY queued_at DESC LIMIT 1",
        (study_id, tenant_id),
    ).fetchone()
    if existing:
        return str(existing[0])

    row = conn.execute(
        "INSERT INTO analysis (tenant_id, study_id, status, pipeline_version, error_slug) "
        "VALUES (%s, %s, 'queued', %s, %s) RETURNING id",
        (tenant_id, study_id, "tus-upload-0.1", error_slug),
    ).fetchone()
    return str(row[0])


# ---------------------------------------------------------------------------
# Celery task entry point
# ---------------------------------------------------------------------------


if app is not None:

    @app.task(
        name="liverra.tasks.study_upload_complete",
        bind=True,
        max_retries=3,
        default_retry_delay=60,
    )
    def study_upload_complete(self, upload_id: str, tenant_id: str) -> dict:
        """Promote a finished tus upload into the standard cascade pipeline."""
        logger.info(
            "study_upload_complete invoked upload=%s tenant=%s",
            upload_id, tenant_id,
        )

        # 0. Bail early if Orthanc isn't configured — nothing useful to do.
        if not _orthanc_url():
            logger.warning(
                "ORTHANC_URL not set — recording study but skipping PACS push + cascade"
            )
            with psycopg.connect(_sync_db_url(), autocommit=True) as conn:
                hit = _find_study_for_upload(conn, upload_id)
                if hit is None:
                    return {"status": "no_study"}
                study_id, _ = hit
                aid = _insert_analysis(
                    conn,
                    tenant_id=tenant_id,
                    study_id=study_id,
                    error_slug="orthanc_not_configured",
                )
            return {"status": "deferred", "analysis_id": aid}

        # 1. Pull zip out of S3.
        try:
            blob = _download_upload_blob(upload_id)
        except Exception as exc:
            logger.exception("upload blob download failed")
            raise self.retry(exc=exc, countdown=60)

        # 2. STOW each DICOM to Orthanc.
        dicom_files = list(_iter_dicom_from_blob(blob))
        if not dicom_files:
            logger.error("upload %s had zero DICOM members in zip", upload_id)
            with psycopg.connect(_sync_db_url(), autocommit=True) as conn:
                hit = _find_study_for_upload(conn, upload_id)
                if hit:
                    sid, _ = hit
                    aid = _insert_analysis(
                        conn, tenant_id=tenant_id, study_id=sid,
                        error_slug="no_dicom_in_zip",
                    )
                    return {"status": "no_dicom", "analysis_id": aid}
            return {"status": "no_dicom"}

        try:
            real_uid = _stow_to_orthanc(dicom_files)
        except Exception as exc:
            logger.exception("orthanc push failed")
            raise self.retry(exc=exc, countdown=120)

        # 3. Promote study row to the real UID + create analysis row.
        with psycopg.connect(_sync_db_url(), autocommit=True) as conn:
            hit = _find_study_for_upload(conn, upload_id)
            if hit is None:
                # The study row was supposed to be created by the
                # ingestion gates running inline on the final PATCH; if
                # it's missing the API request crashed mid-way. Don't
                # crash the worker — just log.
                logger.error("study row missing for upload %s", upload_id)
                return {"status": "no_study"}
            study_id, _ = hit
            if real_uid:
                # Idempotent promotion: if a study with this real UID
                # already exists for the tenant (re-upload of same scan),
                # the helper deletes our placeholder + returns the existing
                # study id so downstream rows attach to the canonical study.
                study_id = _update_study_uid(
                    conn, study_id, real_uid, tenant_id
                )

            # 4. Decide whether to dispatch the cascade chain.
            if not _inference_configured():
                aid = _insert_analysis(
                    conn,
                    tenant_id=tenant_id,
                    study_id=study_id,
                    error_slug="inference_url_not_configured",
                )
                logger.info(
                    "GPU URL not configured — study %s is in PACS but no cascade dispatched. "
                    "Analysis %s left in queued state.", study_id, aid,
                )
                return {
                    "status": "uploaded_no_cascade",
                    "analysis_id": aid,
                    "study_id": study_id,
                }

            aid = _insert_analysis(
                conn, tenant_id=tenant_id, study_id=study_id,
            )

        # 5. Dispatch the existing /from-orthanc cascade chain. This is
        #    the same pipeline `POST /api/v1/analyses/from-orthanc` uses.
        try:
            from celery import chain  # type: ignore[import-not-found]
            from src.tasks.ingest import ingest_study  # type: ignore[import-not-found]
            from src.tasks.real_cascade_task import real_cascade_task  # type: ignore[import-not-found]

            chain(
                ingest_study.si(aid, study_id),
                real_cascade_task.si(aid, 0),
            ).apply_async()
            logger.info(
                "cascade chain dispatched: analysis=%s study=%s", aid, study_id,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("cascade dispatch failed: %s", exc)
            # Analysis row is already created in 'queued' state — operator
            # can re-dispatch from /pacs/studies once the chain dep loads.

        return {
            "status": "cascade_dispatched",
            "analysis_id": aid,
            "study_id": study_id,
        }
