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

## Run on Irakli's box — REQUIRES `--network host` on this WSL2 setup

```bash
cd packages/ml-inference-gpu
docker build -t liverra/gpu-inference:1.0.1 .

docker run -d --gpus all \
  --network host \
  -e PORT=9101 \
  --restart unless-stopped \
  --name liverra-gpu \
  liverra/gpu-inference:1.0.1

# Register with tailscale serve (one-time; persists in /var/lib/tailscale)
tailscale serve --bg --tcp 9101 tcp://localhost:9101

# Verify from any tailnet device EXCEPT this WSL box
# (userspace tailscaled can't reach its own tailnet IP from inside WSL):
curl http://100.124.94.29:9101/health
# → {"ok": true, "cuda_available": true, "cuda_device_name": "NVIDIA GeForce RTX 3090"}
```

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
docker run -d --gpus all --network host -e PORT=9101 --restart unless-stopped \
  --name liverra-gpu liverra/gpu-inference:NEW_TAG
```

If the laptop's cascade isn't running concurrently the cutover is
instantaneous; otherwise an in-flight cascade will fail with a clean
`httpx.ConnectError` and can be re-triggered after the restart.
