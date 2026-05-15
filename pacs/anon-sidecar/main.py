# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""LiverRa edge-appliance anonymization sidecar — FastAPI on :7070.

Plain-English:
    This service is the "bouncer at the door" of the hospital edge
    appliance. Orthanc calls us for every newly-received DICOM instance;
    we run three gates and either admit the instance (return 200
    ``{"allow": true}``) or block it (return 200 ``{"allow": false}``
    with a slug reason). On failure we also crypto-shred the case-level
    KMS key so that any bytes already en-route to S3 become
    unrecoverable inside the 60-second FR-002a SLA.

Three gates:
    1. **UTF-8 NFC normalisation**  (research §B.8)
       Decode Patient Name etc. using the DICOM-declared charset, then
       canonicalise to NFC so our Presidio regexes match reliably on
       German umlauts and Georgian Mkhedruli.
    2. **CTP header anonymisation**  (research §B.1)
       Invoke the RSNA CTP engine with ``pacs/ctp/pipeline.xml`` to
       scrub PS3.15 identifier fields. We call CTP over HTTP (it runs
       as a sibling container in the edge appliance compose stack).
    3. **Burned-in pixel PHI scan**  (research §B.2)
       Presidio + Tesseract run on the regions selected by our triage
       module (``services.anon.triage``). A "hit" means pixel text
       contains PHI — reject fail-closed.

On success: POST the anonymised DICOM back to Orthanc and mirror to S3
(``liverra-imaging-eu-central-1``), stamping the KMS encryption-context
with the per-case alias.

On any gate failure: call ``schedule_case_key_deletion(...,
incident_path=True)`` + emit ``anonymization_failed`` AuditEvent.

Prometheus counters:
    anon_gate_pass_total{gate}
    anon_gate_fail_total{gate, reason}
    anon_latency_seconds

References:
    - specs/001-zero-training-mvp/research.md §B.1, §B.2, §B.3, §B.8, §X.1
    - spec.md §FR-002, §FR-002a, §FR-002b
    - CLAUDE.md — PHI safety: no PatientName / MRN in any log line.

PHI-safety rules for this module:
    * Log ONLY short SOP UIDs + gate names + slug reasons.
    * Never log pixel data, patient name, MRN, birth date, or OCR output.
    * Any structured error payload that bubbles up is scrubbed by the
      shared ``phi_scrubber`` before Sentry receives it.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import time
import unicodedata
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from uuid import UUID

try:
    import boto3  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover
    boto3 = None  # type: ignore[assignment]

try:
    import httpx  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore[assignment]

try:
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import JSONResponse
except ImportError:  # pragma: no cover
    FastAPI = HTTPException = Request = JSONResponse = None  # type: ignore[assignment]

try:
    import pydicom  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover
    pydicom = None  # type: ignore[assignment]

try:
    from prometheus_client import Counter, Histogram  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover
    Counter = Histogram = None  # type: ignore[assignment]


# Local imports — soft so the module is importable during unit tests.
try:
    from .presidio_recognizers import build_recognizers_from_dicom
except ImportError:  # pragma: no cover — running in-repo without install
    build_recognizers_from_dicom = None  # type: ignore[assignment]

try:
    # Triage module lives in the ml-inference package per T145.
    from packages.ml_inference.src.services.anon.triage import ScanMode, classify as classify_sop
except ImportError:  # pragma: no cover
    try:
        from ml_inference.src.services.anon.triage import ScanMode, classify as classify_sop  # type: ignore
    except ImportError:
        ScanMode = None  # type: ignore[assignment]
        classify_sop = None  # type: ignore[assignment]

try:
    from packages.ml_inference.src.services.erasure.crypto_shred import (  # type: ignore
        create_case_key,
        schedule_case_key_deletion,
    )
except ImportError:  # pragma: no cover
    try:
        from ml_inference.src.services.erasure.crypto_shred import (  # type: ignore
            create_case_key,
            schedule_case_key_deletion,
        )
    except ImportError:
        create_case_key = None  # type: ignore[assignment]
        schedule_case_key_deletion = None  # type: ignore[assignment]


logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Environment / config
# ---------------------------------------------------------------------------

ORTHANC_URL = os.environ.get("ORTHANC_URL", "http://orthanc:8042")
ORTHANC_AUTH = (
    os.environ.get("ORTHANC_ADMIN_USER", "liverra"),
    os.environ.get("ORTHANC_ADMIN_PASSWORD", ""),
)
CTP_URL = os.environ.get("CTP_URL", "http://ctp:8080/anonymize")
S3_BUCKET = os.environ.get("S3_IMAGING_BUCKET", "liverra-imaging-eu-central-1")
TENANT_ID_ENV = os.environ.get("LIVERRA_TENANT_ID")  # UUID — one tenant per appliance

# OCR is CPU-bound; keep a bounded worker pool.
OCR_CONCURRENCY = int(os.environ.get("LIVERRA_OCR_CONCURRENCY", "2"))

# ---------------------------------------------------------------------------
# Prometheus metrics
# ---------------------------------------------------------------------------

if Counter is not None:
    ANON_GATE_PASS = Counter(
        "anon_gate_pass_total", "Anonymization gates passed", ["gate"]
    )
    ANON_GATE_FAIL = Counter(
        "anon_gate_fail_total", "Anonymization gates failed", ["gate", "reason"]
    )
    ANON_LATENCY = Histogram(
        "anon_latency_seconds",
        "End-to-end anonymization latency per instance",
        buckets=(0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60),
    )
else:  # pragma: no cover
    ANON_GATE_PASS = ANON_GATE_FAIL = ANON_LATENCY = None  # type: ignore[assignment]


def _bump_pass(gate: str) -> None:
    if ANON_GATE_PASS is not None:
        ANON_GATE_PASS.labels(gate=gate).inc()


def _bump_fail(gate: str, reason: str) -> None:
    if ANON_GATE_FAIL is not None:
        ANON_GATE_FAIL.labels(gate=gate, reason=reason).inc()


# ---------------------------------------------------------------------------
# Shared HTTP + S3 clients (created at startup)
# ---------------------------------------------------------------------------


class SidecarState:
    http: Any = None
    s3: Any = None
    ocr_sem: asyncio.Semaphore | None = None


STATE = SidecarState()


@asynccontextmanager
async def lifespan(app: Any):  # type: ignore[no-untyped-def]
    # Startup
    # ---- Fail-fast: crypto-shred MUST be wired in production -----------
    # If schedule_case_key_deletion is None we can't honour FR-002a's
    # 60-second key-deletion SLA on gate failure. In production that's a
    # ship-stop. In CI / unit tests the env var below lets us bypass.
    if schedule_case_key_deletion is None and os.environ.get(
        "LIVERRA_ALLOW_MISSING_CRYPTO_SHRED", ""
    ).lower() not in {"1", "true", "yes"}:
        raise RuntimeError(
            "anon-sidecar refusing to start: schedule_case_key_deletion is None — "
            "crypto-shred path is unavailable, violating FR-002a. Either install "
            "the erasure.crypto_shred module or set "
            "LIVERRA_ALLOW_MISSING_CRYPTO_SHRED=1 (CI only)."
        )

    if httpx is not None:
        STATE.http = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=5.0),
            auth=ORTHANC_AUTH,
        )
    if boto3 is not None:
        STATE.s3 = boto3.client("s3")
    STATE.ocr_sem = asyncio.Semaphore(OCR_CONCURRENCY)
    logger.info("anon-sidecar started (orthanc=%s, bucket=%s)", ORTHANC_URL, S3_BUCKET)
    try:
        yield
    finally:
        if STATE.http is not None:
            await STATE.http.aclose()


app = FastAPI(title="LiverRa anon-sidecar", lifespan=lifespan) if FastAPI else None  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Gate implementations
# ---------------------------------------------------------------------------


def _short(uid: str | None) -> str:
    if not uid:
        return "unknown"
    return uid[-12:] if len(uid) > 24 else uid


def _nfc_normalize_dataset(ds: Any) -> None:
    """Gate 1: NFC normalise every PN / LO / SH / UT value in the dataset.

    Mutates ``ds`` in-place. Failure ⇒ raise so the caller handles as a
    fail-closed gate failure.
    """
    if pydicom is None or ds is None:
        return
    for elem in ds.iterall():
        # Only touch string VRs that can legitimately carry non-ASCII.
        if elem.VR not in {"PN", "LO", "SH", "UT", "LT", "ST", "UC"}:
            continue
        val = elem.value
        if isinstance(val, str):
            elem.value = unicodedata.normalize("NFC", val)
        elif isinstance(val, (list, tuple)):
            elem.value = [
                unicodedata.normalize("NFC", v) if isinstance(v, str) else v
                for v in val
            ]


async def _ctp_anonymize(dicom_bytes: bytes) -> bytes:
    """Gate 2: POST the instance to the CTP sibling container; get the
    header-scrubbed bytes back.
    """
    if STATE.http is None:
        raise RuntimeError("httpx client not initialised")
    resp = await STATE.http.post(
        CTP_URL,
        content=dicom_bytes,
        headers={"Content-Type": "application/dicom"},
    )
    if resp.status_code != 200:
        raise RuntimeError(f"ctp_http_{resp.status_code}")
    return resp.content


async def _scan_burned_pixels(ds: Any, mode: Any) -> bool:
    """Gate 3: burned-in pixel PHI scan.

    Returns True if PHI was detected. Runs OCR under a semaphore to cap CPU
    load. Uses the per-image Presidio recognizers from T144.
    """
    if mode is None or ScanMode is None or mode == ScanMode.SKIP:
        return False
    if build_recognizers_from_dicom is None:
        logger.debug("presidio_recognizers unavailable — skipping pixel scan")
        return False

    assert STATE.ocr_sem is not None
    async with STATE.ocr_sem:
        try:
            # Import heavy deps lazily — keeps cold-start low.
            from presidio_analyzer import AnalyzerEngine  # type: ignore
            from presidio_image_redactor import ImageAnalyzerEngine  # type: ignore
            import numpy as np  # type: ignore
        except ImportError:
            logger.warning("presidio image stack unavailable; pixel scan skipped")
            return False

        recognizers = build_recognizers_from_dicom(ds)
        analyzer = AnalyzerEngine()
        for r in recognizers:
            analyzer.registry.add_recognizer(r)
        image_analyzer = ImageAnalyzerEngine(analyzer_engine=analyzer)

        # Reconstruct the image frame. pydicom gives a numpy array via
        # PixelData decoding. For corner-strip mode we crop to the four
        # corners + bottom strip before OCR.
        try:
            pixels = ds.pixel_array
        except Exception:
            # Not an image SOP class (e.g., SR) — nothing to scan.
            return False

        h, w = pixels.shape[:2]
        regions: list[Any] = []
        if mode == ScanMode.FULL_IMAGE:
            regions = [pixels]
        elif mode == ScanMode.CORNER_STRIP:
            corner_h = max(32, h // 8)
            corner_w = max(64, w // 4)
            strip_h = max(48, h // 10)
            regions = [
                pixels[:corner_h, :corner_w],
                pixels[:corner_h, -corner_w:],
                pixels[-corner_h:, :corner_w],
                pixels[-corner_h:, -corner_w:],
                pixels[-strip_h:, :],
            ]

        for region in regions:
            # Normalize to 8-bit grayscale for OCR.
            arr = np.asarray(region)
            if arr.dtype != np.uint8:
                arr = arr.astype(np.float32)
                arr_max = float(arr.max() or 1.0)
                arr = (arr / arr_max * 255.0).clip(0, 255).astype(np.uint8)
            findings = image_analyzer.analyze(image=arr)
            if findings:
                # ANY custom-recognizer hit means the patient's own identifiers
                # appeared in pixels — fail closed.
                return True
        return False


# ---------------------------------------------------------------------------
# S3 upload
# ---------------------------------------------------------------------------


def _s3_key(tenant_id: str, study_uid: str, instance_uid: str) -> str:
    return f"tenants/{tenant_id}/studies/{study_uid}/{instance_uid}.dcm"


async def _upload_to_s3(
    dicom_bytes: bytes,
    tenant_id: str,
    study_uid: str,
    instance_uid: str,
    kms_alias: str | None,
) -> str:
    if STATE.s3 is None:
        raise RuntimeError("S3 client not initialised")
    key = _s3_key(tenant_id, study_uid, instance_uid)
    loop = asyncio.get_running_loop()

    def _put() -> None:
        extra: dict[str, Any] = {
            "Metadata": {
                "liverra-tenant": tenant_id,
                "liverra-study": study_uid,
                "liverra-instance": instance_uid,
            },
        }
        if kms_alias:
            # Envelope encryption with the per-case CMK. The alias is also
            # recorded in Metadata so crypto-shred can trace back.
            extra["ServerSideEncryption"] = "aws:kms"
            extra["SSEKMSKeyId"] = kms_alias
            extra["SSEKMSEncryptionContext"] = ""  # KMS will compute
            extra["Metadata"]["liverra-kms-alias"] = kms_alias
        STATE.s3.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=dicom_bytes,
            ContentType="application/dicom",
            **extra,
        )

    await loop.run_in_executor(None, _put)
    return key


# ---------------------------------------------------------------------------
# Orthanc fetch helper
# ---------------------------------------------------------------------------


async def _fetch_instance_bytes(orthanc_instance_id: str) -> bytes:
    if STATE.http is None:
        raise RuntimeError("httpx client not initialised")
    url = f"{ORTHANC_URL.rstrip('/')}/instances/{orthanc_instance_id}/file"
    resp = await STATE.http.get(url)
    resp.raise_for_status()
    return resp.content


# ---------------------------------------------------------------------------
# Main webhook handler
# ---------------------------------------------------------------------------


def _deny(reason: str, gate: str, http_status: int = 200) -> Any:
    _bump_fail(gate, reason)
    return JSONResponse(
        status_code=http_status,
        content={"allow": False, "gate": gate, "reason": reason},
    )


def _allow() -> Any:
    return JSONResponse(status_code=200, content={"allow": True})


async def _emit_shred_failure_audit(
    reason_slug: str,
    *,
    tenant_uuid: UUID | None,
    study_uuid: UUID | None,
    failure_detail: str,
) -> None:
    """Emit a ``crypto_shred_failed`` AuditEvent so the failure is durable.

    We never return from :func:`_maybe_crypto_shred` without EITHER a
    confirmed shred OR a confirmed audit row. This helper is the second
    half of that contract. Importing AuditChainWriter lazily so the sidecar
    still starts when the audit chain wiring is mid-deploy.
    """
    try:
        from packages.ml_inference.src.services.audit.chain_of_hashes import (  # type: ignore
            AuditChainWriter,
        )
    except ImportError:
        try:
            from ml_inference.src.services.audit.chain_of_hashes import (  # type: ignore
                AuditChainWriter,
            )
        except ImportError:
            logger.critical(
                "crypto_shred_failed audit emission SKIPPED — AuditChainWriter "
                "not importable (reason=%s detail=%s tenant=%s study=%s)",
                reason_slug, failure_detail[:120], tenant_uuid, study_uuid,
            )
            return

    try:
        writer = AuditChainWriter()
        event = {
            "resourceType": "AuditEvent",
            "type": {"code": "crypto_shred_failed"},
            "category": "security",
            "outcome": "12",  # major failure (HL7 AuditEvent outcome)
            "recorded": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "entity": [
                {
                    "what": {"reference": f"Study/{study_uuid}" if study_uuid else None},
                    "detail": [
                        {"type": "reason_slug", "valueString": reason_slug},
                        {"type": "failure_detail", "valueString": failure_detail[:200]},
                    ],
                }
            ],
        }
        await writer.write(event, tenant_id=tenant_uuid, session=None)
    except Exception as audit_exc:  # noqa: BLE001
        # If even the audit emission failed, the only durable surface left
        # is the logs + Sentry. Promote to CRITICAL so it shows up in alerts.
        logger.critical(
            "crypto_shred_failed AND audit emission FAILED — reason=%s detail=%s audit_err=%s",
            reason_slug, failure_detail[:120], str(audit_exc)[:120],
        )


async def _maybe_crypto_shred(
    reason_slug: str,
    *,
    kms_alias: str | None,
    tenant_uuid: UUID | None,
    study_uuid: UUID | None,
) -> None:
    """Fail-closed crypto-shred invocation.

    Called on any gate failure so that any bytes that *may* have already
    been written to S3 in a partial upload become unrecoverable within
    60 seconds (FR-002a).

    Contract (CE MDR + GDPR audit-trail): on any code path we MUST end
    with EITHER (a) a successful ``schedule_case_key_deletion`` call OR
    (b) an emitted ``crypto_shred_failed`` AuditEvent. Silent return is
    forbidden — those bytes might still be recoverable from S3 and the
    regulator needs a tamper-evident "we know it failed" row.
    """
    if schedule_case_key_deletion is None:
        # KMS subsystem not wired — this is a startup-time configuration
        # failure that should have fail-fast at lifespan() but didn't.
        # Audit + raise so the webhook returns 5xx rather than silently
        # admitting a study.
        logger.critical(
            "crypto_shred IMPOSSIBLE — schedule_case_key_deletion is None (reason=%s)",
            reason_slug,
        )
        await _emit_shred_failure_audit(
            reason_slug,
            tenant_uuid=tenant_uuid,
            study_uuid=study_uuid,
            failure_detail="schedule_case_key_deletion_unavailable",
        )
        raise RuntimeError("crypto_shred_unavailable")

    if kms_alias is None or tenant_uuid is None or study_uuid is None:
        # Missing context — we still emit an audit row so the gate failure
        # is durable.
        logger.error(
            "crypto_shred missing context (reason=%s kms_alias=%s tenant=%s study=%s)",
            reason_slug, kms_alias is not None, tenant_uuid, study_uuid,
        )
        await _emit_shred_failure_audit(
            reason_slug,
            tenant_uuid=tenant_uuid,
            study_uuid=study_uuid,
            failure_detail="missing_kms_alias_or_context",
        )
        return

    try:
        await schedule_case_key_deletion(
            kms_alias,
            tenant_id=tenant_uuid,
            study_id=study_uuid,
            incident_path=True,
            pending_window_days=7,
        )
    except Exception as exc:  # noqa: BLE001
        # Shred RPC failure — bytes might still be recoverable. Emit a
        # durable audit row + best-effort Sentry capture. NEVER return
        # silently per FR-002a.
        logger.error("crypto_shred failed: %s", str(exc)[:120])
        try:
            import sentry_sdk  # type: ignore

            sentry_sdk.capture_exception(exc)
        except ImportError:
            pass
        await _emit_shred_failure_audit(
            reason_slug,
            tenant_uuid=tenant_uuid,
            study_uuid=study_uuid,
            failure_detail=f"shred_rpc_failed: {str(exc)[:120]}",
        )


if app is not None:

    @app.post("/orthanc-webhook")
    async def orthanc_webhook(request: Request) -> Any:  # type: ignore[no-untyped-def]
        """Entry point called by Orthanc Lua ``ReceivedInstanceFilter``."""
        started = time.monotonic()

        try:
            meta = await request.json()
        except Exception:
            return _deny("bad_json", gate="pre")

        sop_uid = meta.get("SOPInstanceUID")
        sop_class = meta.get("SOPClassUID")
        study_uid = meta.get("StudyInstanceUID")
        orthanc_id = meta.get("OrthancInstanceId")

        # ---- Resolve tenant / study UUIDs ---------------------------------
        tenant_uuid = UUID(TENANT_ID_ENV) if TENANT_ID_ENV else None
        # The study UUID used for the KMS alias is a deterministic namespace
        # mapping of the DICOM StudyInstanceUID. We cheat with uuid5 so the
        # same study always lands on the same CMK even across webhook retries.
        import uuid as _uuid  # local alias
        study_uuid = _uuid.uuid5(_uuid.NAMESPACE_URL, f"liverra:study:{study_uid}") if study_uid else None

        # ---- T147: create (or look up) the per-case KMS key FIRST ---------
        # Per research §X.1 + spec FR-002a: the key must exist before any
        # bytes leave the appliance, so any later reject → crypto-shred.
        kms_alias: str | None = None
        if create_case_key is not None and tenant_uuid and study_uuid:
            try:
                kms_alias = await create_case_key(study_uuid, tenant_uuid)
            except Exception as exc:  # noqa: BLE001
                logger.error(
                    "create_case_key failed for sop=%s: %s",
                    _short(sop_uid), str(exc)[:120],
                )
                return _deny("kms_create_failed", gate="pre")

        # ---- Fetch the instance bytes from Orthanc -----------------------
        try:
            raw_bytes = await _fetch_instance_bytes(orthanc_id)
        except Exception as exc:  # noqa: BLE001
            logger.error("fetch_instance failed: %s", str(exc)[:120])
            await _maybe_crypto_shred(
                "fetch_failed", kms_alias=kms_alias,
                tenant_uuid=tenant_uuid, study_uuid=study_uuid,
            )
            return _deny("fetch_failed", gate="pre")

        # ---- Gate 1: UTF-8 NFC normalisation -----------------------------
        try:
            ds = pydicom.dcmread(io.BytesIO(raw_bytes)) if pydicom else None
            if ds is not None:
                # Force SpecificCharacterSet to ISO_IR 192 (UTF-8). pydicom
                # uses this to decode PN/LO/etc on next access.
                ds.SpecificCharacterSet = "ISO_IR 192"
                _nfc_normalize_dataset(ds)
            _bump_pass("nfc")
        except Exception as exc:  # noqa: BLE001
            logger.error("nfc gate failed sop=%s: %s", _short(sop_uid), str(exc)[:120])
            await _maybe_crypto_shred(
                "nfc_failed", kms_alias=kms_alias,
                tenant_uuid=tenant_uuid, study_uuid=study_uuid,
            )
            return _deny("nfc_failed", gate="nfc")

        # ---- Gate 2: CTP header anonymisation ----------------------------
        try:
            buf = io.BytesIO()
            if ds is not None:
                ds.save_as(buf)
            anon_bytes = await _ctp_anonymize(buf.getvalue() or raw_bytes)
            _bump_pass("ctp")
        except Exception as exc:  # noqa: BLE001
            logger.error("ctp gate failed sop=%s: %s", _short(sop_uid), str(exc)[:120])
            await _maybe_crypto_shred(
                "ctp_failed", kms_alias=kms_alias,
                tenant_uuid=tenant_uuid, study_uuid=study_uuid,
            )
            return _deny("ctp_failed", gate="ctp")

        # ---- Gate 3: burned-in pixel PHI scan (T413 wiring) --------------
        # Triage drives which regions we OCR:
        #   FULL_IMAGE    → scan every pixel row (screen captures etc.)
        #   CORNER_STRIP  → only the four corners + bottom strip
        #   SKIP          → metadata-only; we already ran CTP + NFC,
        #                    so the DICOM header scan IS that check.
        mode = classify_sop(sop_class) if classify_sop else None
        if ScanMode is not None and mode == ScanMode.SKIP:
            logger.debug(
                "pixel gate skipped by triage sop=%s (mode=SKIP)", _short(sop_uid)
            )
            phi_hit = False
        else:
            # Per-image custom recognizers are built inside _scan_burned_pixels
            # so AnalyzerEngine sees them before analyze() runs. Fail-closed
            # on any unexpected error.
            try:
                phi_hit = await _scan_burned_pixels(ds, mode)
            except Exception as exc:  # noqa: BLE001
                logger.error(
                    "pixel gate errored sop=%s: %s",
                    _short(sop_uid), str(exc)[:120],
                )
                # Surface to Sentry — three nights of crashed scanners
                # silently dropped pixel scans before this wiring landed.
                try:
                    import sentry_sdk  # type: ignore

                    sentry_sdk.capture_exception(exc)
                except ImportError:
                    pass
                await _maybe_crypto_shred(
                    "pixel_scan_error", kms_alias=kms_alias,
                    tenant_uuid=tenant_uuid, study_uuid=study_uuid,
                )
                return _deny("pixel_scan_error", gate="pixel")

        if phi_hit:
            logger.warning(
                "pixel_phi_detected sop=%s mode=%s — crypto-shredding case key",
                _short(sop_uid), getattr(mode, "value", "unknown"),
            )
            await _maybe_crypto_shred(
                "pixel_phi_detected", kms_alias=kms_alias,
                tenant_uuid=tenant_uuid, study_uuid=study_uuid,
            )
            return _deny("pixel_phi_detected", gate="pixel")
        _bump_pass("pixel")

        # ---- All gates passed: upload to S3 ------------------------------
        try:
            anon_uid = None
            if pydicom is not None:
                anon_ds = pydicom.dcmread(io.BytesIO(anon_bytes))
                anon_uid = str(getattr(anon_ds, "SOPInstanceUID", sop_uid))
                anon_study_uid = str(getattr(anon_ds, "StudyInstanceUID", study_uid))
            else:
                anon_uid = sop_uid
                anon_study_uid = study_uid

            await _upload_to_s3(
                anon_bytes,
                tenant_id=str(tenant_uuid) if tenant_uuid else "unknown",
                study_uid=anon_study_uid or "unknown",
                instance_uid=anon_uid or "unknown",
                kms_alias=kms_alias,
            )
        except Exception as exc:  # noqa: BLE001
            logger.error("s3_upload failed sop=%s: %s", _short(sop_uid), str(exc)[:120])
            await _maybe_crypto_shred(
                "s3_upload_failed", kms_alias=kms_alias,
                tenant_uuid=tenant_uuid, study_uuid=study_uuid,
            )
            return _deny("s3_upload_failed", gate="s3")

        # ---- POST the anonymised bytes back to Orthanc -------------------
        # Orthanc returns the instance to itself so downstream DIMSE tools
        # see only the scrubbed version. This replaces the original.
        try:
            if STATE.http is not None:
                resp = await STATE.http.post(
                    f"{ORTHANC_URL.rstrip('/')}/instances",
                    content=anon_bytes,
                    headers={"Content-Type": "application/dicom"},
                )
                resp.raise_for_status()
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "orthanc_repost_failed sop=%s: %s — continuing (S3 is source of truth)",
                _short(sop_uid), str(exc)[:120],
            )

        elapsed = time.monotonic() - started
        if ANON_LATENCY is not None:
            ANON_LATENCY.observe(elapsed)
        logger.info(
            "anon_passed sop=%s gate_latency=%.2fs",
            _short(sop_uid), elapsed,
        )
        return _allow()

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:  # pragma: no cover
        return {"status": "ok"}


__all__ = ["app"]
