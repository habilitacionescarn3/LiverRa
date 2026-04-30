# LiverRa PACS Edge Stack

Orthanc + (future) nginx + CTP anonymizer + MONAI Informatics Gateway (MIG).

## Dev quickstart (upload + view local CTs)

```bash
# 1. Bring up postgres + orthanc only
docker compose -f deploy/local/docker-compose.yml up -d postgres orthanc

# 2. Confirm healthy
docker compose -f deploy/local/docker-compose.yml ps

# 3. Smoke-check Orthanc (default dev creds: orthanc/orthanc)
curl -sf -u orthanc:orthanc http://localhost:8042/system
curl -sf -u orthanc:orthanc http://localhost:8042/dicom-web/studies   # [] when empty

# 4. Wipe everything (when you want a clean slate)
docker compose -f deploy/local/docker-compose.yml down -v
```

Anonymization sidecar is **disabled** in local dev. The Lua hook at
`pacs/orthanc/liverra-hooks.lua` only calls the webhook when
`LIVERRA_ANON_SIDECAR_URL` is set — unset = accept everything. Do NOT upload
unanonymized real-patient DICOMs to a dev Orthanc.

See `docs/how-to/upload-and-view-dicom.md` for the full upload-and-view loop.

## Status

🚧 Edge-hardening (nginx + CTP + bridge) deferred to a later feature spec.

## Architecture (target)

```
Hospital Modality (CT/MRI)
  ↓ DIMSE C-STORE
Orthanc (mini-PACS, receives studies)
  ↓ Lua hook → anon-sidecar (CTP headers + Presidio pixel scan)
  ↓
MIG (forwards to cloud via DICOMweb STOW-RS)
  ↓ outbound HTTPS/WSS
LiverRa Cloud (AWS)
```

## Port back from MediMind

Reference:
`/Users/toko/Desktop/medplum_medimind/docker-compose.pacs.yml`,
`pacs/nginx/nginx.conf`,
`pacs/bridge/` (Python webhook sync pattern).
