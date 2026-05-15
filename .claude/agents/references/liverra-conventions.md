# LiverRa Project Conventions — Shared Reference

Fast-lookup extract of LiverRa's rules sourced from `/Users/toko/Desktop/LiverRa/CLAUDE.md`. Loaded on-demand by audit agents that need to verify code against project-wide conventions. Keep tight and scannable.

LiverRa is a CE MDR Class IIb SaMD for liver imaging. Regulatory traceability is non-negotiable.

---

## Theme Tokens & Forbidden Hex

**Source of truth:** `packages/app/src/emr/styles/theme.css`. Brand ramp = `--liverra-primary-50…900`; semantic tokens (`--emr-primary`, `--emr-secondary`, `--emr-accent`, `--emr-light-accent`) are aliased on top. T464 gates the brand-ramp swap pending design-lead sign-off — never edit ramp values without bumping `brand-tokens.md` status.

**Token categories:**
- **Brand:** `--emr-primary`, `--emr-secondary`, `--emr-accent`, `--emr-light-accent`
- **Surface (auto light/dark):** `--emr-bg-page`, `--emr-bg-card`, `--emr-bg-modal`, `--emr-bg-hover`, `--emr-bg-input`
- **Text:** `--emr-text-primary`, `--emr-text-secondary`, `--emr-text-inverse`
- **Status:** `--emr-success`, `--emr-warning`, `--emr-error`, `--emr-info`
- **Borders:** `--emr-border-color`, `--emr-border-default`
- **Alpha overlays:** `--emr-{primary,secondary,white}-alpha-N`

**Forbidden hex (zero tolerance — Tailwind/Chakra/Facebook blues that clash with the LiverRa palette):**
`#3b82f6`, `#60a5fa`, `#2563eb`, `#93c5fd`, `#1d4ed8`, `#4299e1`, `#63b3ed`, `#4267B2`, `#3b5998`

**Do NOT** use `--emr-gray-N` variables for backgrounds — numbering inverts between light/dark mode. Use surface tokens.

**TypeScript inline-style contexts only** (not CSS): `THEME_COLORS.*` / `STATUS_COLORS.*` from `packages/app/src/emr/constants/theme-colors.ts`.

---

## Dark Mode Architecture — The 7 Rules

1. NEVER hardcode dark hex values in CSS modules (e.g., `#1e293b`, `#334155`). Use `var(--emr-bg-card)`, `var(--emr-bg-hover)`, etc.
2. NEVER use dark-mode values as `var()` fallbacks — `var(--emr-bg-card, #1e293b)` is wrong; the variable is always defined, the fallback never fires.
3. NEVER use numeric fallbacks for theme variables — `var(--emr-font-sm, 12px)` is unnecessary.
4. Always use semantic `var(--emr-xxx)` variables — they auto-switch light/dark via `data-mantine-color-scheme`.
5. NEVER write `:root[data-mantine-color-scheme="dark"]` overrides in CSS modules. Dark mode is owned by `theme.css`; module-level overrides cause gray-scale inversion bugs.
6. NEVER use `--emr-gray-N` variables for backgrounds. The numbering inverts. Use semantic surface vars instead.
7. For progress bars / colored fills, use direct brand or semantic palette tokens (`var(--emr-success)`, `var(--emr-secondary)`) — intentional brand colors, not surfaces.

---

## Primary Button Gradient

ALL primary buttons MUST use:
```css
background: var(--emr-gradient-primary);
```
Definition lives in `theme.css` and follows the brand ramp. **Never inline the gradient hex** — when T464 lands and the ramp updates, gradients update automatically only if they use the token.

---

## EMR Component Library — Mantine → EMR* Mapping

**Source of truth:** `explanations/ui-component-library.md`.
**Locations:** 51 common components in `packages/app/src/emr/components/common/`, 21 form fields in `packages/app/src/emr/components/shared/EMRFormFields/`.

| Need | Use this | NOT this |
|---|---|---|
| Modal | `EMRModal` | `@mantine/core` Modal |
| Confirm dialog | `EMRConfirmationModal` | inline Modal |
| Bottom sheet | `EMRBottomSheet` | custom Drawer |
| Text input | `EMRTextInput` | `TextInput` |
| Textarea | `EMRTextarea` | `Textarea` |
| Number input | `EMRNumberInput` | `NumberInput` |
| Select | `EMRSelect` | `Select` |
| MultiSelect | `EMRMultiSelect` | `MultiSelect` |
| Autocomplete | `EMRAutocomplete` | `Autocomplete` |
| Checkbox | `EMRCheckbox` | `Checkbox` |
| Switch | `EMRSwitch` | `Switch` |
| Radio group | `EMRRadioGroup` | `Radio.Group` |
| Date picker | `EMRDatePicker` | `@mantine/dates` DatePicker |
| DateTime | `EMRDateTimePicker` | `DateTimePicker` |
| Time | `EMRTimeInput` | `TimeInput` |
| Color | `EMRColorInput` | `ColorInput` |
| Primary button | `EMRButton` | `Button` (with inline gradient) |
| Icon button | `EMRIconButton` | `ActionIcon` (when used as primary action) |
| FAB | `EMRFAB` | custom floating button |
| Table | `EMRTable` / `EMRVirtualTable` | `Table` (raw Mantine) |
| Page header | `EMRPageHeader` | custom header |
| Card | `EMRCard` | `Paper` (when used as card) |
| Badge | `EMRBadge` | `Badge` (as status indicator) |
| Alert | `EMRAlert` | `Alert` |
| Tabs | `EMRTabs` | `Tabs` |
| Breadcrumbs | `EMRBreadcrumbs` | `Breadcrumbs` |
| Empty state | `EMREmptyState` | custom div |

**Allowed raw Mantine layout primitives** (do NOT flag): `Box`, `Group`, `Stack`, `Text`, `Paper`, `Grid`, `Container`, `Flex`, `SimpleGrid`, `Center`, `Space`, `Divider`.

The `frontend-designer` agent runs a denylist grep flagging any `@mantine/core` or `@mantine/dates` import outside the allowed layout-primitive set.

**Known gaps:** check `explanations/ui-component-library.md` — `EMRTable` may not be ported everywhere; flag as tech debt rather than blocking work.

---

## EMRModal Usage

ALL modals MUST use `EMRModal` from `packages/app/src/emr/components/common/EMRModal.tsx`.

**Sizes:** `sm` (580px), `md` (780px), `lg` (980px), `xl` (1200px), `xxl` (95vw). Prefer `lg` or larger for any form with 4+ fields.

```tsx
<EMRModal
  opened={opened} onClose={onClose} size="lg"
  icon={IconEdit} title={t('title')} subtitle={name}
  cancelLabel={t('cancel')} submitLabel={t('save')}
  onSubmit={handleSubmit} submitLoading={loading}
>
  {/* Form fields only — EMR* components */}
</EMRModal>
```

---

## Unified Typography

NEVER hardcode font sizes. Use `theme.css` variables:
- Sizes: `--emr-font-xs` (11px) through `--emr-font-3xl` (24px)
- Weights: `--emr-font-normal` (400) through `--emr-font-bold` (700)

---

## Mobile-First Responsive

- Style for mobile first, enhance with media queries
- Min 44×44px tap targets, min 16px font on mobile (prevents iOS zoom)
- Mantine breakpoints: xs 576, sm 768, md 992, lg 1200, xl 1400
- Use Mantine responsive props: `span={{ base: 12, md: 6 }}`

**Flexbox text overflow rules:**
- Buttons/badges/pills: `flexShrink: 0` + `whiteSpace: 'nowrap'`
- Flex children with truncation (lineClamp / ellipsis): `minWidth: 0`
- `Group` with mixed content: `wrap="wrap"`, never `wrap="nowrap"` unless all children fit

**Mantine Button rules:**
- NEVER override `padding` on Button `root` — breaks internal label height
- Use `EMRButton` for standard cases
- For inline/compact: Mantine `size="compact-sm"` or `"sm"` — NEVER `"compact-xs"`

---

## i18n Locale Triad

- **Active: `en`, `ru`, `ka`.** English is source of truth.
- **`de` is retained-fallback** — preserved for legacy DACH bundles but NOT a launch target. Missing `de` keys are LOW.
- **`__TODO_TRANSLATE__:<en-value>`** markers in `ru`/`ka` are EXPECTED (pending CODEOWNERS medical review). NOT a finding.
- **Medical terminology in non-English files is CODEOWNERS-locked.** Never propose translation content without medical reviewer sign-off.
- **Locale support declared in TWO files — drift = HIGH:**
  1. `packages/app/src/emr/contexts/TranslationContext.tsx` — `Locale` type, `SUPPORTED_LOCALES`, `TRANSLATION_NAMESPACES`, bundle caches
  2. `packages/app/src/emr/services/localeService.ts` — `Locale` type, `SUPPORTED_LOCALES`, `INTL_TAG`
- Missing keys fall back automatically (`ru → en`, `ka → en`, `de → en`) — never crash.
- New namespaces must be registered in `TRANSLATION_NAMESPACES` in `TranslationContext.tsx`.

---

## FHIR Discipline

- **Base URL:** `http://liverra.ai/fhir`
- **Extension URL pattern:** `http://liverra.ai/fhir/StructureDefinition/[name]`
- **Constants source of truth:**
  - `packages/app/src/emr/constants/fhir-systems.ts` — `FHIR_BASE_URL`, `LIVERRA_IDENTIFIER_SYSTEMS`
  - `packages/app/src/emr/constants/fhir-extensions.ts` — all extension URL constants
  - `packages/app/src/emr/constants/fhir-identifiers.ts` — identifier helpers
- **Published StructureDefinitions** (source of truth for extension URLs):
  - `packages/fhirtypes/src/liverra/extensions/StructureDefinition-audit-chain-leaf-hash.json`
  - `StructureDefinition-audit-chain-sequence-no.json`
  - `StructureDefinition-audit-model-version.json`
  - `StructureDefinition-audit-permission-checked.json`
  - (plus others — read the directory at runtime for the live list)
- **Every `extension.url` literal in code MUST match a published StructureDefinition URL exactly.** Drift = HIGH.
- **Never hardcode FHIR URLs** in component/service code — import from the constants files.
- **Reference fields MUST include `reference`** (`{ reference: 'Patient/123', display: 'John' }`), not display-only.

---

## Audit Chain Pattern (Class IIb regulatory)

- **Frontend:** `packages/app/src/emr/services/pacs/auditService.ts` — fire-and-forget; non-blocking user actions.
- **Backend:** `packages/ml-inference/src/services/audit/chain_of_hashes.py` + `packages/ml-inference/src/services/fhir/audit_event_emitter.py` — co-write the chain row + FHIR AuditEvent in a SINGLE transaction, **fail-closed** per FR-029b.
- **BLOCKER:** any code that writes to the `audit_event_chain` table outside `AuditChainWriter`.
- **BLOCKER:** chain row written in a different transaction than the FHIR AuditEvent.
- AuditEvents MUST include `audit-chain-leaf-hash` + `audit-chain-sequence-no` extensions. Inference outputs MUST include `audit-model-version`. Access events MUST include `audit-permission-checked`.

---

## Model Licensing Discipline

**ALL ML models used commercially MUST have BOTH code AND weights under permissive licenses (Apache-2.0 / MIT / CC-BY-4.0).** See full table in CLAUDE.md "Model Licensing Discipline".

**FORBIDDEN weights on production paths (BLOCKER):**
- VISTA3D weights — NVIDIA OneWay Noncommercial (NCLS v1)
- MedSAM-2 weights — CC-BY-SA-4.0 research/education only
- LiLNet weights — don't exist publicly
- Pictorial-Couinaud weights — don't exist publicly
- TotalSegmentator subtask weights for `liver_vessels`, `liver_segments`, `liver_lesions` — paid commercial license required (internal demos OK behind an env flag; never a shipped default)

**Verified clean alternatives:**
- TotalSegmentator base `total` task — Apache-2.0 code + Apache-2.0 weights (parenchyma, spleen, gallbladder)
- STU-Net — Apache-2.0 code + Apache-2.0 weights (liver organ binary mask)
- BAMF aimi-liver-tumor-ct — MIT code + MIT weights (drop-in replacement for `liver_vessels`)
- LiverRa proprietary: Couinaud heuristic, LI-RADS rule classifier, segment-aware FLR

Every inference output MUST record its `model_version` (digest) into the audit chain.

---

## Critical Rules (Zero Tolerance)

- **No bulk file edits >3 files.** Max 3 files per batch; read full file before editing; use Edit tool, not sed/scripts.
- **No `tsc --noEmit` after code changes** unless explicitly requested — Vite/VS Code catch type errors in real time.
- **All UI work via the `frontend-designer` agent.** Never write UI code directly.
- **All FHIR work via the `fhir-developer` skill** for new endpoints.
- **FHIR identifier systems + extension URLs centralized** — never hardcode.

---

## Quick File-Path Anchors (for grep)

```
packages/app/src/emr/styles/theme.css                              # theme tokens
packages/app/src/emr/constants/fhir-systems.ts                     # FHIR base URL, identifiers
packages/app/src/emr/constants/fhir-extensions.ts                  # extension URL constants
packages/app/src/emr/constants/fhir-identifiers.ts                 # identifier helpers
packages/app/src/emr/constants/theme-colors.ts                     # TS inline-style theme tokens
packages/app/src/emr/contexts/TranslationContext.tsx               # Locale type + namespaces
packages/app/src/emr/services/localeService.ts                     # Locale type + INTL_TAG
packages/app/src/emr/components/common/                            # EMR* common components
packages/app/src/emr/components/shared/EMRFormFields/              # EMR* form fields
packages/app/src/emr/services/pacs/auditService.ts                 # frontend audit (fire-and-forget)
packages/ml-inference/src/services/audit/chain_of_hashes.py        # backend audit chain writer
packages/ml-inference/src/services/fhir/audit_event_emitter.py     # backend FHIR AuditEvent emitter
packages/fhirtypes/src/liverra/extensions/StructureDefinition-*.json  # published extensions
packages/app/src/emr/views/__e2e__/                                # existing E2E specs + fixtures
```
