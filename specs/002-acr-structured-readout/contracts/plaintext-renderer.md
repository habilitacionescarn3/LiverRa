# Contract — Plain-Text Renderer

**Feature**: 002-acr-structured-readout

Pure-function contract for the plain-text serializer that produces clipboard text from a `ReadoutSnapshot`. Same conceptual contract governs the PDF section builder's text layer to satisfy cross-channel parity (FR-024a).

---

## 1. Signature

```typescript
// packages/app/src/emr/services/report/acrPlainTextRenderer.ts
export function renderReadoutPlainText(snapshot: ReadoutSnapshot): string;
```

**Inputs**: `ReadoutSnapshot` (defined in `data-model.md` §2).
**Output**: a `string` ready for `navigator.clipboard.writeText(...)`.
**Side effects**: none (no I/O, no logging, no clock reads — `capturedAt` is on the snapshot).

A semantically identical Python function lives at `packages/ml-inference/src/services/export/acr_plaintext_renderer.py` and is unit-tested for byte-equivalence against the TS renderer for a fixed corpus of snapshots.

---

## 2. Output structure

```
--- {{localized RUO disclaimer}} ---

{{SECTION_HEADER_1}}
  {{Label}}: {{value with units}}{{<stale marker if any>}}
  {{Label}}: {{value with units}}
  {{warning indented under the line it applies to}}

{{SECTION_HEADER_2}}
  - {{itemId}} (segment {{n}}): {{summary}}
  - {{itemId}} (segment {{n}}): {{summary}}

...

{{SECTION_HEADER_6}}
  {{Label}}: {{value with units}}

--- {{localized RUO disclaimer}} ---
```

### Header casing rules

| Locale | Casing |
|---|---|
| `en` | ALL UPPER (e.g., `LIVER`) |
| `ru` | Cyrillic upper (e.g., `ПЕЧЕНЬ`) |
| `ka` | Georgian "Mtavruli" capital script when supported by the font, otherwise the standard Mkhedruli wrapped in brackets `[ ღვიძლი ]` — the choice is made by the medical-CODEOWNER reviewer on first pass; renderer reads it from the translation bundle as already-cased |
| `de` (legacy) | German upper (e.g., `LEBER`) |

In every locale, the header string read from the translation bundle is used verbatim — the renderer does NOT apply `toLocaleUpperCase()` programmatically (Georgian Mkhedruli has no uppercase form, so machine-uppercasing is wrong).

### Empty / computing / unavailable sections

```
LIVER
  No findings to report.
```

```
LIVER
  Computing — results will appear when the cascade completes.
```

The status line is the localized string from the `reportAcr.status.*` namespace.

### Stale-finding marker

A trailing `(last computed 2026-05-12 18:04 UTC)` is appended to the value of any stale row. Time is rendered in the active locale's `Intl.DateTimeFormat` short style; UTC offset is included for portability.

### Per-item lists (lesions, calcified findings, biliary cysts)

```
LESIONS
  - L1 (segment VIII): 89.6 mm, ICC pattern (confidence 88%)
  - L2 (segment IVa): 22.1 mm, simple biliary cyst
  - L3 (segment II): 11.4 mm, LR-M
  No further lesions detected.
```

Each row is on its own line. Maximum **zero** truncation — the renderer never elides items regardless of count (FR-013a).

### Warnings (degraded payloads)

A warning string is rendered indented two spaces below the field it applies to, prefixed `! `:

```
SPLEEN
  Volume: 18 mL
  ! Volumetry degraded: TotalSegmentator returned only 65 voxels.
```

### Partial-payload "Not available" markers

```
GALLBLADDER
  Volume: 75 mL
  Wall thickness: Not available
```

Per FR-009a: every expected field for the anatomical section is rendered; missing fields become explicit "Not available" entries; warnings remain attached to their identifying field.

---

## 3. Unicode normalization

Before returning the string, the renderer MUST call `value.normalize('NFC')` (TS) or `unicodedata.normalize('NFC', value)` (Python). This satisfies FR-013a for Georgian combining diacritics.

The output MUST NOT contain:
- Markdown syntax characters that surface as literal punctuation (`*`, `_`, `~`, backtick)
- HTML tags (`<`, `>`)
- Curly braces (`{`, `}`) outside the {{template substitution}} layer (which is consumed before render-time)
- Zero-width characters except where the active locale's script genuinely requires them

---

## 4. Locale resolution

Renderer accepts the snapshot's `locale` field, which has already been resolved client-side:

1. User-active locale (en/ru/ka/de)
2. If user-active locale is unsupported (e.g., `fr`), snapshot.locale is set to `en` and the audit-event locale is also `en` (FR-013, edge case).
3. Per-field translation lookup: try snapshot.locale → fall back to `en` if a key is missing. NEVER render a raw key.

---

## 5. Deterministic output guarantee

For a fixed `ReadoutSnapshot` input and a fixed translation bundle:
- Two invocations of the renderer return byte-equivalent strings.
- The order of sections is the fixed enum order from `data-model.md` §2.
- The order of rows within a section is stable: predefined field order (e.g., for `liver`: HU stats then steatosis), and per-item lists are sorted by `lesion_id` lexicographic ascending.
- No `Date.now()`, no `Math.random()`, no UUID generation inside the renderer.

This determinism is what enables the cross-channel parity test (FR-038-d) — TS renderer output, Python renderer output, and PDF section text (extracted via `pdfplumber` or equivalent) MUST be byte-equivalent for a fixed snapshot.

---

## 6. Reference golden output (en, completed analysis)

```
--- RESEARCH USE ONLY — NOT FOR PRIMARY DIAGNOSTIC USE ---

LIVER
  Volume: 1,828 mL
  Mean HU: 48 (p10 40, p90 56)
  Steatosis grade: Moderate (Δ liver–spleen = -15 HU)

LESIONS
  - L1 (segment VIII): 89.6 mm, ICC pattern (confidence 88%)
  - No further lesions detected.

VESSELS
  Not assessed.

GALLBLADDER
  Volume: 75 mL
  Wall thickness: 0.7 mm
  Stones detected: No

SPLEEN
  Volume: 18 mL
  ! Volumetry degraded: TotalSegmentator returned only 65 voxels.

FLR ASSESSMENT
  Plan: Right hepatectomy
  FLR: 518 mL (28.4%) — LOW
  Recommendation: consider PVE or ALPPS

--- RESEARCH USE ONLY — NOT FOR PRIMARY DIAGNOSTIC USE ---
```

This exact string is the expected output for the golden snapshot in `tests/unit/report/acrPlainTextRenderer.spec.ts` and `tests/unit/test_acr_plaintext_renderer.py`. Drift between the two implementations is a test failure.
