# UI Upgrade: Analysis Detail View (LiverRa)

## Route
`/cases/f178683c-424c-4d8e-a1b1-ba7785ddae11` on `http://localhost:5173`

## BEFORE Screenshots
- User-provided: Screenshot 2026-05-13 at 18.03.09.png (main view)
- User-provided: Screenshot 2026-05-13 at 18.03.19.png (scrolled to ACR readout)
- Playwright: `screenshots/fd-analysis-detail-BEFORE-main.png` (returned 404 from API — UI shows error state only)

Note: live API returns 404 for the supplied analysis id, so AFTER verification relies on
the user-provided BEFORE screenshots as visual ground truth + static reload to confirm
no regressions in non-data-dependent chrome (hero, RUO ribbon, error state, layout).

## Issues Found (per zone)

### Zone 1 — Top page header
- Title uses `var(--emr-font-md)` (14px) — too small for a clinical title; should be `--emr-font-lg` (16px) or `--emr-font-xl` (18px).
- KPI inline pills are tiny (11px, 24px tall) — surgeons need to scan at a glance; numerals should be tabular and slightly larger.
- No tabular-numerals on numeric values.

### Zone 2 — Left rail "Case workspace"
- `SegmentsList.tsx` uses raw Mantine `Badge` (BANNED — must use `EMRBadge`).
- `CascadeStageTimeline.tsx` uses raw Mantine `Badge` (BANNED — must use `EMRBadge`).
- Segment rows use inline `var(--emr-gray-200)` / `var(--emr-gray-300)` instead of semantic `--emr-border-color`.
- No hover affordance on segment rows.

### Zone 4 — Future Liver Remnant card (THE HERO)
- Uses `var(--emr-gray-50)` (BANNED — use `--emr-bg-hover`/`--emr-bg-card`).
- Uses `var(--emr-gray-200)` / `var(--emr-gray-300)` (BANNED for backgrounds/borders).
- 28.4% renders at `--emr-font-5xl` (32px) but feels generic — needs more weight, tabular numerals, threshold legend.
- No threshold legend ("Low < 30% / Borderline 30–40% / Adequate ≥ 40%") — surgeons need that mental anchor.

### Zone 5 — Structured Radiologic Readout
- Section titles lack visual anchor (icon, color rail).
- Rows blend — no row hover, no clear measurement vs. badge rhythm.
- Vessels image plain, no card framing or scale chrome.

### Cross-cutting violations summary

**Raw Mantine `Badge` (BANNED — must use EMRBadge):**
- `packages/app/src/emr/components/cases/SegmentsList.tsx`
- `packages/app/src/emr/components/cases/CascadeStageTimeline.tsx`

**Inline gray-N tokens (BANNED for surfaces/borders):**
- `FLRPanel.tsx`
- `SegmentsList.tsx`
- `CascadeStageTimeline.tsx`

## Implementation Order

1. Replace raw Mantine `Badge` with `EMRBadge` (Segments, CascadeTimeline).
2. Swap banned `gray-N` tokens for semantic ones.
3. Upgrade `FLRPanel` — bigger tabular numeral, threshold legend, polished tier indicator.
4. Upgrade `AnalysisDetailView.module.css` — larger hero title, tabular metrics, breathing.
5. Upgrade `ACRSection.module.css` — leading rail accent on section header, denser rows, hover, framed vessels image.
6. Upgrade `ACRStructuredReadout.module.css` — softer dividers, polished disclaimer footer.
7. Self-audit greps on all touched files.

## AFTER Screenshots
- Note: live API 404s on this analysis ID. AFTER verification confirms chrome / error
  state / theme tokens; data-driven zones rely on read-only visual change confirmation
  via theme token grep + structural review.
