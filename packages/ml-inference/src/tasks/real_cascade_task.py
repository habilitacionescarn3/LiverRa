# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Real-mode cascade — runs the TS-based 7-stage pipeline as a Celery task.

Plain-English: when ``LIVERRA_CASCADE_REAL_MODE=true``, the orchestrator
dispatches THIS task instead of ``run_cascade`` (Triton-stubs path) or
``demo_cascade`` (synthetic path). It runs the same end-to-end cascade
that ``scripts/real_cascade.py`` runs from the CLI — TotalSegmentator
for parenchyma/vessels/lesions plus the orchestrator-level heuristics
for Couinaud, LI-RADS classification, and segment-aware FLR.

Why: the production HTTP cascade (``run_cascade`` → Triton) currently
runs against placeholder STU-Net stubs, producing garbage masks. The
TS-based pipeline produces clinically-plausible output today; this task
is the bridge so the UI's ``POST /api/v1/analyses/from-orthanc`` ends
up calling it.

Caveats (as of cherry-pick of cd794bc + ddcb4e0):
  - TotalSegmentator weights are CC-BY-NC-SA-4.0 — internal demo / clinical
    validation only. Not for paying customers without a commercial license.
  - The 4 phase NIfTIs must already be in MinIO at
    ``s3://liverra-phases-eu-central-1/{study_id}/{phase}.nii.gz``
    before this task runs (i.e. ingest stage 0 must already have written them).
  - TS runs in-process: the Celery worker host must have a GPU + the
    ``liverra-ml`` conda env (or equivalent) with TotalSegmentator installed.
"""
from __future__ import annotations

import importlib.util
import logging
import os
import sys
from pathlib import Path

from src.workers.app import app

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Lazy import of run_real_cascade from scripts/real_cascade.py
#
# The script is intentionally not part of the importable package tree (it's
# a CLI tool first). We load it on demand so worker startup doesn't pull in
# TotalSegmentator / SimpleITK unless this task actually fires.
# ---------------------------------------------------------------------------

_PKG_ROOT = Path(__file__).resolve().parents[2]  # …/packages/ml-inference
_SCRIPT_PATH = _PKG_ROOT / "scripts" / "real_cascade.py"


def _load_run_real_cascade():
    """Load and cache ``run_real_cascade`` from the script module."""
    if "_real_cascade_module" not in globals():
        # Make sure the package root is on sys.path so the script's own
        # ``from src.orchestrator.couinaud_heuristic import …`` imports work.
        if str(_PKG_ROOT) not in sys.path:
            sys.path.insert(0, str(_PKG_ROOT))
        spec = importlib.util.spec_from_file_location(
            "liverra_real_cascade_script", _SCRIPT_PATH
        )
        if spec is None or spec.loader is None:  # pragma: no cover
            raise RuntimeError(
                f"Cannot load real_cascade.py from {_SCRIPT_PATH}"
            )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        globals()["_real_cascade_module"] = module
    return globals()["_real_cascade_module"].run_real_cascade


@app.task(name="liverra.tasks.real_cascade", bind=True)
def real_cascade_task(self, analysis_id: str, start_stage: int = 0) -> dict:
    """Run the full TS-based cascade for an existing Analysis row.

    Parameters
    ----------
    analysis_id
        UUID of the Analysis row already inserted by the HTTP layer.
    start_stage
        Reserved for retry flows; not currently used (the script always
        runs the full 7-stage pipeline).

    Returns
    -------
    dict
        Summary from ``run_real_cascade()`` — analysis_id, status,
        total_ml, flr_ml, flr_pct, lesion_count, duration_s.
    """
    import psycopg

    sync_url = os.environ.get(
        "DATABASE_URL_SYNC",
        "postgresql://liverra:liverra@localhost:5432/liverra",
    )
    with psycopg.connect(sync_url, autocommit=True) as conn:
        row = conn.execute(
            "SELECT study_id, tenant_id FROM analysis WHERE id = %s",
            (analysis_id,),
        ).fetchone()
        if not row:
            logger.error("real_cascade: analysis %s not found", analysis_id)
            return {"status": "error", "reason": "analysis_not_found"}
        study_id, tenant_id = str(row[0]), str(row[1])

    resection_pattern = os.environ.get(
        "LIVERRA_DEFAULT_RESECTION_PATTERN", "right_hepatectomy"
    )

    logger.info(
        "real_cascade_task: running TS pipeline for analysis=%s study=%s pattern=%s",
        analysis_id,
        study_id,
        resection_pattern,
    )

    run_real_cascade = _load_run_real_cascade()
    try:
        result = run_real_cascade(
            analysis_id=analysis_id,
            study_id=study_id,
            tenant_id=tenant_id,
            resection_pattern=resection_pattern,
        )
    except Exception as exc:
        logger.exception("real_cascade_task: pipeline failed")
        # Mark the analysis as failed so the UI doesn't spin forever.
        with psycopg.connect(sync_url, autocommit=True) as conn:
            conn.execute(
                "UPDATE analysis SET status='failed', completed_at=now() "
                "WHERE id = %s",
                (analysis_id,),
            )
        return {"status": "error", "reason": str(exc)}

    return result
