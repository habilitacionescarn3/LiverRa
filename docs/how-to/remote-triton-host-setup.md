# LiverRa Remote Triton — Host Setup (this machine)

You run Triton in WSL2; a remote teammate (Lasha) connects to it over Tailscale. This is **your** side; `remote-triton-dev-setup.md` is what you send Lasha.

## What we built

- **Tailscale runs in WSL2 in userspace-networking mode.** No `tailscale0` kernel interface, so the rest of WSL2's `0.0.0.0` services (Postgres 5432, Orthanc 8042/4242, MinIO 9000/9001, Redis, etc.) are **not reachable from the tailnet by construction**, not just by ACL. The only way the tailnet can reach into this machine is through ports we explicitly `tailscale serve`.
- **Triton is exposed on tailnet ports 8000 / 8001 / 8002 via `tailscale serve --tcp`.** That's the entire surface area visible to anyone on the tailnet.
- **Auto-start hooks installed:** `/etc/wsl.conf [boot]` runs the daemon on WSL2 boot; `~/.bashrc` ensures it's running on shell entry; sudoers NOPASSWD entry is scoped to one script (`/usr/local/bin/start-tailscaled-userspace.sh`).
- **Identity:** `irakli-ff@github` (dedicated GitHub login).
- **Hostname:** `liverra-triton-host` on tailnet `tail55553c.ts.net`.
- **Tailnet IP:** `100.124.94.29`.

## Files

- `deploy/tailscale-acl.json` — the ACL to paste into the admin console (host email is filled; Lasha's stays as `LASHA_TAILSCALE_ID` until you have it).
- `/usr/local/bin/start-tailscaled-userspace.sh` — daemon starter (root-owned, sudoers-allowed).
- `/etc/sudoers.d/tailscaled-userspace` — NOPASSWD entry for the above.
- `/etc/wsl.conf` — `[boot] command = ...` — runs on WSL2 boot after `wsl --shutdown`.
- `~/.bashrc` — appended idempotent start hook.
- `/var/log/tailscaled-userspace.log` — daemon log.
- `/run/tailscaled-userspace.pid` — current PID.

## What's left for you

### Step 1 — Send Lasha the dev-setup doc

`docs/how-to/remote-triton-dev-setup.md`. Paste it to Slack/email. Ask him for his Tailscale identity (the email or `username@github` shown after he runs `tailscale up`).

### Step 2 — Once Lasha sends his Tailscale ID

1. Edit `deploy/tailscale-acl.json` — replace every `LASHA_TAILSCALE_ID` with his real ID (e.g. `lasha@gmail.com` or `lasha-handle@github`).
2. Open <https://login.tailscale.com/admin/acls/file> and paste the JSON. Save — the `tests` block will fail-fast if it's misconfigured.

### Step 3 — Share this machine with Lasha

<https://login.tailscale.com/admin/machines>:

1. Find `liverra-triton-host`.
2. `…` menu → **Share** → enter Lasha's Tailscale email.
3. He gets an email invite. He accepts; this machine appears in his tailnet view.

### Step 4 — Send Lasha

- Tailnet IP: `100.124.94.29`
- The dev-setup doc

## Day-to-day operations

- **WSL2 stays open + Triton stays up = Lasha can connect.**
- If WSL2 shuts down (last shell closed → WSL idle-out), the tailnet node goes offline. Reopening any WSL2 shell brings tailscaled back via the `[boot]` hook + bashrc fallback.
- Tailscale state survives reboots (state lives at `/var/lib/tailscale/`).

## Verify health

```bash
tailscale status              # shows liverra-triton-host online
tailscale serve status        # shows the three TCP forwarders
docker ps | grep triton       # liverra-triton container Up
curl http://localhost:8000/v2/health/ready   # local Triton health, HTTP 200
```

(Self-curl to `100.124.94.29:8000` from this machine doesn't work — userspace mode has no self-loopback for tailnet IPs. Lasha's machine, where Tailscale runs in normal kernel mode, will connect fine.)

## Tear down

To pause Lasha's access without uninstalling:

```bash
tailscale serve --tcp=8000 off
tailscale serve --tcp=8001 off
tailscale serve --tcp=8002 off
```

Restore: re-run the three `tailscale serve --bg --tcp=PORT tcp://localhost:PORT` commands.

To revoke entirely: in the admin console, **Unshare** the machine from Lasha and/or remove `group:dev` from the ACL.

## If Lasha says "I can't connect"

Check on this end:

```bash
tailscale status                     # node up?
tailscale serve status               # serves still configured?
docker ps | grep triton              # Triton container running?
curl http://localhost:8000/v2/health/ready   # Triton itself healthy?
tail -20 /var/log/tailscaled-userspace.log   # daemon errors?
```

If all four pass: ask Lasha for `tailscale status` output and `tailscale ping liverra-triton-host` from his side.

## Restart tailscaled manually if needed

```bash
sudo pkill -x tailscaled
sudo /usr/local/bin/start-tailscaled-userspace.sh
sleep 2 && tailscale status
```
