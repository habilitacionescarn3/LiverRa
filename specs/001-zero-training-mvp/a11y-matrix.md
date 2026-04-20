---
doc: a11y-matrix
owner: Frontend lead + accessibility reviewer
status: active
wcag_target: 2.1 AA
last_updated: 2026-04-19
enforced_by:
  - packages/app/tests/a11y/component-aria.spec.ts (T465)
  - packages/app/tests/a11y/route-sweep.spec.ts (T371)
  - packages/app/tests/a11y/viewer-keyboard-nav.spec.ts (T458)
---

# LiverRa Per-Component ARIA Matrix

> **Plain-English summary.** Each row tells a screen-reader user what a
> component is (role), what extra attributes it must expose, how to
> drive it from the keyboard, and what it announces when things change.
> Tests in `component-aria.spec.ts` (T465) read this table row-by-row
> and assert the live component matches.

## Conventions

- All interactive controls expose a visible `focus-visible` ring using
  `var(--emr-focus-ring)`.
- Min tap target 44 × 44 px (Mantine breakpoints, §Mobile & touch).
- Live regions use `aria-live="polite"` for routine updates and
  `aria-live="assertive"` for alerts (RUO warnings, C-STORE failures).
- All non-decorative icons have `aria-label` or sibling `<VisuallyHidden>`.
- Screen-reader language switches via `lang` attribute per i18n locale.

---

## Matrix (14 components)

| # | Component | Role | ARIA attributes required | Keyboard shortcuts | Screen-reader announcement template | WCAG 2.1 AA test requirements |
|---|---|---|---|---|---|---|
| 1 | **ResectionPlaneSlider** | `slider` | `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, `aria-valuetext` (mm + FLR %), `aria-label="Resection plane position"`, `aria-orientation="horizontal"` | Left/Right = ±1 mm, PageUp/PageDown = ±10 mm, Home/End = min/max | "Resection plane at 42 millimeters, future liver remnant 32 percent" | 1.3.1, 1.4.3 contrast on thumb, 2.1.1 keyboard, 4.1.2 name/role/value |
| 2 | **LiverViewer3D** | `application` + nested `img role="img"` for each viewport | `aria-label="3D liver analysis viewer"`, `aria-roledescription="medical image viewer"`, per-viewport `aria-label` (axial/coronal/sagittal/3D), `aria-describedby` pointing to current MPR info text | Tab focuses viewer, Arrows rotate 3D / scroll 2D slices, `+`/`-` zoom, `L` toggle layers, `R` reset camera, `Escape` exits focus | "3D liver viewer, axial slice 128 of 256, liver parenchyma overlay visible" | 1.3.1, 2.1.1, 2.1.2 no keyboard trap, 2.4.7 focus visible, 4.1.2 |
| 3 | **LesionList** | `table` with `aria-rowcount`, `aria-colcount` | Each row is `role="row"` + `aria-selected`, per-cell `role="gridcell"`, column headers expose sort direction via `aria-sort`, list has `aria-label="Lesion list"` | Up/Down arrows navigate rows, Enter activates row (selects lesion in viewer), `S` toggles sort, `Space` multi-select | "Lesion 3 of 7 selected, segment VIII, 18 millimeters, HCC probability 0.87" | 1.3.1 info-relationships, 2.1.1, 2.4.3 focus order, 4.1.2 |
| 4 | **FLRPanel** | `region` with `aria-labelledby` | Header `<h2 id="flr-heading">`, container `aria-live="polite"`, numeric outputs wrapped in `<output>` with `aria-label` ("Remnant volume", "Remnant-to-body-weight ratio") | Tab moves between read-only outputs; no shortcuts (read-only) | "Future liver remnant updated: 32 percent of total liver volume, 612 milliliters, RLBWR 0.81" | 1.3.1, 1.4.3 contrast of warning thresholds, 4.1.3 status messages |
| 5 | **CouinaudLegend** | `list` of `listitem` | Container `aria-label="Couinaud segment legend"`, each item `aria-label="Segment VIII, color …, volume 142 milliliters"`; segment-II sample swatch has `role="img"` with `aria-label` describing hex name | Tab between items, Enter highlights segment in viewer, `H` toggles highlight | "Segment VIII highlighted, 142 milliliters, 18 percent of total liver volume" | 1.3.1, 1.4.11 non-text contrast (3:1 for swatches), 1.4.1 color not sole indicator (labels) |
| 6 | **FinalizeWizard** | `dialog` with `aria-modal="true"` | `aria-labelledby` → wizard step heading, `aria-describedby` → step description, each step is `region` with ordered `aria-posinset` + `aria-setsize`, validation errors use `aria-invalid` + `aria-errormessage` | Tab/Shift+Tab within dialog, Enter = next, `Escape` = cancel with confirm, Left/Right between steps when valid | "Finalize report, step 2 of 4: sign with CMS, press Enter to continue or Escape to cancel" | 2.1.2 focus trap, 2.4.3 focus order, 3.3.1 error identification, 4.1.2 |
| 7 | **MBoMTable** | `table` with `aria-label="Model Bill of Materials"` | Column headers `scope="col"`, row headers `scope="row"` for model name column, cells with license badges use sibling `<VisuallyHidden>` ("Apache 2.0"), `aria-sort` on sortable columns | Tab to table, arrow keys navigate cells, `Enter` expands row to model card | "STU-Net parenchyma model, version 1.4.2, Apache 2.0 license, last updated April 10" | 1.3.1 info-relationships, 1.4.11 badge contrast, 2.1.1, 4.1.2 |
| 8 | **DicomDropzone** | `button` + drop target | `aria-label="Upload DICOM study, drag and drop or press Enter to browse"`, `aria-describedby` → format hints, `aria-busy` during upload, upload progress via `progressbar` with `aria-valuenow`/`aria-valuetext` | Tab to focus, Enter/Space opens file picker, paste supported | "Uploading 243 of 512 images, 47 percent" | 1.3.1, 2.1.1, 2.5.8 tap target ≥ 44 px, 4.1.3 status |
| 9 | **SegmentsLayer** | `group` inside LiverViewer3D toolbar | `role="group"`, `aria-label="Couinaud segment overlay toggles"`, each toggle is `switch` with `aria-checked` | Tab between toggles, Space toggles, shortcut `1-8` toggles segment I-VIII | "Segment IV-a overlay enabled" | 1.3.1, 1.4.1 color not sole indicator (icon + text), 2.1.1, 4.1.2 |
| 10 | **VesselsLayer** | `group` inside LiverViewer3D toolbar | `role="group"`, `aria-label="Vessel overlay toggles"`, each toggle is `switch` with `aria-checked` (portal vein, hepatic vein, artery, IVC), tooltip with `aria-describedby` for vessel anatomical description | Tab between toggles, Space toggles, shortcuts `P`/`H`/`A`/`I` | "Portal vein overlay enabled, red color" | 1.4.1, 1.4.11, 2.1.1, 4.1.2 |
| 11 | **PACSPushPanel** | `region` with `aria-labelledby="pacs-push-heading"` | Status badge is `status` (implicit `aria-live="polite"`), destination select has `aria-label="Destination PACS node"`, push button announces result via `aria-live="assertive"` on failure | Tab between controls, Enter on push button triggers C-STORE | "C-STORE to OrthancTest succeeded, 512 instances stored" / "C-STORE failed, retrying in 30 seconds" | 4.1.3 status messages, 3.3.1 error identification, 2.1.1 |
| 12 | **ClaimRegistryView** | `table` with filter `form` above | Table `aria-label="Claim registry"`, filter form `aria-label="Filter claims"`, pagination `nav` with `aria-label="Pagination"`, each claim row links to detail via `aria-describedby` for current status | Tab between filters, Arrow keys on table, Enter opens claim detail | "Showing claims 1 to 25 of 142, filtered by status approved" | 1.3.1, 2.4.4 link purpose, 4.1.2 |
| 13 | **AuditBrowserView** | `feed` or `table` | Container `role="feed"` with `aria-busy` during load, each event is `article` with `aria-labelledby` → event summary, timestamps machine-readable via `<time datetime>` | Tab to browse, PageUp/PageDown jumps 10 events, `/` focuses search | "Audit event 12 of 847: model_run, 2026-04-19 14:02 UTC, user toko" | 1.3.1, 2.4.3 focus order, 4.1.2, 4.1.3 |
| 14 | **RUODisclaimer** | `alert` (persistent) with `role="note"` on repeat banners | Primary modal instance is `alert` announced on first render; dismissible banner is `note` with close button `aria-label="Dismiss research-use-only notice for this session"`; text includes regulatory disclaimer + link to MBoM | Tab to close button, Enter/Space dismisses | "Research Use Only: outputs are not approved for primary diagnosis. Press Tab to continue or Enter to dismiss." | 1.4.3 contrast, 2.1.1, 4.1.3, 3.2.5 no surprise navigation |

---

## Shared acceptance checks (applied to every row)

1. Color is never the sole indicator (1.4.1) — pair with icon/text/pattern.
2. Minimum tap target ≥ 44 × 44 px (2.5.8 / 2.5.5).
3. Focus indicator ≥ 3:1 contrast with adjacent (1.4.11).
4. Keyboard-reachable within the document tab order (2.1.1, 2.4.3).
5. No time limits without pause/stop/extend option (2.2.1).
6. Live-region changes never steal focus (3.2.5).
7. i18n: `lang` attribute follows `localeService` current locale; Georgian
   Unicode renders via Noto Sans subset without `.notdef` boxes.

## Automation

- **T465** iterates each row, mounts the component in isolation with
  seeded props, and asserts `role`, every listed ARIA attribute, keyboard
  shortcuts via `page.keyboard.press`, and live-region announcement via
  `page.locator('[aria-live]').textContent()`.
- **T458** covers the specific viewer keyboard story in depth.
- **T371** sweeps every route for axe-core violations (route-level twin).

## Update rules

- Adding a new interactive component to the app **requires** a row here
  before merge.
- PRs that touch `packages/app/src/emr/components/**/*.tsx` and lack a
  matching row update must include a waiver comment referencing this
  file.
