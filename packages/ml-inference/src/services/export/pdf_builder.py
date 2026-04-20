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

SUPPORTED_LOCALES: tuple[str, ...] = ("en", "de", "ka")

# Watermark strings per locale — embedded by the CSS ``@page`` rule AND
# asserted by the OCR test. Keeping them here (not JSON) so the PDF
# renderer can't accidentally lose them to a translation drift.
RUO_WATERMARKS: Mapping[str, str] = {
    "en": "RESEARCH USE ONLY — NOT FOR CLINICAL DECISIONS",
    "de": "NUR ZU FORSCHUNGSZWECKEN — NICHT FÜR KLINISCHE ENTSCHEIDUNGEN",
    "ka": "მხოლოდ კვლევითი გამოყენებისთვის — არ არის კლინიკური გადაწყვეტილებებისთვის",
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
