# Profile Page UI Upgrade — 2026-04-20

## Before Screenshots
- `screenshots/profile-before-desktop.png` (1440×900)
- `screenshots/profile-before-mobile.png` (375×812)

## Issues Found

### Raw Mantine form primitives
- `TextInput` (display name) and `Select` (language, theme) imported from `@mantine/core`.
- Raw `Badge` from `@mantine/core` used for Role and MFA status.

### Empty / weak UX in Account section
- Role badge shows `—` when role is missing (no colour coding by role family).
- "Last active" = plain "Never"; no empathetic copy for first-time users.
- No icons next to EMAIL / ROLE / LAST ACTIVE tiles; hard to scan.
- Email helper line is inline with the value — no visual separation.

### Preferences section
- Native `Select` doesn't surface the current label (see BEFORE screenshot — locale + theme inputs are empty).
- Theme is a plain dropdown; users expect a 3-way Light / Dark / System control.
- Save button only appears inline at bottom — no sticky hint of a dirty form.

### Security section
- Only one entry (MFA). Spec asks for Change Password and Active Sessions entries too (stubbed "Coming soon" is OK).
- "Research Use Only" pill is just a floating tooltip — not a clear compliance footer.

### Page header
- No avatar / initials, no full name, no email line, no "Edit profile" affordance.

## Implementation Tasks
1. [x] Replace raw Mantine `TextInput` with `EMRTextInput` (import from `components/shared/EMRFormFields`).
2. [x] Replace raw Mantine `Select` (locale) with `EMRSelect`.
3. [x] Replace theme `Select` with a 3-way tab/pill control using existing Mantine `UnstyledButton` + theme vars (no new lib).
4. [x] Role badge: colour-code by role family (admin=primary, compliance/dpo=warning, surgeon/radiologist=success, fellow=secondary).
5. [x] Account tiles: add left icon, separate helper row, empathetic "Welcome! First session." for Never.
6. [x] Page header: add avatar with user initials + gradient, full display name, email + role chips, a ghost "Edit profile" button that scrolls to Preferences.
7. [x] Security: add Change Password and Active Sessions rows with "Coming soon" badges.
8. [x] Add Research Use Only compliance footer pill.
9. [x] Add new translation keys to en/ru/ka/de profile.json (ru/ka/de get `__TODO_TRANSLATE__:` markers).
10. [x] Keep EMRErrorBoundary, EMRSkeleton, EMRAlert, EMRPageHeader, EMRButton as they are.

## Files Touched
- `packages/app/src/emr/views/settings/ProfileView.tsx` (rewrite body, keep structure)
- `packages/app/src/emr/translations/en/profile.json` (new keys)
- `packages/app/src/emr/translations/de/profile.json` (markers)
- `packages/app/src/emr/translations/ka/profile.json` (markers)
- `packages/app/src/emr/translations/ru/profile.json` (markers)

## Wrappers Used
All existing: EMRTextInput, EMRSelect, EMRButton, EMRAlert, EMRPageHeader, EMRSkeleton, EMRErrorBoundary.
No new wrappers needed — StatusBadge/EMRInfoCard not ported yet in LiverRa, so I render inline status chips using the same theme tokens (EMRPageHeaderBadge styling pattern).
