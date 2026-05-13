"""acr_plaintext_renderer — Python twin of TS acrPlainTextRenderer.

Implements ``specs/002-acr-structured-readout/contracts/plaintext-renderer.md``.
Output is byte-equivalent to ``packages/app/src/emr/services/report/acrPlainTextRenderer.ts``
for the same ``ReadoutSnapshot`` input. The cross-channel parity test
(``tests/integration/test_acr_renderer_cross_channel_parity.py``) is the
release-blocking gate that enforces this contract.
"""
from __future__ import annotations

import unicodedata
from typing import Any, Iterable, Mapping, Sequence


def render_readout_plain_text(snapshot: Mapping[str, Any]) -> str:
    """Convert a ReadoutSnapshot dict into plain text.

    Snapshot dict shape mirrors the TS ``ReadoutSnapshot`` interface:
    ``{analysisId, tenantId, locale, capturedAt, etag, status,
       sections: [{section, title, rows: [{label, value, warning, itemId,
       segment, interpretation, badge, stale, key}], status, emptyMessage}],
       ruoDisclaimer}``.
    """
    raw_disclaimer = str(snapshot.get("ruoDisclaimer", "")).strip()
    # Match TS renderer normalisation: strip any leading/trailing dashes
    # the caller may have already inserted so the banner is always
    # exactly `--- <text> ---`.
    stripped = raw_disclaimer
    while stripped.startswith("---"):
        stripped = stripped[3:].lstrip()
    while stripped.endswith("---"):
        stripped = stripped[:-3].rstrip()
    ruo_banner = f"--- {stripped} ---"

    lines: list[str] = [ruo_banner, ""]
    sections: Sequence[Mapping[str, Any]] = snapshot.get("sections", []) or []
    for idx, section in enumerate(sections):
        if idx > 0:
            lines.append("")
        _render_section(section, lines)
    lines.append("")
    lines.append(ruo_banner)
    out = "\n".join(lines)
    return unicodedata.normalize("NFC", out)


def _render_section(section: Mapping[str, Any], lines: list[str]) -> None:
    title = str(section.get("title", ""))
    rows: Sequence[Mapping[str, Any]] = section.get("rows", []) or []
    lines.append(title)
    if not rows:
        placeholder = section.get("emptyMessage") or "No findings to report."
        lines.append(f"  {placeholder}")
        return
    for row in rows:
        _render_row(row, lines)


def _render_row(row: Mapping[str, Any], lines: list[str]) -> None:
    item_id = row.get("itemId")
    value = row.get("value")
    if value is None:
        value = "Not available"
    stale = row.get("stale")
    warning = row.get("warning")
    if item_id:
        segment = row.get("segment")
        seg_str = f" (segment {segment})" if segment else ""
        lines.append(f"  - {item_id}{seg_str}: {value}")
        if stale:
            lines.append(f"    (last computed {stale.get('computedAt')})")
        if warning:
            lines.append(f"  ! {warning}")
        return
    label = row.get("label", "")
    stale_tail = f" (last computed {stale.get('computedAt')})" if stale else ""
    lines.append(f"  {label}: {value}{stale_tail}")
    if warning:
        lines.append(f"  ! {warning}")


__all__ = ["render_readout_plain_text"]
