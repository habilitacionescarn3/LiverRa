# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""SOPClass-based triage for pixel-PHI scanning.

Plain-English:
    We can't afford to OCR every slice of every study — a typical abdominal
    CT has 400–1,000 slices and Presidio + Tesseract over every one blows
    our ingestion SLA. Instead we look at the SOP Class UID (the DICOM tag
    that says "what kind of image is this?") and choose one of three scan
    modes:

      • FULL_IMAGE: whole-image OCR. Used for modalities where text CAN
        appear anywhere in the frame (Secondary Capture screens, US, CR,
        DX).
      • CORNER_STRIP: OCR only the four corners + the bottom strip. Used
        for primary CT / MR where vendor overlays are always in the corners
        and the main image area is pure anatomy.
      • SKIP: no pixel PHI scan. Used for derived-only objects where OCR
        adds nothing (e.g., the SR / SEG themselves).

References:
    - specs/001-zero-training-mvp/research.md §B.2 (Presidio + Tesseract
      on four corners + bottom strip on triage-positive slices; full-image
      on Secondary Capture class)
    - spec.md §FR-002 (burned-in pixel PHI detection)

The SOP Class UIDs here are the NEMA-registered values (DICOM PS3.6 Annex
A). Do NOT hardcode UIDs anywhere else in the pipeline — import this module.
"""
from __future__ import annotations

from enum import Enum


class ScanMode(str, Enum):
    """Triage result. String-valued so it can be emitted in AuditEvents."""

    FULL_IMAGE = "full"
    CORNER_STRIP = "corner"
    SKIP = "skip"


# ---------------------------------------------------------------------------
# SOP Class UID sets (NEMA-registered — DO NOT edit without updating tests)
# ---------------------------------------------------------------------------

FULL_SCAN_SOP_CLASSES: frozenset[str] = frozenset(
    {
        "1.2.840.10008.5.1.4.1.1.7",        # Secondary Capture Image Storage
        "1.2.840.10008.5.1.4.1.1.7.1",      # Multi-frame Single Bit SC
        "1.2.840.10008.5.1.4.1.1.7.2",      # Multi-frame Grayscale Byte SC
        "1.2.840.10008.5.1.4.1.1.7.3",      # Multi-frame Grayscale Word SC
        "1.2.840.10008.5.1.4.1.1.7.4",      # Multi-frame True Color SC
        "1.2.840.10008.5.1.4.1.1.6.1",      # US Image Storage
        "1.2.840.10008.5.1.4.1.1.6.2",      # Enhanced US Volume Storage
        "1.2.840.10008.5.1.4.1.1.3.1",      # US Multi-frame Image Storage
        "1.2.840.10008.5.1.4.1.1.1",        # Computed Radiography (CR)
        "1.2.840.10008.5.1.4.1.1.1.1",      # Digital X-Ray (DX) — for presentation
        "1.2.840.10008.5.1.4.1.1.1.1.1",    # Digital X-Ray (DX) — for processing
    }
)

CORNER_STRIP_SOP_CLASSES: frozenset[str] = frozenset(
    {
        "1.2.840.10008.5.1.4.1.1.2",        # CT Image Storage (primary)
        "1.2.840.10008.5.1.4.1.1.2.1",      # Enhanced CT Image Storage
        "1.2.840.10008.5.1.4.1.1.2.2",      # Legacy Converted Enhanced CT
        "1.2.840.10008.5.1.4.1.1.4",        # MR Image Storage
        "1.2.840.10008.5.1.4.1.1.4.1",      # Enhanced MR Image Storage
        "1.2.840.10008.5.1.4.1.1.4.4",      # Legacy Converted Enhanced MR
    }
)

# Anything not in either set → SKIP (e.g., SEG 1.2.840.10008.5.1.4.1.1.66.4,
# SR 1.2.840.10008.5.1.4.1.1.88.* — these are derived objects we generate
# ourselves and never need to scan.)


def classify(sop_class_uid: str | None) -> ScanMode:
    """Return the scan mode for a given SOP Class UID.

    An unknown / missing / None UID falls through to ``SKIP`` — the
    anonymization gate will still run the header scrub + NFC normalisation,
    but OCR is not attempted on objects we don't recognise. This keeps the
    pipeline predictable; if an operator wants to force a stricter scan
    policy they can override via admin config.
    """
    if not sop_class_uid:
        return ScanMode.SKIP
    uid = sop_class_uid.strip()
    if uid in FULL_SCAN_SOP_CLASSES:
        return ScanMode.FULL_IMAGE
    if uid in CORNER_STRIP_SOP_CLASSES:
        return ScanMode.CORNER_STRIP
    return ScanMode.SKIP


__all__ = [
    "ScanMode",
    "FULL_SCAN_SOP_CLASSES",
    "CORNER_STRIP_SOP_CLASSES",
    "classify",
]
