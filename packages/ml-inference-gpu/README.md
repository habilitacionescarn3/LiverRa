# LiverRa GPU inference microservice

Stateless TotalSegmentator wrapper. The LiverRa cascade (laptop side)
uploads a CT NIfTI, this service returns a ZIP of mask NIfTIs. That's
the entire API surface. No DB, no S3, no LiverRa knowledge.

## Endpoints

- `POST /infer/total` — multipart `ct_nifti` → `application/zip` containing
  `liver.nii.gz`, `inferior_vena_cava.nii.gz`, `gallbladder.nii.gz`,
  `spleen.nii.gz`.
- `POST /infer/liver_vessels` — multipart `ct_nifti` → `application/zip`
  containing `liver_vessels.nii.gz` and `liver_tumor.nii.gz`.
- `GET /health` — JSON liveness + CUDA visibility check.

## Run on Irakli's box (one-time, then auto-restart on reboot)

```bash
cd packages/ml-inference-gpu
docker build -t liverra/gpu-inference:1.0.0 .
docker run -d --gpus all \
  -p 100.124.94.29:9100:9000 \
  --restart unless-stopped \
  --name liverra-gpu \
  liverra/gpu-inference:1.0.0

# Verify (use the Tailscale IP, NOT localhost — the bind is interface-specific):
curl http://100.124.94.29:9100/health
# → {"ok": true, "cuda_available": true, "cuda_device_name": "NVIDIA GeForce RTX 3090"}
```

**Why `9100:9000`** — the container exposes its app on port 9000
internally, but on the host side we bind to port 9100 because port 9000
is already taken by MinIO (default convention). The
`100.124.94.29:9100:9000` publish form binds to the Tailscale interface
only — the port is **not** reachable from the public internet. Auth is
therefore "anyone on the LiverRa Tailnet"; bearer tokens can be added
later if more isolation is needed.

## Logs

`docker logs -f liverra-gpu` — every request prints duration, input MB,
output mask count, ZIP MB.

## Updating

```bash
git pull
docker build -t liverra/gpu-inference:NEW_TAG .
docker stop liverra-gpu && docker rm liverra-gpu
docker run -d --gpus all -p 100.124.94.29:9100:9000 --restart unless-stopped \
  --name liverra-gpu liverra/gpu-inference:NEW_TAG
```

If the laptop's cascade isn't running concurrently the cutover is
instantaneous; otherwise an in-flight cascade will fail with a clean
`httpx.ConnectError` and can be re-triggered after the restart.
