# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Report PDF builder (T259).

Plain-English:
    Surgeons want a real PDF they can print, attach to an email,
    staple to a pre-op packet. WeasyPrint turns HTML + CSS into pixel-
    perfect print-ready PDF/A-2b and is the only Apache-2.0 renderer
    that embeds complex scripts (Georgian) correctly when handed
    Noto Sans Georgian.

    Every page of the generated PDF MUST carry a visible "Research Use
    Only" watermark — both as a CSS ``@page`` rule AND a ``::before``
    rule on the body, so even if a hacked template hides one, the other
    still paints. ``tests/export/test_pdf_watermark.py`` OCRs the
    rendered PDF per locale to prove this.

Inputs:
    :class:`PDFBuildInput` — a pure Python dict of volumes, FLR, lesions,
    screenshots, locale, plus a handful of attribution fields. The
    Celery task in ``tasks/finalize_report.py`` assembles this from
    database rows before invoking.

Dependencies:
    ``weasyprint>=62`` (LGPL, runtime link only — Apache-2.0 compatible
    per research §B.8), ``Jinja2>=3.1`` (BSD-3-Clause).
"""
from __future__ import annotations

import hashlib
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

try:  # pragma: no cover — optional at import for unit tests
    from jinja2 import Environment, FileSystemLoader, select_autoescape  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    Environment = None  # type: ignore[assignment,misc]
    FileSystemLoader = None  # type: ignore[assignment,misc]
    select_autoescape = None  # type: ignore[assignment,misc]

try:  # pragma: no cover
    from weasyprint import HTML as _WeasyHTML  # type: ignore[import-not-found]
    from weasyprint import CSS as _WeasyCSS  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    _WeasyHTML = None  # type: ignore[assignment,misc]
    _WeasyCSS = None  # type: ignore[assignment,misc]

logger = logging.getLogger(__name__)


# Default template folder — co-located with this module so ``importlib``
# resolution doesn't depend on CWD. Overridable for tests via env var.
_DEFAULT_TEMPLATE_ROOT: Path = Path(
    os.environ.get(
        "LIVERRA_PDF_TEMPLATE_ROOT",
        str(Path(__file__).parent / "pdf_templates"),
    )
).resolve()

SUPPORTED_LOCALES: tuple[str, ...] = ("en", "de", "ka", "ru")

# Watermark strings per locale — embedded by the CSS ``@page`` rule AND
# asserted by the OCR test. Keeping them here (not JSON) so the PDF
# renderer can't accidentally lose them to a translation drift.
RUO_WATERMARKS: Mapping[str, str] = {
    "en": "RESEARCH USE ONLY — NOT FOR CLINICAL DECISIONS",
    "de": "NUR ZU FORSCHUNGSZWECKEN — NICHT FÜR KLINISCHE ENTSCHEIDUNGEN",
    "ka": "მხოლოდ კვლევითი გამოყენებისთვის — არ არის კლინიკური გადაწყვეტილებებისთვის",
    "ru": "ТОЛЬКО ДЛЯ ИССЛЕДОВАТЕЛЬСКИХ ЦЕЛЕЙ — НЕ ДЛЯ КЛИНИЧЕСКИХ РЕШЕНИЙ",
}


@dataclass(frozen=True)
class PDFBuildInput:
    """Everything a report PDF renders from. Pure data, no DB handles."""

    report_id: str
    analysis_id: str
    tenant_display_name: str
    finalized_by_display: str
    finalized_at: datetime
    locale: str  # one of SUPPORTED_LOCALES

    # Volumetric summary
    parenchyma_volume_ml: float
    couinaud_volumes: Mapping[str, float]  # "I".."VIII" → mL
    flr_remnant_volume_ml: float | None
    flr_remnant_pct_functional: float | None
    flr_adequacy_label: str | None  # pre-localised

    # Lesions — already localised rows (label, diameter_mm, volume_ml,
    # confidence_pct, class_label_localised).
    lesions: Sequence[Mapping[str, Any]] = field(default_factory=tuple)

    # Attached 3D screenshots as data URIs ("data:image/png;base64,...").
    screenshots: Sequence[str] = field(default_factory=tuple)

    # MBoM summary — one row per model, already formatted by caller.
    model_summary: Sequence[Mapping[str, str]] = field(default_factory=tuple)

    # Demo-case banner flag; renders a red "SAMPLE DATA" bar when True.
    sample_case_flag: bool = False

    # RUO claim registry snapshot — per-claim status for the attestation
    # section; array of ``{key, status, watermark_variant}`` dicts.
    claim_registry: Sequence[Mapping[str, Any]] = field(default_factory=tuple)

    # Software versions string stamped on the footer (same value used in
    # DICOM-SEG/SR ``SoftwareVersions``).
    software_versions: str = "0.0.0-dev"

    # --- Modern report layout (T-PDF-redesign) ----------------------------
    # The fields below feed the redesigned executive-summary + audit pages.
    # All optional so legacy callers keep working with the old template.

    # FLR adequacy thresholds (fraction of total parenchyma volume, expressed
    # as percentage points). Default to the literature-standard 25/30 split.
    flr_threshold_inadequate: float = 25.0
    flr_threshold_borderline: float = 30.0

    # Per-stage cascade audit rows. Each row may include keys:
    #   stage_no, stage, model_version, license_hash, license_short,
    #   license_warn (bool — flagged for non-commercial licenses), written_at,
    #   status_icon ("ok"/"warn"/"err"), output_uri.
    cascade_checkpoints: Sequence[Mapping[str, Any]] = field(default_factory=tuple)

    # Couinaud Roman-numeral → CSS-friendly hex (e.g. {"I":"#E8B84F", ...}).
    couinaud_palette: Mapping[str, str] = field(default_factory=dict)

    # Lesion class slug → hex (e.g. {"hcc":"#dc2626", "icc":"#ea580c", ...}).
    lesion_class_palette: Mapping[str, str] = field(default_factory=dict)

    # Optional study-level identifiers for the cover band.
    study_uid: str | None = None
    pipeline_version: str | None = None

    # Pre-rendered SVG markup for the executive summary. When present the
    # template embeds them directly (via ``|safe``) instead of rendering the
    # plain volumetric / FLR fallback table.
    couinaud_chart_svg: str | None = None
    flr_donut_svg: str | None = None

    # Headline KPIs already pre-formatted by the caller for the hero cards
    # ("FLR %", "Liver volume", "Lesions", "Cascade"). Each row:
    #   {label, value, sublabel, tone ("default"|"ok"|"warn"|"alert")}.
    kpi_cards: Sequence[Mapping[str, Any]] = field(default_factory=tuple)

    # Total liver volume + lesion count surfaced explicitly so the template
    # can render the headline numbers even without ``kpi_cards``.
    lesion_count: int | None = None

    # Vessel volumes from cascade Stage 3a (portal + hepatic). The
    # ``vessels_chart_svg`` is a small comparison bar embedded in the
    # vessels section; values stay surfaced as numbers for screen readers
    # and CSV exports.
    portal_vein_ml: float | None = None
    hepatic_vein_ml: float | None = None
    vessels_chart_svg: str | None = None

    # Per-stage CT-overlay PNG data URIs — produced by services.stage_render
    # and embedded inline within their stage section (so a surgeon sees
    # the actual CT, not just colourful charts). When the cascade is a
    # stub run / S3 is missing artifacts, these stay None and the template
    # surfaces a clear "imaging unavailable" placeholder card.
    parenchyma_render_uri: str | None = None
    vessels_render_uri: str | None = None
    flr_render_uri: str | None = None
    four_phase_render_uri: str | None = None
    mesh3d_render_uri: str | None = None
    ct_renders_unavailable: bool = False

    # Renderer diagnostics — list of human-readable strings to display
    # in a yellow banner at the top of the report. Populated by
    # ``services.report_renderer`` when stage_render detects implausible
    # masks (e.g. liver mask >3500 mL, vessel masks empty, multi-component
    # liver masks). Helps a surgeon distinguish "the AI rendered nothing"
    # from "the AI rendered garbage" — and which S3 paths to re-check.
    mask_warnings: Sequence[str] = field(default_factory=tuple)

    # Phase 1 heuristic findings — pre-shaped rows from ``analysis_finding``
    # mirroring the FindingsCard.tsx schema (label / value / badge /
    # detail / alert per finding). Empty list hides the panel.
    findings_rows: Sequence[Mapping[str, Any]] = field(default_factory=tuple)

    # ACR structured readout sections (002-acr-structured-readout T066).
    # Mapping[section_name -> list[row]] produced by
    # ``services.export.acr_section_builder.build_acr_sections``.
    # Keys preserve insertion order: liver, lesions, vessels,
    # gallbladder, spleen, flrAssessment.
    acr_sections: Mapping[str, Sequence[Mapping[str, Any]]] = field(default_factory=dict)

    # Lobe split — left = II+III+IV, right = V+VIII when Couinaud is
    # populated; falls back to a Cantlie-line 50/50 of parenchyma_volume_ml
    # when Couinaud is empty (so the page-1 cards never show 0/0).
    # ``lobe_split_source`` is "couinaud" or "cantlie_estimate"; the
    # template badges the latter so surgeons know it's not exact.
    lobe_left_ml: float = 0.0
    lobe_right_ml: float = 0.0
    lobe_split_source: str = "couinaud"


@dataclass(frozen=True)
class PDFBuildResult:
    pdf_bytes: bytes
    sha256_hex: str
    page_count: int
    locale: str


def _jinja_env(template_root: Path) -> Any:
    if Environment is None:
        raise RuntimeError(
            "PDF rendering requires Jinja2; install via `pip install Jinja2>=3.1`"
        )
    return Environment(
        loader=FileSystemLoader(str(template_root)),
        autoescape=select_autoescape(("html", "xml")),
        trim_blocks=True,
        lstrip_blocks=True,
        enable_async=False,
    )


def _resolve_font_paths() -> list[Path]:
    """Noto Sans + Noto Sans Georgian paths; fall back silently when absent
    so unit tests on dev laptops without the fonts pass — production
    container images bake them in under ``/usr/share/fonts/truetype/noto``.
    """
    candidates = [
        Path("/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"),
        Path("/usr/share/fonts/truetype/noto/NotoSansGeorgian-Regular.ttf"),
        Path(os.environ.get("LIVERRA_NOTO_SANS_PATH", "")),
        Path(os.environ.get("LIVERRA_NOTO_SANS_GEORGIAN_PATH", "")),
    ]
    return [p for p in candidates if p and p.exists()]


def _base_css(locale: str) -> str:
    """Assemble the always-on CSS — fonts, @page watermark, ::before banner.

    The watermark is painted TWICE per page (running element + body::before
    pseudo-element) so removing one doesn't remove both.
    """
    watermark = RUO_WATERMARKS.get(locale, RUO_WATERMARKS["en"])
    return f"""
    @font-face {{
      font-family: 'LiverRa Sans';
      src: local('Noto Sans'), local('Helvetica');
    }}
    @font-face {{
      font-family: 'LiverRa Georgian';
      src: local('Noto Sans Georgian'), local('DejaVu Sans');
    }}

    @page {{
      size: A4;
      margin: 22mm 16mm 22mm 16mm;
      @top-center {{
        content: "{watermark}";
        font-family: 'LiverRa Sans', sans-serif;
        font-size: 8pt;
        color: #b91c1c;
        letter-spacing: 0.12em;
      }}
      @bottom-center {{
        content: "{watermark} · Page " counter(page) " of " counter(pages);
        font-family: 'LiverRa Sans', sans-serif;
        font-size: 7pt;
        color: #991b1b;
      }}
    }}

    body {{
      font-family: 'LiverRa Sans', 'LiverRa Georgian', sans-serif;
      font-size: 9pt;
      color: #1f2937;
      line-height: 1.45;
    }}

    body::before {{
      content: "{watermark}";
      position: fixed;
      top: 48%;
      left: 0;
      right: 0;
      text-align: center;
      font-family: 'LiverRa Sans', sans-serif;
      font-size: 36pt;
      color: rgba(185, 28, 28, 0.08);
      transform: rotate(-22deg);
      letter-spacing: 0.35em;
      z-index: -1;
      pointer-events: none;
    }}

    h1, h2, h3 {{ color: #111827; }}
    h1 {{ font-size: 16pt; margin: 0; letter-spacing: -0.005em; }}
    h2 {{
      font-size: 11pt;
      margin: 7mm 0 2.5mm 0;
      padding-bottom: 1mm;
      border-bottom: 0.4pt solid #e5e7eb;
      letter-spacing: 0.01em;
    }}
    table.volumes {{ border-collapse: collapse; width: 100%; font-size: 8.5pt; }}
    table.volumes th, table.volumes td {{
      border: 0.5pt solid #cbd5f5; padding: 3mm 4mm; text-align: left;
    }}
    .sample-banner {{
      background: #fee2e2;
      color: #991b1b;
      padding: 4mm 6mm;
      font-weight: 700;
      border: 1pt solid #b91c1c;
      margin-bottom: 6mm;
      text-align: center;
    }}

    /* --- Modern report layout (T-PDF-redesign) ------------------------- */

    .brand-band {{
      background: linear-gradient(135deg, #1a365d 0%, #2b6cb0 50%, #3182ce 100%);
      color: #ffffff;
      padding: 6mm 7mm 5mm 7mm;
      border-radius: 1.5mm;
      margin-bottom: 5mm;
      page-break-inside: avoid;
    }}
    .brand-band .brand-row {{
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 6mm;
    }}
    .brand-band .wordmark {{
      font-weight: 800;
      font-size: 18pt;
      letter-spacing: 0.02em;
    }}
    .brand-band .wordmark .accent {{ color: #bee3f8; }}
    .brand-band .ruo-chip {{
      background: rgba(254, 226, 226, 0.95);
      color: #7f1d1d;
      padding: 1mm 3mm;
      border-radius: 1mm;
      font-size: 7.5pt;
      font-weight: 700;
      letter-spacing: 0.06em;
    }}
    .brand-band .meta {{
      margin-top: 3mm;
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 2mm 6mm;
      font-size: 8pt;
      color: #ebf4ff;
    }}
    .brand-band .meta .k {{ color: #bee3f8; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; font-size: 7pt; }}
    .brand-band .meta .v {{ color: #ffffff; font-weight: 500; }}

    .kpi-grid {{
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 3mm;
      margin: 3mm 0 5mm 0;
      page-break-inside: avoid;
    }}
    .kpi-card {{
      background: #f9fafb;
      border: 0.4pt solid #e5e7eb;
      border-left: 2.5pt solid #6b7280;
      border-radius: 1.2mm;
      padding: 3mm 3.5mm;
    }}
    .kpi-card.tone-ok {{ border-left-color: #16a34a; }}
    .kpi-card.tone-warn {{ border-left-color: #d97706; }}
    .kpi-card.tone-alert {{ border-left-color: #dc2626; }}
    .kpi-card .kpi-label {{
      color: #6b7280;
      font-size: 7pt;
      font-weight: 600;
      letter-spacing: 0.07em;
      text-transform: uppercase;
    }}
    .kpi-card .kpi-value {{
      color: #111827;
      font-size: 18pt;
      font-weight: 700;
      line-height: 1.1;
      margin-top: 1mm;
    }}
    .kpi-card.tone-ok .kpi-value {{ color: #15803d; }}
    .kpi-card.tone-warn .kpi-value {{ color: #b45309; }}
    .kpi-card.tone-alert .kpi-value {{ color: #b91c1c; }}
    .kpi-card .kpi-sub {{
      color: #6b7280;
      font-size: 7.5pt;
      margin-top: 0.8mm;
    }}

    .exec-grid {{
      display: grid;
      grid-template-columns: 1.45fr 1fr;
      gap: 5mm;
      margin-bottom: 5mm;
      page-break-inside: avoid;
    }}
    .exec-card {{
      background: #ffffff;
      border: 0.4pt solid #e5e7eb;
      border-radius: 1.2mm;
      padding: 3mm 4mm;
    }}
    .exec-card .exec-title {{
      color: #374151;
      font-size: 9pt;
      font-weight: 700;
      margin-bottom: 2mm;
    }}
    .exec-card .exec-sub {{ color: #6b7280; font-size: 7.5pt; margin-top: 1mm; }}

    /* Inline-SVG visual hooks live as attributes inside the <svg> markup
       (see services/export/visualizations.py) — WeasyPrint's CSS engine
       does not propagate `fill` rules into inline SVG, so we keep the
       chart-internal styling on attributes. */
    .flr-thresholds {{ font-size: 7.5pt; color: #6b7280; text-align: center; margin-top: 1.5mm; }}

    .lesion-card {{
      display: grid;
      grid-template-columns: 6mm 1fr auto auto auto;
      gap: 3mm;
      align-items: center;
      padding: 2.2mm 3mm;
      border: 0.4pt solid #e5e7eb;
      border-radius: 1mm;
      margin-bottom: 1.5mm;
      page-break-inside: avoid;
    }}
    .lesion-row-detailed {{
      border: 0.4pt solid #e5e7eb;
      border-radius: 1.2mm;
      padding: 2.5mm 3.5mm 3mm 3.5mm;
      margin-bottom: 2mm;
      page-break-inside: avoid;
      background: #ffffff;
    }}
    .lesion-row-detailed .lesion-head {{
      display: flex;
      align-items: center;
      gap: 3mm;
      flex-wrap: wrap;
      margin-bottom: 1.5mm;
    }}
    .lesion-row-detailed .lesion-num {{ font-size: 7.5pt; }}
    .lesion-row-detailed .lesion-class {{ font-size: 10pt; }}
    .lesion-row-detailed .meta-pill {{
      background: #f3f4f6;
      color: #374151;
      padding: 0.4mm 2mm;
      border-radius: 6mm;
      font-size: 7pt;
      font-weight: 600;
      letter-spacing: 0.03em;
    }}
    .lesion-row-detailed .conf-strong {{
      margin-left: auto;
      font-size: 11pt;
      font-weight: 800;
      color: #111827;
      font-variant-numeric: tabular-nums;
    }}
    .stage-section {{
      page-break-inside: avoid;
      margin-bottom: 5mm;
    }}
    .stage-grid {{
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4mm;
      margin: 2mm 0 4mm 0;
    }}
    .stage-tag {{
      display: inline-block;
      background: #1a365d;
      color: #ffffff;
      padding: 0.5mm 2.5mm;
      border-radius: 1mm;
      font-size: 6.5pt;
      font-weight: 700;
      letter-spacing: 0.1em;
      margin-right: 2mm;
      vertical-align: middle;
    }}

    .ct-render {{
      display: block;
      width: 100%;
      max-width: 100%;
      margin: 2mm 0 1mm 0;
      border: 0.4pt solid #cbd5f5;
      border-radius: 1mm;
      page-break-inside: avoid;
    }}
    .ct-render-caption {{
      color: #6b7280;
      font-size: 7pt;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-weight: 600;
      margin-bottom: 1mm;
    }}
    .ct-unavailable {{
      background: #fef3c7;
      border: 0.5pt dashed #d97706;
      border-radius: 1.2mm;
      padding: 4mm 5mm;
      color: #92400e;
      font-size: 8pt;
      margin: 3mm 0;
    }}
    .ct-unavailable strong {{ color: #78350f; display: block; margin-bottom: 1mm; }}

    .lesion-thumbnail {{
      display: block;
      width: 100%;
      max-width: 100%;
      margin-top: 2mm;
      border: 0.4pt solid #cbd5f5;
      border-radius: 1mm;
      page-break-inside: avoid;
    }}
    .lesion-chip {{
      display: inline-block;
      width: 3.5mm;
      height: 3.5mm;
      border-radius: 50%;
      background: #9ca3af;
      border: 0.4pt solid rgba(0,0,0,0.08);
      vertical-align: middle;
    }}
    .lesion-class {{ font-weight: 700; color: #111827; font-size: 9pt; }}
    .lesion-meta {{ color: #6b7280; font-size: 7.5pt; }}
    .lesion-num {{ color: #9ca3af; font-weight: 700; font-size: 7.5pt; letter-spacing: 0.05em; }}
    .lesion-conf {{ color: #374151; font-variant-numeric: tabular-nums; font-size: 8.5pt; }}

    .audit-table {{
      border-collapse: collapse;
      width: 100%;
      font-size: 7.8pt;
    }}
    .audit-table th {{
      background: #f9fafb;
      border-bottom: 0.6pt solid #d1d5db;
      padding: 2mm 3mm;
      text-align: left;
      color: #4b5563;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-size: 7pt;
    }}
    .audit-table td {{
      border-bottom: 0.3pt solid #f3f4f6;
      padding: 1.8mm 3mm;
      vertical-align: top;
    }}
    .audit-table .col-stage {{ font-weight: 700; color: #111827; }}
    .audit-table .col-hash {{ font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; color: #6b7280; font-size: 7pt; }}
    .audit-table .license-warn {{
      color: #b45309;
      font-weight: 700;
    }}
    .audit-table .license-warn::before {{
      content: "\\26A0  "; /* ⚠ */
    }}
    .audit-table .status-ok {{ color: #16a34a; font-weight: 700; }}
    .audit-table .status-warn {{ color: #d97706; font-weight: 700; }}
    .audit-table .status-err {{ color: #dc2626; font-weight: 700; }}

    .screenshot-grid {{
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 3mm;
      margin-top: 3mm;
    }}
    .screenshot-grid figure {{ margin: 0; }}
    .screenshot-grid img {{
      width: 100%;
      border: 0.4pt solid #d1d5db;
      border-radius: 1mm;
    }}
    .screenshot-grid figcaption {{
      color: #6b7280;
      font-size: 7pt;
      margin-top: 0.8mm;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-weight: 600;
    }}

    .footer-strip {{
      margin-top: 6mm;
      padding-top: 3mm;
      border-top: 0.5pt solid #cbd5f5;
      color: #4b5563;
      font-size: 7.5pt;
    }}
    .footer-strip .ruo-line {{ color: #991b1b; font-weight: 700; }}

    .section-lead {{ color: #6b7280; font-size: 8pt; margin: -1.5mm 0 2mm 0; }}

    .pill {{
      display: inline-block;
      padding: 0.4mm 1.8mm;
      border-radius: 8mm;
      font-size: 7pt;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }}
    .pill.tone-ok {{ background: #dcfce7; color: #166534; }}
    .pill.tone-warn {{ background: #fef3c7; color: #92400e; }}
    .pill.tone-alert {{ background: #fee2e2; color: #991b1b; }}
    .pill.tone-default {{ background: #f3f4f6; color: #374151; }}

    /* --- Phase 1 findings panel ---------------------------------------- */
    .findings-list {{
      display: flex;
      flex-direction: column;
      gap: 1.5mm;
    }}
    .finding-row {{
      border: 0.4pt solid #e5e7eb;
      border-left: 2.5pt solid #6b7280;
      border-radius: 1mm;
      padding: 2mm 3mm;
      background: #ffffff;
      page-break-inside: avoid;
    }}
    .finding-row.alert-warn {{ border-left-color: #d97706; background: #fffbeb; }}
    .finding-row.alert-info {{ border-left-color: #2563eb; }}
    .finding-row .finding-head {{
      display: flex;
      align-items: center;
      gap: 3mm;
      flex-wrap: wrap;
    }}
    .finding-row .finding-label {{
      font-size: 9pt;
      font-weight: 700;
      color: #111827;
      flex: 1;
      min-width: 0;
    }}
    .finding-row .finding-value {{
      color: #4b5563;
      font-size: 8.5pt;
      font-variant-numeric: tabular-nums;
    }}
    .finding-row .finding-detail {{
      color: #6b7280;
      font-size: 7.5pt;
      margin-top: 1mm;
    }}
    /* B-ACR-1: stale-finding badge — FR-023c. */
    .finding-row .finding-stale {{
      color: #6b7280;
      font-size: 7.5pt;
      font-style: italic;
      margin-left: 6pt;
    }}
    .finding-row .finding-warning {{
      color: #b45309;
      background: #fef3c7;
      font-size: 7.5pt;
      padding: 1mm 2mm;
      border-radius: 1mm;
      margin-top: 1mm;
      display: inline-block;
    }}

    /* --- Lesion reasoning bullets -------------------------------------- */
    .lesion-reasoning {{
      margin: 1.5mm 0 0 0;
      padding-left: 4mm;
      color: #4b5563;
      font-size: 8pt;
      line-height: 1.4;
    }}
    .lesion-reasoning li {{
      margin-bottom: 0.7mm;
    }}
    """


def build_pdf(
    inp: PDFBuildInput,
    *,
    template_root: Path | None = None,
    translations: Mapping[str, str] | None = None,
) -> PDFBuildResult:
    """Render the surgeon-facing report to PDF bytes.

    Parameters:
        inp: pure-data bundle (see :class:`PDFBuildInput`).
        template_root: override for test fixtures; defaults to
            ``packages/ml-inference/src/services/export/pdf_templates``.
        translations: optional flat ``key → localised_string`` map to
            hand to Jinja (e.g. section headings). When ``None`` we
            pass through the template-embedded defaults.

    Raises:
        RuntimeError: if WeasyPrint / Jinja2 missing.
        ValueError: if ``inp.locale`` is not one of :data:`SUPPORTED_LOCALES`.
    """
    if inp.locale not in SUPPORTED_LOCALES:
        raise ValueError(
            f"locale must be one of {SUPPORTED_LOCALES}; got {inp.locale!r}"
        )
    if _WeasyHTML is None:
        raise RuntimeError(
            "PDF rendering requires WeasyPrint; install via "
            "`pip install weasyprint>=62`"
        )

    root = template_root or _DEFAULT_TEMPLATE_ROOT
    env = _jinja_env(root)
    template = env.get_template(f"{inp.locale}/report.html")

    rendered_html = template.render(
        report_id=inp.report_id,
        analysis_id=inp.analysis_id,
        tenant_display_name=inp.tenant_display_name,
        finalized_by_display=inp.finalized_by_display,
        finalized_at=inp.finalized_at.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        parenchyma_volume_ml=f"{inp.parenchyma_volume_ml:.1f}",
        couinaud_volumes=inp.couinaud_volumes,
        flr_remnant_volume_ml=(
            f"{inp.flr_remnant_volume_ml:.1f}"
            if inp.flr_remnant_volume_ml is not None
            else None
        ),
        flr_remnant_pct_functional=(
            f"{inp.flr_remnant_pct_functional:.1f}"
            if inp.flr_remnant_pct_functional is not None
            else None
        ),
        flr_adequacy_label=inp.flr_adequacy_label,
        lesions=inp.lesions,
        screenshots=inp.screenshots,
        model_summary=inp.model_summary,
        sample_case_flag=inp.sample_case_flag,
        claim_registry=inp.claim_registry,
        software_versions=inp.software_versions,
        watermark_text=RUO_WATERMARKS[inp.locale],
        # Modern layout extras (T-PDF-redesign):
        flr_threshold_inadequate=inp.flr_threshold_inadequate,
        flr_threshold_borderline=inp.flr_threshold_borderline,
        cascade_checkpoints=inp.cascade_checkpoints,
        couinaud_palette=inp.couinaud_palette,
        lesion_class_palette=inp.lesion_class_palette,
        study_uid=inp.study_uid,
        pipeline_version=inp.pipeline_version,
        couinaud_chart_svg=inp.couinaud_chart_svg,
        flr_donut_svg=inp.flr_donut_svg,
        kpi_cards=inp.kpi_cards,
        lesion_count=(
            inp.lesion_count if inp.lesion_count is not None else len(inp.lesions)
        ),
        portal_vein_ml=inp.portal_vein_ml,
        hepatic_vein_ml=inp.hepatic_vein_ml,
        vessels_chart_svg=inp.vessels_chart_svg,
        parenchyma_render_uri=inp.parenchyma_render_uri,
        vessels_render_uri=inp.vessels_render_uri,
        flr_render_uri=inp.flr_render_uri,
        four_phase_render_uri=inp.four_phase_render_uri,
        mesh3d_render_uri=inp.mesh3d_render_uri,
        ct_renders_unavailable=inp.ct_renders_unavailable,
        mask_warnings=list(inp.mask_warnings or ()),
        findings_rows=list(inp.findings_rows or ()),
        acr_sections=dict(inp.acr_sections or {}),
        lobe_left_ml=inp.lobe_left_ml,
        lobe_right_ml=inp.lobe_right_ml,
        lobe_split_source=inp.lobe_split_source,
        t=translations or {},
    )

    css = _WeasyCSS(string=_base_css(inp.locale))

    # WeasyPrint ``HTML.render`` → ``Document``; call the document's PDF
    # serialiser. NOT the DOM ``document.write`` method.
    html_renderer = _WeasyHTML(string=rendered_html, base_url=str(root))
    rendered_document = html_renderer.render(stylesheets=[css])
    pdf_bytes = rendered_document.write_pdf()  # type: ignore[call-arg]
    page_count = len(getattr(rendered_document, "pages", []) or [])

    sha256_hex = hashlib.sha256(pdf_bytes).hexdigest()
    logger.info(
        "built report PDF report_id=%s locale=%s pages=%d sha256=%s",
        inp.report_id,
        inp.locale,
        page_count,
        sha256_hex[:12],
    )

    return PDFBuildResult(
        pdf_bytes=pdf_bytes,
        sha256_hex=sha256_hex,
        page_count=page_count,
        locale=inp.locale,
    )


def font_paths_available() -> list[Path]:
    """Test helper — expose which Noto fonts are installed on this host."""
    return _resolve_font_paths()


__all__ = [
    "PDFBuildInput",
    "PDFBuildResult",
    "SUPPORTED_LOCALES",
    "RUO_WATERMARKS",
    "build_pdf",
    "font_paths_available",
]
