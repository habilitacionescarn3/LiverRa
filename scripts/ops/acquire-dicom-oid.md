# Runbook — Acquire DICOM OID Root for LiverRa

> **Owner:** CTO / Infrastructure lead
> **Blocker for:** T138 platform bootstrap; `ci-dicom-uid-present` gate
> **Lead time:** ~5 business days
> **Cost:** ~$300 USD (one-time)

## Why

Every LiverRa-generated DICOM object (SEG, SR, Secondary Capture) must carry a
globally-unique SOP Instance UID. DICOM requires UIDs to be rooted at an
organization-specific OID so two vendors' instances never collide. Without a
registered OID root, our DICOM output is non-conformant and PACS endpoints
may reject it.

## What to acquire

- **Provider:** [Medical Connections Ltd — UID Service](https://www.medicalconnections.co.uk/FreeUID.html)
  (the standard industry registrar; ISO-accredited agent for `1.2.826.0.1.*`).
- **Format of allocated OID:** `1.2.826.0.1.XXXXXX` (LiverRa receives a base,
  extends it per-instance with dotted segments).
- **What the OID identifies:** the LiverRa legal entity issuing DICOM
  instances. One root suffices for all tenants; per-tenant sub-branches are
  derived at runtime by the ml-inference service.

## Steps

1. On Medical Connections' UID Service page, select the paid tier (free tier
   is insufficient for commercial SaaS; paid tier issues a permanent root).
2. Pay ~$300 USD from the LiverRa corporate card; retain receipt for
   expenses + audit trail.
3. Fill the registrant form with the LiverRa legal entity (not personal).
4. Wait for Medical Connections confirmation email (~3–5 business days).
5. Verify the issued OID is of the form `1.2.826.0.1.XXXXXX`.

## Storage of the OID

- Write the acquired value to **AWS Secrets Manager** under the key
  `liverra/dicom-uid-root` in region `eu-central-1`.
- Secret value is a single string (no JSON wrapper).
- Tag the secret with `purpose=dicom-uid-root` and `rotation=never` (OIDs are
  permanent — they **must not** rotate).
- Mirror the value to the 1Password "LiverRa / Infrastructure" vault with the
  note "canonical source = AWS Secrets Manager".

## Runtime consumption

`scripts/ops/configure-dicom-uid-root.sh` reads the secret and exports it as
the environment variable `LIVERRA_UID_ROOT`, consumed by the ml-inference
service at boot (T138 bootstrap). The CI check `ci-dicom-uid-present` asserts
the secret exists before any `go-live` tag can be pushed (SC-007).

## Failure modes

| Symptom | Cause | Remediation |
|---|---|---|
| ml-inference boot error `LIVERRA_UID_ROOT not set` | Secret not provisioned | Run this runbook end-to-end, re-run deploy |
| PACS C-STORE rejected with "unrecognized UID root" | Wrong OID format | Double-check Medical Connections confirmation; must start `1.2.826.0.1.` |
| CI gate `ci-dicom-uid-present` fails | Secret missing in target region | Confirm secret exists in `eu-central-1` specifically |

## Evidence

Attach the Medical Connections confirmation email + invoice to
`s3://liverra-audit/operations/dicom-oid-acquisition/` and reference in the
compliance dashboard's MBoM entry for identity roots.
