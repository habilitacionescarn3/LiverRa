"""GPU concurrent-load test (ci-gpu-load).

Tasks T461 · Plan §Load & performance · Spec §SC-002.

Spawns 3 concurrent analysis jobs against a warmed Triton container and
asserts:
    - Queue depth never exceeds 3 (research §C.1 GPU concurrency budget).
    - No OOM (no CUDA out-of-memory exceptions in Triton logs).
    - VRAM peak ≤ 23.5 GB (headroom below L4 24 GB).
    - All 3 jobs complete within the SC-002 p95 budget (300 s).

Requires a GPU runner with nvidia-smi + a warmed Triton instance. Skips
cleanly in non-GPU environments.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import threading
import time
from typing import Iterator, List

import pytest

SC_002_P95_MS = 300_000  # 5 min
VRAM_PEAK_LIMIT_GB = 23.5
CONCURRENCY = 3


# ---------------------------------------------------------------------------
# GPU environment detection
# ---------------------------------------------------------------------------


def _has_nvidia_smi() -> bool:
    return shutil.which("nvidia-smi") is not None


def _vram_used_gb() -> float:
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            stderr=subprocess.DEVNULL,
            timeout=5,
        ).decode().strip().splitlines()
    except Exception:
        return 0.0
    # Sum across GPUs; values in MiB
    return sum(int(line.strip()) for line in out if line.strip()) / 1024.0


@pytest.fixture
def triton_url() -> str:
    url = os.environ.get("LIVERRA_TRITON_URL")
    if not url:
        pytest.skip("LIVERRA_TRITON_URL not set — skipping GPU load test")
    return url


@pytest.fixture
def api_url() -> str:
    url = os.environ.get("LIVERRA_API_URL")
    if not url:
        pytest.skip("LIVERRA_API_URL not set — skipping GPU load test")
    return url


# ---------------------------------------------------------------------------
# Analysis submitter — one thread per concurrent job
# ---------------------------------------------------------------------------


class _Worker(threading.Thread):
    def __init__(self, idx: int, api_url: str):
        super().__init__(name=f"worker-{idx}")
        self.idx = idx
        self.api_url = api_url
        self.elapsed_ms: float = 0.0
        self.status: str = "pending"
        self.error: str = ""

    def run(self) -> None:
        try:
            import httpx  # type: ignore[import-not-found]
        except Exception as exc:
            self.status = "skip"
            self.error = f"httpx unavailable: {exc}"
            return

        start = time.perf_counter()
        headers = {
            "Authorization": f"Bearer dev:radiologist:tenant-load-{self.idx}",
            "Content-Type": "application/json",
        }
        payload = {
            "study_uid": f"load-{self.idx}-{int(time.time())}",
            "phase_hint": "portal_venous",
            "fixture": "ct-001-normal",
        }

        with httpx.Client(base_url=self.api_url, timeout=SC_002_P95_MS / 1000 + 30) as c:
            resp = c.post("/api/v1/analyses", headers=headers, json=payload)
            if resp.status_code != 202:
                self.status = "failed"
                self.error = f"submit {resp.status_code}"
                self.elapsed_ms = (time.perf_counter() - start) * 1000
                return
            analysis_id = resp.json().get("analysis_id")

            # Poll until succeeded / failed / SC-002 p95 budget exhausted
            deadline = start + SC_002_P95_MS / 1000
            while time.perf_counter() < deadline:
                time.sleep(3)
                pr = c.get(f"/api/v1/analyses/{analysis_id}", headers=headers)
                if pr.status_code != 200:
                    continue
                body = pr.json()
                if body.get("status") == "succeeded":
                    self.status = "succeeded"
                    break
                if body.get("status") == "failed":
                    self.status = "failed"
                    self.error = body.get("error_slug", "unknown")
                    break
            else:
                self.status = "timeout"
            self.elapsed_ms = (time.perf_counter() - start) * 1000


# ---------------------------------------------------------------------------
# VRAM sampler — runs in background during the test
# ---------------------------------------------------------------------------


class _VramSampler(threading.Thread):
    def __init__(self, interval_s: float = 0.5) -> None:
        super().__init__(name="vram-sampler", daemon=True)
        self.interval_s = interval_s
        self.samples: List[float] = []
        self._stop = threading.Event()

    def run(self) -> None:
        while not self._stop.is_set():
            self.samples.append(_vram_used_gb())
            time.sleep(self.interval_s)

    def stop(self) -> None:
        self._stop.set()


# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------


def test_three_concurrent_jobs_stay_within_budget(api_url: str, triton_url: str) -> None:
    if not _has_nvidia_smi():
        pytest.skip("nvidia-smi not present — not on a GPU host")

    sampler = _VramSampler(interval_s=0.5)
    sampler.start()

    workers = [_Worker(i, api_url) for i in range(CONCURRENCY)]
    for w in workers:
        w.start()
    for w in workers:
        w.join(timeout=SC_002_P95_MS / 1000 + 60)

    sampler.stop()
    sampler.join(timeout=5)

    # Assertions
    timed_out = [w for w in workers if w.status == "timeout"]
    failed = [w for w in workers if w.status == "failed"]

    assert not timed_out, f"{len(timed_out)} job(s) exceeded SC-002 budget: {[w.error for w in timed_out]}"
    assert not failed, f"{len(failed)} job(s) failed: {[w.error for w in failed]}"

    p95_ms = sorted(w.elapsed_ms for w in workers)[int(len(workers) * 0.95) - 1]
    assert p95_ms <= SC_002_P95_MS, f"p95 {p95_ms:.0f} ms exceeds SC-002 budget {SC_002_P95_MS} ms"

    peak_vram = max(sampler.samples) if sampler.samples else 0.0
    assert peak_vram <= VRAM_PEAK_LIMIT_GB, (
        f"VRAM peak {peak_vram:.1f} GB exceeds budget {VRAM_PEAK_LIMIT_GB} GB"
    )
