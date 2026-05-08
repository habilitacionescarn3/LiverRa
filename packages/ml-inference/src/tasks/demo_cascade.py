# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Demo-mode cascade — simulates full 7-stage pipeline with synthetic output.

Plain-English: when `LIVERRA_CASCADE_DEMO_MODE=true`, the orchestrator
dispatches THIS task instead of the real cascade. It runs through 7
stages over ~30s, writing realistic checkpoints + lesions + FLR to the
DB so the UI shows a complete cascade run end-to-end.

Why: lets clinicians evaluate the full UX (live progress, results
review, finalize wizard, report) without depending on:
  - Real 4-phase liver CT input data
  - DICOM→NIfTI conversion pipeline
  - Pre-uploaded NIfTI volumes in MinIO
  - Triton actually being able to run on the input

The synthetic output is deterministic per analysis_id (so retries land
the same data) and clinically plausible (volumes within physiologic
range, lesion distribution typical of metastatic CRLM, FLR ~30%).

Switch off (use real cascade) by unsetting LIVERRA_CASCADE_DEMO_MODE.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from typing import Any
from uuid import UUID

from celery import shared_task

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Stage timing — total ~30s on warm cache, ~45s on cold
# ---------------------------------------------------------------------------

STAGES = [
    ("anonymization", 2.0, "mock-1", "sha256:abc123"),
    ("parenchyma", 6.0, "stunet-v1", "sha256:def456"),
    ("vessels", 4.0, "totalseg-v1", "sha256:ghi789"),
    ("couinaud", 3.0, "pictorial-v1", "sha256:jkl012"),
    ("lesion_detection", 5.0, "stunet-lesions-v1", "sha256:mno345"),
    ("classification", 3.0, "lilnet-v1", "sha256:pqr678"),
    ("flr_init", 2.0, "flr-default-v1", "sha256:stu901"),
]


def _seed_int(analysis_id: str, key: str) -> int:
    """Deterministic 31-bit int derived from analysis_id + key."""
    h = hashlib.sha256(f"{analysis_id}:{key}".encode()).hexdigest()
    return int(h[:8], 16) & 0x7FFFFFFF


def _synthetic_lesions(analysis_id: str) -> list[dict[str, Any]]:
    """Generate 2-4 plausible lesions with different classifications."""
    seed = _seed_int(analysis_id, "lesion_count")
    count = 2 + (seed % 3)  # 2, 3, or 4 lesions
    classifications = [
        ("hcc", 0.86),
        ("metastasis", 0.74),
        ("fnh", 0.61),
        ("hemangioma", 0.79),
        ("cyst", 0.92),
    ]
    segments = [4, 7, 8, 6, 5]
    diameters = [32.5, 18.7, 24.1, 12.3, 41.2]
    out = []
    for i in range(count):
        cls_label, cls_conf = classifications[i % len(classifications)]
        seg = segments[i % len(segments)]
        diam = diameters[i % len(diameters)]
        # plausible bbox volume from diameter (sphere approx, mm^3 → ml)
        vol_ml = round(((diam / 2) ** 3 * 4 / 3 * 3.14159) / 1000, 2)
        x_lo = 100 + i * 35
        y_lo = 150 + i * 20
        z_lo = 70 + i * 15
        out.append({
            "bbox3d": json.dumps({
                "x": [x_lo, x_lo + int(diam)],
                "y": [y_lo, y_lo + int(diam)],
                "z": [z_lo, z_lo + int(diam * 0.7)],
            }),
            "couinaud_segment": seg,
            "couinaud_location": seg,
            "diameter_mm": diam,
            "longest_diameter_mm": diam,
            "volume_ml": vol_ml,
            "mask_uri": f"s3://liverra-demo/{analysis_id}/lesion-{i+1}.nii.gz",
            "discovery_source": "ai",
            "classification": json.dumps({
                "label": cls_label,
                "confidence": cls_conf,
                "abstain": cls_conf < 0.65,
            }),
        })
    return out


# ---------------------------------------------------------------------------
# Celery task
# ---------------------------------------------------------------------------


@shared_task(name="liverra.tasks.demo_cascade", bind=True)
def demo_cascade(self, analysis_id_str: str, start_stage: int = 0) -> dict[str, Any]:
    """Simulate the 7-stage cascade with realistic synthetic outputs.

    Writes to Postgres directly via psycopg (sync) — no async session
    needed, keeps this task self-contained.
    """
    import psycopg

    analysis_id = analysis_id_str  # already a string from dispatch
    db_url = os.environ.get(
        "DATABASE_URL_SYNC",
        "postgresql://liverra:liverra@localhost:5432/liverra",
    )

    logger.info("demo_cascade: starting analysis=%s start_stage=%s", analysis_id, start_stage)

    # 1. Mark analysis as running
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE analysis SET status='running', started_at=now() WHERE id=%s",
                (analysis_id,),
            )
        conn.commit()

    # 2. Run through 7 stages with realistic timing
    for idx, (stage, duration, model_version, license_hash) in enumerate(STAGES):
        stage_no = idx + 1
        if stage_no <= start_stage:
            continue

        # Simulate inference time
        time.sleep(duration)

        # Write checkpoint
        with psycopg.connect(db_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO pipeline_checkpoint
                        (analysis_id, stage_no, stage, output_uri, model_version, model_license_hash)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT DO NOTHING
                    """,
                    (
                        analysis_id, stage_no, stage,
                        f"s3://liverra-demo/{analysis_id}/{stage}.nii.gz",
                        model_version, license_hash,
                    ),
                )
            conn.commit()
        logger.info("demo_cascade: stage %d (%s) complete", stage_no, stage)

    # 3. Insert segmentations (4 layers: parenchyma, vessels, couinaud, lesions)
    seg_specs = [
        ("liver", "whole_liver", 1829.10, "1.2.840.demo.parenchyma", "10200004"),
        ("vessels", "portal+hepatic", 5.20, "1.2.840.demo.vessels", "397894008"),
        ("couinaud", "8_segments", 1829.10, "1.2.840.demo.couinaud", "63627004"),
        ("lesion", "focal_lesions", 75.30, "1.2.840.demo.lesions", "52988006"),
    ]
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            for cat, detail, vol, sop_uid, snomed in seg_specs:
                cur.execute(
                    """
                    INSERT INTO segmentation
                        (analysis_id, generation_source, mask_uri, sop_instance_uid,
                         anatomy_category, anatomy_detail, volume_ml, mask_url, snomed_code)
                    VALUES (%s, 'ai', %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        analysis_id,
                        f"s3://liverra-demo/{analysis_id}/{cat}.dcm",
                        f"{sop_uid}.{analysis_id[:8]}",
                        cat, detail, vol,
                        f"s3://liverra-demo/{analysis_id}/{cat}.dcm",
                        snomed,
                    ),
                )
        conn.commit()

    # 4. Insert lesions
    lesions = _synthetic_lesions(analysis_id)
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            for lesion in lesions:
                cur.execute(
                    """
                    INSERT INTO lesion
                        (analysis_id, bbox3d, couinaud_segment, couinaud_location,
                         diameter_mm, longest_diameter_mm, volume_ml, mask_uri,
                         discovery_source, classification)
                    VALUES (%s, %s::jsonb, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        analysis_id, lesion["bbox3d"], lesion["couinaud_segment"],
                        lesion["couinaud_location"], lesion["diameter_mm"],
                        lesion["longest_diameter_mm"], lesion["volume_ml"],
                        lesion["mask_uri"], lesion["discovery_source"],
                        lesion["classification"],
                    ),
                )
        conn.commit()

    # 5. Insert FLR calculation (right hepatectomy — typical 28-32% FLR)
    flr_pct_seed = _seed_int(analysis_id, "flr") % 500  # 0-499
    flr_pct = 26.0 + (flr_pct_seed / 100.0)  # 26.0-31.0
    total_ml = 1829.10
    flr_ml = round(total_ml * flr_pct / 100, 2)
    resected_ml = round(total_ml - flr_ml, 2)
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO flr_calculation
                    (analysis_id, plane_pose, total_ml, flr_ml, flr_pct,
                     plane_normal, plane_offset_mm, resected_volume_ml, remnant_volume_ml,
                     remnant_pct_functional, author)
                VALUES (%s, %s::jsonb, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, 'ai_default')
                """,
                (
                    analysis_id,
                    # Axial-cut plane at mid-volume so FlrPlaneOverlay paints
                    # the purple band in the default (axial) viewport in dev.
                    json.dumps({"axis": "axial", "z_index": 128, "plane": "axial_midline"}),
                    total_ml, flr_ml, flr_pct,
                    json.dumps({"x": 0, "y": 0, "z": 1}),
                    128.0, resected_ml, flr_ml, flr_pct,
                ),
            )
        conn.commit()

    # 6. Mark analysis as completed
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE analysis SET status='completed', completed_at=now() WHERE id=%s",
                (analysis_id,),
            )
        conn.commit()

    logger.info("demo_cascade: completed analysis=%s", analysis_id)
    return {
        "status": "completed",
        "analysis_id": analysis_id,
        "stages_run": len(STAGES) - start_stage,
        "lesions_count": len(lesions),
        "flr_pct": flr_pct,
    }
