# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Python mirror of ``packages/app/src/emr/constants/fhir-codesystems.ts``.

Plain-English:
    The TypeScript file ``fhir-codesystems.ts`` is the single source of
    truth for every SNOMED CT code LiverRa writes into a FHIR payload
    (DiagnosticReport, Observation, etc.). The SEG/SR builders live on
    the Python side, so we keep this thin mirror. **Every change here
    MUST be matched in the TS file** — the contract test
    ``test_dicom_artifacts_golden.py`` asserts both lists agree.

Cross-ref:
    - ``contracts/dicom-artifacts.md`` §Segments + §Qualitative Evaluation
    - spec.md §FR-024, §FR-025

Each entry is a ``SnomedConcept`` — matches the TS shape of ``code`` +
``display`` + ``system``. The system URL is ``http://snomed.info/sct``
(SNOMED CT canonical URL per FHIR spec).
"""
from __future__ import annotations

from dataclasses import dataclass

SNOMED_SYSTEM_URL: str = "http://snomed.info/sct"


@dataclass(frozen=True)
class SnomedConcept:
    """One SNOMED CT coded concept — mirror of the TS interface."""

    code: str
    display: str
    system: str = SNOMED_SYSTEM_URL


def _snomed(code: str, display: str) -> SnomedConcept:
    return SnomedConcept(code=code, display=display)


# ---------------------------------------------------------------------------
# Anatomy — liver + 8 Couinaud segments + vasculature
# ---------------------------------------------------------------------------

LIVER = _snomed("10200004", "Liver structure")

COUINAUD_I = _snomed("245302009", "Couinaud hepatic segment I")
COUINAUD_II = _snomed("245303004", "Couinaud hepatic segment II")
COUINAUD_III = _snomed("245304005", "Couinaud hepatic segment III")
COUINAUD_IV = _snomed("245305006", "Couinaud hepatic segment IV")
COUINAUD_V = _snomed("245306007", "Couinaud hepatic segment V")
COUINAUD_VI = _snomed("245307003", "Couinaud hepatic segment VI")
COUINAUD_VII = _snomed("245308008", "Couinaud hepatic segment VII")
COUINAUD_VIII = _snomed("245309003", "Couinaud hepatic segment VIII")

PORTAL_VEIN = _snomed("32764006", "Portal vein structure")
HEPATIC_VEIN = _snomed("8887007", "Hepatic vein structure")

# ---------------------------------------------------------------------------
# LiLNet 6-class tumor head
# ---------------------------------------------------------------------------

HCC = _snomed("109841003", "Hepatocellular carcinoma")
ICC = _snomed("312104005", "Intrahepatic cholangiocarcinoma")
FNH = _snomed("62129009", "Focal nodular hyperplasia of liver")
HEMANGIOMA = _snomed("235857004", "Hemangioma of liver")
CYST = _snomed("235866006", "Cyst of liver")
METASTASIS = _snomed("94381002", "Secondary malignant neoplasm of liver")

# Sentinel for LiLNet abstention (temperature-scaled confidence below
# calibrated cutoff) — rendered per contracts/dicom-artifacts.md as
# "Uncertain" in SR qualitative evaluations.
MORPHOLOGY_UNCERTAIN = _snomed(
    "261665006", "Unknown (qualifier value)"
)

# ---------------------------------------------------------------------------
# SEG segment category/type — DCM 85756007 "Tissue" is overly broad; we use
# the specific SNOMED types for segment type and a single broad anatomy
# category per highdicom convention.
# ---------------------------------------------------------------------------

CATEGORY_ORGAN = _snomed("123037004", "Anatomical Structure")
CATEGORY_VASCULAR = _snomed("85756007", "Body structure")  # vascular structure umbrella
CATEGORY_LESION = _snomed(
    "49755003", "Morphologically altered structure"
)

# Algorithm type — per highdicom `SegmentAlgorithmTypeValues`.
ALGORITHM_AUTOMATIC = "AUTOMATIC"
ALGORITHM_SEMIAUTOMATIC = "SEMIAUTOMATIC"

# ---------------------------------------------------------------------------
# Measurement concepts (DICOM DCM + SNOMED) used by the SR builder
# ---------------------------------------------------------------------------

# Unit codes — UCUM per DICOM CP-1870.
UCUM_ML = _snomed("mL", "milliliter")  # system overridden by caller
UCUM_MM = _snomed("mm", "millimeter")
UCUM_PERCENT = _snomed("%", "percent")
UCUM_DIMENSIONLESS = _snomed("1", "no units")

# SNOMED measurement concepts.
SCT_VOLUME = _snomed("118565006", "Volume")
SCT_PERCENTAGE = _snomed("118586006", "Percentage")
# DCM 112039 "Long Axis" is the commonly cited RECIST "longest diameter"
# concept in DICOM-SR; we tag it via DCM system in the SR builder.
DCM_LONGEST_DIAMETER_CODE = "112039"
DCM_LONGEST_DIAMETER_DISPLAY = "Long Axis"
DCM_LONGEST_DIAMETER_SYSTEM = "DCM"

# FLR adequacy qualitative evaluation codes (SR TID 1500 subtemplate).
# Thresholds per spec.md FR-026 / contracts §FLR Adequacy:
#   <25% → inadequate, 25–30% (non-cirrhotic) → borderline, >=30% → adequate
SCT_ADEQUATE = _snomed("260379002", "Adequate")
SCT_BORDERLINE = _snomed("262188008", "Borderline")
SCT_INADEQUATE = _snomed("260385009", "Negative")

# Comment / text content item concept (leading RUO disclaimer).
DCM_COMMENT_CODE = "121106"
DCM_COMMENT_DISPLAY = "Comment"
DCM_COMMENT_SYSTEM = "DCM"


# ---------------------------------------------------------------------------
# Ordered lookups used by both SEG + SR builders
# ---------------------------------------------------------------------------

COUINAUD_SEGMENTS_ORDERED: tuple[SnomedConcept, ...] = (
    COUINAUD_I,
    COUINAUD_II,
    COUINAUD_III,
    COUINAUD_IV,
    COUINAUD_V,
    COUINAUD_VI,
    COUINAUD_VII,
    COUINAUD_VIII,
)

LESION_CLASSES_ORDERED: tuple[SnomedConcept, ...] = (
    HCC,
    ICC,
    FNH,
    HEMANGIOMA,
    CYST,
    METASTASIS,
)


LESION_CLASS_BY_LABEL: dict[str, SnomedConcept] = {
    "hcc": HCC,
    "icc": ICC,
    "fnh": FNH,
    "hemangioma": HEMANGIOMA,
    "cyst": CYST,
    "metastasis": METASTASIS,
}


def lesion_concept_for(label: str | None) -> SnomedConcept:
    """Resolve a free-text LiLNet label to its SNOMED concept.

    Unknown / abstained labels fall back to :data:`MORPHOLOGY_UNCERTAIN`.
    """
    if not label:
        return MORPHOLOGY_UNCERTAIN
    return LESION_CLASS_BY_LABEL.get(label.strip().lower(), MORPHOLOGY_UNCERTAIN)


# ---------------------------------------------------------------------------
# FLR adequacy threshold helper (FR-026, contracts §Qualitative Evaluation)
# ---------------------------------------------------------------------------

FLR_INADEQUATE_PCT = 25.0
FLR_BORDERLINE_PCT = 30.0
FLR_ADEQUATE_PCT = 40.0


def flr_adequacy_for(remnant_pct_functional: float) -> SnomedConcept:
    """Return the SNOMED qualitative evaluation for an FLR percentage.

    Thresholds (non-cirrhotic baseline):

    - ``< 25 %`` → :data:`SCT_INADEQUATE`
    - ``>= 25 %`` and ``< 30 %`` → :data:`SCT_BORDERLINE`
    - ``>= 30 %`` (includes the documented ≥40 % "clearly adequate" band) → :data:`SCT_ADEQUATE`
    """
    if remnant_pct_functional < FLR_INADEQUATE_PCT:
        return SCT_INADEQUATE
    if remnant_pct_functional < FLR_BORDERLINE_PCT:
        return SCT_BORDERLINE
    return SCT_ADEQUATE


__all__ = [
    "SNOMED_SYSTEM_URL",
    "SnomedConcept",
    "LIVER",
    "COUINAUD_I",
    "COUINAUD_II",
    "COUINAUD_III",
    "COUINAUD_IV",
    "COUINAUD_V",
    "COUINAUD_VI",
    "COUINAUD_VII",
    "COUINAUD_VIII",
    "COUINAUD_SEGMENTS_ORDERED",
    "PORTAL_VEIN",
    "HEPATIC_VEIN",
    "HCC",
    "ICC",
    "FNH",
    "HEMANGIOMA",
    "CYST",
    "METASTASIS",
    "MORPHOLOGY_UNCERTAIN",
    "LESION_CLASSES_ORDERED",
    "LESION_CLASS_BY_LABEL",
    "lesion_concept_for",
    "CATEGORY_ORGAN",
    "CATEGORY_VASCULAR",
    "CATEGORY_LESION",
    "ALGORITHM_AUTOMATIC",
    "ALGORITHM_SEMIAUTOMATIC",
    "SCT_VOLUME",
    "SCT_PERCENTAGE",
    "UCUM_ML",
    "UCUM_MM",
    "UCUM_PERCENT",
    "UCUM_DIMENSIONLESS",
    "DCM_LONGEST_DIAMETER_CODE",
    "DCM_LONGEST_DIAMETER_DISPLAY",
    "DCM_LONGEST_DIAMETER_SYSTEM",
    "SCT_ADEQUATE",
    "SCT_BORDERLINE",
    "SCT_INADEQUATE",
    "DCM_COMMENT_CODE",
    "DCM_COMMENT_DISPLAY",
    "DCM_COMMENT_SYSTEM",
    "FLR_INADEQUATE_PCT",
    "FLR_BORDERLINE_PCT",
    "FLR_ADEQUATE_PCT",
    "flr_adequacy_for",
]
