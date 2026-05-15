# UI Upgrade: SigninView

## BEFORE Screenshots
- Desktop (1440x900): `screenshots/fd-signin-BEFORE-desktop.png`
- Tablet (768x1024): `screenshots/fd-signin-BEFORE-tablet.png`
- Mobile (375x812): `screenshots/fd-signin-BEFORE-mobile.png`

## Issues Found
- Brand block floats with too much whitespace, card looks disconnected
- Title "Sign in to LiverRa" duplicates the giant LiverRa wordmark above
- No trust signals (HIPAA / GDPR / encrypted) — sign-in for hospital staff should radiate security
- Card is flat, lightweight — needs layered shadow + ring + better depth
- Inputs are too short for thumb comfort (~46px); should be ~50-52px
- Aurora is too subtle, disconnected from card
- "Back to home" footer is a lonely orphan link
- Help/support link is buried at bottom

## Implementation Plan
1. Add trust badge translation keys (en/ru/ka/de)
2. Redesign brand block: tighter, with trust chip row underneath
3. Remove redundant in-card title; replace with subtitle hierarchy
4. Stronger card treatment: layered shadow + subtle ring + 18px radius
5. Field height: 48-52px responsive
6. Refined aurora: dual radial halos that frame the card
7. Footer strip: region badge + back-to-home with arrow icon
8. Preserve: all data-testids, all handlers, all conditional logic, all i18n keys
