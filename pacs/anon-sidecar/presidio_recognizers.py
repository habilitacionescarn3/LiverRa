# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Per-image custom Presidio recognizers built from DICOM metadata.

Plain-English:
    Presidio is Microsoft's open-source PHI/PII detector. Its *built-in*
    recognizers are English-centric (US SSN, US driver licenses, etc.)
    and don't know anything about a specific patient. Burned-in pixel
    text, however, usually says exactly what's in the *header* — the
    patient's own name, MRN, institution, etc. So for each incoming
    DICOM instance we build a *fresh set* of PatternRecognizers that
    look for the literal strings that appear in that image's own header.
    If those strings show up in the OCR output of the pixels → PHI
    contamination → reject + crypto-shred.

References:
    - specs/001-zero-training-mvp/research.md §B.2
    - spec.md §FR-002, §FR-002a, §FR-002b (Unicode NFC)
    - CLAUDE.md rule: PHI scrubbing on every log statement.

Dependencies:
    presidio-analyzer>=2.2  → PatternRecognizer / Pattern / AnalyzerEngine
    pydicom>=3.0            → DICOM dataset (ds) handling
"""
from __future__ import annotations

import logging
import re
import unicodedata
from typing import Any, Iterable

try:  # Soft-import so unit tests can stub without the heavy dep installed
    from presidio_analyzer import Pattern, PatternRecognizer
except ImportError:  # pragma: no cover
    Pattern = None  # type: ignore[assignment]
    PatternRecognizer = None  # type: ignore[assignment]


logger = logging.getLogger(__name__)

# Shared per-entity minimum score. Lower => false positives from partial
# matches; too high => misses on OCR glitches. 0.6 is the intended threshold
# per the docstring above (was 0.85, which silently let OCR-noised names
# through — e.g. "MUI LER" instead of "MÜLLER"; audit H-PACS-5).
DEFAULT_SCORE = 0.6


# ---------------------------------------------------------------------------
# Accent / case normalisation helpers
# ---------------------------------------------------------------------------

def _nfc(s: str) -> str:
    """NFC normalisation (research §B.8) — required before regex building."""
    return unicodedata.normalize("NFC", s)


def _strip_accents(s: str) -> str:
    """NFD decomposition then drop combining marks — lets "Müller" match "Muller"
    in low-quality OCR output without introducing locale-specific mappings.
    Georgian Mkhedruli has no combining marks, so it passes through unchanged.
    """
    decomposed = unicodedata.normalize("NFD", s)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def _tokenize_name(raw: str) -> list[str]:
    """Split a DICOM Person Name into meaningful tokens.

    DICOM PN format: ``Family^Given^Middle^Prefix^Suffix``; CTP may have
    already hashed this so we defensively skip tokens shorter than 2 chars
    or composed only of hash-like hex.
    """
    pieces: list[str] = []
    for segment in raw.replace("^", " ").split():
        token = _nfc(segment).strip().strip(",.-")
        if len(token) < 2:
            continue
        if re.fullmatch(r"[0-9a-f]{8,}", token):
            # Hash artefact — not real name text
            continue
        pieces.append(token)
    return pieces


def _fuzzy_chars(token: str) -> str:
    """Build a regex body that tolerates common OCR mistakes inside a token.

    OCR engines routinely:
      * inject a space inside a long token ("MÜLLER" → "MUI LER")
      * confuse adjacent glyphs (I↔L, O↔0, S↔5, B↔8)
      * drop combining marks (the caller already accent-strips)

    We allow at most one optional whitespace between each pair of letters
    so the regex can still anchor on the first/last character but doesn't
    miss a single OCR break. We do NOT enable substitution sets (i.e.
    I→[IL1]) — too noisy on radiology images that print "ID" or "L1" in
    overlays. Per-character optional whitespace is the conservative win.
    """
    escaped_chars = [re.escape(c) for c in token]
    # Join with optional single whitespace between every adjacent pair.
    # Cap at 1 to avoid catastrophic backtracking on long tokens.
    return r"\s?".join(escaped_chars)


def _regex_for_token(token: str) -> str:
    """Build a case+accent+OCR-fuzzy insensitive regex.

    Matches:
      1. The token verbatim
      2. The accent-stripped form ("Muller" for "Müller")
      3. A fuzzy variant that tolerates a single inserted whitespace
         between any adjacent character pair (OCR glitch — see
         H-PACS-5).

    The caller wraps the result with ``(?i)`` for case-insensitivity.
    """
    escaped = re.escape(token)
    stripped = _strip_accents(token)
    alternatives = [escaped]
    if stripped != token:
        alternatives.append(re.escape(stripped))
    # Fuzzy variant — only meaningful on tokens ≥ 3 chars (shorter tokens
    # would explode false-positive rate). Apply both to the original and
    # to the accent-stripped form for completeness.
    if len(token) >= 3:
        alternatives.append(_fuzzy_chars(token))
        if stripped != token and len(stripped) >= 3:
            alternatives.append(_fuzzy_chars(stripped))
    body = "(?:" + "|".join(alternatives) + ")"
    # \b works for Latin/Cyrillic; for Georgian Mkhedruli \b may under-match,
    # so we accept a preceding/following non-word OR string boundary.
    return rf"(?:\b|(?<=\W)|^){body}(?:\b|(?=\W)|$)"


# ---------------------------------------------------------------------------
# Per-field recognizer constructors
# ---------------------------------------------------------------------------


def _make_recognizer(
    entity: str,
    tokens: Iterable[str],
    *,
    score: float = DEFAULT_SCORE,
    context: Iterable[str] | None = None,
) -> Any | None:
    """Return a PatternRecognizer matching any of ``tokens``, or None if empty."""
    if PatternRecognizer is None:
        logger.debug("presidio-analyzer not installed; skipping recognizer build")
        return None

    patterns = [
        Pattern(name=f"{entity}-{i}", regex=f"(?i){_regex_for_token(t)}", score=score)
        for i, t in enumerate(tokens)
        if t
    ]
    if not patterns:
        return None

    return PatternRecognizer(
        supported_entity=entity,
        patterns=patterns,
        context=list(context) if context else None,
        # Supported languages: UTF-8 text; Presidio treats language as an
        # annotation, not a filter. We keep it generic.
        supported_language="en",
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def build_recognizers_from_dicom(ds: Any) -> list[Any]:
    """Build per-image custom recognizers from the DICOM header.

    Parameters
    ----------
    ds:
        A ``pydicom.Dataset`` (or duck-typed dict-like) with the usual
        PS3.15 confidentiality fields already decoded to str.

    Returns
    -------
    list of ``PatternRecognizer``
        Ready to add to an ``AnalyzerEngine.registry``.
    """
    if PatternRecognizer is None:
        return []

    recognizers: list[Any] = []

    def _get(tag: str) -> str | None:
        value = getattr(ds, tag, None)
        if value is None:
            return None
        text = str(value).strip()
        return _nfc(text) if text else None

    # ---- Patient name (PN VR) ------------------------------------------
    patient_name = _get("PatientName")
    if patient_name:
        tokens = _tokenize_name(patient_name)
        # Full run AND individual tokens — OCR may break at spaces.
        rec = _make_recognizer(
            "PATIENT_NAME",
            [patient_name, *tokens],
            context=["patient", "name", "pt", "pat"],
        )
        if rec is not None:
            recognizers.append(rec)

    # ---- Patient ID (LO VR) --------------------------------------------
    patient_id = _get("PatientID")
    if patient_id:
        rec = _make_recognizer(
            "PATIENT_ID",
            [patient_id],
            context=["mrn", "id", "patient id", "pid"],
            score=0.95,
        )
        if rec is not None:
            recognizers.append(rec)

    # ---- Date of birth --------------------------------------------------
    # Match both the canonical YYYYMMDD form and common display variants.
    dob_raw = _get("PatientBirthDate")
    if dob_raw and re.fullmatch(r"\d{8}", dob_raw):
        yyyy, mm, dd = dob_raw[:4], dob_raw[4:6], dob_raw[6:8]
        variants = {
            dob_raw,
            f"{yyyy}-{mm}-{dd}",
            f"{dd}.{mm}.{yyyy}",
            f"{dd}/{mm}/{yyyy}",
            f"{mm}/{dd}/{yyyy}",
        }
        rec = _make_recognizer(
            "PATIENT_DOB",
            variants,
            context=["dob", "birth", "born", "geburt"],
            score=0.9,
        )
        if rec is not None:
            recognizers.append(rec)

    # ---- Institution name ----------------------------------------------
    institution = _get("InstitutionName")
    if institution:
        tokens = [institution, *(_tokenize_name(institution))]
        rec = _make_recognizer(
            "INSTITUTION_NAME",
            tokens,
            context=["institution", "hospital", "clinic", "klinik", "klinikum"],
            score=0.8,
        )
        if rec is not None:
            recognizers.append(rec)

    # ---- Referring physician -------------------------------------------
    ref_phys = _get("ReferringPhysicianName")
    if ref_phys:
        tokens = _tokenize_name(ref_phys)
        rec = _make_recognizer(
            "REFERRING_PHYSICIAN",
            [ref_phys, *tokens],
            context=["dr", "doctor", "physician", "referring", "arzt"],
        )
        if rec is not None:
            recognizers.append(rec)

    logger.debug("Built %d per-image recognizers", len(recognizers))
    return recognizers


__all__ = [
    "build_recognizers_from_dicom",
    "DEFAULT_SCORE",
]
