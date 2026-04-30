# Upload and view a real DICOM

This walks through the full loop: bring up Orthanc, upload a DICOM, watch it render in the Cornerstone3D viewer. No AI pipelines, no mocked backend — the real PACS path.

## Prerequisites

- Docker Desktop running
- `curl`, `jq`, `bash` in your `$PATH`
- Node 22+ / npm
- (Optional but nice) a DICOM file you already have on disk. If not, the `fetch-sample-dicom.sh` script grabs a public anonymized CT.

## 1. Start the stack

```bash
docker compose -f deploy/local/docker-compose.yml up -d postgres orthanc

# Wait for healthy — typically <10 s
docker compose -f deploy/local/docker-compose.yml ps
# liverra-orthanc  ... Up (healthy)

# Default dev creds: orthanc / orthanc
curl -sf -u orthanc:orthanc http://localhost:8042/dicom-web/studies    # []
```

## 2. Seed with a sample study (optional)

```bash
./scripts/fetch-sample-dicom.sh    # downloads ~20 instances into fixtures/dicom/ (gitignored)
./scripts/seed-orthanc.sh          # POSTs them to Orthanc
```

Skip this if you'd rather drop your own DICOM files through the browser. The
dropzone on `/pacs/studies` accepts `.dcm` files or whole folders.

## 3. Run the app

```bash
# VITE_LIVERRA_DEV_BYPASS=true grants full permissions in dev without Cognito.
# Not needed once a real backend + OIDC env vars are wired up.
cd packages/app
VITE_LIVERRA_DEV_BYPASS=true npx vite --port 5173
```

Open <http://localhost:5173/pacs/studies>. The study you seeded (or any DICOMs
you drag in) will appear in the list. Click a row → `/pacs/studies/:uid` opens
the viewer and streams pixels via WADO-RS.

## Troubleshooting

| Symptom | Usually means | Fix |
|---|---|---|
| `/pacs/studies` redirects to `/signin` | Dev bypass flag not set | Restart Vite with `VITE_LIVERRA_DEV_BYPASS=true` |
| "Cannot reach Orthanc" alert on the list | Orthanc not up or proxy mis-targeted | `docker compose ps` → is `orthanc` healthy? On macOS the proxy must target `127.0.0.1:8042`, not `localhost` |
| List renders but viewer stays black | Cornerstone3D failed to decode | Open browser devtools → Network; look for 401/404 on `/dicom-web/.../frames/1`. 401 means auth injection broke — check `ORTHANC_DEV_USER` / `ORTHANC_DEV_PASSWORD` |
| `optimizeDeps` warnings about `decodeImageFrameWorker.js` | Cornerstone web worker path | Cosmetic, already mitigated via `optimizeDeps.exclude` in `vite.config.ts` |
| Upload returns "no valid DICOM files" | Dropped a `.zip` or non-DICOM | Extract the `.zip` first; the PACS path takes raw `.dcm` only |

## Clean slate

```bash
docker compose -f deploy/local/docker-compose.yml down -v    # also wipes Orthanc Postgres
rm -rf fixtures/dicom/
```

## Where the moving parts live

| What | Where |
|---|---|
| DICOMweb client | `packages/app/src/emr/services/pacs/dicomwebClient.ts` |
| Cornerstone3D init | `packages/app/src/emr/services/pacs/cornerstoneInit.ts` |
| Studies list view (QIDO) | `packages/app/src/emr/views/pacs/PacsStudiesView.tsx` |
| Viewer view (WADO) | `packages/app/src/emr/views/pacs/PacsStudyViewerView.tsx` |
| Upload hook (STOW) | `packages/app/src/emr/hooks/useStowUpload.ts` |
| Vite proxy (`/dicom-web` → Orthanc) | `packages/app/vite.config.ts` |
| Orthanc compose + healthcheck | `deploy/local/docker-compose.yml` |
| Orthanc Lua hook (webhook gate) | `pacs/orthanc/liverra-hooks.lua` |
| E2E test | `packages/app/src/emr/views/__e2e__/pacs/test-pacs-upload-and-view.ts` |

## Running the E2E

```bash
cd packages/app
PACS_E2E_ENABLED=true VITE_LIVERRA_DEV_BYPASS=true \
  npx playwright test src/emr/views/__e2e__/pacs/ --project=chromium-desktop
```

The spec skips cleanly (rather than failing) if Orthanc isn't running or
fixtures aren't present, so it's safe to leave in CI lanes that don't boot the
PACS stack.

## Production notes (what's still ahead)

The dev proxy model (Basic-auth injection in Vite) is dev-only. Before this
loop ships to hospitals we need:

1. **nginx terminus** in front of Orthanc that validates the Cognito JWT and
   forwards to Orthanc via an internal-only network.
2. **CTP anonymizer sidecar** + re-enable the Lua webhook (set
   `LIVERRA_ANON_SIDECAR_URL`). Today the hook accepts every instance.
3. **FHIR `ImagingStudy` mirror** via a Medplum-wired pacs-bridge (see
   `/Users/toko/Desktop/medplum_medimind/pacs/bridge/` for the reference
   implementation).

None of those block the dev flow; they're Phase-2 hardening tracked as their
own feature specs.
