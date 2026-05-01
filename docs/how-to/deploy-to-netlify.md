# Deploy LiverRa to Netlify (UI public, models private)

This is the user-facing path: a polished web app on `https://<name>.netlify.app`,
backed by Lasha's local FastAPI exposed via Cloudflare Tunnel, with the GPU +
6 ML models staying on Irakli's PC over Tailscale (never publicly exposed).

```
Internet user → Netlify static SPA
              → API call to https://<tunnel-host>/api/v1/*
              → Cloudflare Tunnel → Lasha laptop FastAPI :8090
              → Celery worker → Triton on Irakli's PC (Tailscale)
              → result back to user
```

---

## Step 1 — Cloudflare Tunnel (one-time, ~10 min)

```bash
brew install cloudflare/cloudflare/cloudflared
cloudflared tunnel login                    # opens browser
cloudflared tunnel create liverra-api       # prints UUID — save it

# Set up DNS (assumes you have a Cloudflare-hosted domain):
cloudflared tunnel route dns liverra-api liverra-api.<your-domain>

# Copy the example config and fill in placeholders:
mkdir -p ~/.cloudflared
cp deploy/cloudflared/config.example.yml ~/.cloudflared/config.yml
# Edit ~/.cloudflared/config.yml — replace <UUID> and <HOSTNAME>.

# Run as a launchd service so it auto-restarts:
sudo cloudflared service install
brew services start cloudflared
```

**No domain?** Use a quick tunnel for the first demo (random URL, expires when daemon stops):
```bash
cloudflared tunnel --url http://localhost:8090
# prints something like https://crazy-name-123.trycloudflare.com
```
Replace with a named tunnel before sharing widely.

**Smoke test from your phone (LTE, not WiFi):**
```bash
curl https://liverra-api.<your-domain>/api/v1/system/health
# → {"status":"ok",...}
```

---

## Step 2 — Make sure local backend is running

On Lasha's laptop, three processes must be alive:

```bash
# 1. FastAPI
cd packages/ml-inference
LIVERRA_ENV=development LIVERRA_AUTH_BYPASS=true \
  DATABASE_URL=postgresql+asyncpg://liverra:liverra@localhost:5432/liverra \
  REDIS_URL=redis://localhost:6379/0 \
  CELERY_BROKER_URL=redis://localhost:6379/1 \
  CELERY_RESULT_BACKEND=redis://localhost:6379/2 \
  TRITON_URL=100.124.94.29:8001 TRITON_GRPC_URL=100.124.94.29:8001 \
  TRITON_HTTP_URL=http://100.124.94.29:8000 \
  ANON_SIDECAR_URL=http://localhost:7070/anonymize \
  CORS_ORIGINS=https://<your-app>.netlify.app,http://localhost:5173 \
  .venv/bin/uvicorn src.main:app --host 0.0.0.0 --port 8090

# 2. Celery worker (same env)
.venv/bin/celery -A src.workers.app:app worker --loglevel=info

# 3. Mock anonymization sidecar
.venv/bin/python scripts/mock_anon_sidecar.py 7070

# 4. Don't let macOS sleep mid-demo:
caffeinate -d &
```

Once the public demo is over, kill `caffeinate` and let the laptop sleep.

---

## Step 3 — Deploy frontend to Netlify

### One-time: connect repo

1. Go to https://app.netlify.com → "Add new site" → "Import an existing project"
2. Choose your Git provider, select the LiverRa repo
3. Netlify auto-detects `netlify.toml` at the repo root — confirm:
   - Base directory: `packages/app`
   - Build command: `npm install --prefix ../.. --workspaces=false --include-workspace-root && npm run build`
   - Publish directory: `packages/app/dist`
4. **Set environment variables** before first deploy (Site settings → Environment):

```
VITE_LIVERRA_API_BASE_URL = https://liverra-api.<your-domain>/api/v1
VITE_LIVERRA_MOCK_API     = false
VITE_LIVERRA_DEV_BYPASS   = false      ← MUST be false (build will fail if true)
VITE_DICOM_WEB_BASE       = https://liverra-api.<your-domain>/dicom-web
```

### Deploy

```bash
git push origin main
```

Netlify auto-builds + deploys. You get a URL like `https://liverra-foobar.netlify.app`.

### Custom domain (optional)

Site settings → Domain management → Add custom domain → `app.liverra.<your-domain>`. Netlify provisions Let's Encrypt cert automatically.

---

## Step 4 — Verify end-to-end

From any machine (NOT Lasha's laptop) — your phone, a friend's laptop, anywhere:

1. Visit `https://<app>.netlify.app`
2. Sign in (dev creds: any email, password `livercheck` — see `auth/login` route)
3. Click `/pacs/studies` in sidebar
4. Click "Run AI" on any study row
5. Watch cascade run live (browser → Cloudflare Tunnel → Lasha → Celery → Irakli's Triton → results back)
6. Lesions, FLR, segments render in the UI

If any step fails, debug per network hop:
```bash
# Hop 1: Internet → Netlify
curl https://<app>.netlify.app                         # 200
# Hop 2: Browser → Cloudflare Tunnel
curl https://<tunnel-host>/api/v1/system/health        # 200
# Hop 3: Tunnel → Lasha's FastAPI
curl http://localhost:8090/api/v1/system/health        # 200 on his machine
# Hop 4: FastAPI → Tailscale → Irakli's Triton
curl http://100.124.94.29:8000/v2/health/ready         # 200
```

---

## Operational notes

- **Lasha's laptop must stay online + awake during demos.** Use `caffeinate -d`.
- **If Cloudflare Tunnel daemon dies**, the public site shows backend-down errors. `brew services start cloudflared` to restart.
- **Static SPA caches forever** — Netlify auto-invalidates on deploy. If users see stale HTML, they need to hard-reload (Shift+Cmd+R).
- **CORS errors?** Add the exact Netlify origin to `CORS_ORIGINS` env on Lasha's laptop FastAPI process and restart. Wildcards don't work.
- **Long-term**, move the backend to a small AWS/Fly.io VM so the demo doesn't depend on Lasha's laptop being online. The VM connects to Triton via Tailscale — Triton stays on Irakli's PC.

---

## Production hardening (when going to clinical pilot)

1. Replace dev-bypass auth with real Cognito OIDC (set `VITE_LIVERRA_OIDC_*` vars in Netlify)
2. Move backend to AWS ECS or Fly.io
3. Set up signed model weights (Cosign per Constitution X)
4. Enable real Medplum FHIR (replace fhirClient stub)
5. Implement tus chunked DICOM upload (replace the demo seed-data path)
6. Audit chain-of-hashes verification job (cron)
7. CE MDR Class IIb SaMD documentation per Constitution II
