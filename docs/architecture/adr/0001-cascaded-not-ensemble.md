# ADR 0001 — Cascaded Celery orchestration, not Triton ensemble

- **Status:** Accepted
- **Date:** 2026-04-19
- **Authors:** Eng leads (backend + ML)
- **Source:** research.md §C.2

---

## Context

Our pipeline runs 7 stages: anonymization verify → parenchyma
segmentation → lesion detection → Couinaud parsing → vessel
segmentation → classification fanout → FLR calculation. Several of
these stages use Triton Inference Server (STU-Net, Pictorial Couinaud,
LiLNet, VISTA3D, MedSAM-2).

Triton natively supports **ensemble models** — you declare a YAML
graph, Triton wires the outputs of one model to the inputs of the
next, and clients see a single inference endpoint. It's the path of
least resistance for "call all these models in a chain."

The alternative is **application-level orchestration**: our FastAPI
layer hands the cascade to Celery workers, each stage is a distinct
Celery task, and Postgres holds a `pipeline_checkpoint` row per stage
so state survives worker restarts.

The constitutional principle at stake is Principle III (cascaded
architecture with explicit stage boundaries). The decision shapes how
we handle failures, partial results, observability, regulatory
traceability, and GPU scheduling.

## Decision

We orchestrate the cascade in **Celery + Postgres state machine**, not
via Triton ensemble. Triton is used only for *single-model* inference
at the stage level.

Each stage is a distinct Celery task with:
- Explicit timeout budget (soft + hard)
- Its own `pipeline_checkpoint` row written in the same transaction
  that releases the GPU lease for the next stage
- Its own retry policy and observability spans
- Its own FHIR AuditEvent emitted via the chain writer

The `pipeline_checkpoint` contract is defined in research §X.2 and
operationalized in migration `20260419_0002`.

## Consequences

### Positive

- **Partial-result preservation** (FR-014b): if classification fails
  on lesion 3 of 7, the first 2 results + parenchyma + lesion
  detection are already persisted. We return a partial analysis, not
  a full failure.
- **Worker-restart recovery**: on Celery worker crash, the next
  worker reads the highest checkpoint row and resumes from the next
  stage. Stages 1..N-1 are not re-executed, preserving the audit
  chain.
- **Per-stage observability**: each stage is a named OTel span with
  its own latency histogram (`liverra_cascade_stage_latency_seconds`).
  Dashboards slice by stage cleanly.
- **Per-stage retry policy**: STU-Net gets 3 retries with exponential
  backoff; LiLNet gets 1 retry because logits are expensive to
  re-compute. These policies live in Celery decorators, not in a YAML.
- **GPU scheduling flexibility**: Tier-A (always-loaded) vs Tier-B
  (lazy, 10-min idle unload) — per research §C.1 — is a decision
  Celery makes via Triton model-control requests at task entry. An
  ensemble YAML cannot express this.
- **Regulatory traceability**: every stage emits an AuditEvent with
  `model.version` from the MBoM, anchored by the chain-of-hashes.
  Ensemble inference emits one audit record for the whole chain,
  which is insufficient for per-model SBOM compliance.

### Negative

- **More code to maintain**: Celery task wiring, checkpoint table,
  orchestrator cascade service. Ensemble YAML would be ~30 lines
  total.
- **Inter-stage serialization cost**: passing tensors between stages
  via shared memory is not free. Research §C.3 mitigates with
  in-process NumPy for stages 1→3 in one Celery task + NIfTI-on-S3
  at stage boundaries for durable audit.
- **Higher operational cognitive load**: ops must understand Celery
  queue dynamics in addition to Triton model-control. Research §C.2
  includes the dashboard + runbook coverage to bound this cost.

### Mitigations

- **Cognitive load**: the queue + cascade dashboard (liverra-queue,
  liverra-latency) + the restore runbook ([dr-restore.md](../../runbooks/dr-restore.md))
  consolidate operational knowledge. New ops staff onboard via these.
- **Serialization cost**: in-process handoff for stages 1→3 avoids
  N-1 serialize/deserialize hops; S3 is only written at durable
  boundaries.

## Alternatives considered

### Triton ensemble

- **Pro:** ~30 LoC YAML; Triton handles the graph.
- **Con:** No per-stage audit, no partial-result preservation, no
  per-stage retry, no Tier-A/B VRAM policy expressible, no
  worker-restart recovery at intra-ensemble granularity, no
  regulatory MBoM stamp at per-model grain.
- **Verdict:** Rejected. Constitution Principle III demands explicit
  stage boundaries; ensemble hides them.

### Prefect / Dagster

- **Pro:** Purpose-built DAG orchestrators with UIs.
- **Con:** Adds a full-weight service to the stack (Prefect server
  or Dagster daemon + its Postgres); duplicates Celery's concurrency
  model; no native GPU-aware scheduling. Research §C.2 evaluates both
  and rejects on complexity-vs-benefit.
- **Verdict:** Rejected. Celery's decorator-based retry + Postgres as
  state store is lighter and aligns with our existing backend stack.

### Pure FastAPI async + asyncio

- **Pro:** No new dependency; async/await is ergonomic.
- **Con:** No durable queue, no worker pool for GPU-bound tasks,
  no acks-late semantics, no retry with exponential backoff without
  reinventing Celery's guarantees.
- **Verdict:** Rejected for the orchestration layer; retained for
  HTTP request handling + SSE streaming only.

---

## References

- Research §C.2 — cascade orchestration decision
- Research §X.2 — `pipeline_checkpoint` contract
- Plan §Testing Strategy — per-stage test harness
- Constitution Principle III — cascaded architecture mandate
