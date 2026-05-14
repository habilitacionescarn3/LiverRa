# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Audit rewriter — chain-integrity preserving substitutions (T335, US9).

Plain-English:
    We hand the rewriter a small dict containing a UUID, an email, a
    DICOM UID, and an MRN-shaped token, and verify:

      1. All four are substituted with ``[erased:xxxxxxxxxxxx]`` tokens.
      2. Non-identifier strings pass through unchanged.
      3. The substitutions are stable — feeding the same input twice
         with the same ``tombstone_hash`` yields the same output
         (important so the audit log remains deterministic).
      4. Chain-integrity expectation: the rewriter never recomputes
         ``leaf_hash`` (we assert on the function body via a string
         search — the column is never referenced outside comments).
"""
from __future__ import annotations

import pathlib


def test_rewrite_string_substitutes_identifiers() -> None:
    from src.services.erasure.audit_rewriter import _rewrite_string  # type: ignore

    tombstone = b"\xaa" * 32
    text_in = (
        "Study UUID 11111111-1111-4111-8111-111111111111, "
        "Series UID 1.2.840.10008.1.2.3.4.5.6.7.8.9, "
        "MRN: 55512 and contact dpo@example.com"
    )
    out, count = _rewrite_string(text_in, tombstone)

    assert count == 4, f"expected 4 substitutions, got {count}: {out}"
    # The original identifier substrings MUST be gone.
    assert "11111111-1111-4111-8111-111111111111" not in out
    assert "dpo@example.com" not in out
    assert "MRN: 55512" not in out
    assert "1.2.840.10008.1.2.3.4.5.6.7.8.9" not in out
    # Surrounding text preserved.
    assert "Study UUID" in out
    assert "and contact" in out


def test_rewrite_string_is_deterministic() -> None:
    """Same input + tombstone → same output (stable audit trail)."""
    from src.services.erasure.audit_rewriter import _rewrite_string  # type: ignore

    tombstone = b"\xbb" * 32
    text = "uuid 22222222-2222-4222-8222-222222222222"
    out1, _ = _rewrite_string(text, tombstone)
    out2, _ = _rewrite_string(text, tombstone)
    assert out1 == out2


def test_walk_and_rewrite_preserves_structure() -> None:
    from src.services.erasure.audit_rewriter import _walk_and_rewrite  # type: ignore

    tombstone = b"\xcc" * 32
    counter = [0]
    node = {
        "resourceType": "AuditEvent",
        "entity": [{"what": {"reference": "Study/33333333-3333-4333-8333-333333333333"}}],
        "note": "Uploaded by clinician at 14:00",
        "id": "44444444-4444-4444-4444-444444444444",
    }
    out = _walk_and_rewrite(node, tombstone, counter)

    assert isinstance(out, dict)
    assert out["resourceType"] == "AuditEvent"
    assert out["note"] == node["note"]  # non-identifier string unchanged
    ref = out["entity"][0]["what"]["reference"]
    assert "33333333-3333-4333-8333-333333333333" not in ref
    assert ref.startswith("Study/[erased:")
    assert counter[0] >= 2  # two UUIDs in the document


def test_rewriter_source_never_updates_leaf_hash() -> None:
    """Chain-integrity assertion (research §A.3): the module MUST NOT
    UPDATE any of ``leaf_hash``, ``prev_leaf_hash``, or
    ``sequence_no``. We enforce this as a textual contract so future
    refactors can't regress it silently.
    """
    src = (
        pathlib.Path(__file__).resolve().parent.parent / "audit_rewriter.py"
    ).read_text(encoding="utf-8")

    # We allow the strings to appear in COMMENTS (docstring), but there
    # must be no SQL write targeting them. Covers both the legacy table
    # name and the actual chain table the rewriter now targets (B-AUDIT-1).
    forbidden_sql_snippets = (
        "UPDATE audit_event SET leaf_hash",
        "UPDATE audit_event SET prev_leaf_hash",
        "UPDATE audit_event SET sequence_no",
        "UPDATE audit_event_chain SET leaf_hash",
        "UPDATE audit_event_chain SET prev_leaf_hash",
        "UPDATE audit_event_chain SET sequence_no",
    )
    for needle in forbidden_sql_snippets:
        assert needle not in src, (
            f"audit_rewriter MUST NOT modify {needle!r} — "
            "would break chain integrity (research §A.3)."
        )

    # Positive assertion: the only table we UPDATE is audit_event_chain
    # and the only column we UPDATE is canonical_json.
    assert "UPDATE audit_event_chain" in src
    assert "SET canonical_json" in src


def test_hash_token_includes_erased_prefix() -> None:
    from src.services.erasure.audit_rewriter import _hash_token  # type: ignore

    token = _hash_token("abc", b"\x00" * 32)
    assert token.startswith("[erased:")
    assert token.endswith("]")
    # 12 hex chars of prefix → total length 8+12+1 = 21.
    assert len(token) == 21
