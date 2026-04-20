---
doc: brand-tokens
owner: Design Lead + Founder
status: pending
founder_sign_off: "<pending — Dr. Levan Gogichaishvili> <YYYY-MM-DD>"
design_lead_sign_off: "<pending — TBD> <YYYY-MM-DD>"
last_updated: 2026-04-19
release_blocking: true
gates:
  - release-gate.yml (T398) fails when status != approved
  - T464 theme.css ramp rewrite gated on status = approved
---

# LiverRa Brand Tokens — Source of Truth

> **Plain-English summary.** Think of this file as the paint-chip card for
> LiverRa. Every color, font, and gradient used anywhere in the product
> must come from here. Until the founder and the design lead both sign
> off (`status: approved`), we ship with the warm-gray placeholder ramp
> currently in `theme.css`. When this file flips to `approved`, task
> **T464** replaces the placeholder ramp with the values below, and
> `release-gate.yml` stops blocking pilot tags.

---

## 1. Ramp Requirements

Every ramp is **10 stops** — `50, 100, 200, 300, 400, 500, 600, 700, 800, 900`.
Stops must be monotonically increasing in luminance delta so Tailwind-style
utility semantics apply (`-50` lightest, `-900` darkest).

### 1.1 Primary brand ramp (`--liverra-primary-*`)

Required stops: `50, 100, 200, 300, 400, 500, 600, 700, 800, 900`.

Acceptance:
- `-500` is the canonical "LiverRa brand" tone (used in logo, primary
  CTA gradient mid-stop, and `--emr-secondary`).
- `-700` becomes `--emr-primary` (headings, navigation).
- `-400` becomes `--emr-accent` (hover states, secondary CTA).
- `-100` becomes `--emr-light-accent` (badge backgrounds, selection rings).

### 1.2 Accent ramp (`--liverra-accent-*`)

Required stops: `50, 100, 200, 300, 400, 500, 600, 700, 800, 900`.

Purpose: data-viz + FLR calculator highlights. Must be visually
distinct from primary ramp — ΔE2000(primary-500, accent-500) ≥ 25.

### 1.3 Semantic ramps

| Ramp | Stops required | Canonical token |
|---|---|---|
| `--liverra-success-*` | 50, 100, 300, 500, 700, 900 | `-500 → --emr-success` |
| `--liverra-warning-*` | 50, 100, 300, 500, 700, 900 | `-500 → --emr-warning` |
| `--liverra-error-*` | 50, 100, 300, 500, 700, 900 | `-500 → --emr-error` |
| `--liverra-info-*` | 50, 100, 300, 500, 700, 900 | `-500 → --emr-info` |

Semantic ramps MUST NOT collide with Couinaud segment palette (see §3).

---

## 2. Contrast Requirements (WCAG 2.1 AA)

| Role | Against | Ratio |
|---|---|---|
| Body text (≥ 16 px regular) | white `#ffffff` | **≥ 4.5 : 1** |
| Body text (≥ 16 px regular) | black `#000000` | **≥ 4.5 : 1** |
| Large text (≥ 24 px or ≥ 18.5 px bold) | white / black | **≥ 3 : 1** |
| UI component borders / focus rings | adjacent background | **≥ 3 : 1** |
| Iconography (non-decorative) | background | **≥ 3 : 1** |

Automation:
- `ci-palette-cvd-check` (T469) fails the build if any `-500` through
  `-900` primary/accent stop misses 4.5 : 1 on `#ffffff`.
- Dark-mode sweep (`T462`) enforces same ratios against `#000000`.

---

## 3. CVD-Safe Couinaud Palette Constraint

The 8-segment Couinaud legend is already defined in `theme.css` as
`--couinaud-seg-{I..VIII}`. Any future palette update (including new
brand ramp) MUST keep these 8 tokens **independent of the primary/accent
ramps** because surgeons rely on them for left-right orientation under
CVD (Color Vision Deficiency).

Acceptance:
- Simulate deuteranopia, protanopia, tritanopia (chroma-js `color.vision`
  or DaltonLens); pairwise **ΔE2000 ≥ 12** across all 8 segments under
  each simulation.
- CI job `ci-palette-cvd-check` runs the simulation per PR and fails if
  any pair drops below the floor.
- Manual review by founder for clinical plausibility (e.g., Segment IV
  must remain recognizable on the axial slice).

If an approved brand ramp accidentally overlaps a Couinaud color, the
Couinaud token wins — rebrand is responsible for remapping.

---

## 4. Typography

| Tier | Primary | Fallback chain |
|---|---|---|
| Sans (UI) | **Noto Sans** (Latin + Georgian subset) | Helvetica Neue → Arial → system-ui |
| Monospace (code / DICOM tags) | **JetBrains Mono** | Menlo → Consolas → monospace |
| Display (hero + report titles) | **Noto Serif Display** (optional) | Georgia → serif |

Token map (already stubbed in theme.css):
- `--emr-font-family` → Noto Sans stack.
- `--emr-font-family-mono` → JetBrains Mono stack.

Loading strategy:
- Self-host woff2 subsets (Latin + Georgian) via `@font-face` with
  `font-display: swap`. **Do not** use Google Fonts CDN in production
  (GDPR residency — see plan §Data Residency).
- Budget: ≤ 200 KB combined font payload initial load (T469 bundle gate).

---

## 5. Gradient Spec

Brand primary gradient — used on `EMRButton` primary variant, login
hero, and report PDF header band.

**Placeholder (current, MediMind-inherited):**
```
linear-gradient(135deg, #1a365d 0%, #2b6cb0 50%, #3182ce 100%)
```

**Target (LiverRa — final values TBD on sign-off):**
```
linear-gradient(
  135deg,
  var(--liverra-primary-800) 0%,
  var(--liverra-primary-500) 50%,
  var(--liverra-accent-400) 100%
)
```

Acceptance:
- Mid-stop contrast against white ≥ 4.5 : 1.
- End stops differ by ≥ 35 ΔE2000 (visibly distinguishable gradient).
- No stop may be one of the forbidden hexes listed in theme.css header
  (`#3b82f6 #60a5fa #2563eb #4267B2 #93c5fd #1d4ed8 #4299e1 #63b3ed`).

---

## 6. Dark-Mode Pairing

Every token in §1 must have a dark-variant value. Pairing is authored
in the `[data-mantine-color-scheme="dark"]` block in theme.css.

Acceptance:
- `T462` visual sweep must pass — no hardcoded hex leaks, RUO watermark
  still legible, overlay tokens ≥ 4.5 : 1 on `#000000`.

---

## 7. Change Gates

| Gate | Behavior |
|---|---|
| Status = `pending` | `release-gate.yml` (T398) fails pilot release tags |
| Status = `pending` | `T464` does **not** modify `theme.css` ramp values |
| Status = `approved` | `T464` implements the rewrite in a single PR |
| Any token change | triggers `ci-palette-cvd-check` + `ci-forbidden-colors-scan` |
| Couinaud palette change | requires founder + radiology lead co-sign |

---

## 8. Sign-off Block

```
founder_sign_off: <Dr. Levan Gogichaishvili> <YYYY-MM-DD>
design_lead_sign_off: <TBD> <YYYY-MM-DD>
radiology_lead_co_sign_if_couinaud: <Zviad Giorgadze> <YYYY-MM-DD>
status: pending | approved
approved_ramp_commit_sha: <filled when approved>
```

**No commit may flip `status: approved` without both sign-off lines
populated with real names + ISO-8601 dates.**

---

## 9. Related artifacts

- `packages/app/src/emr/styles/theme.css` — consumer (T464 target)
- `.github/workflows/release-gate.yml` — enforcer (T398)
- `packages/app/tests/visual/dark-mode-sweep.spec.ts` — automation (T462)
- `docs/runbooks/readiness-matrix.md` — release dashboard (T396)
