# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Self-contained PDF report renderer for a completed Analysis.

Plain-English:
    Pulls the rows + masks + a CT phase, renders a multi-page PDF
    (cover, slice montage with parenchyma overlay, volumetry, FLR,
    lesion list) and returns the bytes. Used by the on-demand
    ``GET /analyses/{id}/report/pdf`` endpoint and the Celery
    finalize task.

Design choice:
    Uses ``matplotlib.backends.backend_pdf.PdfPages`` only — no
    reportlab dependency. Each page is one matplotlib Figure. A
    diagonal "RESEARCH USE ONLY" watermark is drawn on every page
    via the figure-level ``text`` API.

Output style mirrors ``packages/ml-inference/scripts/show_results.py``
so visual review is consistent across CLI + UI flows.
"""
from __future__ import annotations

import io
import logging
import os
import tempfile
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import nibabel  # noqa: F401 — ensures plugin registration for SimpleITK fallbacks
import numpy as np
import SimpleITK as sitk
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.figure import Figure
from matplotlib.patches import Rectangle
from PIL import Image

from . import stage_render

logger = logging.getLogger(__name__)

# Bump when changing PDF layout — invalidates the S3 cache key so old
# sparse PDFs aren't served after a deploy.
PDF_LAYOUT_VERSION = "v2"

PHASES_BUCKET_DEFAULT = "liverra-phases-eu-central-1"
ANALYSES_BUCKET_DEFAULT = "liverra-analyses-eu-central-1"

# Cap lesion previews at 10 (matches frontend ReportInlineView).
LESION_PREVIEW_CAP = 10


# ---------------------------------------------------------------------------
# S3 helpers
# ---------------------------------------------------------------------------


def _download_nii(s3_client: Any, bucket: str, key: str) -> Optional[np.ndarray]:
    """Fetch a NIfTI object from S3 and return a (Z, Y, X) numpy array.

    Returns ``None`` (with a logged warning) if the object is missing —
    callers handle the absence gracefully so a missing CT phase still
    produces a degraded-but-readable PDF.
    """
    try:
        obj = s3_client.get_object(Bucket=bucket, Key=key)
    except Exception as exc:  # noqa: BLE001
        logger.warning("report_renderer: missing s3://%s/%s — %s", bucket, key, exc)
        return None
    raw = obj["Body"].read()
    with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=False) as tf:
        tf.write(raw)
        path = tf.name
    try:
        img = sitk.ReadImage(path)
        return sitk.GetArrayFromImage(img)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Watermark
# ---------------------------------------------------------------------------


def _watermark(fig: Figure) -> None:
    """Draw a diagonal "RESEARCH USE ONLY" stripe across the figure."""
    fig.text(
        0.5,
        0.5,
        "RESEARCH USE ONLY",
        fontsize=64,
        color="#bb0000",
        ha="center",
        va="center",
        rotation=30,
        alpha=0.10,
        weight="bold",
        zorder=10,
    )


def _save_page(pdf: PdfPages, fig: Figure) -> None:
    pdf.savefig(fig, bbox_inches="tight")
    plt.close(fig)


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------


def _render_cover(pdf: PdfPages, payload: dict[str, Any]) -> None:
    fig = plt.figure(figsize=(8.5, 11))
    fig.suptitle("LiverRa — Analysis Report", fontsize=20, weight="bold", y=0.95)
    _watermark(fig)

    analysis = payload["analysis"]
    study = payload["study"]
    checkpoints = payload["checkpoints"]

    completed_at = analysis.get("completed_at")
    completed_str = (
        completed_at.astimezone(timezone.utc).isoformat()
        if isinstance(completed_at, datetime)
        else str(completed_at or "—")
    )

    body_lines = [
        f"Patient identifier:    {study.get('patient_ref') or '—'}",
        f"Study Instance UID:    {study.get('study_instance_uid') or '—'}",
        f"Study UUID:            {study.get('id') or '—'}",
        f"Analysis ID:           {analysis['id']}",
        f"Pipeline version:      {analysis.get('pipeline_version') or '—'}",
        f"Status:                {analysis.get('status') or '—'}",
        f"Completed at (UTC):    {completed_str}",
        f"Generated at (UTC):    {datetime.now(timezone.utc).isoformat()}",
    ]
    fig.text(
        0.08,
        0.82,
        "\n".join(body_lines),
        fontsize=11,
        family="monospace",
        va="top",
    )

    fig.text(
        0.08,
        0.55,
        "Model versions per stage",
        fontsize=13,
        weight="bold",
    )
    if checkpoints:
        rows = [
            f"  {cp['stage_no']:>2}. {cp['stage']:<18}  {cp['model_version']}"
            for cp in checkpoints
        ]
        fig.text(
            0.08,
            0.52,
            "\n".join(rows),
            fontsize=10,
            family="monospace",
            va="top",
        )
    else:
        fig.text(0.08, 0.52, "  (no pipeline checkpoints recorded)", fontsize=10, va="top")

    fig.text(
        0.08,
        0.20,
        "RESEARCH USE ONLY — Not for diagnostic use",
        fontsize=12,
        weight="bold",
        color="#bb0000",
    )
    fig.text(
        0.08,
        0.16,
        (
            "This report is generated by the LiverRa investigational pipeline.\n"
            "All measurements are pre-clinical and require surgeon review and\n"
            "validation before any clinical decision."
        ),
        fontsize=9,
        va="top",
    )
    _save_page(pdf, fig)


def _render_volumetry(pdf: PdfPages, segmentations: list[dict[str, Any]]) -> None:
    fig = plt.figure(figsize=(8.5, 11))
    fig.suptitle("Volumetry", fontsize=14, weight="bold")
    _watermark(fig)

    if not segmentations:
        fig.text(
            0.5,
            0.5,
            "No per-anatomy segmentation rows were recorded for this analysis.",
            ha="center",
            va="center",
            fontsize=11,
            color="#666",
        )
        _save_page(pdf, fig)
        return

    headers = ["Category", "Detail", "Volume (ml)", "Source"]
    rows = []
    for seg in segmentations:
        rows.append(
            [
                str(seg.get("anatomy_category") or "—"),
                str(seg.get("anatomy_detail") or "—"),
                (
                    f"{float(seg['volume_ml']):.2f}"
                    if seg.get("volume_ml") is not None
                    else "—"
                ),
                str(seg.get("generation_source") or "ai"),
            ]
        )

    ax = fig.add_subplot(1, 1, 1)
    ax.axis("off")
    table = ax.table(
        cellText=rows,
        colLabels=headers,
        cellLoc="left",
        loc="upper center",
    )
    table.auto_set_font_size(False)
    table.set_fontsize(9)
    table.scale(1.0, 1.4)
    _save_page(pdf, fig)


def _render_flr(pdf: PdfPages, flr: Optional[dict[str, Any]]) -> None:
    fig = plt.figure(figsize=(8.5, 11))
    fig.suptitle("Future Liver Remnant (FLR)", fontsize=14, weight="bold")
    _watermark(fig)

    if not flr:
        fig.text(
            0.5,
            0.5,
            "No FLR calculation available.",
            ha="center",
            va="center",
            fontsize=11,
            color="#666",
        )
        _save_page(pdf, fig)
        return

    def _fmt(value: Any, suffix: str = "") -> str:
        if value is None:
            return "—"
        try:
            return f"{float(value):.2f}{suffix}"
        except (TypeError, ValueError):
            return str(value)

    lines = [
        f"Total liver volume:           {_fmt(flr.get('total_ml'), ' ml')}",
        f"Future liver remnant (FLR):   {_fmt(flr.get('flr_ml'), ' ml')}",
        f"FLR % of total:               {_fmt(flr.get('flr_pct'), ' %')}",
        f"Functional remnant %:         {_fmt(flr.get('remnant_pct_functional'), ' %')}",
        f"Resected volume:              {_fmt(flr.get('resected_volume_ml'), ' ml')}",
        f"Author:                       {flr.get('author') or '—'}",
    ]
    fig.text(0.08, 0.85, "\n".join(lines), fontsize=11, family="monospace", va="top")

    plane_pose = flr.get("plane_pose")
    fig.text(0.08, 0.55, "Plane pose (JSON):", fontsize=12, weight="bold")
    fig.text(
        0.08,
        0.52,
        str(plane_pose) if plane_pose is not None else "—",
        fontsize=9,
        family="monospace",
        va="top",
        wrap=True,
    )

    _save_page(pdf, fig)


# ---------------------------------------------------------------------------
# v2 helpers — mirror frontend ReportInlineView page-by-page.
#
# Each "stage image" page calls the same matplotlib renderer the
# browser already uses (`stage_render.render_*`), so the PDF and the
# on-screen report consume identical pixels. PNG bytes from the
# stage renderer are decoded with PIL and embedded as a single
# imshow into a portrait/landscape PDF page.
# ---------------------------------------------------------------------------


def _liver_volume_ml(segmentations: list[dict[str, Any]]) -> Optional[float]:
    """Sum the volume of all rows whose anatomy_category == 'liver'."""
    total = 0.0
    found = False
    for seg in segmentations:
        if (seg.get("anatomy_category") or "").lower() == "liver":
            v = seg.get("volume_ml")
            if v is not None:
                try:
                    total += float(v)
                    found = True
                except (TypeError, ValueError):
                    continue
    return total if found else None


def _flr_plane_z(payload: dict[str, Any]) -> Optional[int]:
    """Extract the z_index from FLR plane_pose JSON. Mirrors the
    extraction logic in api/analysis.py:render_flr_endpoint."""
    flr = payload.get("flr") or {}
    plane = flr.get("plane_pose") or {}
    if isinstance(plane, dict):
        z = plane.get("z_index")
        if z is not None:
            try:
                return int(z)
            except (TypeError, ValueError):
                return None
    return None


def _embed_png_page(
    pdf: PdfPages,
    png_bytes: bytes,
    title: str,
    *,
    figsize: tuple[float, float] = (11.0, 8.5),
) -> None:
    """Render a single PDF page that contains one PNG image + title."""
    img = Image.open(io.BytesIO(png_bytes))
    fig = plt.figure(figsize=figsize)
    fig.suptitle(title, fontsize=14, weight="bold", y=0.98)
    _watermark(fig)
    ax = fig.add_subplot(1, 1, 1)
    ax.imshow(np.asarray(img))
    ax.axis("off")
    fig.tight_layout(rect=(0, 0, 1, 0.95))
    _save_page(pdf, fig)


def _render_placeholder(pdf: PdfPages, stage_name: str) -> None:
    """Single page card explaining a stage couldn't be rendered."""
    fig = plt.figure(figsize=(11.0, 8.5))
    fig.suptitle(stage_name.replace("_", " ").title(), fontsize=14, weight="bold", y=0.98)
    _watermark(fig)
    fig.text(
        0.5,
        0.5,
        f"No {stage_name.replace('_', ' ')} data available for this analysis.",
        ha="center",
        va="center",
        fontsize=12,
        color="#666",
        style="italic",
    )
    _save_page(pdf, fig)


def _render_stage_image(
    pdf: PdfPages,
    stage_name: str,
    title: str,
    render_fn: Any,
    s3: Any,
    analysis_id: UUID,
    study_id: UUID,
    extra_args: tuple = (),
) -> None:
    """Call a stage_render.render_* function, embed its PNG as a page.

    On any failure (exception, None return, missing data) renders a
    placeholder card. The PDF NEVER fails because of one bad stage.
    """
    try:
        png_bytes = render_fn(s3, analysis_id, study_id, *extra_args)
    except Exception as exc:  # noqa: BLE001
        logger.warning("stage %s failed: %s", stage_name, exc)
        png_bytes = None
    if png_bytes is None:
        _render_placeholder(pdf, stage_name)
        return
    try:
        _embed_png_page(pdf, png_bytes, title)
    except Exception as exc:  # noqa: BLE001
        logger.warning("stage %s embed failed: %s", stage_name, exc)
        _render_placeholder(pdf, stage_name)


def _render_stats_summary(pdf: PdfPages, payload: dict[str, Any]) -> None:
    """2x2 grid of headline numbers — liver volume, FLR%, lesion count, status."""
    fig = plt.figure(figsize=(8.5, 11))
    fig.suptitle("Summary", fontsize=18, weight="bold", y=0.95)
    _watermark(fig)

    flr = payload.get("flr") or {}
    liver_ml = _liver_volume_ml(payload.get("segmentations") or [])
    lesion_count = len(payload.get("lesions") or [])
    status = (payload.get("analysis") or {}).get("status") or "—"

    def _fmt_ml(v: Any) -> str:
        if v is None:
            return "—"
        try:
            return f"{float(v):.0f} ml"
        except (TypeError, ValueError):
            return "—"

    def _fmt_pct(v: Any) -> str:
        if v is None:
            return "—"
        try:
            return f"{float(v):.1f}%"
        except (TypeError, ValueError):
            return "—"

    cards = [
        ("Liver volume", _fmt_ml(liver_ml), "#1a365d"),
        (
            "Future Liver Remnant",
            f"{_fmt_pct(flr.get('flr_pct'))}\n({_fmt_ml(flr.get('flr_ml'))})",
            "#2b6cb0",
        ),
        ("Lesions detected", str(lesion_count), "#92400e" if lesion_count else "#1a7a3a"),
        ("Pipeline status", str(status), "#1a7a3a" if status in ("completed", "complete") else "#92400e"),
    ]

    # 2x2 grid layout
    positions = [(0.10, 0.55), (0.55, 0.55), (0.10, 0.20), (0.55, 0.20)]
    card_w, card_h = 0.35, 0.28
    for (label, value, color), (x, y) in zip(cards, positions):
        # Card background rectangle
        fig.patches.append(
            Rectangle(
                (x, y),
                card_w,
                card_h,
                facecolor="#f7fafc",
                edgecolor="#cbd5e0",
                linewidth=1.0,
                transform=fig.transFigure,
                zorder=1,
            )
        )
        fig.text(x + 0.02, y + card_h - 0.04, label, fontsize=11, color="#4a5568", weight="medium")
        fig.text(
            x + card_w / 2,
            y + card_h / 2 - 0.02,
            value,
            ha="center",
            va="center",
            fontsize=20,
            color=color,
            weight="bold",
        )
    _save_page(pdf, fig)


def _render_qc_flags(pdf: PdfPages, qc_flags: list[dict[str, Any]]) -> None:
    """Stacked colored cards for each QC flag. Skipped if no flags."""
    if not qc_flags:
        return
    fig = plt.figure(figsize=(8.5, 11))
    fig.suptitle("Quality control notes", fontsize=14, weight="bold", y=0.95)
    _watermark(fig)

    color_map = {"warn": ("#fff3cd", "#856404"), "info": ("#cce5ff", "#0c5394")}
    y = 0.85
    card_h = 0.08
    for flag in qc_flags[:8]:  # cap on one page
        level = (flag.get("level") or "info").lower()
        bg, fg = color_map.get(level, color_map["info"])
        fig.patches.append(
            Rectangle(
                (0.08, y - card_h),
                0.84,
                card_h,
                facecolor=bg,
                edgecolor=fg,
                linewidth=0.8,
                transform=fig.transFigure,
                zorder=1,
            )
        )
        fig.text(
            0.10,
            y - 0.025,
            f"[{level.upper()}] {flag.get('code') or '—'}",
            fontsize=10,
            weight="bold",
            color=fg,
        )
        fig.text(
            0.10,
            y - 0.055,
            str(flag.get("message") or "")[:140],
            fontsize=9,
            color=fg,
        )
        y -= card_h + 0.02
        if y < 0.10:
            break
    _save_page(pdf, fig)


def _render_lesion_previews(
    pdf: PdfPages,
    s3: Any,
    analysis_id: UUID,
    study_id: UUID,
    lesions: list[dict[str, Any]],
) -> None:
    """One thumbnail per lesion (capped at LESION_PREVIEW_CAP). Each
    on its own page — the stage_render lesion thumbnail is wide
    (3 axes + enhancement curve) so it deserves a full landscape page."""
    if not lesions:
        return
    capped = lesions[:LESION_PREVIEW_CAP]
    overflow = len(lesions) - len(capped)
    for idx, le in enumerate(capped, start=1):
        lesion_id = le.get("id")
        if lesion_id is None:
            continue
        try:
            png_bytes = stage_render.render_lesion_thumbnail(
                s3, analysis_id, study_id, lesion_id,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("lesion %s render failed: %s", lesion_id, exc)
            png_bytes = None

        diameter = le.get("longest_diameter_mm")
        diameter_str = f"{float(diameter):.1f} mm" if diameter is not None else "—"
        klass = le.get("suggested_class") or le.get("classification") or "unclassified"
        couinaud = le.get("couinaud_location") or le.get("couinaud_segment") or "—"
        title = (
            f"Lesion #{idx} • {str(lesion_id)[:8]} • Couinaud {couinaud} • "
            f"{diameter_str} • {klass}"
        )
        if png_bytes is None:
            fig = plt.figure(figsize=(11.0, 8.5))
            fig.suptitle(title, fontsize=12, weight="bold", y=0.98)
            _watermark(fig)
            fig.text(
                0.5, 0.5,
                "Lesion thumbnail unavailable\n(mask not yet written to object store)",
                ha="center", va="center", fontsize=11, color="#666",
            )
            _save_page(pdf, fig)
        else:
            try:
                _embed_png_page(pdf, png_bytes, title)
            except Exception as exc:  # noqa: BLE001
                logger.warning("lesion %s embed failed: %s", lesion_id, exc)

    if overflow > 0:
        fig = plt.figure(figsize=(8.5, 4))
        _watermark(fig)
        fig.text(
            0.5,
            0.5,
            f"+{overflow} more lesion(s) not shown — see full list in the live report.",
            ha="center",
            va="center",
            fontsize=11,
            style="italic",
            color="#666",
        )
        _save_page(pdf, fig)


def _render_pipeline_table(pdf: PdfPages, payload: dict[str, Any]) -> None:
    """Pipeline checkpoint table — mirrors browser ReportInlineView checkpoint section."""
    checkpoints = payload.get("checkpoints") or []
    fig = plt.figure(figsize=(11.0, 8.5))
    fig.suptitle("Pipeline checkpoints", fontsize=14, weight="bold", y=0.96)
    _watermark(fig)

    if not checkpoints:
        fig.text(
            0.5, 0.5,
            "No pipeline checkpoints recorded.",
            ha="center", va="center", fontsize=11, color="#666",
        )
        _save_page(pdf, fig)
        return

    headers = ["#", "Stage", "Model version", "License (8)", "Written at"]
    rows: list[list[str]] = []
    for cp in checkpoints:
        license_hash = cp.get("model_license_hash") or ""
        written = cp.get("written_at")
        written_str = (
            written.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
            if isinstance(written, datetime)
            else (str(written) if written else "—")
        )
        rows.append(
            [
                str(cp.get("stage_no") if cp.get("stage_no") is not None else "—"),
                str(cp.get("stage") or "—"),
                str(cp.get("model_version") or "—"),
                str(license_hash)[:8] if license_hash else "—",
                written_str,
            ]
        )

    ax = fig.add_subplot(1, 1, 1)
    ax.axis("off")
    table = ax.table(
        cellText=rows,
        colLabels=headers,
        cellLoc="left",
        loc="upper center",
    )
    table.auto_set_font_size(False)
    table.set_fontsize(9)
    table.scale(1.0, 1.4)
    _save_page(pdf, fig)


# ---------------------------------------------------------------------------
# Data loading (sync — caller wraps in run_in_executor as needed)
# ---------------------------------------------------------------------------


def _load_payload_sync(
    analysis_id: UUID, db_url: str
) -> dict[str, Any]:
    """Fetch all DB rows for the report. Uses sync psycopg for portability."""
    import psycopg

    sync_url = db_url
    if sync_url.startswith("postgresql+asyncpg://"):
        sync_url = sync_url.replace("postgresql+asyncpg://", "postgresql://", 1)

    with psycopg.connect(sync_url) as conn:
        conn.autocommit = True
        cur = conn.cursor()

        cur.execute(
            """
            SELECT id, study_id, tenant_id, status, queued_at, started_at,
                   completed_at, error_slug, pipeline_version, model_versions,
                   implausible_output_reason
            FROM analysis WHERE id = %s
            """,
            (str(analysis_id),),
        )
        row = cur.fetchone()
        if row is None:
            raise LookupError(f"analysis {analysis_id} not found")
        cols = [d.name for d in cur.description]
        analysis = dict(zip(cols, row))

        cur.execute(
            """
            SELECT id, study_instance_uid, patient_ref, received_at,
                   ingestion_outcome
            FROM study WHERE id = %s
            """,
            (str(analysis["study_id"]),),
        )
        srow = cur.fetchone()
        cols = [d.name for d in cur.description] if srow else []
        study = dict(zip(cols, srow)) if srow else {}

        cur.execute(
            """
            SELECT stage_no, stage, output_uri, written_at, model_version,
                   model_license_hash
            FROM pipeline_checkpoint WHERE analysis_id = %s
            ORDER BY stage_no
            """,
            (str(analysis_id),),
        )
        cp_cols = [d.name for d in cur.description]
        checkpoints = [dict(zip(cp_cols, r)) for r in cur.fetchall()]

        cur.execute(
            """
            SELECT id, anatomy_category, anatomy_detail, volume_ml,
                   generation_source, snomed_code
            FROM segmentation WHERE analysis_id = %s
            ORDER BY anatomy_category NULLS LAST, anatomy_detail
            """,
            (str(analysis_id),),
        )
        seg_cols = [d.name for d in cur.description]
        segmentations = [dict(zip(seg_cols, r)) for r in cur.fetchall()]

        cur.execute(
            """
            SELECT id, plane_pose, total_ml, flr_ml, flr_pct,
                   resected_volume_ml, remnant_volume_ml,
                   remnant_pct_functional, author, computed_at
            FROM flr_calculation WHERE analysis_id = %s
            ORDER BY computed_at DESC LIMIT 1
            """,
            (str(analysis_id),),
        )
        frow = cur.fetchone()
        flr = dict(zip([d.name for d in cur.description], frow)) if frow else None

        cur.execute(
            """
            SELECT l.id, l.couinaud_segment, l.couinaud_location,
                   l.longest_diameter_mm, l.volume_ml, l.discovery_source,
                   l.classification, c.suggested_class
            FROM lesion l
            LEFT JOIN classification c ON c.lesion_id = l.id
            WHERE l.analysis_id = %s
            ORDER BY l.id
            """,
            (str(analysis_id),),
        )
        l_cols = [d.name for d in cur.description]
        lesions = [dict(zip(l_cols, r)) for r in cur.fetchall()]

    return {
        "analysis": analysis,
        "study": study,
        "checkpoints": checkpoints,
        "segmentations": segmentations,
        "flr": flr,
        "lesions": lesions,
    }


# ---------------------------------------------------------------------------
# Public render function
# ---------------------------------------------------------------------------


def render_analysis_pdf(
    analysis_id: UUID,
    *,
    db_url: Optional[str] = None,
    s3_client: Any = None,
    phases_bucket: Optional[str] = None,
    analyses_bucket: Optional[str] = None,
) -> bytes:
    """Render a multi-page PDF for ``analysis_id`` and return raw bytes.

    Args:
        analysis_id: UUID of the analysis row to render.
        db_url: SQLAlchemy/psycopg-compatible URL. Falls back to
            ``DATABASE_URL`` / ``LIVERRA_DB_URL`` env vars.
        s3_client: Optional pre-built boto3 S3 client. When ``None``
            we build one honoring ``AWS_ENDPOINT_URL`` for MinIO.
        phases_bucket: CT phases bucket override.
        analyses_bucket: analyses (mask) bucket override.

    The function NEVER raises on missing CT/mask objects — those
    pages render a "data unavailable" placeholder so the report still
    delivers the structured metadata for the surgeon.
    """
    db_url = (
        db_url
        or os.environ.get("LIVERRA_DB_URL")
        or os.environ.get("DATABASE_URL")
        or "postgresql://liverra:liverra@localhost:5432/liverra"
    )

    if s3_client is None:
        import boto3

        s3_client = boto3.client(
            "s3",
            region_name=os.environ.get("AWS_REGION", "eu-central-1"),
            endpoint_url=os.environ.get("AWS_ENDPOINT_URL"),
            aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
            aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
        )

    phases_bucket = phases_bucket or os.environ.get(
        "S3_PHASES_BUCKET", PHASES_BUCKET_DEFAULT
    )
    analyses_bucket = analyses_bucket or os.environ.get(
        "LIVERRA_ANALYSES_BUCKET", ANALYSES_BUCKET_DEFAULT
    )

    payload = _load_payload_sync(analysis_id, db_url)
    study = payload["study"]
    study_uuid = study.get("id")

    # QC flags computed live from the parenchyma mask (no DB column).
    qc_flags: list[dict[str, Any]] = []
    if study_uuid:
        try:
            from . import qc_flags as qc_module
            qc_flags = qc_module.compute_qc_flags(s3_client, analysis_id, study_uuid) or []
        except Exception as exc:  # noqa: BLE001
            logger.info("qc_flags compute skipped: %s", exc)

    buf = io.BytesIO()
    with PdfPages(buf) as pdf:
        # 1. Cover (existing — analysis metadata + model versions)
        _render_cover(pdf, payload)

        # 2. Headline stats grid
        _render_stats_summary(pdf, payload)

        # 3. QC flags (skipped if empty)
        _render_qc_flags(pdf, qc_flags)

        # 4-8. Per-stage rendered images — same source as browser
        if study_uuid:
            _render_stage_image(
                pdf, "parenchyma", "Parenchyma — multi-slice with liver contour",
                stage_render.render_parenchyma, s3_client, analysis_id, study_uuid,
            )
            _render_stage_image(
                pdf, "vessels", "Vessels — portal + hepatic vein tree",
                stage_render.render_vessels, s3_client, analysis_id, study_uuid,
            )
            _render_stage_image(
                pdf, "flr", "Future Liver Remnant — resection plane visualisation",
                stage_render.render_flr, s3_client, analysis_id, study_uuid,
                extra_args=(_flr_plane_z(payload),),
            )
            _render_stage_image(
                pdf, "four_phase", "4-phase comparison",
                stage_render.render_four_phase, s3_client, analysis_id, study_uuid,
            )
            _render_stage_image(
                pdf, "mesh3d", "3D mesh — liver parenchyma",
                stage_render.render_mesh3d, s3_client, analysis_id, study_uuid,
            )

        # 9. Volumetry table (existing)
        _render_volumetry(pdf, payload["segmentations"])

        # 10. FLR numeric table (existing — kept alongside the FLR plane image)
        _render_flr(pdf, payload["flr"])

        # 11. Lesion previews — capped at LESION_PREVIEW_CAP, mirrors browser
        if study_uuid:
            _render_lesion_previews(
                pdf, s3_client, analysis_id, study_uuid, payload["lesions"],
            )

        # 12. Pipeline checkpoint table
        _render_pipeline_table(pdf, payload)

    return buf.getvalue()


__all__ = ["render_analysis_pdf"]
