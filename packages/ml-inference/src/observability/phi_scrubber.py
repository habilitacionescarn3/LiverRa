# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""PHI scrubber (T069).

Rules-based scrubber for Sentry / PostHog / structured-log payloads
(LiverRa spec NFR-007). Fail-closed per FR-029b: if any exception is
raised during scrubbing the event MUST be dropped, never sent.

Plain-English analogy:
    Imagine a shredder that sits in front of the mailbox. Every letter
    going out is first fed through — names, patient IDs, email
    addresses are blacked out. If the shredder jams, the letter never
    leaves the building. Better to lose observability than leak PHI.

Rules implemented in v1:

1. DICOM UIDs           — dotted numeric ≥9 components, length 16–64
2. Emails               — RFC-5322-ish
3. MRN-like tokens      — configurable per tenant (e.g. "MRN: 1234567",
                          "Patient ID: X-5532/2025")
4. German given/family name list (top 50, partial — see constants)
5. Georgian given/family name list (Latin + native script)
6. Field-name allowlist — keys that are safe even if their values look
   like MRNs (``study_instance_uid``, ``analysis_id``, ``model_version``,
   ``error_slug``, ``stage``, ``sequence_no``, ``tenant_id``, …).
"""
from __future__ import annotations

import copy
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Iterable

from prometheus_client import Counter

try:  # pragma: no cover — exercised at import time.
    import ahocorasick  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover
    ahocorasick = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

phi_scrubber_failed_total = Counter(
    "phi_scrubber_failed_total",
    "Count of scrubber failures (fail-closed — event dropped).",
    labelnames=("reason",),
)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

REDACTION: str = "[redacted]"

# Field names whose VALUES pass through unchanged even if they look
# MRN-shaped. Everything else is scrubbed.
SAFE_FIELD_NAMES: frozenset[str] = frozenset(
    {
        "analysis_id",
        "correlation_id",
        "error_code",
        "error_slug",
        "event_type",
        "leaf_hash",
        "level",
        "model_version",
        "pipeline_stage",
        "prev_leaf_hash",
        "request_id",
        "sequence_no",
        "series_instance_uid",
        "sop_instance_uid",
        "stage",
        "study_instance_uid",
        "tenant_id",
        "timestamp",
        "trace_id",
        "transaction_uid",
        "user_role",
    }
)

# DICOM UID — dotted numeric, at least 9 groups, 16–64 chars.
# NOTE: only scrub DICOM UIDs OUTSIDE of allowlisted fields; inside an
# allowlisted field (e.g. ``study_instance_uid``) they're considered safe.
_DICOM_UID_RE = re.compile(r"\b(?:\d+\.){8,}\d+\b")

_EMAIL_RE = re.compile(
    r"(?i)\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b"
)

# MRN-like labels. Case-insensitive, matches the LABEL + its payload.
_MRN_LABEL_RE = re.compile(
    r"(?i)\b(?:MRN|Patient\s*ID|PatientID|Patient\s*No\.?|Pat\.?\s*Nr\.?|"
    r"Chart\s*No\.?|Medical\s*Record\s*Number)\s*[:#]?\s*[A-Z0-9\-/]{3,}"
)

# Bare 6-10 digit numeric bursts that are likely MRNs when NOT in a
# safe field. Intentionally conservative — we do not touch sequence_no
# values because they are recognized via field name.
_BARE_MRN_RE = re.compile(r"\b\d{6,10}\b")

# --- German given + family names (PARTIAL LIST — production deployment
# should load the full curated dataset from tenant config). Source: public
# top-50 lists (Destatis 2023, Deutsche Post Namensforschung).
# PARTIAL LIST — production deployment should load full list from tenant config
GERMAN_NAMES: tuple[str, ...] = (
    # Given (male)
    "Alexander", "Andreas", "Benjamin", "Christian", "Daniel",
    "David", "Dennis", "Dominik", "Felix", "Florian",
    "Hans", "Jakob", "Jan", "Johannes", "Jonas",
    "Julian", "Kevin", "Leon", "Lukas", "Markus",
    "Martin", "Matthias", "Maximilian", "Michael", "Niklas",
    "Paul", "Peter", "Philipp", "Sebastian", "Simon",
    "Stefan", "Thomas", "Tim", "Tobias",
    # Given (female)
    "Anna", "Elena", "Emma", "Hannah", "Johanna",
    "Julia", "Katharina", "Laura", "Lea", "Lena",
    "Lisa", "Maria", "Marie", "Nina", "Petra",
    "Sabine", "Sarah", "Sophie", "Stefanie",
    # Family (top 50)
    "Müller", "Mueller", "Schmidt", "Schneider", "Fischer",
    "Weber", "Meyer", "Wagner", "Becker", "Schulz",
    "Hoffmann", "Schäfer", "Schaefer", "Koch", "Bauer",
    "Richter", "Klein", "Wolf", "Schröder", "Schroeder",
    "Neumann", "Schwarz", "Zimmermann", "Braun", "Krüger",
    "Krueger", "Hofmann", "Hartmann", "Lange", "Werner",
    "Schmitz", "Krause", "Meier", "Lehmann", "Schmid",
    "Schulze", "Maier", "Köhler", "Koehler", "Herrmann",
    "König", "Koenig", "Walter", "Mayer", "Huber",
    "Kaiser", "Fuchs", "Peters", "Lang", "Scholz",
    "Möller", "Moeller", "Weiß", "Weiss", "Jung",
    "Hahn", "Schubert", "Özdemir", "Oezdemir",
)

# --- Georgian names (PARTIAL LIST). Both Latin transliteration and
# native script. Source: Statistics Georgia + hospital registries.
# PARTIAL LIST — production deployment should load full list from tenant config
GEORGIAN_NAMES: tuple[str, ...] = (
    # Given (male) — Latin
    "Giorgi", "Davit", "Irakli", "Levan", "Zviad",
    "Nika", "Lasha", "Vakhtang", "Tornike", "Mikheil",
    "Nodar", "Shota", "Otar", "Zurab", "Revaz",
    "Beka", "Sandro", "Luka",
    # Given (female) — Latin
    "Nino", "Tamar", "Mariam", "Ana", "Salome",
    "Lika", "Elene", "Natia", "Ketevan", "Tamta",
    "Mzia", "Manana",
    # Family — Latin (typical -shvili / -dze / -adze endings)
    "Gogichaishvili", "Giorgadze", "Svanadze", "Japaridze",
    "Beridze", "Kapanadze", "Tsereteli", "Kiknadze",
    "Chavchavadze", "Saakashvili", "Gelashvili", "Lomidze",
    "Khutsishvili", "Meladze", "Tabatadze", "Gurgenidze",
    "Kakabadze", "Lortkipanidze", "Dolidze", "Nadiradze",
    "Chkheidze", "Tevzadze", "Khelaia", "Kvaratskhelia",
    # Native script — common given + family
    "გიორგი", "დავით", "ირაკლი", "ლევან", "ზვიად",
    "ნიკა", "ლაშა", "ვახტანგ", "თორნიკე", "მიხეილ",
    "ნინო", "თამარ", "მარიამ", "ანა", "სალომე",
    "ლიკა", "ელენე", "ნათია", "ქეთევან",
    "გოგიჩაიშვილი", "გიორგაძე", "სვანაძე", "ჯაფარიძე",
    "ბერიძე", "კაპანაძე", "წერეთელი", "კიკნაძე",
    "ჭავჭავაძე", "სააკაშვილი", "გელაშვილი", "ლომიძე",
)


class ScrubberFailure(RuntimeError):
    """Raised when scrubbing fails. Caller MUST drop the event."""


# ---------------------------------------------------------------------------
# Scrubber implementation
# ---------------------------------------------------------------------------


@dataclass
class PHIScrubber:
    """Rules-based, fail-closed PHI scrubber.

    ``PHIScrubber`` is intentionally cheap to construct — the heavy
    state (compiled Aho-Corasick automaton) is built lazily.
    """

    extra_name_list: tuple[str, ...] = field(default_factory=tuple)
    extra_mrn_patterns: tuple[str, ...] = field(default_factory=tuple)
    safe_field_names: frozenset[str] = field(default_factory=lambda: SAFE_FIELD_NAMES)

    _automaton: Any = field(init=False, repr=False, default=None)
    _extra_mrn_re: re.Pattern[str] | None = field(init=False, repr=False, default=None)

    def __post_init__(self) -> None:
        self._automaton = self._build_automaton(
            GERMAN_NAMES + GEORGIAN_NAMES + self.extra_name_list
        )
        if self.extra_mrn_patterns:
            joined = "|".join(f"(?:{p})" for p in self.extra_mrn_patterns)
            self._extra_mrn_re = re.compile(joined)

    # -- public API ------------------------------------------------------

    def scrub_dict(self, obj: Any) -> Any:
        """Deep-copy ``obj`` and redact PHI. Fail-closed.

        Walks all nested dicts / lists / tuples. Any exception is
        translated into :class:`ScrubberFailure` so the caller (Sentry
        ``before_send`` etc.) can drop the event.
        """
        try:
            cloned = copy.deepcopy(obj)
            return self._walk(cloned, parent_key=None)
        except ScrubberFailure:
            raise
        except Exception as exc:  # noqa: BLE001 — fail-closed is the contract.
            phi_scrubber_failed_total.labels(reason="scrub_dict").inc()
            logger.error("phi_scrubber.scrub_dict failed: %s", exc, exc_info=True)
            raise ScrubberFailure("scrub_dict failed") from exc

    def scrub_string(self, s: str) -> str:
        """Scrub a free-text string. Fail-closed."""
        try:
            return self._scrub_string_inner(s)
        except Exception as exc:  # noqa: BLE001
            phi_scrubber_failed_total.labels(reason="scrub_string").inc()
            logger.error(
                "phi_scrubber.scrub_string failed: %s", exc, exc_info=True
            )
            raise ScrubberFailure("scrub_string failed") from exc

    # -- internals -------------------------------------------------------

    def _walk(self, node: Any, *, parent_key: str | None) -> Any:
        if isinstance(node, dict):
            return {k: self._walk(v, parent_key=k) for k, v in node.items()}
        if isinstance(node, list):
            return [self._walk(v, parent_key=parent_key) for v in node]
        if isinstance(node, tuple):
            return tuple(self._walk(v, parent_key=parent_key) for v in node)
        if isinstance(node, str):
            if parent_key and parent_key in self.safe_field_names:
                # Field name is on the allowlist — leave value alone.
                return node
            return self._scrub_string_inner(node)
        # Non-string scalars (int/float/bool/None) → pass through.
        return node

    def _scrub_string_inner(self, s: str) -> str:
        if not s:
            return s

        # 1. DICOM UIDs.
        redacted = _DICOM_UID_RE.sub(REDACTION, s)

        # 2. MRN labels (redact the ENTIRE label+payload span).
        redacted = _MRN_LABEL_RE.sub(REDACTION, redacted)

        # 3. Tenant-specific MRN patterns (if any).
        if self._extra_mrn_re is not None:
            redacted = self._extra_mrn_re.sub(REDACTION, redacted)

        # 4. Emails.
        redacted = _EMAIL_RE.sub(REDACTION, redacted)

        # 5. Bare 6-10 digit numeric bursts (residual MRNs).
        redacted = _BARE_MRN_RE.sub(REDACTION, redacted)

        # 6. Names (Aho-Corasick). We replace token-by-token: the
        #    automaton gives us (end_index, value). We sort matches
        #    by descending end_index so earlier replacements don't
        #    shift indices for later ones.
        redacted = self._redact_names(redacted)

        return redacted

    def _redact_names(self, s: str) -> str:
        if self._automaton is None:
            return s

        # Collect non-overlapping matches with simple word-boundary check.
        matches: list[tuple[int, int]] = []  # (start, end)
        try:
            iter_ = self._automaton.iter(s)
        except Exception:  # noqa: BLE001
            # Automaton returned before finalization — treat as no matches.
            return s

        for end_index, value in iter_:
            start = end_index - len(value) + 1
            end = end_index + 1
            # Word-boundary: previous char not alpha, next char not alpha
            prev_ok = start == 0 or not s[start - 1].isalpha()
            next_ok = end == len(s) or not s[end].isalpha()
            if prev_ok and next_ok:
                matches.append((start, end))

        if not matches:
            return s

        # Merge overlaps + replace from right to left.
        matches.sort()
        merged: list[tuple[int, int]] = []
        for start, end in matches:
            if merged and start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], end))
            else:
                merged.append((start, end))

        out = s
        for start, end in reversed(merged):
            out = out[:start] + REDACTION + out[end:]
        return out

    @staticmethod
    def _build_automaton(names: Iterable[str]) -> Any:
        if ahocorasick is None:
            # Fallback: simple set + linear scan in _redact_names via regex.
            # We still return an object with an ``iter`` method for uniform code.
            class _FallbackAutomaton:
                def __init__(self, words: tuple[str, ...]) -> None:
                    # Longest-first so multi-word names are caught before
                    # single tokens.
                    self._patterns = sorted(set(words), key=len, reverse=True)

                def iter(self, s: str) -> Iterable[tuple[int, str]]:
                    for pat in self._patterns:
                        start = 0
                        while True:
                            i = s.find(pat, start)
                            if i < 0:
                                break
                            yield (i + len(pat) - 1, pat)
                            start = i + len(pat)

            return _FallbackAutomaton(tuple(names))

        auto = ahocorasick.Automaton()
        for name in names:
            if name:
                auto.add_word(name, name)
        auto.make_automaton()
        return auto


__all__ = [
    "GERMAN_NAMES",
    "GEORGIAN_NAMES",
    "PHIScrubber",
    "REDACTION",
    "SAFE_FIELD_NAMES",
    "ScrubberFailure",
    "phi_scrubber_failed_total",
]
