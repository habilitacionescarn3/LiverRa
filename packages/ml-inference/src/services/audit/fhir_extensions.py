"""LiverRa FHIR extension URLs — Python-side registry.

Mirrors ``packages/app/src/emr/constants/fhir-extensions.ts``. Audit
code MUST reference these constants by name; hardcoded URLs are
forbidden per file-header convention so drift between TS and Python is
impossible.

Source-of-truth: TS module above. If you add an extension here, add it
there too (and vice-versa).
"""
from __future__ import annotations

from typing import Final

# Keep in sync with packages/app/src/emr/constants/fhir-systems.ts
FHIR_BASE_URL: Final[str] = "http://liverra.ai/fhir"
_EXT_BASE: Final[str] = f"{FHIR_BASE_URL}/StructureDefinition"

# -- AuditEvent extensions (chain-of-hashes + model traceability) --
AUDIT_PERMISSION_CHECKED: Final[str] = f"{_EXT_BASE}/audit-permission-checked"
AUDIT_MODEL_VERSION: Final[str] = f"{_EXT_BASE}/audit-model-version"
AUDIT_CHAIN_SEQUENCE_NO: Final[str] = f"{_EXT_BASE}/audit-chain-sequence-no"
AUDIT_CHAIN_LEAF_HASH: Final[str] = f"{_EXT_BASE}/audit-chain-leaf-hash"

# -- AuditEvent extensions added by 002-acr-structured-readout --
AUDIT_LOCALE: Final[str] = f"{_EXT_BASE}/audit-locale"
AUDIT_TENANT: Final[str] = f"{_EXT_BASE}/audit-tenant"
AUDIT_CLIENT_ACTION_ID: Final[str] = f"{_EXT_BASE}/audit-client-action-id"
AUDIT_FAILURE_CATEGORY: Final[str] = f"{_EXT_BASE}/audit-failure-category"

# -- RUO + analysis-level flags (for symmetry with TS registry) --
RUO_CLAIM_KEY: Final[str] = f"{_EXT_BASE}/ruo-claim-key"
RUO_WATERMARK_PRESENT: Final[str] = f"{_EXT_BASE}/ruo-watermark-present"
ATYPICAL_ANATOMY_FLAGS: Final[str] = f"{_EXT_BASE}/atypical-anatomy-flags"
IMPLAUSIBLE_OUTPUT_REASON: Final[str] = f"{_EXT_BASE}/implausible-output-reason"
PARTIAL_COVERAGE_FLAG: Final[str] = f"{_EXT_BASE}/partial-coverage-flag"

# -- ImagingStudy workflow extensions (PACS reading worklist) --
IMAGING_STUDY_STATUS: Final[str] = f"{_EXT_BASE}/imaging-study-status"
IMAGING_STUDY_TIMELINE: Final[str] = f"{_EXT_BASE}/imaging-study-timeline"
IMAGING_PRIORITY: Final[str] = f"{_EXT_BASE}/imaging-priority"
ORTHANC_STUDY_ID: Final[str] = f"{_EXT_BASE}/orthanc-study-id"

# Audit CodeSystem URLs (used by AuditEvent.subtype.system).
AUDIT_SUBTYPE_SYSTEM: Final[str] = f"{FHIR_BASE_URL}/CodeSystem/audit-subtypes"
CLINICAL_ROLES_SYSTEM: Final[str] = f"{FHIR_BASE_URL}/CodeSystem/clinical-roles"


class LIVERRA_EXTENSIONS:
    """Class-style alias matching ``LIVERRA_EXTENSIONS`` in
    ``packages/app/src/emr/constants/fhir-extensions.ts``.

    Exists so callers can write ``LIVERRA_EXTENSIONS.AUDIT_PERMISSION_CHECKED``
    in parity with the TS object-literal shape. Previously this lived in a
    separate ``services/fhir/constants.py`` mirror — folded in here so there
    is exactly one Python source of truth.
    """

    AUDIT_PERMISSION_CHECKED: Final[str] = AUDIT_PERMISSION_CHECKED
    AUDIT_MODEL_VERSION: Final[str] = AUDIT_MODEL_VERSION
    AUDIT_CHAIN_SEQUENCE_NO: Final[str] = AUDIT_CHAIN_SEQUENCE_NO
    AUDIT_CHAIN_LEAF_HASH: Final[str] = AUDIT_CHAIN_LEAF_HASH
    AUDIT_LOCALE: Final[str] = AUDIT_LOCALE
    AUDIT_TENANT: Final[str] = AUDIT_TENANT
    AUDIT_CLIENT_ACTION_ID: Final[str] = AUDIT_CLIENT_ACTION_ID
    AUDIT_FAILURE_CATEGORY: Final[str] = AUDIT_FAILURE_CATEGORY
    RUO_CLAIM_KEY: Final[str] = RUO_CLAIM_KEY
    RUO_WATERMARK_PRESENT: Final[str] = RUO_WATERMARK_PRESENT
    ATYPICAL_ANATOMY_FLAGS: Final[str] = ATYPICAL_ANATOMY_FLAGS
    IMPLAUSIBLE_OUTPUT_REASON: Final[str] = IMPLAUSIBLE_OUTPUT_REASON
    PARTIAL_COVERAGE_FLAG: Final[str] = PARTIAL_COVERAGE_FLAG
    IMAGING_STUDY_STATUS: Final[str] = IMAGING_STUDY_STATUS
    IMAGING_STUDY_TIMELINE: Final[str] = IMAGING_STUDY_TIMELINE
    IMAGING_PRIORITY: Final[str] = IMAGING_PRIORITY
    ORTHANC_STUDY_ID: Final[str] = ORTHANC_STUDY_ID


__all__ = [
    "AUDIT_PERMISSION_CHECKED",
    "AUDIT_MODEL_VERSION",
    "AUDIT_CHAIN_SEQUENCE_NO",
    "AUDIT_CHAIN_LEAF_HASH",
    "AUDIT_LOCALE",
    "AUDIT_TENANT",
    "AUDIT_CLIENT_ACTION_ID",
    "AUDIT_FAILURE_CATEGORY",
    "RUO_CLAIM_KEY",
    "RUO_WATERMARK_PRESENT",
    "ATYPICAL_ANATOMY_FLAGS",
    "IMPLAUSIBLE_OUTPUT_REASON",
    "PARTIAL_COVERAGE_FLAG",
    "IMAGING_STUDY_STATUS",
    "IMAGING_STUDY_TIMELINE",
    "IMAGING_PRIORITY",
    "ORTHANC_STUDY_ID",
    "AUDIT_SUBTYPE_SYSTEM",
    "CLINICAL_ROLES_SYSTEM",
    "LIVERRA_EXTENSIONS",
]
