# UI Upgrade — Case Analysis Page

## BEFORE screenshots
- `screenshots/case-analysis-before/desktop.png`
- `screenshots/case-analysis-before/tablet.png`
- `screenshots/case-analysis-before/mobile.png` (stuck on 404 because mobile test couldn't click row — not a layout bug, just script limitation)

## Issues found
1. **Header + metrics strip stacked.** Two separate cards (PageHeader + CascadeStageTimeline summary). Should consolidate.
2. **Viewer cramped.** Center column is squeezed between fixed-width left drawer (320px) and fixed-width FLR rail (320px). On a 1440 viewport, viewer is only ~700px wide — should be the dominant zone.
3. **No theater-mode.** No way to focus on the viewer without being distracted by the rails.
4. **No collapsible rails.** Rails always full-width; no quick toggle.
5. **Mantine raw imports** in AnalysisDetailView: `Badge, Box, Group, Stack, Tabs, Text` from `@mantine/core` and `useMediaQuery` from `@mantine/hooks`. Must replace with EMR + native + custom hook.
6. **RUO disclaimer overlapping the FLR card** (orange banner peeking up at bottom-right of viewer).
7. **Mobile broken** — entire panel stack is 100% width vertical with no bottom-sheet handling for rails.
8. **No keyboard shortcut** for theater toggle.
9. **Hardcoded numeric values** (320, 280) in inline styles — fine, but flow them into CSS module + tokens.

## Plan (per file)

### New files
- [x] `packages/app/src/emr/hooks/useMediaQuery.ts` — minimal native hook
- [x] `packages/app/src/emr/components/common/EMRTabs.tsx` + `.module.css` — EMR tabs primitive (segmented-pill style, no Mantine)
- [x] `packages/app/src/emr/components/common/EMRBadge.tsx` + `.module.css` — small EMR badge
- [x] `packages/app/src/emr/components/common/EMRIconButton.tsx` + `.module.css` — square icon button (theater toggle, rail collapse)
- [x] `packages/app/src/emr/views/cases/AnalysisDetailView.module.css` — layout styles for the page

### Edits
- [x] `packages/app/src/emr/components/common/index.ts` — export EMRTabs, EMRBadge, EMRIconButton
- [x] `packages/app/src/emr/views/cases/AnalysisDetailView.tsx` — full rewrite of layout (no business-logic changes), removing all Mantine imports, adding theater mode, collapsible rails, unified header band, responsive bottom-sheets via `EMRBottomSheet`.
- [x] `packages/app/src/emr/translations/en/analysis.json` — add new keys (`detail.theater.enter`, `detail.theater.exit`, `detail.rails.collapse`, etc.) — only English; use `__TODO_TRANSLATE__` markers in `de/ka` later if needed. (CODEOWNERS rule = no medical translations from us — but layout-only labels like "Collapse" are not medical, so we add them.)

## Implementation steps
1. Create `useMediaQuery` hook.
2. Create EMR primitives (Tabs, Badge, IconButton).
3. Update common barrel `index.ts`.
4. Add new translation keys to `en/analysis.json` only.
5. Rewrite `AnalysisDetailView.tsx` and add CSS module.
6. AFTER screenshots.
