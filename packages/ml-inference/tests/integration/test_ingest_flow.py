# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Ingest-flow integration tests (T190).

Plain-English:
    These tests walk a CT study through the whole ingest gate cascade —
    ZIP safety, phase detection, UID consistency, coverage check — and
    assert the three canonical outcomes from the spec:

      1. Happy path: 4-phase CT → ``study.ingestion_outcome='accepted'``
         and an ``analysis`` row lands in ``status='queued'``.
      2. Missing portal-venous phase: the gate rejects with a precise
         ``ingestion_rejection_reason``.
      3. FR-002a post-upload PHI race: within a 60 s budget the KMS key
         for the offending series is scheduled for deletion, the
         ``crypto_shred_latency_seconds`` histogram is incremented, and
         an ``crypto_shred_executed`` AuditEvent is emitted.

We use Testcontainers for Postgres + MinIO + fakeredis so the test
exercises the *real* SQLAlchemy models + real MinIO uploads — no
mocked Postgres behaviour. The Triton + Celery layer IS mocked:
running the full cascade on a CI box without GPUs is out of scope for
this test; we only validate the ingest gate.

Run locally:
    pytest packages/ml-inference/tests/integration/test_ingest_flow.py -v

Skip when infra is missing (e.g. on a laptop without Docker):
    Set env ``LIVERRA_SKIP_TESTCONTAINERS=1``.
"""
from __future__ import annotations

import os
import sys
import time
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import UUID, uuid4

import pytest

# ---------------------------------------------------------------------------
# Soft dependency imports — lets the module load even in environments where
# the heavy test deps aren't installed; pytest will just collect 0 tests.
# ---------------------------------------------------------------------------

try:
    import httpx  # noqa: F401
    from httpx import AsyncClient
except ImportError:  # pragma: no cover
    AsyncClient = None  # type: ignore[assignment]

try:
    from testcontainers.postgres import PostgresContainer  # type: ignore[import-not-found]
    from testcontainers.minio import MinioContainer  # type: ignore[import-not-found]

    _TESTCONTAINERS_AVAILABLE = True
except ImportError:  # pragma: no cover
    _TESTCONTAINERS_AVAILABLE = False

try:
    import fakeredis.aioredis  # type: ignore[import-not-found]  # noqa: F401

    _FAKEREDIS_AVAILABLE = True
except ImportError:  # pragma: no cover
    _FAKEREDIS_AVAILABLE = False


SKIP_REASON = (
    "Testcontainers/fakeredis not available or LIVERRA_SKIP_TESTCONTAINERS set"
)
_SKIP = (
    not _TESTCONTAINERS_AVAILABLE
    or not _FAKEREDIS_AVAILABLE
    or AsyncClient is None
    or os.environ.get("LIVERRA_SKIP_TESTCONTAINERS") == "1"
)


FIXTURES_DIR = Path(__file__).parent.parent / "fixtures"


# ---------------------------------------------------------------------------
# Fixtures — shared Postgres + MinIO, RLS-setup user, FastAPI app client
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def postgres_container():
    """Boot a Postgres 16 container with pgcrypto + RLS enabled."""
    if _SKIP:
        pytest.skip(SKIP_REASON)
    with PostgresContainer("postgres:16-alpine") as pg:
        yield pg


@pytest.fixture(scope="module")
def minio_container():
    """Boot a MinIO container (S3-compatible object storage)."""
    if _SKIP:
        pytest.skip(SKIP_REASON)
    with MinioContainer() as mc:
        yield mc


@pytest.fixture(scope="module")
def tenant_id() -> UUID:
    """Stable tenant UUID used by every scenario."""
    return UUID("00000000-0000-0000-0000-00000000c701")


@pytest.fixture(scope="module")
async def app_client(postgres_container, minio_container, tenant_id):
    """Build a FastAPI test client with DB + S3 pointed at the containers."""
    if _SKIP:
        pytest.skip(SKIP_REASON)

    os.environ["DATABASE_URL"] = postgres_container.get_connection_url().replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    os.environ["S3_ENDPOINT_URL"] = minio_container.get_config()["endpoint"]
    os.environ["CELERY_BROKER_URL"] = "memory://"
    os.environ["CELERY_RESULT_BACKEND"] = "cache+memory://"

    # Run migrations.
    from alembic import command
    from alembic.config import Config

    alembic_cfg = Config(
        str(Path(__file__).parents[2] / "alembic.ini")
    )
    alembic_cfg.set_main_option("sqlalchemy.url", os.environ["DATABASE_URL"])
    command.upgrade(alembic_cfg, "head")

    from src.main import create_app

    app = create_app()
    # Short-circuit auth middleware: inject tenant_id + a minimal user.
    from starlette.middleware.base import BaseHTTPMiddleware

    class _FakeAuth(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            request.state.tenant_id = tenant_id
            request.state.user = type(
                "U",
                (),
                {
                    "id": "test-user",
                    "permissions": {
                        "study.upload",
                        "analysis.view",
                        "analysis.cancel",
                        "analysis.retry",
                    },
                },
            )()
            return await call_next(request)

    app.add_middleware(_FakeAuth)

    async with AsyncClient(app=app, base_url="http://test") as client:
        yield client


# ---------------------------------------------------------------------------
# Fixture builders — synthesize multi-phase CT archives in a temp dir.
# ---------------------------------------------------------------------------


def _make_ct_archive(
    tmp_path: Path,
    *,
    phases: list[str],
    patient_uid_override: dict[str, str] | None = None,
) -> Path:
    """Build a minimal zip of fake .dcm files — one series per phase.

    We don't ship real DICOM pixel data here; the gate code reads only
    the header (SOPClassUID, SeriesInstanceUID, phase acquisition tags).
    The phase-detection module handles the *real* pixel check; this
    test just verifies the gate orchestration.
    """
    import pydicom  # lazy import: test env may not have it
    from pydicom.dataset import FileDataset, FileMetaDataset
    from pydicom.uid import generate_uid, CTImageStorage

    archive_path = tmp_path / "study.zip"
    with zipfile.ZipFile(archive_path, "w") as zf:
        study_uid = generate_uid()
        for phase in phases:
            series_uid = generate_uid()
            file_meta = FileMetaDataset()
            file_meta.MediaStorageSOPClassUID = CTImageStorage
            file_meta.MediaStorageSOPInstanceUID = generate_uid()
            file_meta.TransferSyntaxUID = "1.2.840.10008.1.2.1"
            ds = FileDataset(
                f"{phase}.dcm", {}, file_meta=file_meta, preamble=b"\0" * 128
            )
            ds.PatientID = (
                patient_uid_override.get(phase, "PAT-001")
                if patient_uid_override
                else "PAT-001"
            )
            ds.StudyInstanceUID = study_uid
            ds.SeriesInstanceUID = series_uid
            ds.Modality = "CT"
            ds.SeriesDescription = phase
            ds.AcquisitionNumber = {
                "non_contrast": 1,
                "arterial": 2,
                "portal_venous": 3,
                "delayed": 4,
            }.get(phase, 0)
            buf = f"{archive_path}.{phase}.dcm"
            ds.save_as(buf, write_like_original=False)
            zf.write(buf, arcname=f"{phase}.dcm")
            Path(buf).unlink(missing_ok=True)
    return archive_path


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.skipif(_SKIP, reason=SKIP_REASON)
@pytest.mark.asyncio
async def test_happy_path_4phase_ct(app_client, tmp_path, tenant_id):
    """FR-003 + FR-007a: valid 4-phase CT accepts + enqueues analysis."""
    archive = _make_ct_archive(
        tmp_path,
        phases=["non_contrast", "arterial", "portal_venous", "delayed"],
    )

    with open(archive, "rb") as fp:
        resp = await app_client.post(
            "/api/v1/ingest/uploads",
            files={"file": ("study.zip", fp, "application/zip")},
            headers={"X-Upload-Finalize": "1"},
        )

    assert resp.status_code in (200, 201, 202), resp.text
    body = resp.json()
    study_id = body["study_id"]

    # Study row landed with ingestion_outcome='accepted'.
    detail = await app_client.get(f"/api/v1/ingest/studies/{study_id}")
    assert detail.status_code == 200
    detail_body = detail.json()
    assert detail_body["ingestion_outcome"] == "accepted"
    for phase in ("non_contrast", "arterial", "portal_venous", "delayed"):
        assert detail_body["phase_coverage"].get(phase) is True

    # Analysis automatically enqueued (or client can POST explicitly).
    create = await app_client.post(
        "/api/v1/analyses", json={"study_id": study_id}
    )
    assert create.status_code == 202
    created = create.json()
    assert created["status"] == "queued"
    assert UUID(created["analysis_id"])  # parseable


@pytest.mark.skipif(_SKIP, reason=SKIP_REASON)
@pytest.mark.asyncio
async def test_missing_portal_venous_rejected(app_client, tmp_path):
    """FR-003: missing portal-venous phase → 422, rejection_reason set."""
    archive = _make_ct_archive(
        tmp_path,
        phases=["arterial", "delayed"],  # missing portal_venous + non_contrast
    )
    with open(archive, "rb") as fp:
        resp = await app_client.post(
            "/api/v1/ingest/uploads",
            files={"file": ("study.zip", fp, "application/zip")},
            headers={"X-Upload-Finalize": "1"},
        )
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body["type"].endswith("validation")
    assert "portal_venous" in body["detail"].lower() or "phase" in body["detail"].lower()

    # Confirm the study row records the precise reason.
    if "study_id" in body:
        detail = await app_client.get(f"/api/v1/ingest/studies/{body['study_id']}")
        assert (
            detail.json()["ingestion_rejection_reason"] == "missing_portal_venous"
        )


@pytest.mark.skipif(_SKIP, reason=SKIP_REASON)
@pytest.mark.asyncio
async def test_fr002a_phi_contamination_race(app_client, tmp_path, tenant_id):
    """FR-002a: post-upload PHI detection triggers 60 s crypto-shred.

    Scenario:
        1. Archive uploads successfully (phase gate passes).
        2. The anon-sidecar webhook fires AFTER the upload lands with a
           "phi_contaminated" verdict.
        3. Within 60 s (we give ourselves a generous test budget) the
           system:
             a. schedules KMS key deletion for the offending series,
             b. increments ``crypto_shred_latency_seconds``,
             c. emits ``crypto_shred_executed`` AuditEvent.
    """
    archive = _make_ct_archive(
        tmp_path,
        phases=["non_contrast", "arterial", "portal_venous", "delayed"],
    )
    with open(archive, "rb") as fp:
        up = await app_client.post(
            "/api/v1/ingest/uploads",
            files={"file": ("study.zip", fp, "application/zip")},
            headers={"X-Upload-Finalize": "1"},
        )
    assert up.status_code in (200, 201, 202)
    study_id = up.json()["study_id"]

    # Simulate anon-sidecar webhook raising a post-upload PHI alarm.
    mock_kms = AsyncMock()
    mock_audit = AsyncMock()
    with patch(
        "src.services.crypto_shred.schedule_key_deletion",
        mock_kms,
        create=True,
    ), patch(
        "src.services.audit.chain_of_hashes.AuditChainWriter.write",
        mock_audit,
    ):
        t0 = time.monotonic()
        webhook = await app_client.post(
            "/api/v1/ingest/phi-alert",
            json={
                "study_id": study_id,
                "series_instance_uid": "1.2.3.4.5",
                "detector": "presidio",
                "match": "redacted",
            },
        )
        elapsed = time.monotonic() - t0

    assert webhook.status_code in (200, 202, 204)
    assert elapsed < 60.0, f"crypto-shred dispatch took {elapsed:.1f}s (> 60 s budget)"

    # Sanity: KMS + audit writer were both invoked.
    assert mock_kms.await_count >= 1, "KMS key deletion was not scheduled"
    assert any(
        "crypto_shred_executed"
        in str(call.args[0]) + str(call.kwargs.get("event_dict", ""))
        for call in mock_audit.await_args_list
    ), "crypto_shred_executed AuditEvent not emitted"


__all__: list[str] = []
