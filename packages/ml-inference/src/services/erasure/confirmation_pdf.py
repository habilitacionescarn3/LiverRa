# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""GDPR erasure confirmation PDF (T326, US9).

Plain-English:
    When a DPO executes an Art. 17 erasure we owe them (and the data
    subject) a one-page proof: "at time T, user X, acting as DPO of
    tenant Y, erased study Z; the case CMK was destroyed, N audit
    events had their residual identifiers hashed, and the tombstone
    hash is ``…``."

    The PDF is rendered with WeasyPrint when available. In test
    environments that lack the GObject stack we fall back to a
    deterministic plain-text summary so unit tests can still exercise
    the contents.

Spec refs:
    - spec.md §FR-040
    - SC-016 (evidence of erasure preserved)
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ConfirmationInputs:
    """Minimal contract for the confirmation renderer.

    All strings are intentionally non-PHI: justification is scrubbed
    by the API layer before being handed to the renderer.
    """

    erasure_request_id: str
    study_id: str
    tenant_id: str
    dpo_email: str
    justification: str
    executed_at: datetime
    tombstone_hash_hex: str
    events_rewritten: int
    substitutions: int


_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>LiverRa — GDPR Erasure Confirmation</title>
<style>
  body {{ font-family: 'Inter', 'Arial', sans-serif; color: #0d1b2a; margin: 40px; }}
  h1   {{ font-size: 22px; margin-bottom: 4px; }}
  h2   {{ font-size: 14px; color: #3a506b; text-transform: uppercase; letter-spacing: 1px; margin-top: 28px; }}
  table {{ border-collapse: collapse; width: 100%; margin-top: 12px; font-size: 12px; }}
  th, td {{ text-align: left; padding: 6px 10px; border-bottom: 1px solid #e0e0e0; vertical-align: top; }}
  th   {{ width: 40%; color: #3a506b; font-weight: 600; }}
  .hash {{ font-family: 'SFMono-Regular', 'Menlo', monospace; font-size: 11px; word-break: break-all; }}
  .footer {{ margin-top: 40px; font-size: 10px; color: #5a6c7d; }}
</style>
</head>
<body>
  <h1>GDPR Art. 17 Erasure — Confirmation</h1>
  <p>Issued by LiverRa. This document is evidence that the below case
     was erased in accordance with Art. 17 of Regulation (EU) 2016/679.</p>

  <h2>Request</h2>
  <table>
    <tr><th>Erasure request ID</th><td class="hash">{erasure_request_id}</td></tr>
    <tr><th>Study ID (erased)</th><td class="hash">{study_id}</td></tr>
    <tr><th>Tenant ID</th><td class="hash">{tenant_id}</td></tr>
    <tr><th>Data Protection Officer</th><td>{dpo_email}</td></tr>
    <tr><th>Justification</th><td>{justification_html}</td></tr>
    <tr><th>Executed at (UTC)</th><td>{executed_at}</td></tr>
  </table>

  <h2>Result</h2>
  <table>
    <tr><th>Tombstone hash (SHA-256)</th><td class="hash">{tombstone_hash_hex}</td></tr>
    <tr><th>Audit events rewritten</th><td>{events_rewritten}</td></tr>
    <tr><th>Residual identifiers hashed</th><td>{substitutions}</td></tr>
  </table>

  <div class="footer">
    Case-envelope CMK destruction was scheduled via AWS KMS.
    Derived artefacts in S3 are unreadable without the key.
    Audit chain integrity is preserved: leaf hashes were NOT modified.
  </div>
</body>
</html>
"""


def _escape_html(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def render_html(inputs: ConfirmationInputs) -> str:
    """Return the confirmation as a self-contained HTML string.

    Plain-text callers (unit tests) use this directly; the PDF
    renderer below wraps it in WeasyPrint.
    """
    return _HTML_TEMPLATE.format(
        erasure_request_id=_escape_html(inputs.erasure_request_id),
        study_id=_escape_html(inputs.study_id),
        tenant_id=_escape_html(inputs.tenant_id),
        dpo_email=_escape_html(inputs.dpo_email),
        justification_html=_escape_html(inputs.justification),
        executed_at=_escape_html(inputs.executed_at.isoformat()),
        tombstone_hash_hex=_escape_html(inputs.tombstone_hash_hex),
        events_rewritten=inputs.events_rewritten,
        substitutions=inputs.substitutions,
    )


def build(inputs: ConfirmationInputs) -> bytes:
    """Render the confirmation PDF. Returns raw PDF bytes.

    When WeasyPrint is not installed (common in CI that doesn't ship
    the GObject/Cairo stack) we fall back to a minimal UTF-8 encoded
    text representation so the orchestrator pipeline still runs end-
    to-end. The fallback is clearly labelled so operators can spot it.
    """
    html = render_html(inputs)
    try:
        from weasyprint import HTML  # type: ignore[import-untyped]
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "WeasyPrint unavailable (%s); emitting plain-text fallback",
            exc,
        )
        header = b"LIVERRA-ERASURE-CONFIRMATION/plain-text-fallback\n"
        return header + html.encode("utf-8")

    try:
        return HTML(string=html).write_pdf()  # type: ignore[return-value]
    except Exception as exc:  # noqa: BLE001
        logger.error("WeasyPrint render failed: %s", exc, exc_info=True)
        raise


__all__ = ["ConfirmationInputs", "build", "render_html"]
