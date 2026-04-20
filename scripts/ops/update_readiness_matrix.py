#!/usr/bin/env python3
"""T397 helper — rewrite Status + Evidence columns of readiness-matrix.md.

Plain-English summary: this script is the brains behind the nightly
readiness-matrix workflow. Given a JSON blob of {"SC-001": {conclusion,
url, ...}, ...} it finds each matching row in the markdown table and
updates the Status and Evidence columns without touching the rest of
the file.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

ICONS = {
    "success": ":white_check_mark: green",
    "failure": ":x: red",
    "cancelled": ":warning: cancelled",
    "skipped": ":next_track_button: skipped",
    "timed_out": ":x: timed-out",
}


def cell(run: dict) -> tuple[str, str]:
    """Return (status_cell, evidence_cell)."""
    if not run:
        return ":hourglass: pending", "-"
    conclusion = (run.get("conclusion") or "").lower()
    status = (run.get("status") or "").lower()
    url = run.get("url") or "-"
    if status and status != "completed":
        return f":arrows_counterclockwise: {status}", url
    text = ICONS.get(conclusion, ":hourglass: pending")
    return text, url


# Gate name -> readable label used in the Upgraded SC gates table rows.
GATE_LABEL_MATCHES = {
    "ci-palette-cvd-check": ("Palette CVD check",),
    "e2e-gpu": ("GPU load",),
    "ci-alembic-migrations": ("Alembic round-trip",),
    "ci-dicom-uid-present": ("DICOM UID present",),
    "ci-bundle-check": ("Bundle budget",),
}


def rewrite(status: dict, matrix_path: pathlib.Path) -> bool:
    text = matrix_path.read_text()
    lines = text.splitlines(keepends=True)
    out: list[str] = []
    changed = False

    sc_row = re.compile(r"^\|\s*(SC-\d{3})\s*\|")

    for line in lines:
        m = sc_row.match(line)
        if m:
            sc_id = m.group(1)
            run = status.get(sc_id) or {}
            s, url = cell(run)
            parts = [p.strip() for p in line.strip().strip("|").split("|")]
            if len(parts) >= 5:
                parts[3] = s
                parts[4] = url if url and url != "-" else "-"
                new = "| " + " | ".join(parts) + " |\n"
                if new != line:
                    changed = True
                out.append(new)
                continue

        handled = False
        for gate_job, labels in GATE_LABEL_MATCHES.items():
            if any(lbl in line for lbl in labels) and line.lstrip().startswith("|"):
                parts = [p.strip() for p in line.strip().strip("|").split("|")]
                if len(parts) >= 4:
                    run = status.get(f"GATE-{gate_job}") or {}
                    s, _ = cell(run)
                    parts[3] = s
                    new = "| " + " | ".join(parts) + " |\n"
                    if new != line:
                        changed = True
                    out.append(new)
                    handled = True
                    break
        if handled:
            continue

        out.append(line)

    matrix_path.write_text("".join(out))
    return changed


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--status-json", required=True, type=pathlib.Path)
    ap.add_argument("--matrix-path", required=True, type=pathlib.Path)
    args = ap.parse_args(argv)

    status = json.loads(args.status_json.read_text())
    changed = rewrite(status, args.matrix_path)
    print(f"matrix={args.matrix_path} changed={changed}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
