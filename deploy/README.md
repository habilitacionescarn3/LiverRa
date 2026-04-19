# LiverRa Deployment

Docker Compose stacks for local, production, and on-prem deployments.

## Status

🚧 Stub. To be populated by feature spec.

## Expected contents

```
deploy/
├── docker-compose.local.yml       # Local dev stack (app + ml-inference + orthanc + postgres)
├── docker-compose.production.yml  # Cloud production (AWS ECS / EKS ready)
├── docker-compose.onprem.yml      # Hospital on-prem edge appliance
└── kubernetes/                    # EKS manifests (Phase 2)
```

## Planned architecture

- **MVP:** Docker Compose on single AWS EC2 (g5.xlarge GPU for inference)
- **Phase 2:** AWS EKS multi-node with Triton autoscaling
- **On-prem:** Edge appliance (Intel NUC) with Docker Compose running Orthanc + CTP + outbound-only cloud connection
