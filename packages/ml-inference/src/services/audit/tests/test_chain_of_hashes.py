"""Chain-of-hashes tamper-detection tests.

Ensures the AuditEvent chain MUST reject tampering at three canonical
positions (start, middle, end), per plan §Mandatory security-critical suites
and SC-010.

We keep the test mechanically robust against the concrete hash algorithm by
driving the chain entirely through the module's own writer/verifier. The goal
is to assert that **a mutation anywhere** invalidates verification — the
algorithm's job is to expose it.

References: tasks T361 · plan §Testing Strategy · SC-010 audit integrity.
"""

from __future__ import annotations

import copy
from typing import Callable, List

import pytest

# ---------------------------------------------------------------------------
# Module import (skip cleanly if early bootstrap has not wired the writer yet)
# ---------------------------------------------------------------------------

try:
    from src.services.audit import chain_of_hashes as coh  # type: ignore[import-not-found]
except Exception as exc:  # pragma: no cover
    coh = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None


pytestmark = pytest.mark.skipif(coh is None, reason=f"audit.chain_of_hashes not importable: {_IMPORT_ERROR}")


# ---------------------------------------------------------------------------
# Helpers — wrap module APIs with best-effort introspection so the test runs
# whether the module exposes functional `write_event`/`verify_chain` or a
# class `ChainWriter` / `ChainVerifier`.
# ---------------------------------------------------------------------------


def _write_event(writer_state: dict, event: dict) -> dict:
    if hasattr(coh, "write_event"):
        return coh.write_event(event, state=writer_state)  # type: ignore[attr-defined]
    if hasattr(coh, "ChainWriter"):
        writer = writer_state.setdefault("_writer", coh.ChainWriter())  # type: ignore[attr-defined]
        return writer.write(event)
    pytest.skip("chain_of_hashes exposes neither write_event nor ChainWriter")


def _verify_chain(chain: List[dict]) -> bool:
    if hasattr(coh, "verify_chain"):
        return bool(coh.verify_chain(chain))  # type: ignore[attr-defined]
    if hasattr(coh, "ChainVerifier"):
        verifier = coh.ChainVerifier()  # type: ignore[attr-defined]
        return bool(verifier.verify(chain))
    pytest.skip("chain_of_hashes exposes neither verify_chain nor ChainVerifier")


def _seed_chain(n: int = 10) -> List[dict]:
    state: dict = {}
    chain: List[dict] = []
    for i in range(n):
        event = {
            "event_id": f"evt-{i:04d}",
            "tenant_id": "tenant-test",
            "action": "test.action",
            "resource_id": f"res-{i:04d}",
            "outcome": "success",
            "sequence": i,
        }
        chain.append(_write_event(state, event))
    return chain


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_pristine_chain_verifies() -> None:
    chain = _seed_chain(10)
    assert _verify_chain(chain) is True


@pytest.mark.parametrize(
    "tamper_at",
    ["start", "middle", "end"],
    ids=["tamper-start", "tamper-middle", "tamper-end"],
)
def test_tampering_at_position_is_detected(tamper_at: str) -> None:
    chain = _seed_chain(10)
    idx = {"start": 0, "middle": 5, "end": 9}[tamper_at]
    tampered = copy.deepcopy(chain)

    # Mutate the payload of the selected event. We deliberately modify a
    # non-hash field so the writer's computed leaf_hash is preserved — exactly
    # the threat model (adversary edits data but forgets to recompute hash).
    if "payload" in tampered[idx]:
        tampered[idx]["payload"] = "ADVERSARY_MODIFIED"
    elif "action" in tampered[idx]:
        tampered[idx]["action"] = "adversary.rewritten"
    else:
        tampered[idx]["_adversary_flag"] = True

    assert _verify_chain(tampered) is False, (
        f"Chain tampering at position {tamper_at} (index {idx}) was not detected"
    )


def test_deleting_event_breaks_linearity() -> None:
    chain = _seed_chain(10)
    del chain[4]
    assert _verify_chain(chain) is False, "Chain with a deleted event was not detected"


def test_reordering_events_breaks_chain() -> None:
    chain = _seed_chain(10)
    chain[3], chain[7] = chain[7], chain[3]
    assert _verify_chain(chain) is False, "Reordered chain was not detected"


def test_appending_forged_event_without_recompute_fails() -> None:
    chain = _seed_chain(10)
    forged = {
        "event_id": "evt-forged",
        "tenant_id": "tenant-test",
        "action": "adversary.action",
        "sequence": 10,
        "leaf_hash": "f" * 64,      # adversary's arbitrary hash
        "prev_hash": "a" * 64,      # wrong previous link
    }
    chain.append(forged)
    assert _verify_chain(chain) is False
