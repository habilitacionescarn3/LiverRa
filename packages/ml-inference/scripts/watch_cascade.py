"""Live progress watcher for the LiverRa cascade.

Polls Postgres for the latest Analysis row + its pipeline_checkpoint entries
and prints a one-line progress bar. Also tails the celery log to surface
sanity_failure / soft_time_limit issues in real time.

Usage:
    python packages/ml-inference/scripts/watch_cascade.py
    # Ctrl+C exits at any time.
"""
from __future__ import annotations

import os
import re
import sys
import time
from datetime import datetime, timezone

import psycopg

DB_URL = os.environ.get(
    "DATABASE_URL_SYNC",
    "postgresql://liverra:liverra@localhost:5432/liverra",
)
LOG = "/tmp/celery.log"

STAGES = [
    ("anonymization", "🧹 anon"),
    ("parenchyma", "🫀 parenchyma"),
    ("vessels", "🩸 vessels"),
    ("couinaud", "🗺  couinaud"),
    ("lesion_detection", "🎯 lesions"),
    ("classification", "🔬 classify"),
    ("flr_init", "📊 FLR"),
]


def fmt_bar(completed: set[str]) -> str:
    cells = []
    for stage_key, label in STAGES:
        if stage_key in completed:
            cells.append(f"\033[92m●\033[0m")  # green
        else:
            cells.append("\033[90m○\033[0m")  # gray
    return " ".join(cells)


def fmt_legend() -> str:
    return " ".join(label for _, label in STAGES)


def latest_state(conn) -> tuple | None:
    row = conn.execute(
        """
        SELECT id, status, started_at, queued_at
        FROM analysis
        ORDER BY queued_at DESC
        LIMIT 1
        """
    ).fetchone()
    if not row:
        return None
    aid, status, started_at, queued_at = row
    ckpts = conn.execute(
        """
        SELECT stage_no, stage, model_version, written_at
        FROM pipeline_checkpoint
        WHERE analysis_id = %s
        ORDER BY stage_no
        """,
        (aid,),
    ).fetchall()
    return aid, status, started_at, queued_at, ckpts


def latest_log_warn() -> str | None:
    """Return the most recent SanityFailure / SoftTimeLimit / TypeError line."""
    if not os.path.exists(LOG):
        return None
    try:
        with open(LOG, "rb") as f:
            tail = f.read()[-8192:].decode("utf-8", errors="ignore")
    except Exception:
        return None
    pat = re.compile(
        r"(SanityFailure|SoftTimeLimit|TypeError|ProgrammingError|ChordError)"
    )
    matches = [m for m in pat.finditer(tail)]
    if not matches:
        return None
    return tail.splitlines()[-1][:120]


def main() -> int:
    print("Watching LiverRa cascade…  (Ctrl+C to exit)\n")
    print(f"  Stages: {fmt_legend()}\n")

    last_aid = None
    start_wall = time.time()
    final_status = None

    with psycopg.connect(DB_URL) as conn:
        conn.autocommit = True
        while True:
            try:
                state = latest_state(conn)
            except Exception as exc:
                print(f"\rDB poll error: {exc}", end="", flush=True)
                time.sleep(0.5)
                continue
            if state is None:
                print("\r⏳ Waiting for an Analysis row…", end="", flush=True)
                time.sleep(0.4)
                continue

            aid, status, started_at, queued_at, ckpts = state
            if aid != last_aid:
                last_aid = aid
                start_wall = time.time()
                print(f"\n  Analysis: {aid}")

            completed = {row[1] for row in ckpts}
            bar = fmt_bar(completed)
            elapsed = time.time() - start_wall
            num = len(completed)

            line = (
                f"\r  {bar}  [{num}/{len(STAGES)}]  "
                f"\033[1m{status:<14}\033[0m  "
                f"+{elapsed:5.1f}s"
            )
            warn = latest_log_warn()
            if warn:
                line += f"  \033[93m⚠ {warn[:80]}\033[0m"
            print(line, end="", flush=True)

            if status in ("completed", "partial_result", "failed"):
                final_status = status
                break
            # Auto-detect "logically complete" when all 7 stages have checkpoints
            # (the cascade doesn't always flip status='completed').
            if num >= len(STAGES):
                final_status = "all-stages-checkpointed"
                break

            time.sleep(0.3)

    print()
    print()
    if final_status:
        print(f"=== {final_status} ===\n")
        with psycopg.connect(DB_URL) as conn:
            conn.autocommit = True
            print("Pipeline checkpoints:")
            for r in conn.execute(
                "SELECT stage_no, stage, model_version, output_uri "
                "FROM pipeline_checkpoint WHERE analysis_id=%s ORDER BY stage_no",
                (last_aid,),
            ).fetchall():
                sn, st, mv, uri = r
                print(f"  {sn}. {st:<18} {mv:<32} {uri}")
            print()
            flr = conn.execute(
                "SELECT total_ml, flr_ml, flr_pct, plane_pose, computed_at "
                "FROM flr_calculation WHERE analysis_id=%s",
                (last_aid,),
            ).fetchone()
            if flr:
                total, flr_ml, pct, pose, when = flr
                print(f"FLR result:")
                print(f"  total liver volume:  {total} ml")
                print(f"  future liver remnant: {flr_ml} ml ({pct} %)")
                print(f"  plane:                {pose}")
                print(f"  computed at:          {when}")
            else:
                print("No FLR row — cascade did not reach stage 7.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n\n^C")
        sys.exit(0)
