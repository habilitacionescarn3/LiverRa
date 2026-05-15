# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""LiverRa local-dev anonymization sidecar.

Tiny FastAPI service that the cascade's anonymization stage calls
(see `src/tasks/anonymization.py`). Implements the contract:

    POST /anonymize {"study_id": "<uuid>", "analysis_id": "<uuid>"}
    -> {"status": "done", "output_uri": "orthanc://anonymized/<id>"}

Implementation reuses Orthanc's built-in DICOM anonymizer at
``POST /studies/{id}/anonymize``, which strips the standard PS3.15-E
basic profile + LiverRa custom tags. This is sufficient for *local
development testing* — for clinical pilots and production, replace
with CTP (MIRC) or a Presidio + Tesseract OCR sidecar per
`docs/research/07-technical-architecture.md`.

WHY a separate service instead of inlining in the Celery worker:
the production deployment uses CTP/MIRC which is a heavyweight Java
process. Keeping the cascade ↔ anonymizer boundary as HTTP means the
real CTP container can drop in by changing one env var.
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx
import psycopg
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logger = logging.getLogger("liverra.anon_sidecar")
logging.basicConfig(level=logging.INFO)

ORTHANC_URL = os.environ.get("ORTHANC_URL", "http://localhost:8042")
ORTHANC_USER = os.environ.get("ORTHANC_USERNAME", "orthanc")
ORTHANC_PASSWORD = os.environ.get("ORTHANC_PASSWORD", "orthanc")
DATABASE_URL = os.environ.get(
    "DATABASE_URL_SYNC",
    "postgresql://liverra:liverra@localhost:5432/liverra",
)


class AnonymizeRequest(BaseModel):
    study_id: str
    analysis_id: str


class AnonymizeResponse(BaseModel):
    status: str
    output_uri: str


app = FastAPI(title="LiverRa anon-sidecar (dev)", version="0.1.0")


def _resolve_study_instance_uid(study_id: str) -> str | None:
    """Look up the DICOM StudyInstanceUID for a Postgres study row."""
    try:
        with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
            row = conn.execute(
                "SELECT study_instance_uid FROM study WHERE id = %s",
                (study_id,),
            ).fetchone()
            return row[0] if row else None
    except Exception as exc:  # noqa: BLE001
        logger.warning("DB lookup for study %s failed: %s", study_id, exc)
        return None


def _find_orthanc_study(study_instance_uid: str) -> str | None:
    """Resolve a DICOM StudyInstanceUID to an Orthanc internal study id."""
    try:
        with httpx.Client(timeout=10) as client:
            r = client.post(
                f"{ORTHANC_URL}/tools/find",
                auth=(ORTHANC_USER, ORTHANC_PASSWORD),
                json={
                    "Level": "Study",
                    "Query": {"StudyInstanceUID": study_instance_uid},
                },
            )
            r.raise_for_status()
            ids = r.json()
            return ids[0] if ids else None
    except Exception as exc:  # noqa: BLE001
        logger.warning("Orthanc find for UID %s failed: %s", study_instance_uid, exc)
        return None


def _anonymize_orthanc_study(orthanc_id: str) -> str | None:
    """Trigger Orthanc's built-in DICOM anonymizer. Returns the new
    anonymized study's Orthanc id, or None on failure."""
    try:
        with httpx.Client(timeout=120) as client:
            r = client.post(
                f"{ORTHANC_URL}/studies/{orthanc_id}/anonymize",
                auth=(ORTHANC_USER, ORTHANC_PASSWORD),
                json={"KeepPrivateTags": False, "Force": True},
            )
            r.raise_for_status()
            body: dict[str, Any] = r.json()
            return body.get("ID")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Orthanc anonymize for %s failed: %s", orthanc_id, exc)
        return None


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/anonymize", response_model=AnonymizeResponse)
def anonymize(req: AnonymizeRequest) -> AnonymizeResponse:
    study_instance_uid = _resolve_study_instance_uid(req.study_id)
    if not study_instance_uid:
        raise HTTPException(
            status_code=404,
            detail=f"study {req.study_id} not found in Postgres",
        )

    orthanc_id = _find_orthanc_study(study_instance_uid)
    if not orthanc_id:
        raise HTTPException(
            status_code=404,
            detail=f"study UID {study_instance_uid} not found in Orthanc",
        )

    new_orthanc_id = _anonymize_orthanc_study(orthanc_id)
    if not new_orthanc_id:
        # FAIL-CLOSED: never return success when Orthanc's anonymizer fails.
        # The previous behaviour returned a "passthrough" URI pointing at the
        # ORIGINAL un-scrubbed DICOM (raw PatientName/DOB/MRN), which then
        # flowed into S3, FHIR ImagingStudy, and PDF reports. Per FR-002a,
        # gate failures MUST block downstream stages. If a dev fast-path is
        # ever needed it must be gated behind an explicit env var
        # (LIVERRA_ANON_SIDECAR_BYPASS) AND emit an AuditEvent — neither is
        # wired today, so we always 502.
        logger.error(
            "Anonymize failed for orthanc=%s analysis=%s — failing closed (no passthrough)",
            orthanc_id, req.analysis_id,
        )
        raise HTTPException(
            status_code=502,
            detail="anonymization_failed",
        )

    logger.info(
        "anonymized analysis=%s: orthanc %s -> %s",
        req.analysis_id, orthanc_id, new_orthanc_id,
    )
    return AnonymizeResponse(
        status="done",
        output_uri=f"orthanc://anonymized/{new_orthanc_id}",
    )
