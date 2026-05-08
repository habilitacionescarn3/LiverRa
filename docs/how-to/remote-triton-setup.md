# Remote Triton over Tailscale

Develop the LiverRa stack while Triton runs on a different machine, connected via Tailscale (private encrypted tunnel; no router config, no public exposure).

The setup is split by role:

- **You run Triton on this machine?** → [remote-triton-host-setup.md](./remote-triton-host-setup.md)
- **You're the remote developer connecting to someone else's Triton?** → [remote-triton-dev-setup.md](./remote-triton-dev-setup.md)

The Tailscale ACL policy lives at [`deploy/tailscale-acl.json`](../../deploy/tailscale-acl.json) — applied by the host. It restricts the dev to ports 8000 / 8001 / 8002 only, with no reverse path.
