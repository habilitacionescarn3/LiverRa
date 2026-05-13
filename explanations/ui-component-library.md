# LiverRa EMR UI Component Library

Technical reference for the standardized UI components used across the LiverRa application. This is the source of truth the `frontend-designer` agent reads before any UI work — it tells the agent what wrappers exist, what's still missing, and which Mantine components to replace with what.

**If a component you need isn't here, see [Known Gaps](#known-gaps) before reaching for a raw Mantine component.**

---

## Quick Reference

| Category | Count | Location |
|----------|-------|----------|
| **Common UI** | 28 components | `packages/app/src/emr/components/common/` |
| **Form Fields** | 18 components | `packages/app/src/emr/components/shared/EMRFormFields/` |
| **Calendar primitives** | 5 files | `packages/app/src/emr/components/shared/EMRFormFields/calendar/` |
| **Tables** | _missing_ | See [Known Gaps](#known-gaps) — use `Mantine Table` with theme tokens as interim, flag as tech debt |
| **Charts** | _no shared wrapper_ | Charts use raw libs (e.g., Recharts) with `CHART_COLORS.series` from `constants/theme-colors.ts` |

---

## Critical Rules

1. **Use EMR\* wrappers, never raw Mantine form/UI components.** The only Mantine imports allowed are layout primitives — see the [denylist](#banned-mantine-imports). Wrapping is what enforces consistent styling, accessibility, and dark-mode behavior.
2. **No hardcoded colors.** Hex values live in exactly one file: `packages/app/src/emr/styles/theme.css`. Everywhere else, reference `var(--emr-*)` in CSS or `THEME_COLORS.*` / `STATUS_COLORS.*` from `packages/app/src/emr/constants/theme-colors.ts` in TypeScript.
3. **Mobile-first responsive.** Style mobile first; enhance with `@media (min-width: ...)`. Min tap target 44×44 px, min font size 16 px (prevents iOS zoom).
4. **No dark-mode overrides in CSS modules.** Dark mode is owned entirely by `theme.css` — writing `:root[data-mantine-color-scheme="dark"]` in a module causes gray-scale inversion bugs. Use semantic surface vars (`--emr-bg-page`, `--emr-bg-card`, etc.) and let the variable switch.
5. **Accessibility minimums.** All interactive elements need a visible focus state, an accessible label or `aria-label`, and keyboard navigation. EMR\* wrappers already provide these — raw Mantine usage often skips them.

---

## Component Architecture

LiverRa's EMR components follow **two internal patterns**. When creating a new component, read the closest existing sibling and match its architecture.

| Pattern | Built With | Examples |
|---------|-----------|----------|
| **Custom-Built** | Only layout primitives (`Box`, `Popover`, `Text`). No Mantine form components inside. Full pixel control. | `EMRDatePicker`, `EMRDateTimePicker`, `EMRTabs`, `EMRCheckbox`, `EMRBottomSheet` |
| **Mantine Wrapper** | Wraps a Mantine component inside `EMRFieldWrapper` + `EMRFieldBaseProps`. Inherits Mantine's a11y, keyboard, and ARIA. | `EMRTextInput`, `EMRSelect`, `EMRSwitch`, `EMRNumberInput`, `EMRMultiSelect` |

**The custom calendar system.** Date/time pickers use a fully custom calendar — **never Mantine's `@mantine/dates` calendars**. `EMRCalendar` lives in `shared/EMRFormFields/calendar/` (5 files: `CalendarHeader`, `DayGrid`, `MonthGrid`, `YearGrid`, `utils`). `EMRDatePicker` and `EMRDateTimePicker` consume it via a `Popover`. All `@mantine/dates` imports are banned.

**When no wrapper exists.**

1. **Form field needed** → create a new file in `shared/EMRFormFields/` following the `EMRFieldWrapper` + `EMRFieldBaseProps` pattern; use `EMRTextInput.tsx` as the template. Export from `index.ts`.
2. **Date/time field needed** → use the `EMRCalendar` system; use `EMRDateTimePicker.tsx` as the template. Never wrap Mantine's date components.
3. **Generic UI element** → create a new file in `common/` with `EMR` prefix. Use theme variables only.
4. **Flag it** in your work summary: "NEW EMR COMPONENT CREATED: EMRFoo".

If a wrapper is too complex to build during the current task, flag it as tech debt rather than smuggling a raw Mantine import into the page.

---

## Mapping Table — Mantine → EMR\*

The agent's denylist grep relies on this table. Keep it in sync with `frontend-designer.md`.

| Instead of... | Use this | Import from |
|---|---|---|
| Mantine `Modal` | `EMRModal` | `../components/common` |
| Mantine `Tabs` | `EMRTabs` | `../components/common` |
| Mantine `SegmentedControl` | `EMRTabs` (`variant="pills"`, `grow`) | `../components/common` |
| Mantine `Button` | `EMRButton` | `../components/common` |
| Mantine `ActionIcon` (for primary actions) | `EMRIconButton` or `EMRFAB` | `../components/common` |
| Mantine `Badge` | `EMRBadge` | `../components/common` |
| Mantine `Alert` | `EMRAlert` | `../components/common` |
| Mantine `Card` | `EMRCard` | `../components/common` |
| Mantine `Breadcrumbs` | `EMRBreadcrumbs` | `../components/common` |
| Mantine `Skeleton` (form-shaped) | `EMRSkeleton` / `FormLoadingSkeleton` | `../components/common` |
| Mantine `Notification` / `Toast` | `EMRToast` / `EMRNotificationCenter` | `../components/common` |
| Mantine `Dropzone` | `EMRDropzone` | `../components/common` |
| Custom empty state | `EMREmptyState` | `../components/common` |
| Custom page header | `EMRPageHeader` | `../components/common` |
| Custom confirmation dialog | `EMRConfirmationModal` | `../components/common` |
| Mantine `TextInput` | `EMRTextInput` | `../components/shared/EMRFormFields` |
| Mantine `Textarea` | `EMRTextarea` | `../components/shared/EMRFormFields` |
| Mantine `NumberInput` | `EMRNumberInput` | `../components/shared/EMRFormFields` |
| Mantine `Select` | `EMRSelect` | `../components/shared/EMRFormFields` |
| Mantine `MultiSelect` | `EMRMultiSelect` | `../components/shared/EMRFormFields` |
| Mantine `Autocomplete` | `EMRAutocomplete` | `../components/shared/EMRFormFields` |
| Mantine `Checkbox` | `EMRCheckbox` | `../components/shared/EMRFormFields` |
| Mantine `Switch` | `EMRSwitch` | `../components/shared/EMRFormFields` |
| Mantine `Radio` / `RadioGroup` | `EMRRadioGroup` | `../components/shared/EMRFormFields` |
| Mantine `DatePicker` / `DateInput` | `EMRDatePicker` | `../components/shared/EMRFormFields` |
| Mantine `DateTimePicker` | `EMRDateTimePicker` | `../components/shared/EMRFormFields` |
| Mantine `TimeInput` | `EMRTimeInput` | `../components/shared/EMRFormFields` |
| Mantine `ColorInput` | `EMRColorInput` | `../components/shared/EMRFormFields` |

**Key API differences** when swapping Mantine → EMR\* (so behavior doesn't break):

| EMR Component | `onChange` Signature | Notes |
|---|---|---|
| `EMRTextInput` | `onChange(value: string)` | NOT event — pass value directly |
| `EMRSelect` | `onChange(value: string \| null)` | Same as Mantine Select |
| `EMRMultiSelect` | `onChange(value: string[])` | Same as Mantine MultiSelect |
| `EMRSwitch` | `onChange(checked: boolean)` | NOT event — pass boolean directly |
| `EMRCheckbox` | `onChange(checked: boolean)` | NOT event — pass boolean directly |
| `EMRNumberInput` | `onChange(value: number \| string)` | Same as Mantine NumberInput |

**Width control:** EMR components default to `fullWidth={true}`. For inline / filter usage, set `fullWidth={false}` and supply `style={{ width: N }}`.

---

## Banned Mantine Imports

**Rule: ONLY layout primitives may be imported directly from `@mantine/core`. Everything else must use an EMR\* wrapper.**

Safe layout primitives (OK to import from `@mantine/core`):

```
Box, Group, Stack, Text, Paper, Center, Flex, Grid, SimpleGrid, ScrollArea,
Skeleton, LoadingOverlay, Tooltip, ActionIcon, UnstyledButton, Collapse,
Popover, Menu, Divider, Container, Title, Anchor, Code, List, Image,
Accordion, Breadcrumbs, Card, CopyButton, Indicator, Kbd, Loader, Mark,
Notification, Pagination, Portal, Progress, RingProgress, ThemeIcon,
Timeline, Transition, VisuallyHidden, Avatar, Affix, FocusTrap, FileButton, Drawer
```

**ALL `@mantine/dates` imports are banned.** Use `EMRDatePicker`, `EMRDateTimePicker`, or `EMRTimeInput`.

Validation grep (the agent runs this on every file it touches):

```bash
# Should return ZERO matches
grep -rnE "from '@mantine/core'" [file] | grep -vE "(Box|Group|Stack|Text|Paper|Center|Flex|Grid|SimpleGrid|ScrollArea|Skeleton|LoadingOverlay|Tooltip|ActionIcon|UnstyledButton|Collapse|Popover|Menu|Divider|Container|Title|Anchor|Code|List|Image|Accordion|Breadcrumbs|Card|CopyButton|Indicator|Kbd|Loader|Mark|Notification|Pagination|Portal|Progress|RingProgress|ThemeIcon|Timeline|Transition|VisuallyHidden|Avatar|Affix|FocusTrap|FileButton|Drawer)"

# Should return ZERO matches
grep -rnE "from '@mantine/dates'" [file]
```

---

## Common Components (28)

`packages/app/src/emr/components/common/`

### Modals & dialogs

| Component | Purpose |
|---|---|
| `EMRModal` | Standardized modal dialog with gradient header. Sizes: `sm` (580 px), `md` (780 px), `lg` (980 px), `xl` (1200 px), `xxl` (95 vw). |
| `EMRConfirmationModal` | Confirmation dialog for destructive or important actions. |
| `SessionTimeoutModal` | Inactivity warning + extend-session prompt. |
| `EMRBottomSheet` | Mobile bottom sheet (slide-up modal) for touch-first interactions. |

### Buttons

| Component | Purpose |
|---|---|
| `EMRButton` | Primary button. Uses `var(--emr-gradient-primary)`. Variants: primary / secondary / danger / ghost / outline / subtle. |
| `EMRIconButton` | Icon-only button with tooltip and a11y label. |
| `EMRFAB` | Floating action button for mobile / dashboard quick actions. |

### Cards & display

| Component | Purpose |
|---|---|
| `EMRCard` | Generic content card container with consistent padding, border, shadow. |
| `EMRBadge` | Status badge with semantic variants. |
| `EMRAlert` | Banner / inline alert with semantic variants. |
| `EMRErrorCard` | Larger error display with optional retry action. |
| `EMRPageHeader` | Page title with icon, subtitle, optional badge + action area. |
| `EMRBreadcrumbs` | Breadcrumb navigation trail. |
| `EMREmptyState` | Standard empty / no-data state with optional CTA. |

### Tabs & navigation

| Component | Purpose |
|---|---|
| `EMRTabs` | Tab navigation with animated indicator. Replaces Mantine `Tabs` and `SegmentedControl`. |

### Progress / steppers

| Component | Purpose |
|---|---|
| `EMRProgressStepper` | Linear multi-step progress indicator. |
| `EMRWizardStepper` | Wizard-style stepper with active / completed / pending states. |

### State, loading, skeletons

| Component | Purpose |
|---|---|
| `EMRSkeleton` | Generic skeleton loader. |
| `EMRTableSkeleton` | Skeleton specifically shaped like a data table. |
| `EMRTableEmptyState` | Empty-state row for table contexts. |
| `FormLoadingSkeleton` | Skeleton shaped like a form section. |

### Error handling

| Component | Purpose |
|---|---|
| `EMRErrorBoundary` | React error boundary with theme-styled fallback. |
| `FormErrorBoundary` | Form-context error boundary that preserves draft state when possible. |
| `FailClosedErrorStates` | Fail-closed error UI for compliance-critical surfaces (Research Use Only, audit-required flows). |

### File / upload

| Component | Purpose |
|---|---|
| `EMRDropzone` | DICOM / file upload zone with drag-and-drop. |

### Toasts / notifications

| Component | Purpose |
|---|---|
| `EMRToast` | Single toast notification. |
| `EMRNotificationCenter` | Stacked toast / notification center for the app shell. |

### Mobile

| Component | Purpose |
|---|---|
| `MobileFormWrapper` | Mobile-optimized form container with safe-area padding, sticky CTAs, larger tap targets. |

---

## Form Fields (18)

`packages/app/src/emr/components/shared/EMRFormFields/`

### Text inputs

| Component | Purpose |
|---|---|
| `EMRTextInput` | Single-line text. Use for all text-style fields. |
| `EMRTextarea` | Multi-line text. |
| `EMRNumberInput` | Numeric with stepper buttons. |
| `EMRColorInput` | Color picker (uses theme palette as defaults). |

### Selection

| Component | Purpose |
|---|---|
| `EMRSelect` | Single-select dropdown. |
| `EMRMultiSelect` | Multi-select dropdown. |
| `EMRAutocomplete` | Searchable single-select with custom-text input. |
| `EMRVirtualSelect` | Virtualized select for large option lists (1k+). |

### Boolean

| Component | Purpose |
|---|---|
| `EMRCheckbox` | Checkbox. `onChange(checked: boolean)`. |
| `EMRSwitch` | Toggle switch. `onChange(checked: boolean)`. |
| `EMRRadioGroup` | Radio option group. |

### Date / time

| Component | Purpose |
|---|---|
| `EMRDatePicker` | Date input + custom calendar in `Popover`. Apple-style, never `@mantine/dates`. |
| `EMRDateTimePicker` | Date + time combined input. |
| `EMRTimeInput` | Time-only picker. |

### Form structure & wrappers

| Component | Purpose |
|---|---|
| `EMRFieldWrapper` | Label + hint + error wrapper used by all field components. Use this when building a new wrapper. |
| `EMRFormSection` | Grouped form section with title and optional description. |
| `EMRFormRow` | Multi-column field layout (responsive). |
| `EMRFormActions` | Standardized submit / cancel button bar. |
| `EMRFieldTypes.ts` | Shared TypeScript prop interfaces. Reference, not a rendered component. |

---

## Known Gaps

Components that exist in MediMind but **not yet in LiverRa**. When you encounter the need, prefer flagging tech debt over smuggling a raw Mantine import.

| Gap | Workaround until ported |
|---|---|
| `EMRTable` / `EMRVirtualTable` | Use Mantine `Table` with `var(--emr-*)` theme tokens for colors and borders. Flag for porting. |
| `EMRContentSection` / `EMRCollapsibleSection` | Compose `EMRCard` + `Group` (Mantine layout primitive) + `Collapse` for now. |
| `EMRStatCard` / `EMRStatCardGroup` | Compose `EMRCard` + `Text` (Mantine primitive) for KPI tiles. |
| `EMRSearchFilterSection` | Compose `EMRTextInput` + `EMRSelect` + `EMRButton` in a `Group`. |
| `EMRCircularGauge` | Use Mantine `RingProgress` (layout-primitive list) with `var(--emr-success/warning/error)`. |
| `EMRAddButton` / `EMRDeleteButton` | Use `EMRButton variant="primary"` with an icon prop / `variant="danger"` respectively. |
| `EMRActionButtons` (table-row action group) | Compose `EMRIconButton`s in a `Group`. |
| `EMRCodeBadge` (ICD-10 / NCSP / LOINC style) | Use `EMRBadge` with monospace font from `var(--emr-font-mono)` for now. |
| Mantine `DatePickerInput` | No wrapper yet. Flag as tech debt. |

---

## Import Patterns

```tsx
// Common components — barrel export
import { EMRModal, EMRButton, EMRCard, EMRBadge, EMRPageHeader } from '../components/common';
import { IconEdit } from '@tabler/icons-react';

// Form fields — barrel export
import {
  EMRTextInput,
  EMRSelect,
  EMRDatePicker,
  EMRCheckbox,
  EMRFormSection,
} from '../components/shared/EMRFormFields';

// Layout primitives (allowed from Mantine)
import { Box, Group, Stack, Grid } from '@mantine/core';

// Color constants (TypeScript inline-style contexts only)
import { THEME_COLORS, STATUS_COLORS } from '../constants/theme-colors';
```

**The path depth (`../`) depends on where the consuming view lives.** From `emr/views/cases/AnalysisDetailView.tsx`, it's `../../components/common`. From a colocated section module, it may be `../components/common`. Use the editor's auto-import — never hand-type the path.

---

## Source of truth pointers

| Question | File |
|---|---|
| What does this color resolve to? | `packages/app/src/emr/styles/theme.css` |
| What hex should I use in inline styles? | `packages/app/src/emr/constants/theme-colors.ts` |
| Which Mantine imports are banned? | This file → [Banned Mantine Imports](#banned-mantine-imports) |
| What's the EMR\* equivalent of this Mantine component? | This file → [Mapping Table](#mapping-table--mantine--emr) |
| What are the dark-mode rules? | `CLAUDE.md` → "Dark Mode Architecture (CRITICAL — 7 rules)" |
| How does the agent self-audit? | `.claude/agents/frontend-designer.md` → Phase 5b |
