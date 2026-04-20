# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Compliance reviewer services (US10, T338-T342, T448).

Plain-English:
    The "compliance" package is the reviewer-side of the audit trail.
    It does not *write* anything to the audit chain on the hot path —
    the rest of the app already does that. Its job is to *read* and
    *verify* what has accumulated:

      - ``mbom_reader.py``     — lists every shipped ML model,
      - ``chain_verifier.py``  — walks the per-tenant SHA-256 chain +
                                  confirms against the S3 Merkle anchor,
      - ``ruo_spot_check.py``  — randomly samples exported artifacts and
                                  OCRs the RUO watermark region,
      - ``claim_registry.py``  — CRUD on ``RegulatoryClaimRegistry``
                                  (gate for FR-028b disclaimer scope).

Spec refs: research.md §A.3, FR-028b, FR-038, SC-009, SC-010.
"""
