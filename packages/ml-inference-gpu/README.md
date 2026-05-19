# LiverRa GPU inference microservice

Stateless TotalSegmentator wrapper. The LiverRa cascade (laptop side)
uploads a CT NIfTI, this service returns a ZIP of mask NIfTIs. That's
the entire API surface. No DB, no S3, no LiverRa knowledge.

## Endpoints

All `/infer/*` endpoints require `Authorization: Bearer <LIVERRA_GPU_SHARED_TOKEN>`.
Successful responses carry `X-LiverRa-Model-Version`,
`X-LiverRa-Model-Weights-SHA`, and `X-LiverRa-License-Mode`
(`apache-2.0-base` | `commercial-licensed` | `noncommercial-demo`)
headers — the laptop client persists these onto
`Analysis.model_versions` for regulatory provenance, so an audit can
tell a commercially licensed run from a non-commercial demo run.

- `POST /infer/total` — multipart `ct_nifti` → `application/zip` containing
  `liver.nii.gz`, `inferior_vena_cava.nii.gz`, `gallbladder.nii.gz`,
  `spleen.nii.gz`. Apache-2.0 / no commercial license required.
- `POST /infer/liver_vessels` — multipart `ct_nifti` → `application/zip`
  containing `liver_vessels.nii.gz` and `liver_tumor.nii.gz`.
  ⚠ Gated. Requires EITHER `LIVERRA_TS_COMMERCIAL_LICENSED=true` (paid
  TS commercial license, attested) OR `LIVERRA_TS_NONCOMMERCIAL_DEMO=true`
  (internal-demo / clinical-validation under the weights'
  CC-BY-NC-SA-4.0 non-commercial terms — response stamped
  `X-LiverRa-License-Mode: noncommercial-demo`). Neither set → HTTP 451.
- `POST /infer/total_and_vessels` — combined call (kept for backward
  compatibility, but the cascade no longer uses it because the two-call
  pattern is ~2 minutes faster on Tailscale links). Same commercial-
  license gate as `liver_vessels`.
- `GET /health` — JSON liveness + CUDA + provenance info. Returns
  HTTP 503 when CUDA is unavailable so K8s liveness probes correctly
  mark the pod unhealthy.

## Run on Irakli's box — REQUIRES `--network host` on this WSL2 setup

```bash
cd packages/ml-inference-gpu
docker build -t liverra/gpu-inference:1.0.3 .

# Generate a strong shared token (paste the SAME value on the laptop's
# .env as LIVERRA_GPU_SHARED_TOKEN — both ends must match):
TOKEN=$(python -c "import secrets; print(secrets.token_urlsafe(48))")

docker run -d --gpus all \
  --network host \
  -e PORT=9101 \
  -e LIVERRA_GPU_SHARED_TOKEN="$TOKEN" \
  -e LIVERRA_TS_COMMERCIAL_LICENSED=false \
  --restart unless-stopped \
  --name liverra-gpu \
  liverra/gpu-inference:1.0.3

# Register with tailscale serve (one-time; persists in /var/lib/tailscale)
tailscale serve --bg --tcp 9101 tcp://localhost:9101

# Verify from any tailnet device EXCEPT this WSL box
# (userspace tailscaled can't reach its own tailnet IP from inside WSL):
curl http://100.124.94.29:9101/health
# → {"ok": true, "cuda_available": true, "cuda_device_name": "NVIDIA GeForce RTX 3090"}
```

**Internal-demo box?** Add `-e LIVERRA_TS_NONCOMMERCIAL_DEMO=true` to
the `docker run` to unlock lesion detection / `liver_vessels` for
demos + clinical validation under the weights' CC-BY-NC-SA-4.0
non-commercial terms. Do NOT also set `LIVERRA_TS_COMMERCIAL_LICENSED`
unless a paid license was genuinely purchased — the demo flag stamps
`X-LiverRa-License-Mode=noncommercial-demo` into provenance, which is
the honest record for a non-paying deployment. `GET /health` echoes
`vessels_license_mode` so you can confirm the posture after restart.

**Why `--network host` is required.** WSL2's tailscaled runs in
`--tun=userspace-networking` mode (no kernel TUN driver). Tailscale's
userspace TCP/IP stack cannot reliably reach `docker-proxy`-published
ports — see Tailscale GitHub
[#13931](https://github.com/tailscale/tailscale/issues/13931) and
[#14559](https://github.com/tailscale/tailscale/issues/14559).
The existing services on this box (Triton :8000-:8002, liverra-api
:8090) all use `--network host`, which is why they work; `liverra-gpu`
must do the same.

`PORT=9101` keeps the container off port 9000 (MinIO's port).

## Logs

`docker logs -f liverra-gpu` — every request prints duration, input MB,
output mask count, ZIP MB.

## Updating

```bash
git pull
docker build -t liverra/gpu-inference:NEW_TAG .
docker stop liverra-gpu && docker rm liverra-gpu
docker run -d --gpus all --network host \
  -e PORT=9101 \
  -e LIVERRA_GPU_SHARED_TOKEN="$TOKEN" \
  -e LIVERRA_TS_COMMERCIAL_LICENSED=false \
  --restart unless-stopped \
  --name liverra-gpu liverra/gpu-inference:NEW_TAG
```

If the laptop's cascade isn't running concurrently the cutover is
instantaneous; otherwise an in-flight cascade will fail with a clean
`httpx.ConnectError` and can be re-triggered after the restart.
