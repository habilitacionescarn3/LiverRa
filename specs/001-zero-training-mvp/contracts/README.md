# Interface Contracts — Phase 1

**Feature**: 001-zero-training-mvp · **Plan**: [`../plan.md`](../plan.md) · **Data model**: [`../data-model.md`](../data-model.md) · **Research**: [`../research.md`](../research.md)

This directory is the contract surface the LiverRa v1 platform exposes — to web clients, to the cascaded ML pipeline, and to hospital PACS. Implementers MUST treat these as the source of truth when writing API handlers, Triton model configs, and DICOM-SEG/SR generators. Any change to a contract requires a spec amendment.

| Contract | File | Consumers |
|---|---|---|
| HTTP API (all 8 route groups) | [`api-openapi.yaml`](./api-openapi.yaml) | `packages/app` (frontend), external test clients |
| Triton model I/O (5 stages) | [`triton-stages.md`](./triton-stages.md) | `packages/ml-inference` orchestrator, Triton repo `config.pbtxt` |
| DICOM-SEG + DICOM-SR artifacts | [`dicom-artifacts.md`](./dicom-artifacts.md) | `packages/ml-inference/src/services/seg_sr`, hospital PACS |

### Design choices

- The HTTP API is **one OpenAPI 3.1 document** with route groups expressed as `tags` (not 8 separate files) — implementers validate against a single schema, and tooling (`openapi-generator`, `schemathesis`) consumes the whole surface at once.
- Every tagged group aligns 1:1 with a FastAPI router module under `packages/ml-inference/src/api/<tag>/`.
- Auth is OIDC Bearer tokens issued by AWS Cognito (research A.1) + a `custom:tenant_id` claim. The gateway strips and re-injects tokens; no PHI in headers or query strings.
- RBAC per `rbac_matrix.yaml` (research A.4 + X.3). Every protected operation declares its required permission in the OpenAPI description; server enforcement is via the `@require_permission` decorator and Medplum AccessPolicy.
- Error envelope follows **RFC 7807 Problem Details** with LiverRa extensions for tenant-safe error codes (no PHI in `detail`).
- Every state-changing operation writes a FHIR `AuditEvent` (research A.3) with the chain-of-hashes sequence number in an extension — the AuditEvent is not exposed as its own OpenAPI resource but is reachable via the Compliance read-only endpoints.

### Versioning

- Path prefix `/api/v1/` for all routes.
- Breaking changes require `/api/v2/` + overlap + deprecation per Constitution §Deployment Standards.
- Triton model versions are in the Model Bill of Materials (`MBoM.json` per build); the HTTP API exposes the active model version via `/api/v1/system/version`.

### Testing

- `schemathesis run contracts/api-openapi.yaml` in CI — fuzz-tests server responses against the schema.
- Golden-case Triton fixtures in `packages/ml-inference/tests/fixtures/` validate the tensor shapes and dtypes stated in `triton-stages.md`.
- DICOM-SEG/SR roundtrip tests load generated artifacts in a test PACS (Orthanc) and assert SNOMED codes per `dicom-artifacts.md`.
