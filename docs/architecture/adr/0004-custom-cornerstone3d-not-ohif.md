# ADR 0004 — Custom Cornerstone3D shell, not OHIF Viewer v3

- **Status:** Accepted
- **Date:** 2026-04-19
- **Authors:** Eng leads (frontend + clinical UX)
- **Source:** research.md §C.4

---

## Context

LiverRa's viewer must render multi-phase CT (up to 4 phases × 512³
volumes), overlay segmentations (parenchyma, 8 Couinaud segments, 2
vessels, N lesions), support interactive refinement (VISTA3D click +
MedSAM-2 prompt), and burn a non-removable "Research Use Only" (RUO)
overlay on every pixel path — including `getDisplayMedia` screen
captures and print.

Two frontend paths existed:

1. **OHIF Viewer v3** — the mature open-source medical imaging viewer.
   Ships with its own shell, mode system, extension points, hanging
   protocols, study list. Built on top of Cornerstone3D.
2. **Custom Cornerstone3D shell** — we use Cornerstone3D directly
   inside our Vite + React 19 + Mantine 7 app, with our own shell
   primitives ported from the MediMind EMR asset map (see
   `CLAUDE.md §MediMind → LiverRa Reusable Asset Map`).

## Decision

We build a custom Cornerstone3D 2.0 shell inside our Mantine-based
frontend. We do NOT use OHIF Viewer v3.

Our viewer lives at `packages/app/src/emr/components/viewer/` +
`packages/imaging/src/{cornerstone,viewer}/`. MediMind's viewer
primitives (window/level presets, hanging protocols, annotation
service) are ported directly.

## Consequences

### Positive

- **Shell consistency**: the viewer's chrome (toolbars, side panels,
  modals) shares components with the rest of the app. Mantine tokens
  and theme variables flow through. A surgeon who knows the study
  list page doesn't re-learn the viewer's menu system.
- **RUO pixel-burn integration**: our five-layer defensive burn
  (canvas + DOM overlay + `@media print` CSS + server-side WeasyPrint
  burn + DICOM structured-field embedding) is trivially composable
  on a custom shell; OHIF's mode-plugin system would require deep
  hooks that fight its rendering lifecycle.
- **Bundle size**: OHIF's extension loader ships ~800 KB gzip of
  plumbing we don't use. Our shell currently measures ~240 KB gzip
  for the viewer chunk, well under the 2 MB budget in
  `scripts/ci-bundle-check.mjs`.
- **MediMind asset reuse**: we've already built + shipped the
  Cornerstone3D init + hanging protocols + annotation service in
  MediMind. Porting is faster than re-learning OHIF's extension API.
- **Regulatory pixel-path control**: Principle VI (RUO lifecycle)
  requires end-to-end visual compliance. With a custom shell, the
  path from `Triton output → NIfTI → segmentation mask → canvas
  rasterization → RUO burn` is a single audit-traceable pipeline.

### Negative

- **Feature recreation**: we must re-implement study list, hanging
  protocols, measurement tools, comparison view, and any OHIF feature
  a user asks for. MediMind covers most via the asset map, but the
  long tail (e.g. advanced MPR crosshairs) is on us.
- **Upstream drift**: OHIF releases faster than we'll port their
  improvements. We accept the lag explicitly.
- **Testing burden**: our Playwright viewer suite carries
  responsibilities OHIF's own QA would otherwise cover.

### Mitigations

- **Feature recreation**: the MediMind port covers the top 15 viewer
  workflows. New features are prioritised against clinical-lead
  requests; not every OHIF plugin ports.
- **Upstream drift**: Cornerstone3D (the rendering core) is still
  ours; we only lag on OHIF's *shell* features. The core rendering
  path gets CVE patches + GPU-driver fixes via Cornerstone3D
  upgrades directly.
- **Testing**: the viewer-FPS CI job + the US2/US8 E2E scenarios
  ensure regressions are caught early.

## Alternatives considered

### OHIF Viewer v3 as embedded mode

- **Pro:** Mature shell; community plugins.
- **Con:** Two shell systems (OHIF + Mantine) competing for the page
  chrome; RUO burn leaks through OHIF's WebGL compositor in edge
  cases; extension system forces OHIF idioms on the rest of our app;
  ~800 KB extra bundle; Mantine theme tokens don't cascade into
  OHIF's scoped-styles.
- **Verdict:** Rejected on shell conflict + RUO integration risk.

### Commercial viewer (e.g. Visage, 3D Slicer embed)

- **Pro:** Feature-complete; clinical trust signal.
- **Con:** Licensing (non-Apache-2.0 — violates Principle II); per-
  seat pricing breaks our cost model; no ability to embed RUO burn.
- **Verdict:** Rejected on licensing.

### Cornerstone Tools v6 directly (skipping Cornerstone3D)

- **Pro:** Lighter.
- **Con:** Cornerstone Tools v6 is in maintenance mode; Cornerstone3D
  is the active path. Using v6 would mean porting to v3D within 18
  months anyway.
- **Verdict:** Rejected on future-path.

---

## References

- Research §C.4 — viewer decision
- Constitution Principle II (Apache-2.0 only) — rules out commercial viewers
- Constitution Principle VI (RUO lifecycle) — demands pixel-path control
- CLAUDE.md — MediMind → LiverRa Reusable Asset Map
- `packages/imaging/src/cornerstone/` — init + tools
- `packages/app/src/emr/components/viewer/` — shell
