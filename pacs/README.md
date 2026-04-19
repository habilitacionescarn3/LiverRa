# LiverRa PACS Edge Stack

Orthanc + nginx + CTP anonymizer + MONAI Informatics Gateway (MIG).

## Status

🚧 Stub. To be populated by feature spec (likely feature 002 — PACS integration).

## Architecture

```
Hospital Modality (CT/MRI)
  ↓ DIMSE C-STORE
Orthanc (mini-PACS, receives studies)
  ↓
CTP (header + pixel anonymization)
  ↓
MIG (forwards to cloud via DICOMweb STOW-RS)
  ↓ outbound HTTPS/WSS
LiverRa Cloud (AWS)
```

## Port back from MediMind

Reference: `/Users/toko/Desktop/medplum_medimind/docker-compose.pacs.yml`, `pacs/nginx/nginx.conf`, `pacs/bridge/` (Python webhook sync pattern).

## Planned contents

```
pacs/
├── nginx/
│   └── nginx.conf                 # HTTPS termination + auth
├── orthanc/
│   ├── orthanc.json               # Orthanc config
│   └── Dockerfile
├── ctp/
│   └── anonymizer-rules.script    # DICOM de-identification (DICOM PS3.15 Annex E)
├── bridge/
│   └── main.py                    # Webhook sync to LiverRa cloud
└── docker-compose.pacs.yml        # Full stack
```
