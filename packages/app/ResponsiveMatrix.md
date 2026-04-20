# LiverRa Responsive Matrix (per-view breakpoint behavior)

> **Plain-English summary.** Each row is one screen in the app. Each
> column is a screen-size class (smallest phone up to largest desktop).
> The cell says what the layout looks like at that size, how the menu
> works, and anything special (touch gestures, WebGPU fallback, etc.).
> Frontend engineers use this as the spec when styling a view;
> `visual-regression.spec.ts` enforces screenshots per breakpoint.

## Breakpoints

Mantine breakpoints (see `theme.css`):

| Name | Min width | Canonical target device |
|---|---|---|
| `xs` | < 576 px | Small phones (iPhone SE portrait 375 px) |
| `sm` | ≥ 576 px | Large phones / phablets (414 px landscape, 576 portrait) |
| `md` | ≥ 768 px | Tablets (iPad portrait 768 px) |
| `lg` | ≥ 992 px | Small desktops / tablets landscape |
| `xl` | ≥ 1200 px | Desktops / wide monitors (1440 px target) |

Tap-target minimum: **44 × 44 px** on `xs`/`sm`, **40 × 40 px** from `md` up.

Font scale is `clamp`-based on `--emr-font-*` tokens; values below are
the **effective** sizes for body copy on that breakpoint.

---

## Per-view matrix

| View | xs (< 576) | sm (576) | md (768) | lg (992) | xl (1200) | Special behaviors |
|---|---|---|---|---|---|---|
| **LoginView** | Stacked; logo + form full-width; 16 px body; 48 px inputs | Stacked; max 420 px centered; 16 px | 2-col (hero illustration left, form right); 16 px | Same as md; 420 px form col | Same as lg, stronger hero | Locale switcher top-right at all sizes; Georgian Noto Sans subset preloaded |
| **CasesListView** | 1-col list; filter drawer (bottom-sheet); hamburger nav; 16 px | Same as xs; filter pill row pinned top | 2-col (filter sidebar 280 px + list); 15 px | 3-col (filter + list + preview pane); 14 px | Same as lg with wider preview | Virtualized list (TanStack Virtual) at all sizes; search focuses on `/` key md+ |
| **AnalysisDetailView** | 1-col tabs (viewer / FLR / lesions / report); hamburger nav; viewer full-bleed; touch gestures: pinch-zoom, 1-finger pan, 2-finger rotate | Same as xs with larger tab labels | Viewer full-width + collapsible right panel (FLR + lesions); sidebar toggled | Sidebar open, 3-col (nav / viewer / right panel); viewer minimum 680 × 680 | Same as lg; right panel widens to 400 px | **WebGPU fallback**: if WebGPU unavailable, Cornerstone3D WebGL path + notice banner; touch rotate disabled < md (confusing on phone) |
| **ReportView** | 1-col scroll; PDF embed falls back to inline HTML at xs (iOS PDF embed fails); 16 px | Same as xs with 2-col summary cards | PDF embed + metadata sidebar (320 px); 15 px | Same as md with TOC column left | Full 3-col: TOC / PDF / metadata | RUO watermark overlay on every breakpoint; download/print buttons always visible as floating action on xs/sm |
| **OpsQueueView** | 1-col cards; swipe to archive (right) / retry (left); 16 px | Same as xs, cards 2-wide | Table with sticky header; 14 px; inline actions | Same as md with filter sidebar | Same as lg; add analytics sparkline column | Polling every 10 s with pause-on-tab-hidden; SSE stream for live updates from md+ |
| **ErasureWizardView** | Full-screen dialog pattern (EMRModal); step indicator top; 16 px | Same as xs; step indicator horizontal | 2-col (steps sidebar + content); 15 px | Same as md; sidebar 280 px | Same as lg, content max-width 720 px | Confirmation requires 2-factor re-auth + checkbox; Escape disabled on final step; crypto-shred progress announced via aria-live |
| **MBoMView** | 1-col accordion of model cards; 16 px | 2-col card grid; tap reveals license badge | Data table with expandable rows; 14 px | Same as md; right panel shows SBOM attestation | Same as lg; add dependency graph column | License column uses SPDX badges; CI job `ci-license-check` blocks non-Apache-2.0 |
| **DashboardView** | 1-col stat cards stacked; 16 px | 2-col stat grid | 3-col stat grid + recent cases list | 4-col stat grid + widgets | Same as lg with widget drawer | Charts use Cornerstone3D / ECharts-lite; CVD-safe palette from `theme.css` |
| **SettingsView** | Tabs become dropdown select (saves space); 16 px | Same as xs | Horizontal tabs + form content; 15 px | Vertical tab rail + form; 14 px | Same as lg | Tenant switcher hidden on xs (long names); surfaced md+ |
| **PACSPushPanel (modal)** | Full-screen modal; 16 px | Same as xs | Centered modal 640 × 720 max | Same as md | Same as md | Destination autocomplete; live C-STORE progress via SSE; assertive aria-live on failure |
| **AuditBrowserView** | 1-col virtualized feed; date-grouped; 16 px | Same as xs | 2-col (filters + feed); 14 px | 3-col (filters + feed + detail) | Same as lg | Search debounced 300 ms; keyboard shortcut `/` focus search md+ |
| **ClaimRegistryView** | 1-col cards with key stats; 16 px | 2-col cards | Table + pagination; 14 px | Same as md with filter sidebar | Same as lg; add "export CSV" action | Export respects RUO — CSV header includes RUO banner per SC-009 |

---

## Navigation behavior

| Breakpoint | Nav style | Notes |
|---|---|---|
| xs / sm | Hamburger → drawer (Mantine `AppShell.Navbar` collapsed + `Burger`) | Drawer covers 85% viewport width; backdrop closes |
| md | Collapsible sidebar (icons + labels); 240 px expanded, 64 px collapsed | User preference persisted per-device |
| lg / xl | Sidebar always expanded, 280 px | User may toggle to collapsed mode |

Skip-to-content link is present on **every** breakpoint (`2.4.1`).

---

## Touch & gesture routing

- LiverViewer3D gestures enabled only on `md+` (tablet size up) because
  precision pinch-rotate confuses 1-hand phone use. On xs/sm the viewer
  uses discrete on-screen buttons.
- DICOM Dropzone supports paste + drag-drop on all breakpoints; tap
  opens native file picker.
- Long-press is never the sole path for destructive actions (2.5.7).

---

## WebGPU / rendering fallback

| Device class | Default renderer | Fallback |
|---|---|---|
| Desktop with WebGPU flag | WebGPU (Cornerstone3D experimental) | WebGL2 |
| Desktop without WebGPU | WebGL2 | Cornerstone2D MPR only (degraded banner) |
| Tablet (iPadOS 17+) | WebGL2 | Cornerstone2D MPR only |
| Phone | Cornerstone2D MPR only; no 3D | Static report-only view |

Fallbacks surface a banner linking to `docs/runbooks/viewer-fallback.md`
(future runbook — not yet required).

---

## Enforcement

- `packages/app/tests/visual/responsive-sweep.spec.ts` captures
  screenshots at widths 375 / 576 / 768 / 992 / 1440 for every route in
  the routing table and diffs against golden snapshots.
- `tests/visual/dark-mode-sweep.spec.ts` (T462) repeats the sweep for
  dark mode.
- Axe-core sweep (T371) runs at the xs width to catch tap-target
  regressions.

## Update rule

Any new route or view **must** add a row here before merging. The
responsive sweep test hard-fails on "route visible but not listed".
