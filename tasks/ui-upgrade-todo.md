# UI Upgrade: Post-login Home + Global Header / Menu Chrome

## Files in scope
- `packages/app/src/emr/views/LandingView.tsx` + `LandingView.module.css`
- `packages/app/src/emr/EMRPage.tsx`
- `packages/app/src/emr/components/nav/EMRMainMenu.tsx` + `EMRMainMenu.module.css`
- `packages/app/src/emr/components/nav/UserMenuButton.tsx`

## Issues found

### Top bar (`EMRPage.tsx`)
- Plain solid card background with hard 1px bottom border — reads as flat / generic.
- Wordmark is a plain bold `Text` — no gradient, no letter-spacing, no "logo" treatment.
- No glass / saturated-blur surface; doesn't feel like an app shell.
- Home icon button lacks visual separation from the wordmark.

### Main menu (`EMRMainMenu`)
- Active state is a thick gradient block — heavy, overpowers a thin top bar.
- Hover background uses `--emr-hover-bg` which renders as a flat box, not a pill.
- No focus-ring using brand color cleanly.

### UserMenuButton
- Avatar is round but no ring, no shadow halo.
- Chevron icon is detached and tiny.

### LandingView hero
- Wordmark already has a gradient but reads as "text", not "brand mark". Too tight vertically.
- RUO chip is OK but pill shape feels slightly cramped.
- Mesh grid pattern is OK but contrast is low; no ambient spotlight under hero.

### Feature cards
- Icon halo flat with one alpha tint. Cards lift only slightly on hover.
- Top accent bar appears on hover only — feels like a hidden detail.

### Admin chips
- Flat single-line treatment; icons all the same muted color.
- No active/hover ring tint.

## Plan
1. `EMRPage.tsx` — glass top bar (backdrop blur, soft shadow), gradient wordmark wrapper, brand-tinted divider.
2. `EMRMainMenu.module.css` — replace heavy gradient active state with brand-tinted pill + persistent underline indicator; refine hover; mobile bottom-nav active-pill polish.
3. `UserMenuButton.tsx` — thin brand ring around avatar + soft outer shadow.
4. `LandingView.module.css` — bigger hero wordmark, ambient radial spotlight, polished feature card icon halo (gradient bg + brand icon), persistent subtle accent bar, polished admin chips, tightened footer.
5. `LandingView.tsx` — CSS-only changes; no structural edits.
