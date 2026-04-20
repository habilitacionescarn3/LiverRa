# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""LiverRa FHIR canonical URLs — Python mirror.

MIRROR of ``packages/app/src/emr/constants/fhir-extensions.ts`` and
``packages/app/src/emr/constants/fhir-systems.ts`` — keep in sync.
TODO(codegen): generate this file from the TS source at ``turbo run
generate:fhir-types`` time so drift is impossible.

Do **not** hard-code these URLs anywhere else in the Python tree —
import from this module. The Constitution (§IV FHIR-first) forbids
scattered FHIR URL literals.
"""
from __future__ import annotations

from typing import Final

# Base URL — must match ``FHIR_BASE_URL`` in fhir-systems.ts.
FHIR_BASE_URL: Final[str] = "http://liverra.ai/fhir"

_EXT_BASE: Final[str] = f"{FHIR_BASE_URL}/StructureDefinition"


class LIVERRA_EXTENSIONS:
    """Canonical LiverRa extension URLs.

    Matches the ``LIVERRA_EXTENSIONS`` object in
    ``packages/app/src/emr/constants/fhir-extensions.ts``.
    """

    # -- AuditEvent extensions --
    AUDIT_PERMISSION_CHECKED: Final[str] = f"{_EXT_BASE}/audit-permission-checked"
    AUDIT_MODEL_VERSION: Final[str] = f"{_EXT_BASE}/audit-model-version"
    AUDIT_CHAIN_SEQUENCE_NO: Final[str] = f"{_EXT_BASE}/audit-chain-sequence-no"
    AUDIT_CHAIN_LEAF_HASH: Final[str] = f"{_EXT_BASE}/audit-chain-leaf-hash"

    # -- RUO watermark --
    RUO_CLAIM_KEY: Final[str] = f"{_EXT_BASE}/ruo-claim-key"
    RUO_WATERMARK_PRESENT: Final[str] = f"{_EXT_BASE}/ruo-watermark-present"

    # -- Analysis-level safety flags --
    ATYPICAL_ANATOMY_FLAGS: Final[str] = f"{_EXT_BASE}/atypical-anatomy-flags"
    IMPLAUSIBLE_OUTPUT_REASON: Final[str] = f"{_EXT_BASE}/implausible-output-reason"
    PARTIAL_COVERAGE_FLAG: Final[str] = f"{_EXT_BASE}/partial-coverage-flag"


__all__ = ["FHIR_BASE_URL", "LIVERRA_EXTENSIONS"]
