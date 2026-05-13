"""acr_section_builder — server-side counterpart of TS acrAnatomicalMapping.

Builds the six-section ReadoutSnapshot consumed by:
  - The PDF renderer (Jinja2 template iterates over ``snapshot.sections``)
  - The plain-text renderer (``acr_plaintext_renderer``)
  - The cross-channel parity test (which compares TS, Python and PDF text)

The mapping is duplicated from TS by deliberate decision (plan.md
Complexity Tracking row 1). Drift is caught by the parity test —
codegen would be over-engineering for 7 finding types.
"""
from __future__ import annotations

from enum import Enum
from typing import Any, Mapping, Sequence


class AnatomicalSection(str, Enum):
    LIVER = "liver"
    LESIONS = "lesions"
    VESSELS = "vessels"
    GALLBLADDER = "gallbladder"
    SPLEEN = "spleen"
    FLR_ASSESSMENT = "flrAssessment"


ANATOMICAL_SECTION_ORDER: tuple[AnatomicalSection, ...] = (
    AnatomicalSection.LIVER,
    AnatomicalSection.LESIONS,
    AnatomicalSection.VESSELS,
    AnatomicalSection.GALLBLADDER,
    AnatomicalSection.SPLEEN,
    AnatomicalSection.FLR_ASSESSMENT,
)


FINDING_TYPE_TO_SECTION: dict[str, AnatomicalSection] = {
    "hu_stats": AnatomicalSection.LIVER,
    "steatosis": AnatomicalSection.LIVER,
    "spleen": AnatomicalSection.SPLEEN,
    "gallbladder": AnatomicalSection.GALLBLADDER,
    "calcified_lesions": AnatomicalSection.LESIONS,
    "simple_biliary_cysts": AnatomicalSection.LESIONS,
    "indeterminate_malignant": AnatomicalSection.LESIONS,
}


def finding_type_to_section(finding_type: str) -> AnatomicalSection | None:
    return FINDING_TYPE_TO_SECTION.get(finding_type)


# -----------------------------------------------------------------
# Locale-specific section titles + label keys. Mirrors the en/de/ka/ru
# reportAcr.json bundles. The TS side reads from translations at
# request time; we duplicate the English defaults here because the PDF
# render path doesn't have an i18n runtime — the caller passes the
# bundle in.
# -----------------------------------------------------------------

# Default English strings. These are fallbacks; the PDF builder
# normally passes a `bundle` dict resolved from the locale's reportAcr.json.
_DEFAULT_BUNDLE: dict[str, Any] = {
    "sections": {
        "liver": {"title": "LIVER", "empty": "Not assessed"},
        "lesions": {"title": "LESIONS", "empty": "No lesions detected"},
        "vessels": {"title": "VESSELS", "empty": "Not assessed"},
        "gallbladder": {"title": "GALLBLADDER", "empty": "Not assessed"},
        "spleen": {"title": "SPLEEN", "empty": "Not assessed"},
        "flrAssessment": {"title": "FLR ASSESSMENT", "empty": "FLR plan not requested"},
    },
    "labels": {
        "huMean": "Mean HU",
        "steatosisGrade": "Steatosis grade",
        "liverSpleenDelta": "Δ liver–spleen",
        "volume": "Volume",
        "wallThickness": "Wall thickness",
        "stones": "Stones detected",
        "splenomegaly": "Splenomegaly",
        "flrPlan": "Plan",
        "flrPercent": "FLR",
        "flrRecommendation": "Recommendation",
        "yes": "Yes",
        "no": "No",
        "lrM": "LR-M",
    },
    "values": {
        "splenomegalyPresent": "Present",
        "splenomegalyAbsent": "Within reference",
        "flrSafetyLow": "LOW",
        "flrSafetyBorderline": "BORDERLINE",
        "flrSafetyAdequate": "ADEQUATE",
        "steatosisNone": "None",
        "steatosisMild": "Mild",
        "steatosisModerate": "Moderate",
        "steatosisSevere": "Severe",
    },
    "status": {
        "computing": "Computing — results will appear when the cascade completes",
        "computationFailed": "Computation unavailable",
        "noFindings": "No findings to report",
        "notAvailable": "Not available",
    },
    "recommendations": {
        "considerPveAlpps": "consider PVE or ALPPS",
        "borderlineDiscussMdt": "borderline remnant — discuss at MDT",
        "noteAdequateRemnant": "remnant volume meets institutional threshold",
    },
    "lesions": {
        "interpretationCalcified": "Calcified lesion",
        "interpretationSimpleCyst": "Simple biliary cyst",
    },
    "ruoDisclaimer": "RESEARCH USE ONLY — NOT FOR PRIMARY DIAGNOSTIC USE",
}


def _get(bundle: Mapping[str, Any] | None, dotted: str, default: str = "") -> str:
    obj: Any = bundle or _DEFAULT_BUNDLE
    for part in dotted.split("."):
        if not isinstance(obj, Mapping) or part not in obj:
            # Fallback to the default bundle.
            obj2: Any = _DEFAULT_BUNDLE
            for p2 in dotted.split("."):
                if not isinstance(obj2, Mapping) or p2 not in obj2:
                    return default
                obj2 = obj2[p2]
            return str(obj2) if obj2 is not None else default
        obj = obj[part]
    return str(obj) if obj is not None else default


def _capitalize(s: str) -> str:
    return s[:1].upper() + s[1:]


# -----------------------------------------------------------------
# Per-section row builders. Each returns a list of row dicts in stable order.
# -----------------------------------------------------------------

def _build_liver_rows(findings: Mapping[str, Any], bundle: Mapping[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    hu = findings.get("hu_stats")
    if hu:
        mean = int(round(float(hu.get("mean", 0))))
        p10 = int(round(float(hu.get("p10", 0))))
        p90 = int(round(float(hu.get("p90", 0))))
        rows.append({
            "key": "hu_mean",
            "label": _get(bundle, "labels.huMean", "Mean HU"),
            "value": f"{mean} (p10 {p10}, p90 {p90})",
        })

    st = findings.get("steatosis")
    if st and st.get("grade") and st["grade"] != "none":
        grade = st["grade"]
        grade_label = _get(bundle, f"values.steatosis{_capitalize(grade)}", _capitalize(grade))
        delta = st.get("liver_spleen_delta")
        delta_label = _get(bundle, "labels.liverSpleenDelta", "Δ liver–spleen")
        if delta is not None:
            value = f"{grade_label} ({delta_label} = {float(delta):.1f} HU)"
        else:
            value = f"{grade_label} ({delta_label} unavailable)"
        rows.append({
            "key": "steatosis",
            "label": _get(bundle, "labels.steatosisGrade", "Steatosis grade"),
            "value": value,
        })

    return rows


def _build_lesions_rows(
    findings: Mapping[str, Any],
    lesions: Sequence[Mapping[str, Any]],
    bundle: Mapping[str, Any],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    sorted_lesions = sorted(lesions, key=lambda lz: str(lz.get("lesion_id") or lz.get("id") or ""))
    for lesion in sorted_lesions:
        lid = lesion.get("lesion_id") or lesion.get("id") or "?"
        size_mm = lesion.get("size_mm")
        if size_mm is None:
            size_mm = lesion.get("longest_diameter_mm")
        if size_mm is not None:
            size_str = f"{float(size_mm):.1f} mm"
        else:
            size_str = _get(bundle, "status.notAvailable", "Not available")
        cls = lesion.get("classification") or {}
        cls_label = cls.get("label")
        cls_label_up = cls_label.upper() if cls_label else None
        conf = cls.get("confidence")
        if cls_label_up and conf is not None:
            interp = f"{size_str}, {cls_label_up} (Confidence {int(round(float(conf) * 100))}%)"
        elif cls_label_up:
            interp = f"{size_str}, {cls_label_up}"
        else:
            interp = size_str
        rows.append({
            "key": f"lesion-{lid}",
            "label": str(lid),
            "itemId": str(lid),
            "segment": lesion.get("segment") or None,
            "value": interp,
            "interpretation": cls_label_up,
        })

    calc = findings.get("calcified_lesions")
    if calc:
        rows.append({
            "key": "calcified-summary",
            "label": _get(bundle, "lesions.interpretationCalcified", "Calcified lesion"),
            "value": str(len(calc)),
        })
    cysts = findings.get("simple_biliary_cysts")
    if cysts:
        rows.append({
            "key": "cysts-summary",
            "label": _get(bundle, "lesions.interpretationSimpleCyst", "Simple biliary cyst"),
            "value": str(len(cysts)),
        })
    lrm = findings.get("indeterminate_malignant")
    if lrm and int(lrm.get("lr_m_count", 0) or 0) > 0:
        rows.append({
            "key": "lr-m-summary",
            "label": _get(bundle, "labels.lrM", "LR-M"),
            "value": str(lrm["lr_m_count"]),
            "interpretation": lrm.get("interpretation"),
        })
    return rows


def _build_vessels_rows(_findings: Mapping[str, Any], _bundle: Mapping[str, Any]) -> list[dict[str, Any]]:
    return []


def _build_gallbladder_rows(findings: Mapping[str, Any], bundle: Mapping[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    gb = findings.get("gallbladder")
    if not gb:
        return rows
    rows.append({
        "key": "gb-volume",
        "label": _get(bundle, "labels.volume", "Volume"),
        "value": f"{int(round(float(gb.get('volume_ml', 0))))} mL",
    })
    rows.append({
        "key": "gb-wall",
        "label": _get(bundle, "labels.wallThickness", "Wall thickness"),
        "value": (
            f"{float(gb['wall_thickness_mm']):.1f} mm"
            if gb.get("wall_thickness_mm") is not None
            else _get(bundle, "status.notAvailable", "Not available")
        ),
    })
    rows.append({
        "key": "gb-stones",
        "label": _get(bundle, "labels.stones", "Stones detected"),
        "value": _get(bundle, "labels.yes", "Yes") if gb.get("stones_detected") else _get(bundle, "labels.no", "No"),
    })
    return rows


def _build_spleen_rows(findings: Mapping[str, Any], bundle: Mapping[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    sp = findings.get("spleen")
    if not sp:
        return rows
    rows.append({
        "key": "spleen-volume",
        "label": _get(bundle, "labels.volume", "Volume"),
        "value": f"{int(round(float(sp.get('volume_ml', 0))))} mL",
        "warning": sp.get("warning"),
    })
    rows.append({
        "key": "spleen-splenomegaly",
        "label": _get(bundle, "labels.splenomegaly", "Splenomegaly"),
        "value": (
            _get(bundle, "values.splenomegalyPresent", "Present")
            if sp.get("splenomegaly")
            else _get(bundle, "values.splenomegalyAbsent", "Within reference")
        ),
    })
    return rows


def _build_flr_rows(flr: Mapping[str, Any] | None, bundle: Mapping[str, Any]) -> list[dict[str, Any]]:
    if not flr:
        return []
    rows: list[dict[str, Any]] = []
    if flr.get("plan_pattern"):
        rows.append({
            "key": "flr-plan",
            "label": _get(bundle, "labels.flrPlan", "Plan"),
            "value": str(flr["plan_pattern"]).replace("_", " "),
        })
    ml = flr.get("flr_ml")
    pct = flr.get("flr_pct")
    safety = flr.get("safety_class")
    safety_label = (
        _get(bundle, "values.flrSafetyLow", "LOW") if safety == "low" else
        _get(bundle, "values.flrSafetyBorderline", "BORDERLINE") if safety == "borderline" else
        _get(bundle, "values.flrSafetyAdequate", "ADEQUATE") if safety == "adequate" else
        (safety or "")
    )
    parts: list[str] = []
    if ml is not None:
        parts.append(f"{int(round(float(ml)))} mL")
    if pct is not None:
        parts.append(f"({float(pct):.1f}%)")
    if safety_label:
        parts.append(f"— {safety_label}")
    rows.append({
        "key": "flr-value",
        "label": _get(bundle, "labels.flrPercent", "FLR"),
        "value": " ".join(parts) if parts else _get(bundle, "status.notAvailable", "Not available"),
    })
    if safety == "low":
        rows.append({
            "key": "flr-recommendation",
            "label": _get(bundle, "labels.flrRecommendation", "Recommendation"),
            "value": _get(bundle, "recommendations.considerPveAlpps", "consider PVE or ALPPS"),
        })
    elif safety == "borderline":
        rows.append({
            "key": "flr-recommendation",
            "label": _get(bundle, "labels.flrRecommendation", "Recommendation"),
            "value": _get(bundle, "recommendations.borderlineDiscussMdt", "borderline remnant — discuss at MDT"),
        })
    elif safety == "adequate":
        rows.append({
            "key": "flr-recommendation",
            "label": _get(bundle, "labels.flrRecommendation", "Recommendation"),
            "value": _get(
                bundle,
                "recommendations.noteAdequateRemnant",
                "remnant volume meets institutional threshold",
            ),
        })
    return rows


# -----------------------------------------------------------------
# Top-level builder
# -----------------------------------------------------------------

def build_acr_sections(
    findings_dict: Mapping[str, Any] | None,
    lesions: Sequence[Mapping[str, Any]] | None = None,
    flr: Mapping[str, Any] | None = None,
    bundle: Mapping[str, Any] | None = None,
    status: str = "completed",
) -> dict[str, list[dict[str, Any]]]:
    """Build a {section_value: [row, ...]} dict for the Jinja2 template.

    The dict's keys are the AnatomicalSection.value strings preserving
    insertion order (Python 3.7+ guarantee), so the template iterates
    them in the same fixed order as the TS renderer.
    """
    findings = findings_dict or {}
    lesions = lesions or []
    section_to_rows: dict[str, list[dict[str, Any]]] = {}
    builders = {
        AnatomicalSection.LIVER: lambda: _build_liver_rows(findings, bundle or _DEFAULT_BUNDLE),
        AnatomicalSection.LESIONS: lambda: _build_lesions_rows(findings, lesions, bundle or _DEFAULT_BUNDLE),
        AnatomicalSection.VESSELS: lambda: _build_vessels_rows(findings, bundle or _DEFAULT_BUNDLE),
        AnatomicalSection.GALLBLADDER: lambda: _build_gallbladder_rows(findings, bundle or _DEFAULT_BUNDLE),
        AnatomicalSection.SPLEEN: lambda: _build_spleen_rows(findings, bundle or _DEFAULT_BUNDLE),
        AnatomicalSection.FLR_ASSESSMENT: lambda: _build_flr_rows(flr, bundle or _DEFAULT_BUNDLE),
    }
    for section in ANATOMICAL_SECTION_ORDER:
        section_to_rows[section.value] = builders[section]()
    return section_to_rows


def build_readout_snapshot(
    *,
    analysis_id: str,
    tenant_id: str,
    locale: str,
    captured_at: str,
    findings_dict: Mapping[str, Any] | None,
    lesions: Sequence[Mapping[str, Any]] | None = None,
    flr: Mapping[str, Any] | None = None,
    status: str = "completed",
    etag: str | None = None,
    bundle: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the full ReadoutSnapshot dict consumed by the plain-text renderer."""
    section_to_rows = build_acr_sections(
        findings_dict=findings_dict,
        lesions=lesions,
        flr=flr,
        bundle=bundle,
        status=status,
    )
    is_computing = status in ("running", "queued")
    is_failed = status == "failed"
    bundle_resolved = bundle or _DEFAULT_BUNDLE

    sections: list[dict[str, Any]] = []
    for section in ANATOMICAL_SECTION_ORDER:
        rows = section_to_rows[section.value]
        if rows:
            sec_status = "present"
        elif is_computing:
            sec_status = "computing"
        elif is_failed:
            sec_status = "unavailable"
        else:
            sec_status = "empty"
        sections.append({
            "section": section.value,
            "title": _get(bundle_resolved, f"sections.{section.value}.title", section.value.upper()),
            "rows": rows,
            "status": sec_status,
            "emptyMessage": (
                _get(bundle_resolved, "status.computing", "Computing")
                if sec_status == "computing"
                else _get(bundle_resolved, "status.computationFailed", "Computation unavailable")
                if sec_status == "unavailable"
                else _get(bundle_resolved, f"sections.{section.value}.empty", "Not assessed")
            ),
        })

    ruo_disclaimer = _get(
        bundle_resolved,
        "ruoDisclaimer",
        "RESEARCH USE ONLY — NOT FOR PRIMARY DIAGNOSTIC USE",
    )
    # The bundle's value already contains the dashes — strip them here so
    # the plain-text renderer can re-wrap exactly the same way the TS
    # renderer does.
    ruo_clean = ruo_disclaimer.strip()
    while ruo_clean.startswith("---"):
        ruo_clean = ruo_clean[3:].lstrip()
    while ruo_clean.endswith("---"):
        ruo_clean = ruo_clean[:-3].rstrip()

    return {
        "analysisId": analysis_id,
        "tenantId": tenant_id,
        "locale": locale,
        "capturedAt": captured_at,
        "etag": etag,
        "status": status,
        "sections": sections,
        "ruoDisclaimer": ruo_clean,
    }


__all__ = [
    "AnatomicalSection",
    "ANATOMICAL_SECTION_ORDER",
    "FINDING_TYPE_TO_SECTION",
    "finding_type_to_section",
    "build_acr_sections",
    "build_readout_snapshot",
]
