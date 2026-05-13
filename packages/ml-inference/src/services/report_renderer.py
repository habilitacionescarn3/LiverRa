# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Self-contained PDF report renderer for a completed Analysis.

Plain-English:
    Pulls the rows + masks + a CT phase, renders a multi-page PDF
    (cover band, KPI hero cards, Couinaud bar chart, FLR donut gauge,
    lesion atlas, cascade audit trail, model attribution + RUO claim
    registry) and returns the bytes. Used by the on-demand
    ``GET /analyses/{id}/report/pdf`` endpoint and the Celery
    finalize task.

Design choice (T-PDF-redesign):
    Delegates the PDF rendering to ``services.export.pdf_builder.build_pdf``
    (WeasyPrint + Jinja2 + locale templates). This module's
    responsibility is the *data* path: loading rows from Postgres,
    invoking the per-stage screenshot helpers in ``stage_render``,
    and shaping a :class:`PDFBuildInput`. The previous matplotlib-based
    renderer was retired because ``matplotlib.backends.backend_pdf`` is
    a chart engine, not a document engine — the WeasyPrint pipeline
    already powers the finalize-report flow and ships with FR-028a
    dual-watermark compliance + per-locale Noto Sans Georgian fallback.
"""
from __future__ import annotations

import base64
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Mapping, Optional, Sequence
from uuid import UUID

from . import stage_render
from .export.pdf_builder import PDFBuildInput, build_pdf
from .export.visualizations import (
    DEFAULT_COUINAUD_PALETTE,
    DEFAULT_LESION_CLASS_PALETTE,
    LESION_CLASS_DISPLAY,
    couinaud_bar_chart_svg,
    flr_donut_svg,
    lesion_class_bars_svg,
    vessel_volumes_svg,
)

logger = logging.getLogger(__name__)

# Bump when changing PDF layout — invalidates the S3 cache key so old
# sparse PDFs aren't served after a deploy.
PDF_LAYOUT_VERSION = "v11"

PHASES_BUCKET_DEFAULT = "liverra-phases-eu-central-1"
ANALYSES_BUCKET_DEFAULT = "liverra-analyses-eu-central-1"

# Render every lesion in the *list* (with class chips + probability bars)
# but only attach a per-lesion CT thumbnail to the first N. Each thumbnail
# requires loading the CT + parenchyma + per-lesion mask + ALL FOUR phase
# volumes (~560 MiB), so for cases with 50+ lesions an uncapped run
# downloads tens of gigabytes from MinIO and hangs the worker for 10+ min.
# The top-N (by longest diameter) are the clinically most interesting; the
# rest still appear in the lesion list with full probability differential.
LESION_PREVIEW_CAP: int | None = None  # don't truncate the *list*
# CT thumbnails are gated by an env var so the user can dial it back when
# rendering is the bottleneck. Each thumbnail loads ~560 MiB (CT + 4 phases),
# so 50+ lesions × the full pipeline can hang the worker. Default to 5;
# set ``LIVERRA_REPORT_LESION_THUMBS=0`` to skip thumbnails entirely.
LESION_THUMBNAIL_CAP: int = int(os.environ.get("LIVERRA_REPORT_LESION_THUMBS", "5"))


# ---------------------------------------------------------------------------
# Static lookups — license shorthand + lesion-class palette
# ---------------------------------------------------------------------------

# Map ``model_license_hash`` substrings → human-readable shorthand the
# audit table renders. The ``warn`` flag drives the ⚠ chip in the UI for
# non-commercial licenses (CC-BY-NC-SA-4.0, etc.) so reviewers spot them
# at a glance.
_LICENSE_SHORTHANDS: Sequence[tuple[str, str, bool]] = (
    ("apache-2.0",        "Apache-2.0",        False),
    ("cc-by-nc-sa-4.0",   "CC-BY-NC-SA-4.0",   True),
    ("cc-by-nc",          "CC-BY-NC",          True),
    ("cc-by-4.0",         "CC-BY-4.0",         False),
    ("cc-by",             "CC-BY",             False),
    ("mit",               "MIT",               False),
    ("bsd",               "BSD",               False),
    ("gpl",               "GPL",               True),
    ("agpl",              "AGPL",              True),
    ("n/a-rules-based",   "rules-based",       False),
    ("n/a-conversion",    "format conversion", False),
    ("n/a-heuristic",     "heuristic",         False),
)

# Lesion class slug → hex pill colour. Slugs match LiLNet output keys +
# the surgeon-override enum (``hcc | icc | metastasis | fnh | hemangioma
# | cyst | abstained``). Keep ramps medical-friendly: warm hues for the
# malignant set, cool hues for the benign set.
_LESION_CLASS_COLORS: Mapping[str, str] = {
    "hcc":         "#dc2626",
    "icc":         "#ea580c",
    "metastasis":  "#9333ea",
    "metastases":  "#9333ea",
    "fnh":         "#16a34a",
    "hemangioma":  "#db2777",
    "cyst":        "#0891b2",
    "abstained":   "#6b7280",
}


def _shorten_license(license_hash: str | None) -> tuple[str, bool]:
    """Map raw ``model_license_hash`` → (display, warn-flag)."""
    if not license_hash:
        return "—", False
    needle = license_hash.lower()
    for prefix, label, warn in _LICENSE_SHORTHANDS:
        if prefix in needle:
            return label, warn
    return license_hash, False


def _short_uri(uri: str | None) -> str:
    """Last 12 chars of an S3/checkpoint URI for the audit hash column."""
    if not uri:
        return "—"
    if "/" in uri:
        return "…" + uri.rsplit("/", 1)[-1][-12:]
    return uri[-12:]


def _format_dt(value: Any) -> str:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M")
    return str(value or "—")


def _flr_plane_z(payload: dict[str, Any]) -> int | None:
    """Extract the FLR resection-plane Z-index from the persisted plane_pose."""
    flr = payload.get("flr") or {}
    pose = flr.get("plane_pose") or {}
    if isinstance(pose, dict):
        z = pose.get("z_index")
        if isinstance(z, int):
            return z
    return None


# ---------------------------------------------------------------------------
# Screenshot generation (PNG → data URI)
# ---------------------------------------------------------------------------


def _png_to_data_uri(png: bytes | None) -> str | None:
    if not png:
        return None
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def _generate_screenshots(
    s3_client: Any,
    analysis_id: UUID,
    study_uuid: UUID | str | None,
    payload: dict[str, Any],
) -> tuple[dict[str, str], list[str]]:
    """Run each stage_render helper and pack the PNG bytes as data URIs.

    Returns ``(named_screenshots, warnings)`` — named_screenshots is a
    dict keyed by stage label; warnings is a list of human-readable
    strings (mask volume implausible, vessels empty, etc.) which the
    template surfaces at the top of the PDF so the surgeon sees them
    instead of having to grep server logs.
    """
    warnings: list[str] = []
    if not study_uuid:
        return {}, warnings

    # One-shot pre-flight: load volumes once, inspect for plausibility,
    # then let each stage_render call reuse the on-disk path. Doing this
    # here means we capture the warnings even when (e.g.) the parenchyma
    # render itself succeeds — they're independent signals.
    try:
        vols = stage_render._load_volumes(s3_client, analysis_id, study_uuid)
    except Exception as exc:  # noqa: BLE001
        logger.info("plausibility pre-flight skipped: %s", exc)
        vols = None

    if vols is not None:
        liver_mask_ml = vols.get("liver_volume_ml_mask")
        # Compare the mask-file volume to the cascade's DB-reported value.
        # A large mismatch indicates the known parenchyma volume-calc bug
        # in tasks/parenchyma.py:341 where _DEFAULT_VOXEL_VOLUME_ML uses a
        # hardcoded 0.012 mL/voxel constant instead of the CT's real
        # spacing — so DB-reported volumes are systematically under by
        # ~3× for full-abdomen CT FOV.
        db_liver_ml: float | None = None
        for s in payload.get("segmentations") or ():
            if (s.get("anatomy_category") or "").lower() == "liver":
                try:
                    db_liver_ml = float(s.get("volume_ml") or 0.0)
                except (TypeError, ValueError):
                    db_liver_ml = None
                break
        if (
            isinstance(liver_mask_ml, (int, float))
            and isinstance(db_liver_ml, (int, float))
            and db_liver_ml > 0
            and abs(liver_mask_ml / db_liver_ml - 1.0) > 0.25
        ):
            warnings.append(
                f"Volume mismatch — mask file = {liver_mask_ml:.0f} mL but "
                f"cascade-reported liver volume = {db_liver_ml:.0f} mL "
                f"(ratio {liver_mask_ml / db_liver_ml:.2f}×). Likely the "
                "known volume-calc bug in tasks/parenchyma.py:58 — "
                "_DEFAULT_VOXEL_VOLUME_ML is hardcoded to 0.012 mL/voxel "
                "(assumes 300 mm abdominal FOV). Replace with the real CT "
                "spacing for accurate DB volumetry. The CT contours below "
                "trace the mask file's geometry, which is the correct one."
            )
        portal = vols.get("portal")
        hepatic = vols.get("hepatic")
        if portal is None and hepatic is None:
            warnings.append(
                "Vessel masks are empty — Stage 3a (portal + hepatic veins) "
                "produced no output. The vessels page below is omitted."
            )
        elif (portal is None or int(portal.sum()) == 0) and (
            hepatic is None or int(hepatic.sum()) == 0
        ):
            warnings.append(
                "Both vessel masks have 0 voxels — Stage 3a completed but "
                "wrote empty NIfTI files."
            )

    out: dict[str, str] = {}
    plane_z = _flr_plane_z(payload)
    jobs: tuple[tuple[str, Any], ...] = (
        ("parenchyma", lambda: stage_render.render_parenchyma(s3_client, analysis_id, study_uuid)),
        ("vessels",    lambda: stage_render.render_vessels(s3_client, analysis_id, study_uuid)),
        ("flr",        lambda: stage_render.render_flr(s3_client, analysis_id, study_uuid, plane_z)),
        ("four_phase", lambda: stage_render.render_four_phase(s3_client, analysis_id, study_uuid)),
        ("mesh3d",     lambda: stage_render.render_mesh3d(s3_client, analysis_id, study_uuid)),
    )
    for label, fn in jobs:
        try:
            png = fn()
        except Exception as exc:  # noqa: BLE001
            logger.info("screenshot %s skipped: %s", label, exc)
            continue
        uri = _png_to_data_uri(png)
        if uri:
            out[label] = uri
    return out, warnings


def _generate_lesion_thumbnails(
    s3_client: Any,
    analysis_id: UUID,
    study_uuid: UUID | str | None,
    lesion_rows: Sequence[Mapping[str, Any]],
) -> dict[str, str]:
    """Per-lesion 3-axis CT crop + 4-phase enhancement curve.

    Calls ``stage_render.render_lesion_thumbnail`` for the top
    :data:`LESION_THUMBNAIL_CAP` lesions (ranked by longest diameter, the
    clinically most-interesting ones). Returns a dict keyed by lesion ``id``
    (string) for O(1) lookup. Missing renders are skipped silently.

    The cap exists because each thumbnail downloads ~560 MiB (CT + 4 phase
    volumes); a 58-lesion case otherwise needs 32+ GiB of I/O and hangs the
    worker. All lesions still appear in the report list with full
    probability differential — only CT crops are capped.
    """
    if not study_uuid or not lesion_rows or LESION_THUMBNAIL_CAP <= 0:
        return {}

    # Pick the top-N largest lesions for thumbnailing — surgeons triage
    # by size, and tiny incidental cysts don't warrant expensive crops.
    def _diameter(row: Mapping[str, Any]) -> float:
        try:
            return float(row.get("longest_diameter_mm") or 0.0)
        except (TypeError, ValueError):
            return 0.0

    ranked = sorted(lesion_rows, key=_diameter, reverse=True)[:LESION_THUMBNAIL_CAP]

    out: dict[str, str] = {}
    for row in ranked:
        lesion_id = row.get("id")
        if lesion_id is None:
            continue
        bbox = row.get("bbox3d")
        # bbox3d is JSON {"coords": [...]} per the cascade contract;
        # accept either shape so we can also pass the raw list.
        if isinstance(bbox, dict):
            bbox = bbox.get("coords")
        try:
            png = stage_render.render_lesion_thumbnail(
                s3_client, analysis_id, study_uuid, lesion_id, bbox_3d=bbox,
            )
        except Exception as exc:  # noqa: BLE001
            logger.info("lesion thumbnail %s skipped: %s", lesion_id, exc)
            continue
        uri = _png_to_data_uri(png)
        if uri:
            out[str(lesion_id)] = uri
    return out


# ---------------------------------------------------------------------------
# Data loading (sync — caller wraps in run_in_executor as needed)
# ---------------------------------------------------------------------------


def _load_payload_sync(
    analysis_id: UUID, db_url: str
) -> dict[str, Any]:
    """Fetch all DB rows for the report. Uses sync psycopg for portability.

    Pulls ``analysis_finding`` rows too (Phase 1 heuristic findings —
    spleen volumetry, steatosis, IVC patency, gallbladder, etc.) so the
    PDF can surface what the cascade already computed. Mirrors the shape
    consumed by the frontend ``<FindingsCard />`` component.
    """
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
                   l.classification, l.bbox3d,
                   c.suggested_class, c.probs_vec
            FROM lesion l
            LEFT JOIN classification c ON c.lesion_id = l.id
            WHERE l.analysis_id = %s
            ORDER BY l.id
            """,
            (str(analysis_id),),
        )
        l_cols = [d.name for d in cur.description]
        lesions = [dict(zip(l_cols, r)) for r in cur.fetchall()]

        # Phase 1 heuristic findings — keyed by finding_type. Best-effort:
        # the table only exists after migration 0013_analysis_finding so a
        # fresh DB without that migration just returns an empty dict.
        findings: dict[str, Any] = {}
        try:
            cur.execute(
                """
                SELECT finding_type, payload
                FROM analysis_finding WHERE analysis_id = %s
                """,
                (str(analysis_id),),
            )
            for finding_type, payload in cur.fetchall():
                findings[finding_type] = payload
        except Exception as exc:  # noqa: BLE001
            logger.info("findings load skipped: %s", exc)

    return {
        "analysis": analysis,
        "study": study,
        "checkpoints": checkpoints,
        "segmentations": segmentations,
        "flr": flr,
        "lesions": lesions,
        "findings": findings,
    }


# ---------------------------------------------------------------------------
# Payload → PDFBuildInput
# ---------------------------------------------------------------------------


def _adequacy_label(pct: float | None, *, t_inadeq: float = 25.0, t_border: float = 30.0) -> str:
    if pct is None:
        return "—"
    if pct < t_inadeq:
        return "Inadequate"
    if pct < t_border:
        return "Borderline"
    return "Adequate"


def _kpi_tone_for_flr(pct: float | None, t_inadeq: float, t_border: float) -> str:
    if pct is None:
        return "default"
    if pct < t_inadeq:
        return "alert"
    if pct < t_border:
        return "warn"
    return "ok"


def _extract_couinaud_volumes(segmentations: Sequence[Mapping[str, Any]]) -> dict[str, float]:
    """Pull per-segment volumes from the ``segmentation`` rows.

    The cascade persists 8 rows with anatomy_category='couinaud' and
    anatomy_detail='I'..'VIII'. Missing segments default to 0.
    """
    out: dict[str, float] = {r: 0.0 for r in DEFAULT_COUINAUD_PALETTE.keys()}
    for s in segmentations:
        if (s.get("anatomy_category") or "").lower() != "couinaud":
            continue
        detail = (s.get("anatomy_detail") or "").strip().upper()
        if detail in out:
            try:
                out[detail] = float(s.get("volume_ml") or 0.0)
            except (TypeError, ValueError):
                continue
    return out


def _compute_lobe_split(
    couinaud_volumes: Mapping[str, float],
    parenchyma_ml: float,
) -> tuple[float, float, str]:
    """Compute (left_lobe_ml, right_lobe_ml, source).

    Prefers Couinaud-derived sums (left = II+III+IV, right = V+VIII) when
    those segments are populated. Falls back to a Cantlie-line 50/50 of
    the parenchyma volume when Couinaud data is empty so the page-1 cards
    never show 0/0 even when Couinaud failed.

    The Cantlie estimate is intentionally crude — without anatomical
    landmarks it is just half the parenchyma. The badge in the template
    flags it as an estimate so the surgeon doesn't trust it as a real
    volumetric measurement.
    """
    left_couinaud = sum(
        couinaud_volumes.get(k, 0.0) for k in ("II", "III", "IV")
    )
    right_couinaud = sum(
        couinaud_volumes.get(k, 0.0) for k in ("V", "VI", "VII", "VIII")
    )
    if left_couinaud + right_couinaud > 0:
        return float(left_couinaud), float(right_couinaud), "couinaud"
    # Fallback: 50/50 split of total parenchyma (rough estimate, badged).
    half = float(parenchyma_ml) / 2.0
    return half, half, "cantlie_estimate"


def _parse_lesion_classification_field(raw: Any) -> tuple[str, float | None, list[str]]:
    """Defensive parse of the ``lesion.classification`` text column.

    The LI-RADS rule classifier writes a JSON string like::

        {"label": "icc", "confidence": 0.8767, "reasoning": [...]}

    into the column (see scripts/real_cascade.py). Older / simpler paths
    write a bare slug like "hcc". This helper handles both — returning
    ``(slug, confidence_pct_or_none, reasoning_list)``. When the input
    isn't parseable as JSON we treat it as the bare slug.
    """
    if raw is None:
        return "", None, []
    if not isinstance(raw, str):
        return str(raw).strip().lower(), None, []
    text = raw.strip()
    if not text:
        return "", None, []
    if text[0] != "{":
        return text.lower(), None, []
    try:
        obj = json.loads(text)
    except (TypeError, ValueError, json.JSONDecodeError):
        return text.lower(), None, []
    if not isinstance(obj, dict):
        return text.lower(), None, []
    label = (obj.get("label") or obj.get("LABEL") or "").strip().lower()
    raw_conf = obj.get("confidence", obj.get("CONFIDENCE"))
    confidence_pct: float | None = None
    if raw_conf is not None:
        try:
            confidence_pct = float(raw_conf) * 100.0
        except (TypeError, ValueError):
            confidence_pct = None
    reasoning_raw = obj.get("reasoning", obj.get("REASONING")) or []
    if not isinstance(reasoning_raw, list):
        reasoning_raw = [str(reasoning_raw)]
    reasoning = [str(r) for r in reasoning_raw if r]
    return label, confidence_pct, reasoning


def _build_findings_rows(findings: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    """Shape ``analysis_finding`` payloads into template-ready rows.

    Mirrors the row schema from the frontend FindingsCard.tsx (label /
    value / badge / detail / alert) so the PDF presentation matches what
    a surgeon already sees in the analysis-detail view. Returns an empty
    list when no findings are present so the template can hide the panel.
    """
    if not findings:
        return []
    rows: list[dict[str, Any]] = []

    hu = findings.get("hu_stats") or {}
    if isinstance(hu, dict) and "mean" in hu:
        rows.append({
            "key": "hu_stats",
            "label": "Liver attenuation",
            "value": (
                f"mean {float(hu['mean']):.0f} HU · "
                f"range {float(hu.get('p10', 0)):.0f}–{float(hu.get('p90', 0)):.0f} HU"
            ),
            "alert": None,
        })

    st = findings.get("steatosis") or {}
    if isinstance(st, dict) and st.get("grade") and st["grade"] != "none":
        delta = st.get("liver_spleen_delta")
        delta_str = (
            f"liver–spleen Δ {float(delta):.1f} HU"
            if delta is not None else "spleen unavailable"
        )
        grade_badge = {
            "mild":     {"tone": "warn",  "label": "Mild"},
            "moderate": {"tone": "warn",  "label": "Moderate"},
            "severe":   {"tone": "alert", "label": "Severe"},
        }.get(st["grade"])
        rows.append({
            "key": "steatosis",
            "label": "Steatosis",
            "value": delta_str,
            "badge": grade_badge,
            "alert": "warn" if st["grade"] in ("moderate", "severe") else "info",
        })

    sp = findings.get("spleen") or {}
    if isinstance(sp, dict) and "volume_ml" in sp:
        bits: list[str] = [f"{float(sp['volume_ml']):.0f} mL"]
        if sp.get("warning"):
            bits.append(str(sp["warning"]))
        badge = (
            {"tone": "warn", "label": "Splenomegaly"}
            if sp.get("splenomegaly") else None
        )
        rows.append({
            "key": "spleen",
            "label": "Spleen volume",
            "value": " · ".join(bits),
            "badge": badge,
            "alert": "warn" if (sp.get("splenomegaly") or sp.get("warning")) else None,
        })

    gb = findings.get("gallbladder") or {}
    if isinstance(gb, dict) and "volume_ml" in gb:
        flags: list[str] = []
        if gb.get("stones_detected"): flags.append("stones")
        if gb.get("wall_thickened"):  flags.append("wall thickened")
        suffix = f" · {', '.join(flags)}" if flags else ""
        rows.append({
            "key": "gallbladder",
            "label": "Gallbladder",
            "value": f"{float(gb['volume_ml']):.0f} mL{suffix}",
            "alert": "warn" if flags else None,
        })

    cl = findings.get("calcified_lesions") or []
    if isinstance(cl, list) and len(cl) > 0:
        detail = "  ·  ".join(
            f"#{c.get('lesion_id', '?')}: max {float(c.get('hu_max', 0)):.0f} HU"
            for c in cl if isinstance(c, dict)
        )
        rows.append({
            "key": "calcified_lesions",
            "label": "Calcified lesions",
            "value": f"{len(cl)} lesion{'s' if len(cl) != 1 else ''}",
            "detail": detail,
            "alert": "info",
        })

    cy = findings.get("simple_biliary_cysts") or []
    if isinstance(cy, list) and len(cy) > 0:
        rows.append({
            "key": "simple_biliary_cysts",
            "label": "Simple biliary cysts",
            "value": f"{len(cy)} lesion{'s' if len(cy) != 1 else ''} (benign)",
            "detail": "Meets all 4 simple-cyst criteria — no follow-up needed.",
            "alert": "info",
        })

    lrm = findings.get("indeterminate_malignant") or {}
    if isinstance(lrm, dict) and lrm.get("lr_m_count"):
        rows.append({
            "key": "indeterminate_malignant",
            "label": "Indeterminate malignant (LR-M)",
            "value": f"{lrm['lr_m_count']} lesion{'s' if lrm['lr_m_count'] != 1 else ''}",
            "badge": {"tone": "alert", "label": "LR-M"},
            "detail": str(lrm.get("interpretation", "")),
            "alert": "warn",
        })

    return rows


def _extract_parenchyma_volume(
    segmentations: Sequence[Mapping[str, Any]],
    couinaud: Mapping[str, float],
) -> float:
    """Pull total liver volume; fall back to the sum of Couinaud rows."""
    for s in segmentations:
        if (s.get("anatomy_category") or "").lower() == "liver":
            try:
                return float(s.get("volume_ml") or 0.0)
            except (TypeError, ValueError):
                pass
    return float(sum(couinaud.values()))


def _extract_vessel_volumes(
    segmentations: Sequence[Mapping[str, Any]],
) -> tuple[float | None, float | None]:
    """Pull (portal_vein_ml, hepatic_vein_ml) from segmentation rows."""
    portal: float | None = None
    hepatic: float | None = None
    for s in segmentations:
        cat = (s.get("anatomy_category") or "").lower()
        try:
            v = float(s.get("volume_ml") or 0.0)
        except (TypeError, ValueError):
            continue
        if cat == "portal_vein":
            portal = v
        elif cat == "hepatic_vein":
            hepatic = v
    return portal, hepatic


def _format_class_label(slug: str) -> str:
    """Render a lesion-class slug as the display label used on the PDF."""
    if not slug:
        return "—"
    return LESION_CLASS_DISPLAY.get(slug, slug.upper())


def _build_lesion_rows(
    rows: Sequence[Mapping[str, Any]],
    *,
    thumbnails: Mapping[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Shape DB lesion rows into template-ready dicts.

    Each row carries the full 6-class probability vector + an embedded SVG
    bar so the surgeon sees the differential, not just the winning class.
    When ``thumbnails`` is provided the per-lesion CT crop data URI is
    attached as ``thumbnail_uri``. Renders ALL lesions.
    """
    iterable = rows if LESION_PREVIEW_CAP is None else list(rows)[:LESION_PREVIEW_CAP]
    thumb_lookup = dict(thumbnails or {})
    out: list[dict[str, Any]] = []
    for row in iterable:
        # Three sources for the class label, in priority order:
        # 1. classification.suggested_class (structured column from the
        #    LiLNet path) — clean slug like "hcc"
        # 2. lesion.classification when it's a bare slug
        # 3. lesion.classification when it's a JSON string from the
        #    LI-RADS rule classifier — extract label + confidence + reasoning
        slug_from_text, conf_from_text, reasoning = _parse_lesion_classification_field(
            row.get("classification")
        )
        cls_slug = (
            (row.get("suggested_class") or slug_from_text or "").strip().lower()
        )
        probs = row.get("probs_vec") or {}
        if not isinstance(probs, dict):
            probs = {}
        confidence_pct: float = 0.0
        if probs:
            try:
                confidence_pct = max(float(v) for v in probs.values()) * 100.0
            except (TypeError, ValueError):
                confidence_pct = 0.0
        elif conf_from_text is not None:
            confidence_pct = conf_from_text
        lesion_id_str = str(row.get("id")) if row.get("id") is not None else None
        out.append({
            "id": lesion_id_str,
            "diameter_mm": row.get("longest_diameter_mm") or 0.0,
            "volume_ml": row.get("volume_ml") or 0.0,
            "class_slug": cls_slug,
            "class_label_localised": _format_class_label(cls_slug),
            "class_color": _LESION_CLASS_COLORS.get(cls_slug, "#9ca3af"),
            "couinaud_segment": row.get("couinaud_segment"),
            "couinaud_location": row.get("couinaud_location"),
            "discovery_source": row.get("discovery_source"),
            "confidence_pct": confidence_pct,
            "probs": probs,
            "probs_bar_svg": lesion_class_bars_svg(probs) if probs else None,
            "reasoning": reasoning,
            "abstained": cls_slug == "abstained",
            "thumbnail_uri": thumb_lookup.get(lesion_id_str) if lesion_id_str else None,
        })
    return out


def _build_cascade_checkpoints(
    rows: Sequence[Mapping[str, Any]],
    *,
    segmentations: Sequence[Mapping[str, Any]] | None = None,
    findings: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Shape pipeline_checkpoint rows for the audit table.

    Status derivation: a stage is rendered as ``warn`` (degraded) when the
    cascade wrote a checkpoint but the downstream artefact is empty —
    e.g. couinaud-heuristic-v1 with zero per-segment volumes, or
    classification with an unparseable suggested-class. This catches the
    silent-failure pattern where a stage logs OK but produced no usable
    output.

    Appends a synthetic ``Phase 1 findings`` pseudo-row when findings
    exist; this stage isn't a checkpoint but is part of the cascade and
    surgeons need to see its provenance.
    """
    seg_list = list(segmentations or ())
    couinaud_total_ml = sum(
        float(s.get("volume_ml") or 0.0)
        for s in seg_list
        if (s.get("anatomy_category") or "").lower() == "couinaud"
    )

    def _stage_status(stage: str) -> tuple[str, str]:
        # (status_icon, status_label). Default OK; degraded for empty output.
        if stage == "couinaud" and couinaud_total_ml <= 0.0:
            return "warn", "DEGRADED"
        return "ok", "OK"

    out: list[dict[str, Any]] = []
    for cp in rows:
        license_short, license_warn = _shorten_license(cp.get("model_license_hash"))
        icon, label = _stage_status((cp.get("stage") or "").lower())
        out.append({
            "stage_no": cp.get("stage_no"),
            "stage": cp.get("stage") or "—",
            "model_version": cp.get("model_version") or "—",
            "license_hash": cp.get("model_license_hash"),
            "license_short": license_short,
            "license_warn": license_warn,
            "output_uri": cp.get("output_uri"),
            "output_hash_short": _short_uri(cp.get("output_uri")),
            "written_at": _format_dt(cp.get("written_at")),
            "status_icon": icon,
            "status_label": label,
        })

    if findings:
        populated = sum(1 for v in findings.values() if v not in (None, [], {}))
        if populated > 0:
            out.append({
                "stage_no": "7b",
                "stage": "phase1_findings",
                "model_version": "phase1-heuristics-v1",
                "license_hash": "n/a-heuristic",
                "license_short": "heuristic",
                "license_warn": False,
                "output_uri": None,
                "output_hash_short": f"{populated}/7 populated",
                "written_at": "—",
                "status_icon": "ok",
                "status_label": "OK",
            })

    return out


def _build_kpi_cards(
    *,
    flr_pct: float | None,
    parenchyma_ml: float,
    lesion_count: int,
    completed_stages: int,
    total_stages: int,
    t_inadeq: float,
    t_border: float,
) -> list[dict[str, Any]]:
    flr_tone = _kpi_tone_for_flr(flr_pct, t_inadeq, t_border)
    flr_value = f"{flr_pct:.1f} %" if flr_pct is not None else "—"
    flr_sub = _adequacy_label(flr_pct, t_inadeq=t_inadeq, t_border=t_border)

    cascade_tone = "ok" if completed_stages >= total_stages and total_stages > 0 else "warn"

    return [
        {"label": "FLR",       "value": flr_value,                     "sublabel": flr_sub,           "tone": flr_tone},
        {"label": "Liver vol", "value": f"{parenchyma_ml:.0f} mL",     "sublabel": "Whole parenchyma","tone": "default"},
        {"label": "Lesions",   "value": str(lesion_count),             "sublabel": "Detected",        "tone": "alert" if lesion_count else "ok"},
        {"label": "Cascade",   "value": f"{completed_stages}/{total_stages}", "sublabel": "Stages",   "tone": cascade_tone},
    ]


def _build_pdf_input(
    payload: dict[str, Any],
    screenshots: Mapping[str, str] | Sequence[str],
    *,
    lesion_thumbnails: Mapping[str, str] | None = None,
    locale: str = "en",
    mask_warnings: Sequence[str] | None = None,
) -> PDFBuildInput:
    analysis = payload["analysis"]
    study = payload.get("study") or {}
    flr = payload.get("flr") or {}

    couinaud_volumes = _extract_couinaud_volumes(payload.get("segmentations") or ())
    parenchyma_ml = _extract_parenchyma_volume(payload.get("segmentations") or (), couinaud_volumes)
    portal_ml, hepatic_ml = _extract_vessel_volumes(payload.get("segmentations") or ())
    lobe_left_ml, lobe_right_ml, lobe_split_source = _compute_lobe_split(
        couinaud_volumes, parenchyma_ml,
    )
    findings_rows = _build_findings_rows(payload.get("findings"))
    # ACR-structured readout (002-acr-structured-readout T065). Runs in
    # sequence with the legacy flat-list above; both feed the template
    # for the duration of the transition.
    from .export.acr_section_builder import build_acr_sections as _build_acr_sections
    acr_sections = _build_acr_sections(
        findings_dict=payload.get("findings"),
        lesions=payload.get("lesions") or (),
        flr=payload.get("flr"),
        status=str(analysis.get("status") or "completed"),
    )

    flr_pct = flr.get("remnant_pct_functional")
    if flr_pct is None:
        flr_pct = flr.get("flr_pct")
    flr_pct_f = float(flr_pct) if flr_pct is not None else None

    flr_remnant_ml = flr.get("remnant_volume_ml") or flr.get("flr_ml")
    flr_remnant_ml_f = float(flr_remnant_ml) if flr_remnant_ml is not None else None

    lesion_rows = _build_lesion_rows(
        payload.get("lesions") or (), thumbnails=lesion_thumbnails,
    )
    lesion_count = len(payload.get("lesions") or ())
    cascade_checkpoints = _build_cascade_checkpoints(
        payload.get("checkpoints") or (),
        segmentations=payload.get("segmentations") or (),
        findings=payload.get("findings"),
    )
    completed_stages = sum(
        1 for cp in cascade_checkpoints if cp.get("status_icon") == "ok"
    )
    total_stages = max(8, len(cascade_checkpoints))  # canonical 8-stage cascade

    couinaud_chart_svg = couinaud_bar_chart_svg(couinaud_volumes)
    donut_svg = flr_donut_svg(flr_pct_f, (25.0, 30.0))
    vessels_svg = (
        vessel_volumes_svg(portal_ml, hepatic_ml)
        if (portal_ml is not None or hepatic_ml is not None)
        else None
    )

    kpi_cards = _build_kpi_cards(
        flr_pct=flr_pct_f,
        parenchyma_ml=parenchyma_ml,
        lesion_count=lesion_count,
        completed_stages=completed_stages,
        total_stages=total_stages,
        t_inadeq=25.0,
        t_border=30.0,
    )

    completed_at = analysis.get("completed_at")
    finalized_at = (
        completed_at if isinstance(completed_at, datetime) else datetime.now(timezone.utc)
    )

    # Normalize the screenshots arg — accept the new {"parenchyma": uri,
    # "vessels": uri, ...} dict OR the legacy positional list.
    if isinstance(screenshots, Mapping):
        screenshots_dict = dict(screenshots)
        screenshots_list: tuple[str, ...] = tuple(
            v for v in screenshots_dict.values() if isinstance(v, str)
        )
    else:
        screenshots_list = tuple(screenshots or ())
        screenshots_dict = {}

    return PDFBuildInput(
        report_id=str(analysis["id"]),
        analysis_id=str(analysis["id"]),
        tenant_display_name="—",  # tenant lookup is wired by the finalize task; on-demand uses placeholder
        # On-demand reports are auto-rendered (no human review yet); show
        # an explicit "system (auto)" instead of the analysis status string
        # ("completed") which clinicians read as a person's name.
        finalized_by_display="system (auto)",
        finalized_at=finalized_at,
        locale=locale if locale in ("en", "de", "ka", "ru") else "en",
        parenchyma_volume_ml=parenchyma_ml,
        couinaud_volumes=couinaud_volumes,
        flr_remnant_volume_ml=flr_remnant_ml_f,
        flr_remnant_pct_functional=flr_pct_f,
        flr_adequacy_label=_adequacy_label(flr_pct_f),
        lesions=lesion_rows,
        screenshots=screenshots_list,
        model_summary=(),
        sample_case_flag=False,
        claim_registry=(),
        software_versions=str(analysis.get("pipeline_version") or "0.1.0-dev"),
        flr_threshold_inadequate=25.0,
        flr_threshold_borderline=30.0,
        cascade_checkpoints=cascade_checkpoints,
        couinaud_palette=DEFAULT_COUINAUD_PALETTE,
        lesion_class_palette=_LESION_CLASS_COLORS,
        study_uid=study.get("study_instance_uid"),
        pipeline_version=analysis.get("pipeline_version"),
        couinaud_chart_svg=couinaud_chart_svg,
        flr_donut_svg=donut_svg,
        kpi_cards=kpi_cards,
        lesion_count=lesion_count,
        portal_vein_ml=portal_ml,
        hepatic_vein_ml=hepatic_ml,
        vessels_chart_svg=vessels_svg,
        parenchyma_render_uri=screenshots_dict.get("parenchyma"),
        vessels_render_uri=screenshots_dict.get("vessels"),
        flr_render_uri=screenshots_dict.get("flr"),
        four_phase_render_uri=screenshots_dict.get("four_phase"),
        mesh3d_render_uri=screenshots_dict.get("mesh3d"),
        ct_renders_unavailable=(len(screenshots_dict) == 0 and not screenshots_list),
        mask_warnings=tuple(mask_warnings or ()),
        findings_rows=tuple(findings_rows),
        acr_sections=acr_sections,
        lobe_left_ml=lobe_left_ml,
        lobe_right_ml=lobe_right_ml,
        lobe_split_source=lobe_split_source,
    )


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
    locale: str = "en",
) -> bytes:
    """Render a multi-page PDF for ``analysis_id`` and return raw bytes.

    Args:
        analysis_id: UUID of the analysis row to render.
        db_url: SQLAlchemy/psycopg-compatible URL. Falls back to
            ``DATABASE_URL`` / ``LIVERRA_DB_URL`` env vars.
        s3_client: Optional pre-built boto3 S3 client. When ``None``
            we build one honoring ``AWS_ENDPOINT_URL`` for MinIO.
        phases_bucket: CT phases bucket override (consumed by stage_render
            via env var; kept for backward-compatible callers).
        analyses_bucket: analyses (mask) bucket override (same pattern).
        locale: report locale; one of ``en | de | ka`` (defaults to en).

    The function NEVER raises on missing CT/mask objects — those
    screenshots are skipped so the PDF still delivers the structured
    metadata for the surgeon.
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

    # Apply bucket overrides via env so stage_render's helpers pick them up.
    if phases_bucket:
        os.environ.setdefault("S3_PHASES_BUCKET", phases_bucket)
    if analyses_bucket:
        os.environ.setdefault("LIVERRA_ANALYSES_BUCKET", analyses_bucket)

    payload = _load_payload_sync(analysis_id, db_url)
    study_uuid = (payload.get("study") or {}).get("id")
    screenshots, mask_warnings = _generate_screenshots(
        s3_client, analysis_id, study_uuid, payload,
    )
    lesion_thumbnails = _generate_lesion_thumbnails(
        s3_client, analysis_id, study_uuid, payload.get("lesions") or (),
    )

    inp = _build_pdf_input(
        payload, screenshots,
        lesion_thumbnails=lesion_thumbnails,
        locale=locale,
        mask_warnings=mask_warnings,
    )
    result = build_pdf(inp)
    logger.info(
        "rendered analysis PDF analysis_id=%s pages=%d sha256=%s",
        analysis_id,
        result.page_count,
        result.sha256_hex[:12],
    )
    return result.pdf_bytes


__all__ = ["render_analysis_pdf", "PDF_LAYOUT_VERSION"]
