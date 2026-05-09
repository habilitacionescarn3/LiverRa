# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Inline SVG generators for the surgeon-facing PDF report.

Plain-English:
    The PDF report needs a Couinaud-segment bar chart and an FLR adequacy
    donut gauge. WeasyPrint can embed inline SVG directly inside the
    Jinja-rendered HTML, so we build the SVG as plain Python strings —
    no matplotlib, no Plotly, no extra wheels. Vector by construction
    means the chart stays crisp at any print resolution.

These helpers return self-contained ``<svg>...</svg>`` strings that
``pdf_builder.build_pdf`` injects into the template via ``{{ svg|safe }}``.
"""
from __future__ import annotations

import math
from typing import Mapping, Sequence

# Default 8-segment palette mirrors theme.css `--liverra-seg-couinaud-*`
# (light theme). Keep this in sync with
# packages/app/src/emr/components/liver/couinaud-constants.ts +
# packages/app/src/emr/styles/theme.css lines 4073-4080.
DEFAULT_COUINAUD_PALETTE: Mapping[str, str] = {
    "I":    "#E8B84F",
    "II":   "#6FA8DC",
    "III":  "#93C47D",
    "IV":   "#E06666",
    "V":    "#B38BDD",
    "VI":   "#F6B26B",
    "VII":  "#76A5AF",
    "VIII": "#D5A6BD",
}

ROMAN_ORDER: Sequence[str] = ("I", "II", "III", "IV", "V", "VI", "VII", "VIII")


def couinaud_bar_chart_svg(
    volumes: Mapping[str, float],
    palette: Mapping[str, str] | None = None,
    *,
    width: int = 360,
    row_height: int = 22,
    label_col: int = 36,
    value_col: int = 110,
) -> str:
    """Render an 8-row horizontal bar chart of Couinaud segment volumes.

    Each row: ``[Roman numeral] [coloured bar] [mL] [%]``. Bar length is
    proportional to that segment's volume relative to the largest segment
    (so visual rank within the chart is meaningful even when total volume
    varies between cases).
    """
    pal = dict(DEFAULT_COUINAUD_PALETTE)
    if palette:
        pal.update(palette)

    total = sum(max(0.0, float(volumes.get(r, 0.0))) for r in ROMAN_ORDER) or 1.0
    max_v = max((float(volumes.get(r, 0.0)) for r in ROMAN_ORDER), default=0.0) or 1.0

    bar_x = label_col
    bar_max_w = width - label_col - value_col
    height = row_height * len(ROMAN_ORDER) + 8

    rows: list[str] = []
    for idx, roman in enumerate(ROMAN_ORDER):
        v = max(0.0, float(volumes.get(roman, 0.0)))
        bar_w = max(2.0, (v / max_v) * bar_max_w) if v > 0 else 0
        pct = (v / total) * 100.0
        y = 4 + idx * row_height
        text_y = y + row_height / 2 + 4
        bar_y = y + 4
        bar_h = row_height - 8
        color = pal.get(roman, "#9ca3af")
        rows.append(
            f'<text x="0" y="{text_y:.1f}" font-size="9" font-weight="700" '
            f'fill="#374151">{roman}</text>'
            f'<rect x="{bar_x}" y="{bar_y:.1f}" width="{bar_max_w}" height="{bar_h}" '
            f'fill="#f3f4f6"/>'
            f'<rect x="{bar_x}" y="{bar_y:.1f}" width="{bar_w:.1f}" height="{bar_h}" '
            f'fill="{color}" rx="2"/>'
            f'<text x="{bar_x + bar_max_w + 6}" y="{text_y:.1f}" font-size="8.5" '
            f'font-weight="600" fill="#111827">{v:.0f} mL</text>'
            f'<text x="{bar_x + bar_max_w + 60}" y="{text_y:.1f}" font-size="8.5" '
            f'fill="#6b7280">{pct:.1f} %</text>'
        )

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'class="couinaud-chart-svg" width="100%">'
        + "".join(rows)
        + "</svg>"
    )


def flr_donut_svg(
    pct: float | None,
    thresholds: tuple[float, float] = (25.0, 30.0),
    *,
    size: int = 180,
    stroke: int = 22,
) -> str:
    """Render an FLR adequacy donut.

    The arc length is proportional to ``pct``; the colour tier is keyed
    off the two thresholds (``inadequate < t0 < borderline < t1 ≤ adequate``).
    Tick marks at the threshold angles let the surgeon see the safety
    margin at a glance.
    """
    t_inadeq, t_border = thresholds
    if pct is None or math.isnan(pct):
        pct_clean: float = 0.0
        label = "—"
        tier_color = "#9ca3af"  # neutral grey
        tier_label = "Unavailable"
    else:
        pct_clean = max(0.0, min(100.0, float(pct)))
        label = f"{pct_clean:.1f} %"
        if pct_clean < t_inadeq:
            tier_color = "#dc2626"  # red — inadequate
            tier_label = "Inadequate"
        elif pct_clean < t_border:
            tier_color = "#d97706"  # amber — borderline
            tier_label = "Borderline"
        else:
            tier_color = "#16a34a"  # green — adequate
            tier_label = "Adequate"

    cx = size / 2
    cy = size / 2
    r = (size - stroke) / 2
    # Track circle
    circ = 2 * math.pi * r
    arc_len = (pct_clean / 100.0) * circ
    dash_array = f"{arc_len:.2f} {circ - arc_len:.2f}"

    def tick(angle_pct: float) -> str:
        # angle 0 starts at top, sweeps clockwise (matches the foreground arc).
        theta = math.radians(-90 + (angle_pct / 100.0) * 360)
        r_inner = r - stroke / 2 - 2
        r_outer = r + stroke / 2 + 2
        x1 = cx + r_inner * math.cos(theta)
        y1 = cy + r_inner * math.sin(theta)
        x2 = cx + r_outer * math.cos(theta)
        y2 = cy + r_outer * math.sin(theta)
        return (
            f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="#374151" stroke-width="1.2"/>'
        )

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" '
        f'class="flr-donut-svg" width="{size}" height="{size}">'
        # Background ring
        f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" '
        f'stroke="#e5e7eb" stroke-width="{stroke}"/>'
        # Foreground arc — rotated -90° so 0 % starts at the top
        f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" '
        f'stroke="{tier_color}" stroke-width="{stroke}" '
        f'stroke-dasharray="{dash_array}" stroke-linecap="butt" '
        f'transform="rotate(-90 {cx} {cy})"/>'
        # Threshold tick marks
        + tick(t_inadeq)
        + tick(t_border)
        # Centre label — big number + adequacy tier
        + f'<text x="{cx}" y="{cy - 4}" text-anchor="middle" '
        f'font-size="22" font-weight="800" fill="{tier_color}">{label}</text>'
        + f'<text x="{cx}" y="{cy + 18}" text-anchor="middle" '
        f'font-size="9" font-weight="600" fill="#6b7280" '
        f'letter-spacing="0.08em">{tier_label.upper()}</text>'
        + "</svg>"
    )


DEFAULT_LESION_CLASS_PALETTE: Mapping[str, str] = {
    "hcc":         "#dc2626",
    "icc":         "#ea580c",
    "metastasis":  "#9333ea",
    "fnh":         "#16a34a",
    "hemangioma":  "#db2777",
    "cyst":        "#0891b2",
    "abstained":   "#6b7280",
}

# Display order for the 6-class probability stack — keeps the bar visually
# stable so a "wider HCC slice" always reads as more HCC, regardless of
# which class wins on a given lesion.
LESION_CLASS_ORDER: Sequence[str] = (
    "hcc",
    "icc",
    "metastasis",
    "fnh",
    "hemangioma",
    "cyst",
)

LESION_CLASS_DISPLAY: Mapping[str, str] = {
    "hcc":         "HCC",
    "icc":         "ICC",
    "metastasis":  "Met",
    "fnh":         "FNH",
    "hemangioma":  "Hemang.",
    "cyst":        "Cyst",
    "abstained":   "Abstain",
}


def lesion_class_bars_svg(
    probs: Mapping[str, float] | None,
    palette: Mapping[str, str] | None = None,
    *,
    width: int = 360,
    bar_height: int = 14,
    gap_below: int = 14,
) -> str:
    """Render a single horizontal stacked bar of 6 class probabilities.

    Below the bar we print the top-3 classes with their percentages, so a
    surgeon scanning the page reads ``HCC 74 % · ICC 6 % · Met 5 %`` at
    a glance even when the colour itself doesn't match a printer's palette
    perfectly.
    """
    pal = dict(DEFAULT_LESION_CLASS_PALETTE)
    if palette:
        pal.update(palette)

    if not probs:
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {bar_height + gap_below}" '
            f'width="100%" height="{bar_height + gap_below}">'
            f'<rect x="0" y="0" width="{width}" height="{bar_height}" fill="#f3f4f6"/>'
            f'<text x="{width/2}" y="{bar_height/2 + 4}" text-anchor="middle" '
            f'font-size="8" fill="#9ca3af">— no probability vector —</text>'
            f'</svg>'
        )

    # Normalize to floats and clamp negatives.
    raw: list[tuple[str, float]] = []
    for cls in LESION_CLASS_ORDER:
        try:
            v = max(0.0, float(probs.get(cls, 0.0)))
        except (TypeError, ValueError):
            v = 0.0
        raw.append((cls, v))
    total = sum(v for _, v in raw) or 1.0

    # Stacked bar segments
    segments: list[str] = []
    x = 0.0
    for cls, v in raw:
        seg_w = (v / total) * width
        if seg_w > 0:
            color = pal.get(cls, "#9ca3af")
            segments.append(
                f'<rect x="{x:.2f}" y="0" width="{seg_w:.2f}" height="{bar_height}" '
                f'fill="{color}"/>'
            )
        x += seg_w

    # Top-3 legend below
    ranked = sorted(raw, key=lambda kv: -kv[1])[:3]
    legend_x = 0
    legend_items: list[str] = []
    for cls, v in ranked:
        if v <= 0:
            continue
        pct = (v / total) * 100.0
        color = pal.get(cls, "#9ca3af")
        label = LESION_CLASS_DISPLAY.get(cls, cls.upper())
        legend_items.append(
            f'<rect x="{legend_x}" y="{bar_height + 4}" width="6" height="6" fill="{color}"/>'
            f'<text x="{legend_x + 9}" y="{bar_height + 10}" font-size="8" '
            f'fill="#374151" font-weight="600">{label} {pct:.0f}%</text>'
        )
        legend_x += 78

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {bar_height + gap_below}" '
        f'width="100%" height="{bar_height + gap_below}">'
        + "".join(segments)
        + f'<rect x="0" y="0" width="{width}" height="{bar_height}" fill="none" stroke="#e5e7eb" stroke-width="0.4"/>'
        + "".join(legend_items)
        + "</svg>"
    )


def vessel_volumes_svg(
    portal_ml: float | None,
    hepatic_ml: float | None,
    *,
    width: int = 320,
    bar_height: int = 16,
) -> str:
    """Render a tiny side-by-side comparison of portal vs hepatic vein volumes."""
    portal = max(0.0, float(portal_ml or 0.0))
    hepatic = max(0.0, float(hepatic_ml or 0.0))
    max_v = max(portal, hepatic, 1.0)
    inner_w = width - 90
    portal_w = (portal / max_v) * inner_w
    hepatic_w = (hepatic / max_v) * inner_w
    height = (bar_height + 8) * 2 + 4

    rows = []
    for idx, (label, color, v, bw) in enumerate([
        ("Portal",  "#4F94CD", portal,  portal_w),
        ("Hepatic", "#CD5C5C", hepatic, hepatic_w),
    ]):
        y = idx * (bar_height + 8) + 4
        rows.append(
            f'<text x="0" y="{y + bar_height/2 + 4:.1f}" font-size="9" '
            f'font-weight="700" fill="#374151">{label}</text>'
            f'<rect x="50" y="{y}" width="{inner_w}" height="{bar_height}" fill="#f3f4f6"/>'
            f'<rect x="50" y="{y}" width="{bw:.1f}" height="{bar_height}" fill="{color}" rx="2"/>'
            f'<text x="{50 + inner_w + 4}" y="{y + bar_height/2 + 4:.1f}" font-size="8.5" '
            f'fill="#111827" font-weight="600">{v:.1f} mL</text>'
        )

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="100%" height="{height}">'
        + "".join(rows)
        + "</svg>"
    )


__all__ = [
    "DEFAULT_COUINAUD_PALETTE",
    "DEFAULT_LESION_CLASS_PALETTE",
    "ROMAN_ORDER",
    "LESION_CLASS_ORDER",
    "LESION_CLASS_DISPLAY",
    "couinaud_bar_chart_svg",
    "flr_donut_svg",
    "lesion_class_bars_svg",
    "vessel_volumes_svg",
]
