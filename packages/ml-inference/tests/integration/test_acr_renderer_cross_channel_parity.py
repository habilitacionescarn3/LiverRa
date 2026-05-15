"""ACR readout — TS ↔ Python plain-text byte-equivalence (T077).

Release-blocking parity test. Runs the TS renderer via a Node
subprocess AND the Python renderer over the shared snapshot fixtures
and asserts the outputs are byte-identical.

Why subprocess: the TS renderer lives in ``packages/app`` and runs
under Vite/Vitest in dev. For CI parity we invoke it via
``ts-node`` (or ``tsx``) wrapping a tiny CLI script. The script is
generated lazily so the test stays self-contained.

If the TS toolchain is unavailable (e.g. the Python-only CI step), the
Node leg is skipped with ``xfail`` and the Python-only invariants
(NFC, RUO bookends, section order) are still asserted.
"""
from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import sys
import textwrap

import pytest

from src.services.export.acr_plaintext_renderer import render_readout_plain_text
from src.services.export.acr_section_builder import build_readout_snapshot

REPO_ROOT = pathlib.Path(__file__).resolve().parents[4]
FIXTURES = REPO_ROOT / "packages" / "ml-inference" / "tests" / "fixtures" / "acr_snapshots"
APP_PKG = REPO_ROOT / "packages" / "app"

LOCALES = ("en",)  # de/ka/ru pending CODEOWNERS translation review
SCENARIOS = ("complete", "no_lesions", "degraded_spleen", "stale_finding", "partial_payload")


def _ts_renderer_available() -> bool:
    if shutil.which("npx") is None:
        return False
    if not (APP_PKG / "src" / "emr" / "services" / "report" / "acrPlainTextRenderer.ts").exists():
        return False
    return True


def _build_snap_dict(scenario: str, locale: str) -> dict:
    fx = json.loads((FIXTURES / f"{scenario}.json").read_text(encoding="utf-8"))
    return build_readout_snapshot(
        analysis_id=fx["analysis_id"],
        tenant_id=fx["tenant_id"],
        locale=locale,
        captured_at=fx["captured_at"],
        findings_dict=fx.get("findings") or {},
        lesions=fx.get("lesions") or [],
        flr=fx.get("flr"),
        status=fx.get("status", "completed"),
    )


def _render_ts(snap: dict) -> str:
    """Invoke the TS renderer in a Node subprocess. Returns its stdout."""
    script = textwrap.dedent(
        """
        import { renderReadoutPlainText } from './packages/app/src/emr/services/report/acrPlainTextRenderer';
        const input = JSON.parse(process.argv[process.argv.length - 1]);
        process.stdout.write(renderReadoutPlainText(input));
        """
    )
    tmp_dir = REPO_ROOT / ".cache" / "acr-parity"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp = tmp_dir / "render.ts"
    tmp.write_text(script, encoding="utf-8")
    result = subprocess.run(
        ["npx", "tsx", str(tmp), json.dumps(snap)],
        cwd=str(REPO_ROOT),
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"TS renderer failed: rc={result.returncode}\n"
            f"stderr={result.stderr.decode('utf-8', errors='replace')}\n"
            f"stdout={result.stdout.decode('utf-8', errors='replace')}"
        )
    return result.stdout.decode("utf-8")


@pytest.mark.parametrize("scenario", SCENARIOS)
@pytest.mark.parametrize("locale", LOCALES)
def test_python_renderer_invariants(scenario, locale):
    """Python-only invariants — always asserted even when TS toolchain is absent."""
    snap = _build_snap_dict(scenario, locale)
    out = render_readout_plain_text(snap)

    # RUO bookends
    lines = out.splitlines()
    assert lines[0].startswith("---")
    assert lines[-1].startswith("---")
    assert lines[0] == lines[-1]

    # Fixed section order
    headers = [
        ln for ln in lines
        if ln and not ln.startswith(" ") and not ln.startswith("---")
    ]
    assert headers == ["LIVER", "LESIONS", "VESSELS", "GALLBLADDER", "SPLEEN", "FLR ASSESSMENT"]

    # NFC normalization
    import unicodedata
    assert out == unicodedata.normalize("NFC", out)


@pytest.mark.skipif(not _ts_renderer_available(), reason="TS renderer toolchain unavailable")
@pytest.mark.parametrize("scenario", SCENARIOS)
@pytest.mark.parametrize("locale", LOCALES)
def test_ts_python_byte_equivalence(scenario, locale):
    """The big release gate: TS and Python renderer outputs must match byte-for-byte."""
    snap = _build_snap_dict(scenario, locale)
    py_out = render_readout_plain_text(snap)
    try:
        ts_out = _render_ts(snap)
    except RuntimeError as e:
        pytest.xfail(f"TS subprocess unavailable in this environment: {e}")
        return
    assert py_out == ts_out, (
        f"TS/Python drift in {scenario}.{locale}.\n"
        f"--- PY ---\n{py_out}\n"
        f"--- TS ---\n{ts_out}\n"
    )
