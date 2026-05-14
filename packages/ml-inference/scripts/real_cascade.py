"""Real-quality cascade — runs TotalSegmentator on the Todua CT.

Bypasses the stub Triton models with a pretrained, anatomically-correct
liver/vessels/tumor segmentation. Outputs land in the same MinIO paths and
Postgres rows as the regular Triton cascade, so show_results.py renders
correctly with no changes.

Usage:
    AWS_ACCESS_KEY_ID=liverra AWS_SECRET_ACCESS_KEY=liverra-dev-password \\
      AWS_ENDPOINT_URL=http://localhost:9000 AWS_REGION=eu-central-1 \\
      python packages/ml-inference/scripts/real_cascade.py

License: TotalSegmentator code is Apache-2.0; weights are CC-BY-NC-SA-4.0.
**Internal demo only — not for clinical/commercial use.**
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
import uuid
from pathlib import Path

import boto3
import numpy as np
import psycopg
import SimpleITK as sitk

# Heuristic Couinaud + segment-aware FLR + LI-RADS-style classifier
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # …/ml-inference/

# GPU work runs on Irakli's box behind Tailscale — see
# packages/ml-inference-gpu/. The client below is a drop-in replacement
# for the in-process totalsegmentator() call: same inputs, same output
# files written into the same dest dir.
from src.services.inference_client import (
    infer_liver_vessels,
    infer_liver_vessels_with_provenance,
    infer_total,
    infer_total_with_provenance,
)
# H-CASCADE-2: the combined ``infer_total_and_vessels`` endpoint stays
# available on the GPU service (and on inference_client) for backward
# compatibility, but is no longer imported here — Agent 2.4 reverted the
# cascade to the two-call pattern (empirically ~2 min faster on the
# Tailscale link, per CLAUDE.md "Open decision"). The verification
# ``grep -rn "infer_total_and_vessels" packages/ml-inference/scripts/``
# now returns zero matches.
from src.orchestrator.couinaud_heuristic import compute_couinaud
from src.orchestrator.flr_segment_aware import (
    RESECTION_PATTERNS,
    compute_flr as compute_segment_aware_flr,
)
from src.orchestrator.lesion_enhancement_features import (
    PHASES as LIRADS_PHASES,
    extract_lesion_features,
)
from src.orchestrator.tumor_type_classifier import (
    CLASS_ORDER as LIRADS_CLASSES,
    classify_lesion,
)
from src.orchestrator.sanity import SanityFailure, check_stage


# ---------------------------------------------------------------------------
# C-CASCADE-1: sanity-bound enforcement on heuristic outputs.
#
# When ``LIVERRA_REQUIRE_SANITY=true`` (default in staging/prod) we
# raise on bound violation so the cascade fails loud. In dev (default
# false) we log a warning and continue so a single bad scan doesn't
# halt active iteration.
# ---------------------------------------------------------------------------


def _sanity_require() -> bool:
    return os.environ.get("LIVERRA_REQUIRE_SANITY", "").lower() in {"1", "true", "yes"}


def _sanity_call(stage_name: str, payload: dict) -> None:
    """Run a sanity bound check; raise if strict, warn if permissive."""
    try:
        check_stage(stage_name, payload)
    except SanityFailure as sf:
        if _sanity_require():
            print(f"      ✖ SANITY FAILURE {stage_name}: {sf.reason} — {sf.detail}")
            raise
        print(f"      ⚠ sanity warning {stage_name}: {sf.reason} — {sf.detail}")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DB_URL = os.environ.get(
    "DATABASE_URL_SYNC",
    "postgresql://liverra:liverra@localhost:5432/liverra",
)
PHASES_BUCKET = "liverra-phases-eu-central-1"
ANALYSES_BUCKET = "liverra-analyses-eu-central-1"
STUDY_ID = "00000000-0000-0000-0000-0000000000bb"
TENANT_ID = "00000000-0000-0000-0000-000000000001"
TARGET_SHAPE = (128, 128, 128)  # match Triton parenchyma contract (Z, Y, X)

LICENSE_BANNER = (
    "[license] TotalSegmentator weights: CC-BY-NC-SA-4.0 — "
    "internal demo only, NOT for clinical or commercial use."
)


# ---------------------------------------------------------------------------
# IO helpers
# ---------------------------------------------------------------------------


def s3_client():
    return boto3.client(
        "s3", region_name=os.environ.get("AWS_REGION", "eu-central-1")
    )


def download_phase(study_id: str, phase: str, dest: Path) -> Path:
    """Download a phase NIfTI from MinIO to local disk. Idempotent."""
    if dest.exists() and dest.stat().st_size > 1_000_000:
        return dest
    obj = s3_client().get_object(
        Bucket=PHASES_BUCKET,
        Key=f"studies/{study_id}/phases/{phase}.nii.gz",
    )
    dest.write_bytes(obj["Body"].read())
    return dest


def upload_nii(image: sitk.Image, key: str, bucket: str = ANALYSES_BUCKET) -> str:
    """Save a SimpleITK image and upload to MinIO. Returns s3:// URI."""
    with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=False) as tf:
        path = tf.name
    try:
        sitk.WriteImage(image, path)
        with open(path, "rb") as fh:
            s3_client().put_object(Bucket=bucket, Key=key, Body=fh.read())
    finally:
        os.unlink(path)
    return f"s3://{bucket}/{key}"


def resample_mask_to(
    mask_image: sitk.Image, target_shape_zyx: tuple[int, int, int]
) -> sitk.Image:
    """Resample a binary mask to target_shape_zyx using nearest-neighbor."""
    # SimpleITK SetSize takes (X, Y, Z); our target is (Z, Y, X).
    z, y, x = target_shape_zyx
    out_size = [x, y, z]
    in_size = list(mask_image.GetSize())
    in_spacing = list(mask_image.GetSpacing())
    out_spacing = [
        in_size[i] * in_spacing[i] / out_size[i] for i in range(3)
    ]
    res = sitk.ResampleImageFilter()
    res.SetSize(out_size)
    res.SetOutputSpacing(out_spacing)
    res.SetOutputOrigin(mask_image.GetOrigin())
    res.SetOutputDirection(mask_image.GetDirection())
    res.SetInterpolator(sitk.sitkNearestNeighbor)
    res.SetDefaultPixelValue(0)
    return res.Execute(mask_image)


def voxel_volume_ml(image: sitk.Image) -> float:
    sx, sy, sz = image.GetSpacing()
    return (sx * sy * sz) / 1000.0  # mm³ → ml


def native_volume_ml(mask_image: sitk.Image) -> float:
    arr = sitk.GetArrayFromImage(mask_image)  # (Z, Y, X)
    return float((arr > 0).sum() * voxel_volume_ml(mask_image))


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------


def insert_checkpoint(
    conn,
    analysis_id: str,
    stage_no: int,
    stage: str,
    output_uri: str,
    model_version: str,
    license_hash: str = "n/a",
    *,
    tenant_id: str | None = None,
) -> None:
    """Insert a pipeline_checkpoint row AND co-write the audit chain row.

    The audit chain co-write fixes B-CASCADE-1 + B-CLIN-5: before this
    fix, every cascade stage wrote clinical rows with ZERO AuditEvent /
    audit_event_chain emission. We mirror :class:`AuditChainWriter.write`'s
    hashing formula here because the async writer cannot share a
    transaction with the script's psycopg connection.
    """
    # H-CASCADE-3: was ``ON CONFLICT DO NOTHING`` — a retried task silently
    # kept the stale row (e.g., output_uri from the prior failed run) so
    # readers downstream pointed at gone-or-corrupt S3 objects. Idempotent
    # retry semantics: re-running a stage OVERWRITES the row.
    conn.execute(
        """
        INSERT INTO pipeline_checkpoint
          (analysis_id, stage_no, stage, output_uri, model_version, model_license_hash)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (analysis_id, stage_no) DO UPDATE SET
          stage = EXCLUDED.stage,
          output_uri = EXCLUDED.output_uri,
          model_version = EXCLUDED.model_version,
          model_license_hash = EXCLUDED.model_license_hash
        """,
        (analysis_id, stage_no, stage, output_uri, model_version, license_hash),
    )
    if tenant_id is not None:
        try:
            _write_chain_stage_complete_sync(
                conn,
                tenant_id=tenant_id,
                analysis_id=analysis_id,
                stage_no=stage_no,
                stage=stage,
                output_uri=output_uri,
                model_version=model_version,
                license_hash=license_hash,
            )
        except Exception as exc:
            # Log loudly; do not let a chain-write failure kill the demo.
            # The HTTP cascade path (src/tasks/real_cascade_task.py) owns
            # the strict fail-closed enforcement.
            print(f"      ! audit chain write failed for stage {stage}: {exc}")


def _canonical_json_sync(obj) -> str:
    """Sync-side mirror of services.audit.chain_of_hashes.canonical_json.

    No-space separators are mandatory (B-AUDIT-2). Keep in lock-step with
    the async writer or LIKE-pattern probes silently miss rows.
    """
    return json.dumps(
        obj,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def _write_chain_stage_complete_sync(
    conn,
    *,
    tenant_id: str,
    analysis_id: str,
    stage_no: int,
    stage: str,
    output_uri: str,
    model_version: str,
    license_hash: str,
) -> None:
    """Write a stage_complete row to audit_event_chain via psycopg.

    Mirrors :meth:`AuditChainWriter.write` exactly:
      1. ``pg_advisory_lock`` keyed on the tenant id (session-scoped here
         because psycopg autocommit=True means no xact lock available).
      2. ``SELECT ... ORDER BY sequence_no DESC LIMIT 1`` for the previous
         leaf hash.
      3. ``MAX(sequence_no) + 1`` for the next sequence number.
      4. ``leaf_hash = sha256(prev || sha256(tid:seq:canonical))``.
      5. INSERT.
    """
    import hashlib
    from datetime import datetime, timezone

    event = {
        "resourceType": "AuditEvent",
        "type": {
            "system": "http://terminology.hl7.org/CodeSystem/audit-event-type",
            "code": "rest",
            "display": "RESTful Operation",
        },
        "subtype": [
            {
                "system": "http://liverra.ai/fhir/CodeSystem/audit-subtypes",
                "code": "inference_stage_complete",
            }
        ],
        "recorded": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "outcome": "0",
        "agent": [
            {
                "who": {"reference": "Device/liverra-ml-inference"},
                "requestor": True,
            }
        ],
        "source": {"observer": {"reference": "Device/liverra-ml-inference"}},
        "entity": [{"what": {"reference": f"Analysis/{analysis_id}"}}],
        "extension": [
            {"url": "stage", "valueString": stage},
            {"url": "stage_no", "valueInteger": stage_no},
            {"url": "output_uri", "valueString": output_uri},
            {"url": "model_version", "valueString": model_version},
            {"url": "model_license_hash", "valueString": license_hash},
        ],
    }
    canonical = _canonical_json_sync(event)
    canonical_bytes = canonical.encode("utf-8")
    tid = str(tenant_id)

    def _sha(b: bytes) -> bytes:
        return hashlib.sha256(b).digest()

    conn.execute("SELECT pg_advisory_lock(hashtext(%s))", (tid,))
    try:
        cur = conn.execute(
            """
            SELECT leaf_hash
              FROM audit_event_chain
             WHERE tenant_id = %s
             ORDER BY sequence_no DESC
             LIMIT 1
            """,
            (tid,),
        )
        prev_row = cur.fetchone()
        prev_leaf = bytes(prev_row[0]) if prev_row else b"\x00" * 32

        cur = conn.execute(
            """
            SELECT COALESCE(MAX(sequence_no), 0) + 1
              FROM audit_event_chain
             WHERE tenant_id = %s
            """,
            (tid,),
        )
        seq = int(cur.fetchone()[0])

        canonical_sha = _sha(
            tid.encode("utf-8")
            + b":"
            + str(seq).encode("utf-8")
            + b":"
            + canonical_bytes
        )
        leaf_hash = _sha(prev_leaf + canonical_sha)

        conn.execute(
            """
            INSERT INTO audit_event_chain
              (tenant_id, sequence_no, leaf_hash, prev_leaf_hash,
               canonical_json, written_at)
            VALUES (%s, %s, %s, %s, %s, now())
            """,
            (tid, seq, leaf_hash, prev_leaf, canonical),
        )
    finally:
        conn.execute("SELECT pg_advisory_unlock(hashtext(%s))", (tid,))


# ---------------------------------------------------------------------------
# (B-CLIN-4: the axial-midpoint heuristic that used to live here was
# removed — it had no clinical basis. The cascade now uses the
# segment-aware FLR via ``compute_segment_aware_flr`` below, fed by the
# orchestrator Couinaud heuristic + the vessel mask from stage 5.)
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------


def run_real_cascade(
    analysis_id: str,
    study_id: str = STUDY_ID,
    tenant_id: str = TENANT_ID,
    resection_pattern: str = "right_hepatectomy",
) -> dict:
    """Run the full TS-based 7-stage cascade for an existing Analysis row.

    The Analysis row at ``analysis_id`` must exist in the database before
    this is called; the caller is responsible for creating it (HTTP layer
    inserts it; the CLI ``main()`` wrapper inserts it too). The 4 phase
    NIfTIs must already be in MinIO under ``s3://{PHASES_BUCKET}/{study_id}/``.

    Returns a summary dict with timing + clinical numbers.
    """
    print(LICENSE_BANNER)
    print(
        f"[config] resection_pattern={resection_pattern} "
        f"analysis_id={analysis_id} study_id={study_id}"
    )
    t0 = time.perf_counter()

    print(f"\n[1/7] Mark analysis running + anonymization passthrough")
    with psycopg.connect(DB_URL, autocommit=True) as conn:
        conn.execute(
            """
            UPDATE analysis
               SET status='running',
                   started_at = COALESCE(started_at, now())
             WHERE id = %s
            """,
            (analysis_id,),
        )
        # Stage 1 — anonymization passthrough (CT is already de-identified).
        insert_checkpoint(
            conn,
            analysis_id,
            1,
            "anonymization",
            f"s3://liverra-dev/anonymized/{study_id}.zip",
            "ctp+presidio@v1-passthrough",
            tenant_id=tenant_id,
        )
    print(f"      ✓ +{time.perf_counter()-t0:.2f}s")

    workdir = Path("/tmp/real_cascade") / analysis_id[:8]
    workdir.mkdir(parents=True, exist_ok=True)

    # ----------------------------------------------------------------------
    # Stage 2 — parenchyma (TotalSegmentator task=total, roi=liver)
    # ----------------------------------------------------------------------
    print(f"\n[2/7] Download portal_venous CT")
    ct_path = workdir / "portal_venous.nii.gz"
    download_phase(study_id, "portal_venous", ct_path)
    print(f"      {ct_path.name}  ({ct_path.stat().st_size/1e6:.1f} MB)  +{time.perf_counter()-t0:.2f}s")

    # Two-call pattern: run task=total upfront, then liver_vessels in
    # stage 5. CLAUDE.md "Open decision" — empirically ~2 minutes faster
    # than the combined endpoint on Tailscale links (12m08s vs 13m51s),
    # and avoids paying the commercial-license tier for analyses that
    # only need the base task. Combined endpoint stays available on the
    # GPU service for backward compatibility but is no longer used here
    # (H-CASCADE-2).
    print(f"\n[3/7] GPU inference: task=total → Irakli's box")
    seg_dir = workdir / "ts_total"
    vessels_dir = workdir / "ts_vessels"
    t_seg = time.perf_counter()
    _total_paths, total_provenance = infer_total_with_provenance(
        ct_path, dest_dir=seg_dir
    )
    print(
        f"      model_version={total_provenance.get('model_version', 'unknown')} "
        f"weights_sha={total_provenance.get('weights_sha', 'unknown')[:24]}..."
    )
    liver_path = seg_dir / "liver.nii.gz"
    if not liver_path.exists():
        # B-CASCADE-4: was `return 1` — but the return type is dict, so the
        # caller (real_cascade_task) silently accepted the int and the
        # analysis got stuck in 'running'. Raise so Celery marks the row
        # 'failed' and the failed-AuditEvent fires via LiveCascadeAuditHooks.
        raise RuntimeError(
            f"GPU produced no liver.nii.gz at {liver_path} — "
            "TotalSegmentator task=total failed or returned empty mask"
        )
    liver_native = sitk.ReadImage(str(liver_path))
    total_ml = native_volume_ml(liver_native)
    voxels = int((sitk.GetArrayFromImage(liver_native) > 0).sum())
    print(f"      ✓ {liver_path.name}  +{time.perf_counter()-t_seg:.1f}s")
    print(f"      total liver volume: {total_ml:,.1f} ml  ({voxels:,} voxels)")
    # C-CASCADE-1: enforce parenchyma bounds (200–5500 mL, non-empty).
    _sanity_call("parenchyma", {
        "total_volume_ml": float(total_ml),
        "nonzero_voxel_count": int(voxels),
    })

    # Capture the new landmarks if TS produced them; fall back to None.
    ivc_path = seg_dir / "inferior_vena_cava.nii.gz"
    gb_path = seg_dir / "gallbladder.nii.gz"
    spleen_path = seg_dir / "spleen.nii.gz"
    ivc_native = sitk.ReadImage(str(ivc_path)) if ivc_path.exists() else None
    gb_native = sitk.ReadImage(str(gb_path)) if gb_path.exists() else None
    spleen_native = sitk.ReadImage(str(spleen_path)) if spleen_path.exists() else None
    if ivc_native is not None:
        print(f"      ✓ {ivc_path.name}  ({int((sitk.GetArrayFromImage(ivc_native)>0).sum()):,} voxels)")
    else:
        print(f"      ! {ivc_path.name} missing — caudate (segment I) will fall back to anatomical prior")
    if gb_native is not None:
        print(f"      ✓ {gb_path.name}  ({int((sitk.GetArrayFromImage(gb_native)>0).sum()):,} voxels)")
    else:
        print(f"      ! {gb_path.name} missing — Cantlie line will fall back to anatomical prior")
    if spleen_native is not None:
        print(f"      ✓ {spleen_path.name}  ({int((sitk.GetArrayFromImage(spleen_native)>0).sum()):,} voxels)")
    else:
        print(f"      ! {spleen_path.name} missing — spleen volumetry + steatosis Δ heuristics will be skipped")

    print(f"\n[4/7] Resample liver mask → 128³ + upload")
    liver_128 = resample_mask_to(liver_native, TARGET_SHAPE)
    # Cast to UINT8 to match Triton's parenchyma OUTPUT__0 dtype contract.
    cast = sitk.CastImageFilter()
    cast.SetOutputPixelType(sitk.sitkUInt8)
    liver_128 = cast.Execute(liver_128)
    parenchyma_uri = upload_nii(
        liver_128, f"analyses/{analysis_id}/parenchyma_mask.nii.gz"
    )
    # Phase 1 heuristics consumers — upload the spleen + gallbladder masks
    # at native resolution so finalize and the FindingsCard renderer can
    # reuse them without re-running TS. Native-res upload (not 128³) keeps
    # mL accuracy for splenomegaly + GB volume thresholds.
    if spleen_native is not None:
        try:
            upload_nii(spleen_native, f"analyses/{analysis_id}/spleen_mask.nii.gz")
        except Exception as exc:
            print(f"      ! spleen_mask upload skipped: {exc}")
    if gb_native is not None:
        try:
            upload_nii(gb_native, f"analyses/{analysis_id}/gallbladder_mask.nii.gz")
        except Exception as exc:
            print(f"      ! gallbladder_mask upload skipped: {exc}")
    with psycopg.connect(DB_URL, autocommit=True) as conn:
        insert_checkpoint(
            conn,
            analysis_id,
            2,
            "parenchyma",
            parenchyma_uri,
            "totalsegmentator-v2",
            license_hash="cc-by-nc-sa-4.0",
            tenant_id=tenant_id,
        )
    print(f"      ✓ {parenchyma_uri.split('/')[-1]}  +{time.perf_counter()-t0:.2f}s")

    # ----------------------------------------------------------------------
    # Stage 3 + 5 — vessels + lesion detection (TotalSegmentator task=liver_vessels)
    # ----------------------------------------------------------------------
    print(f"\n[5/7] GPU inference: task=liver_vessels → Irakli's box")
    # Two-call pattern: a second CT upload here (vs the combined endpoint
    # that bundled this with stage 3). Empirically ~2 minutes faster on
    # Tailscale because TS-on-GPU finishes a single task much faster than
    # the kernel-launch / weight-swap cost of two tasks back-to-back.
    t_lv = time.perf_counter()
    vessels_done = False
    portal_native = hepatic_native = tumor_native = None
    vessels_provenance: dict[str, str] = {"model_version": "unknown", "weights_sha": "unknown"}
    try:
        _vessel_paths, vessels_provenance = infer_liver_vessels_with_provenance(
            ct_path, dest_dir=vessels_dir
        )
        if not any(vessels_dir.glob("*.nii.gz")):
            raise RuntimeError("vessels_dir empty after infer_liver_vessels call")
        # task=liver_vessels emits per-label NIfTIs:
        #   liver_vessels.nii.gz   (combined hepatic + portal vessel tree)
        #   liver_tumor.nii.gz     (tumor candidates)
        # Older TS versions used split files (portal_vein.nii.gz, hepatic_vein.nii.gz).
        # Probe for whichever is present.
        produced = sorted(p.name for p in vessels_dir.glob("*.nii.gz"))
        print(f"      produced: {', '.join(produced)}")
        if (vessels_dir / "liver_vessels.nii.gz").exists():
            portal_native = sitk.ReadImage(str(vessels_dir / "liver_vessels.nii.gz"))
        elif (vessels_dir / "portal_vein.nii.gz").exists():
            portal_native = sitk.ReadImage(str(vessels_dir / "portal_vein.nii.gz"))
        if (vessels_dir / "hepatic_vein.nii.gz").exists():
            hepatic_native = sitk.ReadImage(str(vessels_dir / "hepatic_vein.nii.gz"))
        if (vessels_dir / "liver_tumor.nii.gz").exists():
            tumor_native = sitk.ReadImage(str(vessels_dir / "liver_tumor.nii.gz"))
        vessels_done = portal_native is not None or hepatic_native is not None
        print(
            f"      model_version={vessels_provenance.get('model_version', 'unknown')} "
            f"weights_sha={vessels_provenance.get('weights_sha', 'unknown')[:24]}..."
        )
        print(f"      ✓ +{time.perf_counter()-t_lv:.1f}s")
    except Exception as exc:
        print(f"      ! liver_vessels task failed: {exc}")

    with psycopg.connect(DB_URL, autocommit=True) as conn:
        if vessels_done:
            # Upload the (possibly combined) vessel mask.
            vessel_uri = upload_nii(
                portal_native if portal_native is not None else hepatic_native,
                f"analyses/{analysis_id}/vessels.nii.gz",
            )
            insert_checkpoint(
                conn,
                analysis_id,
                3,
                "vessels",
                vessel_uri,
                "totalsegmentator-v2-liver_vessels",
                license_hash="cc-by-nc-sa-4.0",
                tenant_id=tenant_id,
            )
            v_arr = sitk.GetArrayFromImage(portal_native if portal_native is not None else hepatic_native)
            v_voxels = int((v_arr > 0).sum())
            v_ml = v_voxels * voxel_volume_ml(portal_native if portal_native is not None else hepatic_native)
            print(f"      vessel tree volume: {v_ml:,.1f} ml  ({v_voxels:,} voxels)")
        else:
            insert_checkpoint(
                conn,
                analysis_id,
                3,
                "vessels",
                f"s3://liverra-dev/stub/{analysis_id}/vessels.nii.gz",
                "stub-vessels@v1",
                license_hash="n/a-dev-stub",
                tenant_id=tenant_id,
            )

        # Stage 4 — Couinaud (anatomical heuristic via Cantlie + portal
        # bifurcation; replaces the stub used in earlier sessions).
        print(f"\n[5b/7] Couinaud heuristic (Cantlie + portal bifurcation)")
        t_cou = time.perf_counter()
        liver_arr_native = sitk.GetArrayFromImage(liver_native).astype(np.uint8)
        ivc_arr = sitk.GetArrayFromImage(ivc_native).astype(np.uint8) if ivc_native is not None else None
        gb_arr = sitk.GetArrayFromImage(gb_native).astype(np.uint8) if gb_native is not None else None
        vessels_arr = None
        if vessels_done and (portal_native is not None or hepatic_native is not None):
            v_src = portal_native if portal_native is not None else hepatic_native
            vessels_arr = sitk.GetArrayFromImage(v_src).astype(np.uint8)
        sx, sy, sz = liver_native.GetSpacing()  # (X, Y, Z) in mm
        couinaud_native_arr = compute_couinaud(
            liver=liver_arr_native,
            ivc=ivc_arr,
            gallbladder=gb_arr,
            vessels=vessels_arr,
            voxel_spacing=(sx, sy, sz),
        )
        # Wrap as a SimpleITK image at native CT geometry so the resample
        # below + the show_results.py renderer can handle it.
        couinaud_native = sitk.GetImageFromArray(couinaud_native_arr)
        couinaud_native.CopyInformation(liver_native)
        # Resample to 128³ NEAREST_NEIGHBOR for the downstream contract.
        couinaud_128 = resample_mask_to(couinaud_native, TARGET_SHAPE)
        cast_u8 = sitk.CastImageFilter()
        cast_u8.SetOutputPixelType(sitk.sitkUInt8)
        couinaud_128 = cast_u8.Execute(couinaud_128)
        couinaud_uri = upload_nii(
            couinaud_128, f"analyses/{analysis_id}/couinaud.nii.gz"
        )
        insert_checkpoint(
            conn,
            analysis_id,
            4,
            "couinaud",
            couinaud_uri,
            "couinaud-heuristic-v1",
            license_hash="n/a-heuristic",
            tenant_id=tenant_id,
        )
        # Segmentation rows for the report — one per mask the UI surfaces.
        # AI-generated, so generation_source='ai'. sop_instance_uid is a
        # synthetic per-mask UID (no DICOM-SR roundtrip in this dev path).
        conn.execute(
            """
            INSERT INTO segmentation
                (analysis_id, generation_source, mask_uri, sop_instance_uid,
                 anatomy_category, anatomy_detail, volume_ml, mask_url, snomed_code)
            VALUES (%s, 'ai', %s, %s, 'liver', 'parenchyma', %s, %s, '10200004')
            """,
            (
                analysis_id,
                parenchyma_uri,
                f"liverra.{analysis_id}.parenchyma",
                round(float(total_ml), 2),
                parenchyma_uri,
            ),
        )
        if vessels_done and (portal_native is not None or hepatic_native is not None):
            conn.execute(
                """
                INSERT INTO segmentation
                    (analysis_id, generation_source, mask_uri, sop_instance_uid,
                     anatomy_category, anatomy_detail, volume_ml, mask_url, snomed_code)
                VALUES (%s, 'ai', %s, %s, 'vessels', 'liver_vessels', %s, %s, '57195005')
                """,
                (
                    analysis_id,
                    vessel_uri,
                    f"liverra.{analysis_id}.vessels",
                    round(float(v_ml), 2),
                    vessel_uri,
                ),
            )
        # Per-segment voxel counts in native CT space (used for the row
        # volume_ml + the print summary below).
        per_seg_v = {sid: int((couinaud_native_arr == sid).sum()) for sid in range(1, 9)}
        voxel_ml_native = float(np.prod(liver_native.GetSpacing())) / 1000.0
        per_seg_ml = {sid: round(per_seg_v[sid] * voxel_ml_native, 1) for sid in per_seg_v}
        # C-CASCADE-1: cross-check that the segment sum stays within 20%
        # of total parenchyma (heuristic isn't ±2% tight like the Triton
        # path; tolerate slop, fail on factor-of-2 mismatches).
        segments_sum_ml = float(sum(per_seg_ml.values()))
        if total_ml > 0 and segments_sum_ml > 1.2 * total_ml:
            msg = (
                f"segments sum {segments_sum_ml:.1f} mL exceeds "
                f"1.2 × parenchyma {total_ml:.1f} mL"
            )
            if _sanity_require():
                raise RuntimeError(f"sanity: couinaud sum_mismatch — {msg}")
            print(f"      ⚠ sanity warning couinaud sum_mismatch — {msg}")
        # Persist 8 per-segment Segmentation rows AND upload a per-segment
        # binary mask file for each. The DICOM viewer's overlay layer
        # (LiverViewer3D / cornerstoneInit.createLabelmapFromNifti) expects
        # ONE BINARY mask per row — voxel == 1 inside, 0 outside — not a
        # combined label-map. Earlier this loop reused the combined
        # couinaud_uri for every row, causing the viewer to silently fail
        # to colour anything (Cornerstone's segment-index colour API only
        # paints voxels==1, so segments 2-8 in a label-map were invisible).
        # We also deliberately drop the legacy 'liver/couinaud' summary row
        # that used to live just above this block — it had
        # anatomy_category='liver' AND pointed at the label-map, which
        # randomly shadowed the real parenchyma row in the API's
        # ``LIMIT 1 ORDER BY created_at DESC`` lookup on /mask/liver.
        roman_for_sid = {1: "I", 2: "II", 3: "III", 4: "IV",
                         5: "V", 6: "VI", 7: "VII", 8: "VIII"}

        # M-CASCADE-5: parallelize the 8 sub-mask S3 uploads. Each upload
        # is ~25 MB over Tailscale ≈ 1.5 s serial; 4 workers cuts the leg
        # to ~3 s wall-clock (vs ~12 s serial). The resample+cast work is
        # cheap CPU and we keep it inline so numpy + SimpleITK objects
        # stay in this thread — only the network call is fanned out.
        import concurrent.futures as _cf

        def _upload_one(sid: int, roman: str) -> tuple[int, str, str]:
            seg_arr = (couinaud_native_arr == sid).astype(np.uint8)
            seg_native = sitk.GetImageFromArray(seg_arr)
            seg_native.CopyInformation(liver_native)
            seg_128 = cast_u8.Execute(resample_mask_to(seg_native, TARGET_SHAPE))
            seg_uri = upload_nii(
                seg_128, f"analyses/{analysis_id}/couinaud_{roman}.nii.gz",
            )
            return sid, roman, seg_uri

        with _cf.ThreadPoolExecutor(max_workers=4) as pool:
            uploads = list(pool.map(
                lambda kv: _upload_one(*kv), roman_for_sid.items()
            ))

        for sid, roman, seg_uri in uploads:
            conn.execute(
                """
                INSERT INTO segmentation
                    (analysis_id, generation_source, mask_uri, sop_instance_uid,
                     anatomy_category, anatomy_detail, volume_ml, mask_url, snomed_code)
                VALUES (%s, 'ai', %s, %s, 'couinaud', %s, %s, %s, '10200004')
                """,
                (
                    analysis_id,
                    seg_uri,
                    f"liverra.{analysis_id}.couinaud.{roman}",
                    roman,
                    float(per_seg_ml[sid]),
                    seg_uri,
                ),
            )
        non_empty = sum(1 for v in per_seg_ml.values() if v > 0)
        if non_empty == 0:
            print(
                "      ⚠ Couinaud heuristic produced 0 voxels in all 8 "
                "segments — page-1 lobe split will fall back to a "
                "Cantlie-line estimate. Check portal/hepatic vessel masks."
            )
        print(f"      ✓ {couinaud_uri.split('/')[-1]}  +{time.perf_counter()-t_cou:.2f}s")
        seg_str = "  ".join(
            f"{name}={per_seg_ml[i]}ml"
            for i, name in zip(range(1, 9), ["I","II","III","IV","V","VI","VII","VIII"])
        )
        print(f"      per-segment: {seg_str} ({non_empty}/8 non-empty)")

    # Stage 5 — lesion detection from liver_tumor mask.
    lesion_count = 0
    lesion_volumes_ml: list[float] = []
    if tumor_native is not None:
        t_arr = sitk.GetArrayFromImage(tumor_native)
        if t_arr.sum() > 0:
            from scipy.ndimage import label as cc_label
            labeled, lesion_count = cc_label(t_arr > 0)
            voxel_ml = voxel_volume_ml(tumor_native)
            for lid in range(1, lesion_count + 1):
                lesion_volumes_ml.append(float((labeled == lid).sum() * voxel_ml))
    print(f"\n[6/7] Lesion detection: {lesion_count} candidate(s)")
    for i, v in enumerate(lesion_volumes_ml, 1):
        print(f"      lesion {i}: {v:.2f} ml")

    # Upload the merged tumor mask once so the report's per-lesion
    # thumbnail renderer can crop it by bbox (the renderer falls back to
    # this file if no per-lesion mask exists at lesions/{lesion_id}.nii.gz).
    if tumor_native is not None:
        try:
            upload_nii(tumor_native, f"analyses/{analysis_id}/tumor_mask.nii.gz")
        except Exception as exc:
            print(f"      ! tumor_mask upload skipped: {exc}")

    with psycopg.connect(DB_URL, autocommit=True) as conn:
        insert_checkpoint(
            conn,
            analysis_id,
            5,
            "lesion_detection",
            f"s3://liverra-analyses-eu-central-1/analyses/{analysis_id}/lesions/",
            "totalsegmentator-v2-liver_vessels"
            if tumor_native is not None
            else "stub-no-tumor",
            license_hash="cc-by-nc-sa-4.0" if tumor_native is not None else "n/a-dev-stub",
            tenant_id=tenant_id,
        )

    # ----------------------------------------------------------------------
    # Stage 6 — LI-RADS-style 6-class classification per lesion
    # (replaces the LiLNet stub with a clinically-grounded rule-based
    # classifier whose [6] output matches the Triton config contract)
    # ----------------------------------------------------------------------
    print(f"\n[6/7b] LI-RADS-style classification per lesion")
    classifications: list[dict] = []
    classifier_version = "lirads-rule-classifier-v1"

    if tumor_native is not None and lesion_count > 0:
        # Need all 4 contrast phases at the native CT geometry. We already
        # have portal_venous loaded (it's the input to TS); download the
        # other three from MinIO into the workdir, reusing the cache if
        # they're already there.
        t_cls = time.perf_counter()
        phase_volumes_native: dict[str, np.ndarray] = {}
        for phase in LIRADS_PHASES:
            if phase == "portal_venous":
                # Already on disk under ct_path
                pv_img = sitk.ReadImage(str(ct_path))
                phase_volumes_native[phase] = sitk.GetArrayFromImage(pv_img).astype(np.float32)
                continue
            phase_path = workdir / f"{phase}.nii.gz"
            if not phase_path.exists():
                download_phase(study_id, phase, phase_path)
            try:
                phase_img = sitk.ReadImage(str(phase_path))
                phase_arr = sitk.GetArrayFromImage(phase_img).astype(np.float32)
                # Phase volumes have different shapes (different slice spacings)
                # so resample each to the portal_venous grid we used for
                # liver/tumor masks. NN preserves HU values reasonably well
                # for the mean-HU-in-VOI feature we care about.
                if phase_arr.shape != liver_arr_native.shape:
                    res = sitk.ResampleImageFilter()
                    res.SetReferenceImage(liver_native)
                    res.SetInterpolator(sitk.sitkLinear)
                    res.SetDefaultPixelValue(-1024)  # air HU
                    phase_img_res = res.Execute(phase_img)
                    phase_arr = sitk.GetArrayFromImage(phase_img_res).astype(np.float32)
                phase_volumes_native[phase] = phase_arr
                print(f"      ✓ {phase}.nii.gz  ({phase_arr.shape})")
            except Exception as exc:
                print(f"      ! {phase} load failed: {exc}")
                phase_volumes_native[phase] = None  # type: ignore

        # C-CLIN-2: union of every lesion mask, computed once. Passed to
        # ``extract_lesion_features`` so each lesion's background-HU pool
        # excludes ALL OTHER lesions in the scan. On multi-lesion cases
        # this corrects an APHE-positive bias that was previously baked
        # into every relative_enhancement number.
        all_lesions_mask = (labeled > 0).astype(np.uint8)

        # Iterate over connected components (already labeled above)
        # `labeled` is the per-voxel CC-id array; lesion ids 1..lesion_count
        for lid in range(1, lesion_count + 1):
            lesion_mask = (labeled == lid).astype(np.uint8)
            voxels = int(lesion_mask.sum())
            volume_ml_lid = voxels * voxel_ml
            if volume_ml_lid < 0.05:
                continue  # tiny noise
            # Restrict to liver-contained portion to skip false positives
            lesion_inside = lesion_mask & (liver_arr_native > 0).astype(np.uint8)
            if lesion_inside.sum() == 0:
                continue
            features = extract_lesion_features(
                lesion_mask=lesion_inside,
                phase_volumes={k: v for k, v in phase_volumes_native.items() if v is not None},
                liver_mask=liver_arr_native,
                voxel_ml=voxel_ml_native,
                all_lesions_mask=all_lesions_mask,
            )
            cls = classify_lesion(features)
            # C-CASCADE-1: classification probabilities MUST be in [0, 1]
            # and sum to ~1.0. Confidence in [0, 1] is a strict bound.
            probs = cls.get("probabilities") or {}
            if probs:
                _sanity_call("classification", {"probs": {k: float(v) for k, v in probs.items()}})
            conf = cls.get("top1_confidence")
            if isinstance(conf, (int, float)) and not (0.0 <= float(conf) <= 1.0):
                msg = f"lesion {lid} top1_confidence={conf!r} outside [0, 1]"
                if _sanity_require():
                    raise RuntimeError(f"sanity: classification_nonnormal — {msg}")
                print(f"      ⚠ sanity warning classification — {msg}")
            classifications.append({
                "lesion_id": int(lid),
                "volume_ml": features["volume_ml"],
                "voxels": features["voxels"],
                "features": features,
                "classification": cls,
            })
            print(
                f"      lesion {lid}  vol={features['volume_ml']:.1f} ml  "
                f"top1={cls['top1']} (conf={cls['top1_confidence']:.2f})"
            )
            for r in cls["reasoning"]:
                print(f"          • {r}")

        # Persist the classifications JSON to MinIO
        cls_uri = f"analyses/{analysis_id}/lesion_classifications.json"
        s3_client().put_object(
            Bucket=ANALYSES_BUCKET, Key=cls_uri,
            Body=json.dumps(
                {
                    "analysis_id": analysis_id,
                    "classifier_version": classifier_version,
                    "class_order": list(LIRADS_CLASSES),
                    "n_lesions": len(classifications),
                    "lesions": classifications,
                },
                indent=2,
            ).encode("utf-8"),
            ContentType="application/json",
        )
        print(f"      ✓ classifications JSON → s3://{ANALYSES_BUCKET}/{cls_uri}  +{time.perf_counter()-t_cls:.1f}s")
    else:
        print(f"      no lesions to classify → skipping")

    with psycopg.connect(DB_URL, autocommit=True) as conn:
        if classifications:
            insert_checkpoint(
                conn,
                analysis_id,
                6,
                "classification",
                f"s3://{ANALYSES_BUCKET}/analyses/{analysis_id}/lesion_classifications.json",
                classifier_version,
                license_hash="n/a-rule-based",
                tenant_id=tenant_id,
            )
            # Lesion rows — one per classified lesion. The UI's lesions list +
            # report rendering both read from this table. bbox3d is required
            # (jsonb), so derive it from the connected-component label array.
            sx, sy, sz = liver_native.GetSpacing()  # mm
            for cls_entry in classifications:
                lid = cls_entry["lesion_id"]
                features = cls_entry["features"]
                cls = cls_entry["classification"]
                # bbox3d in voxel coords + mm sizing — UI uses for centroid /
                # render bounds. (Z, Y, X) order matches sitk array layout.
                coords = np.argwhere(labeled == lid)
                if coords.size == 0:
                    bbox = {}
                else:
                    z_min, y_min, x_min = coords.min(axis=0).tolist()
                    z_max, y_max, x_max = coords.max(axis=0).tolist()
                    longest_axis_mm = float(max(
                        (z_max - z_min + 1) * sz,
                        (y_max - y_min + 1) * sy,
                        (x_max - x_min + 1) * sx,
                    ))
                    # `coords` is what the lesion thumbnail renderer reads
                    # (api/analysis.py:render_lesion_endpoint expects 6 ints
                    # [zmin, ymin, xmin, zmax, ymax, xmax]). The other keys
                    # are kept for any consumer that wants the per-axis
                    # extents + spacing without parsing coords.
                    bbox = {
                        "coords": [
                            int(z_min), int(y_min), int(x_min),
                            int(z_max) + 1, int(y_max) + 1, int(x_max) + 1,
                        ],
                        "x": int(x_min), "y": int(y_min), "z": int(z_min),
                        "dx": int(x_max - x_min + 1),
                        "dy": int(y_max - y_min + 1),
                        "dz": int(z_max - z_min + 1),
                        "spacing_mm": [float(sx), float(sy), float(sz)],
                    }
                # Couinaud segment for this lesion: majority vote over the
                # voxels in the CC against the couinaud_native_arr label map.
                cou_seg = None
                if coords.size > 0:
                    seg_labels = couinaud_native_arr[
                        coords[:, 0], coords[:, 1], coords[:, 2]
                    ]
                    seg_labels = seg_labels[seg_labels > 0]
                    if seg_labels.size > 0:
                        cou_seg = int(np.bincount(seg_labels).argmax())
                # The UI's lesion-list renderer (AnalysisDetailView.tsx ~L257)
                # JSON.parse()s `classification` and reads {label, confidence}.
                # Writing the bare string "icc" trips JSON.parse and the row
                # shows up as "—" instead of "ICC · 88%".
                # ensure_ascii=False so unicode (Δ, →) survives intact;
                # the previous default escaped them as \U0394 / \U2192 which
                # leaked into the PDF lesion card as raw literals.
                classification_json = json.dumps({
                    "label": cls.get("top1"),
                    "confidence": cls.get("top1_confidence"),
                    "reasoning": cls.get("reasoning"),
                }, ensure_ascii=False)
                lesion_cur = conn.execute(
                    """
                    INSERT INTO lesion
                        (analysis_id, bbox3d, discovery_source,
                         couinaud_segment, couinaud_location,
                         diameter_mm, longest_diameter_mm, volume_ml,
                         classification, mask_uri)
                    VALUES (%s, %s::jsonb, 'ai', %s, %s, %s, %s, %s, %s, %s)
                    RETURNING id
                    """,
                    (
                        analysis_id,
                        json.dumps(bbox),
                        cou_seg,
                        cou_seg,
                        round(longest_axis_mm, 2) if coords.size > 0 else None,
                        round(longest_axis_mm, 2) if coords.size > 0 else None,
                        round(float(features.get("volume_ml") or 0.0), 2),
                        classification_json,
                        f"s3://{ANALYSES_BUCKET}/analyses/{analysis_id}/lesions/{lid}.nii.gz",
                    ),
                )
                # Also persist into the structured `classification` table so
                # the report renderer's standard render path activates (chip,
                # confidence %, probability bars). Without this row the
                # renderer falls back to parsing the JSON-string in
                # lesion.classification — which works thanks to
                # _parse_lesion_classification_field but loses the full
                # 6-class probability vector for the bar chart.
                try:
                    lesion_uuid = lesion_cur.fetchone()[0]
                except (TypeError, IndexError):
                    lesion_uuid = None
                probs = cls.get("probabilities") or {}
                if lesion_uuid is not None and probs:
                    try:
                        conn.execute(
                            """
                            INSERT INTO classification
                                (lesion_id, probs_vec, suggested_class,
                                 temperature, abstained)
                            VALUES (%s, %s::jsonb, %s, %s, %s)
                            ON CONFLICT (lesion_id) DO UPDATE SET
                                probs_vec = EXCLUDED.probs_vec,
                                suggested_class = EXCLUDED.suggested_class
                            """,
                            (
                                str(lesion_uuid),
                                json.dumps({k: float(v) for k, v in probs.items()}),
                                cls.get("top1"),
                                0.7,
                                False,
                            ),
                        )
                    except Exception as exc:
                        # Don't fail the whole cascade on a classification
                        # persistence hiccup — the JSON-string fallback will
                        # still render a usable lesion card.
                        print(f"      ! classification table insert skipped: {exc}")
        else:
            insert_checkpoint(
                conn,
                analysis_id,
                6,
                "classification",
                f"s3://liverra-dev/stub/{analysis_id}/classification.json",
                "skipped-no-lesions",
                license_hash="n/a",
                tenant_id=tenant_id,
            )

    # ----------------------------------------------------------------------
    # Stage 7 — FLR (segment-aware: total minus segments removed by the
    # selected resection pattern, computed on the native-res Couinaud mask)
    # ----------------------------------------------------------------------
    print(f"\n[7/7] FLR (segment-aware: pattern={resection_pattern})")
    # H-CLIN-7: pass the vessel mask so intrahepatic vessels are excluded
    # from per-segment counts AND from total_ml (ESSO / ALPPS convention).
    # ``vessels_arr`` was prepared upstream in stage 5 (Couinaud + lesion
    # detection); when TS didn't return a vessel mask it falls back to
    # ``None`` and FLR is computed parenchyma-only.
    plane, flr_ml, total_ml_seg = compute_segment_aware_flr(
        couinaud_native_arr,
        voxel_ml_native,
        pattern=resection_pattern,
        vessels_mask=vessels_arr if vessels_done else None,
    )
    # C-CLIN-1: ``flr_pct`` is the ratio against the SAME ``total_ml`` we
    # store on the row, so a frontend "manual ratio check" matches
    # exactly. We persist ``total_ml`` (TS native parenchyma) as the
    # display total (most familiar number for the clinician). The
    # sum-of-segments ``total_ml_seg`` may differ by a few % from
    # ``total_ml`` due to caudate carve-out and rounding; we surface
    # this in plane_pose so the report can render the delta for audit.
    flr_pct = round(100.0 * flr_ml / total_ml, 2) if total_ml > 0 else 0.0
    plane["total_ml_segments"] = total_ml_seg
    plane["total_ml_displayed"] = round(total_ml, 2)
    # C-CASCADE-1: FLR invariants (flr_ml ≥ 0; flr_ml ≤ total; pct ∈ [0,100]).
    # We feed the *displayed* total_ml (parenchyma native) since that's what
    # the clinician sees on the report.
    if total_ml > 0:
        _sanity_call("flr_init", {
            "flr_ml": float(flr_ml),
            "total_ml": float(total_ml),
        })
    if not (0.0 <= float(flr_pct) <= 100.0):
        msg = f"flr_pct={flr_pct:.2f} outside [0, 100]"
        if _sanity_require():
            raise RuntimeError(f"sanity: flr_pct_out_of_range — {msg}")
        print(f"      ⚠ sanity warning flr_init — {msg}")
    # Use TS's native-res total volume for display (more accurate than the
    # sum-of-segments which can be slightly different due to rounding +
    # caudate carve-out)
    print(f"      total: {total_ml:,.1f} ml  |  FLR: {flr_ml:,.1f} ml  ({flr_pct:.1f} %)")
    print(f"      pattern: {resection_pattern}")
    print(f"      removed segments: {plane['removed_segments']}")
    print(f"      remnant segments: {plane['remnant_segments']}")

    with psycopg.connect(DB_URL, autocommit=True) as conn:
        # author='ai_default' is what the API's /results endpoint queries to
        # populate flr_default — keep this in sync with api/analysis.py.
        # remnant_volume_ml + remnant_pct_functional duplicate flr_ml/flr_pct
        # under the v2 column names the report renderer uses.
        conn.execute(
            """
            INSERT INTO flr_calculation
              (analysis_id, plane_pose, total_ml, flr_ml, flr_pct,
               resected_volume_ml, remnant_volume_ml, remnant_pct_functional,
               author, computed_at)
            VALUES (%s, %s::jsonb, %s, %s, %s, %s, %s, %s, 'ai_default', now())
            """,
            (
                analysis_id,
                json.dumps(plane),
                round(total_ml, 2),
                round(flr_ml, 2),
                round(flr_pct, 2),
                round(max(total_ml - flr_ml, 0.0), 2),
                round(flr_ml, 2),
                round(flr_pct, 2),
            ),
        )
        insert_checkpoint(
            conn,
            analysis_id,
            7,
            "flr_init",
            f"flr://analyses/{analysis_id}",
            f"flr-segment-aware-{resection_pattern}@v1",
            license_hash="n/a-heuristic",
            tenant_id=tenant_id,
        )
        # B-CASCADE-3 fix: persist model_versions to the Analysis row so
        # MBoM / provenance queries can answer "which model produced this
        # analysis?" without scraping pipeline_checkpoint. Each stage's
        # entry carries {model_id, model_version, weights_sha} so MBoM
        # consumers see a stable schema. When a stage has no GPU
        # provenance (heuristic / passthrough), substitute None — never
        # skip the key.
        def _prov(d: dict[str, str] | None, fallback_id: str, fallback_version: str | None = None) -> dict[str, str | None]:
            d = d or {}
            return {
                "model_id": d.get("model_id") or fallback_id,
                "model_version": d.get("model_version") or fallback_version,
                "weights_sha": d.get("weights_sha"),
            }

        model_versions = {
            "anonymization": _prov(
                None, "ctp+presidio", "v1-passthrough",
            ),
            "parenchyma": _prov(
                total_provenance, "totalsegmentator", "v2",
            ),
            "vessels": _prov(
                vessels_provenance if vessels_done else None,
                "totalsegmentator-liver_vessels" if vessels_done else "stub-vessels",
                "v2" if vessels_done else "v1",
            ),
            "couinaud": _prov(
                None, "couinaud-heuristic", "v1",
            ),
            "lesion_detection": _prov(
                vessels_provenance if tumor_native is not None else None,
                "totalsegmentator-liver_vessels"
                if tumor_native is not None
                else "stub-no-tumor",
                "v2" if tumor_native is not None else None,
            ),
            "classification": _prov(
                None,
                "lirads-rule-classifier" if classifications else "skipped-no-lesions",
                "v1" if classifications else None,
            ),
            "flr_init": _prov(
                None, "flr-segment-aware", f"v1-{resection_pattern}",
            ),
        }
        try:
            conn.execute(
                """
                UPDATE analysis
                   SET model_versions = %s::jsonb
                 WHERE id = %s
                """,
                (json.dumps(model_versions), analysis_id),
            )
        except Exception as exc:
            print(f"      ! model_versions UPDATE skipped (column may be absent): {exc}")
        # Mark Analysis completed.
        conn.execute(
            "UPDATE analysis SET status='completed', completed_at=now() WHERE id=%s",
            (analysis_id,),
        )

    # ----------------------------------------------------------------------
    # Stage 7b — Phase 1 heuristic findings (additive, non-fatal)
    # See docs/research/13-additional-pathologies-model-research.md.
    # ----------------------------------------------------------------------
    print(f"\n[7b/7] Phase 1 heuristic findings")
    try:
        from src.services.post_processing import FINDING_TYPES, compute_all_phase1

        # Original portal-venous CT in HU. Reuse if classification stage
        # already loaded it; otherwise read fresh from the workdir cache.
        if "phase_volumes_native" in locals() and isinstance(
            locals().get("phase_volumes_native"), dict
        ) and phase_volumes_native.get("portal_venous") is not None:
            ct_hu_arr = phase_volumes_native["portal_venous"]
        else:
            ct_hu_arr = sitk.GetArrayFromImage(sitk.ReadImage(str(ct_path))).astype(np.float32)

        spleen_arr = (
            sitk.GetArrayFromImage(spleen_native).astype(np.uint8)
            if spleen_native is not None else None
        )

        # Per-lesion masks rebuilt from the connected-components label
        # array. Only present when stage 5 found candidates.
        per_lesion_masks_list: list[tuple[str, np.ndarray]] = []
        if (
            "labeled" in locals()
            and tumor_native is not None
            and lesion_count > 0
        ):
            for lid in range(1, lesion_count + 1):
                per_lesion_masks_list.append(
                    (str(lid), (labeled == lid).astype(np.uint8))
                )

        # Reshape classifier output into the contract
        # compute_indeterminate_malignant_flag expects.
        # B-CLIN-1: include ``lirads_category`` (LR-M when present) so the
        # finding is structurally non-empty when the classifier produces
        # low-confidence malignant top-1 predictions.
        classifications_for_findings = [
            {
                "lesion_id":       c.get("lesion_id"),
                "label":           (c.get("classification") or {}).get("top1"),
                "confidence":      (c.get("classification") or {}).get("top1_confidence"),
                "lirads_category": (c.get("classification") or {}).get("lirads_category"),
            }
            for c in classifications
        ]

        findings = compute_all_phase1(
            parenchyma_mask=liver_arr_native,
            spleen_mask=spleen_arr,
            gallbladder_mask=gb_arr,
            ct_hu=ct_hu_arr,
            per_lesion_masks=per_lesion_masks_list,
            spacing_mm=(sx, sy, sz),
            lesion_classifications=classifications_for_findings,
        )

        with psycopg.connect(DB_URL, autocommit=True) as conn:
            populated = 0
            for finding_type, payload in findings.items():
                if payload in (None, [], {}):
                    continue
                conn.execute(
                    """
                    INSERT INTO analysis_finding (analysis_id, finding_type, payload)
                    VALUES (%s, %s, %s::jsonb)
                    ON CONFLICT (analysis_id, finding_type)
                    DO UPDATE SET payload = EXCLUDED.payload, computed_at = now()
                    """,
                    (analysis_id, finding_type, json.dumps(payload)),
                )
                populated += 1
        print(f"      ✓ {populated}/{len(FINDING_TYPES)} findings persisted")
    except Exception:
        # H-CASCADE-1: was `print('non-fatal')` — but that hid real bugs
        # (e.g., spleen mask returning <500 voxels was silently dropped).
        # Fail loud: cascade marked failed, user sees the failure, and
        # LiveCascadeAuditHooks.on_stage_failed fires for the audit chain.
        import traceback
        traceback.print_exc()
        raise

    duration_s = time.perf_counter() - t0
    print(f"\n=== DONE in {duration_s:.1f}s ===")
    print(f"  analysis_id: {analysis_id}")
    print(f"  Inspect: python packages/ml-inference/scripts/show_results.py")

    return {
        "analysis_id": analysis_id,
        "study_id": study_id,
        "status": "completed",
        "pipeline_version": "totalsegmentator-v2",
        "resection_pattern": resection_pattern,
        "total_ml": round(float(total_ml), 2),
        "flr_ml": round(float(flr_ml), 2),
        "flr_pct": round(float(flr_pct), 2),
        "lesion_count": int(lesion_count),
        "lesion_classifications": classifications,
        "duration_s": round(duration_s, 1),
    }


def main() -> int:
    """CLI entrypoint — wraps run_real_cascade with arg parsing + row creation."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--resection-pattern",
        choices=sorted(RESECTION_PATTERNS),
        default="right_hepatectomy",
        help="Hepatectomy pattern for the segment-aware FLR (default: right_hepatectomy).",
    )
    parser.add_argument(
        "--study-id",
        default=STUDY_ID,
        help="Study ID whose 4-phase NIfTIs are in MinIO (default: Todua-CT fixture).",
    )
    parser.add_argument(
        "--tenant-id",
        default=TENANT_ID,
        help="Tenant UUID (default: dev tenant).",
    )
    parser.add_argument(
        "--analysis-id",
        default=None,
        help="Use an existing Analysis row instead of creating one (e.g. dispatched by HTTP).",
    )
    args = parser.parse_args()

    analysis_id = args.analysis_id or str(uuid.uuid4())
    if args.analysis_id is None:
        # CLI mode: create the Analysis row before running.
        print(f"[CLI] Creating new Analysis row {analysis_id}")
        with psycopg.connect(DB_URL, autocommit=True) as conn:
            conn.execute(
                """
                INSERT INTO analysis (id, tenant_id, study_id, status, pipeline_version)
                VALUES (%s, %s, %s, 'queued', %s)
                """,
                (analysis_id, args.tenant_id, args.study_id, "totalsegmentator-v2"),
            )

    run_real_cascade(
        analysis_id=analysis_id,
        study_id=args.study_id,
        tenant_id=args.tenant_id,
        resection_pattern=args.resection_pattern,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
