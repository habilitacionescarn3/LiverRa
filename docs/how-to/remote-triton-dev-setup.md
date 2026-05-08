# LiverRa Remote Triton — Developer Setup (Lasha)

Hey — I'm running the LiverRa Triton + models on my machine and want you to be able to develop against it from yours. We'll use Tailscale: a free private-network tool, ~10 min, encrypted, no router or firewall config on either end. You only need to do the steps below; I'll handle the rest on my side.

## Step 1 — Install Tailscale (~2 min)

1. <https://tailscale.com/download> for your OS — install.
2. Sign in **with a fresh Google or GitHub identity dedicated to this** — not your main work or personal account. Tailscale ties access to identity, so this keeps the blast radius scoped.
3. Tailscale is now in your menu bar / system tray.

## Step 2 — Send me your Tailscale identity email

Whichever Google/GitHub email you signed in with — send it to me. I need it to:
- Add you to the ACL (so you can reach my Triton on ports 8000 / 8001 / 8002, and *only* those).
- Share my machine to you.

## Step 3 — Wait for the share invite

I'll share my machine with you in the Tailscale admin console. You'll get an email like *"<my-email> has shared a machine with you"*. Click through and accept.

## Step 4 — Verify the connection

Once you've accepted:

```bash
tailscale status
# Expect: my machine listed, with a 100.x.x.x address.

ping 100.124.94.29
# Expect: replies.
```

I'll send you the `100.x.x.x` separately.

## Step 5 — Point LiverRa at the remote Triton

Clone the repo if you don't have it:

```bash
git clone <repo-url> LiverRa
cd LiverRa
npm install
```

Edit `.env.local` (create it from `.env.example` if it doesn't exist) and replace the Triton URLs:

```diff
-TRITON_URL=http://localhost:8001
-TRITON_GRPC_URL=localhost:8001
-TRITON_HTTP_URL=http://localhost:8000
+TRITON_URL=http://100.124.94.29:8001
+TRITON_GRPC_URL=100.124.94.29:8001
+TRITON_HTTP_URL=http://100.124.94.29:8000
```

Leave `ML_INFERENCE_URL` alone — that's your local FastAPI service.

## Step 6 — Verify end-to-end

```bash
curl http://100.124.94.29:8000/v2/health/ready
# Expect: HTTP 200, empty body.

cd packages/ml-inference
TRITON_GRPC_URL=100.124.94.29:8001 \
  python scripts/verify_triton_serves.py
# Expect: all 6 models pass.
```

If health works but `verify_triton_serves` fails, gRPC (port 8001) is being blocked somewhere — message me and I'll check the ACL on my end.

## Step 7 — Run the rest of the stack locally

```bash
docker compose -f deploy/local/docker-compose.yml up -d \
  postgres redis minio orthanc mailhog
# (everything except triton — you're using mine)

cd packages/app && npx vite --port 5173
```

You're set.

## If it stops working later

- Check `tailscale status` — am I online? (My Triton machine has to be awake.)
- Check `curl http://100.124.94.29:8000/v2/health/ready` — is Triton up on my end?
- If the IP changed: shouldn't happen (Tailscale IPs are stable), but if it does, ping me.
