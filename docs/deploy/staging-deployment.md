# LiverRa staging deployment

Target topology: frontend on Netlify, backend on Fly.io (Frankfurt), DB on
Supabase (Frankfurt), Redis on Upstash, object storage on Cloudflare R2,
GPU on Irakli's PC exposed via Tailscale Funnel.

This runbook is **everything you (Lasha) do before Irakli touches anything**.
Irakli's two-command step is at the end (§7).

## 0. Prerequisites

- `gh` CLI (`brew install gh`) + push access to a GitHub repo for this branch
- `fly` CLI (`brew install flyctl`)
- `netlify` CLI (`brew install netlify-cli`)
- `psql` (`brew install libpq && brew link --force libpq`)

Cloud accounts (free tiers cover testing):

| Service | Sign up at | Region to pick |
|---|---|---|
| Supabase | supabase.com | Europe (Frankfurt) |
| Upstash | upstash.com | EU (Frankfurt) |
| Cloudflare R2 | dash.cloudflare.com → R2 | EU |
| Fly.io | fly.io/app/sign-up | (region set per app — fra) |
| Netlify | already have `liverra-app.netlify.app` | — |

## 1. Push code to GitHub

```bash
cd /Users/toko/Desktop/LiverRa
gh repo create liverra --private --source=. --remote=origin
git push -u origin 002-acr-structured-readout
```

## 2. Provision Supabase (database)

1. supabase.com → New project, region **Frankfurt**, generate strong DB password.
2. Wait for provisioning (~2 min).
3. Project Settings → Database → Connection string → **URI**: copy the value.
4. Run the migrations:

```bash
export DATABASE_URL_SYNC="postgresql://postgres.<ref>:<password>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres"
./scripts/deploy-migrate.sh
```

Expected output: `Final revision: 0017_refinement_optimistic_locking (head)`,
RLS enabled on 4 tables, dev tenant inserted.

## 3. Provision Upstash (Redis)

1. upstash.com → Create Redis, region **Frankfurt**, eviction policy `noeviction`.
2. Copy the `redis://` connection URL.

## 4. Provision Cloudflare R2 (S3 storage)

1. dash.cloudflare.com → R2 → Create two buckets:
   - `liverra-phases-staging`
   - `liverra-analyses-staging`
2. R2 → Manage R2 API tokens → Create an API token with write access to both. Save the access-key/secret-key pair.
3. Note your account ID (top of the R2 page) — used in `AWS_ENDPOINT_URL`.

## 5. Deploy backend to Fly.io

```bash
cd packages/ml-inference

# First-time only:
fly launch --copy-config --name liverra-api --region fra --no-deploy

# Fill secrets from the template:
cp ../../scripts/fly-secrets.example.env ../../scripts/fly-secrets.env
$EDITOR ../../scripts/fly-secrets.env   # paste real values from steps 2-4

# Push secrets (one line — Fly reads KEY=VAL from stdin):
grep -v '^\s*#' ../../scripts/fly-secrets.env | grep -v '^\s*$' | \
  xargs fly secrets set --app liverra-api

# Deploy. release_command runs `alembic upgrade head` automatically.
fly deploy --app liverra-api
```

Verify:

```bash
curl https://liverra-api.fly.dev/api/v1/system/health
# → {"status":"ok",...}
```

## 6. Deploy frontend to Netlify

```bash
# Set Netlify env vars from template (use the Netlify UI, or CLI):
cp scripts/netlify-env.example.env scripts/netlify-env.env
$EDITOR scripts/netlify-env.env

netlify env:import scripts/netlify-env.env --context production

# Trigger a deploy:
netlify deploy --build --prod
```

The existing `netlify.toml` already handles base path, SPA redirect, and
security headers.

## 7. Have Irakli expose his GPU (2 commands)

Send Irakli this:

```bash
# 7a — One-time: enable Funnel in the Tailscale admin panel:
#       https://login.tailscale.com/admin/settings/funnel

# 7b — On his PC, generate a shared token + expose port 9101:
export LIVERRA_GPU_SHARED_TOKEN=$(python3 -c "import secrets; print(secrets.token_urlsafe(48))")
echo "TOKEN: $LIVERRA_GPU_SHARED_TOKEN"     # send this back to you

# Restart his GPU service with the token set:
cd packages/ml-inference-gpu
LIVERRA_GPU_SHARED_TOKEN=$LIVERRA_GPU_SHARED_TOKEN python main.py

# In another terminal:
tailscale funnel --bg 9101
# Tailscale prints something like https://desktop-gpu.<tailnet>.ts.net
# Send THAT URL back to you too.
```

When Irakli replies, update two Fly secrets:

```bash
fly secrets set --app liverra-api \
  LIVERRA_INFERENCE_URL="https://desktop-gpu.<tailnet>.ts.net" \
  LIVERRA_GPU_SHARED_TOKEN="<token-from-irakli>"
# (auto-restarts the worker machine)
```

## 8. Smoke test

```bash
# Hit the public health endpoint:
curl https://liverra-api.fly.dev/api/v1/system/health

# Open the frontend:
open https://liverra-app.netlify.app

# Sign up → upload a study → click "Run AI" → wait ~12 min → verify report.
```

## What can be Tested vs Production

This staging stack is for **invited testers + synthetic / fully-anonymized data only**. Before any real PHI:

- Sign DPAs with Supabase, Upstash, Cloudflare, Fly.io, Netlify, Tailscale.
- Replace Supabase Auth with Cognito (CLAUDE.md regulatory plan).
- Move object storage from R2 to AWS S3 eu-central-1 with KMS.
- Move PostgreSQL from Supabase to AWS RDS eu-central-1 OR keep Supabase Enterprise with the BAA in place.
- Get the architecture reviewed by your CE-MDR notified body.

## Files this runbook references

- `packages/ml-inference/Dockerfile` — Python image
- `packages/ml-inference/entrypoint.sh` — picks API/worker/migrate
- `packages/ml-inference/fly.toml` — Fly.io config (one app, two process groups)
- `netlify.toml` — already at repo root
- `scripts/fly-secrets.example.env` — backend secrets template
- `scripts/netlify-env.example.env` — frontend env template
- `scripts/deploy-migrate.sh` — applies Alembic migrations against cloud DB
