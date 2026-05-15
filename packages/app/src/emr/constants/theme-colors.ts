/**
 * Theme Color Constants for TypeScript
 *
 * Use this file ONLY when you need a literal color string in TypeScript /
 * JavaScript code — for example:
 *   - inline `style={{ color: ... }}` in a .tsx file where CSS variables
 *     can't reach
 *   - Cornerstone3D canvas labels (the WebGL canvas doesn't see CSS vars)
 *   - Chart libraries that require literal hex/rgb strings
 *
 * **Prefer `var(--emr-*)` in CSS modules** — those auto-switch for dark mode.
 * This file is light-mode values only.
 *
 * Values mirror `packages/app/src/emr/styles/theme.css`. The brand ramp
 * (THEME_COLORS.primary/secondary/accent/lightAccent) currently holds the
 * placeholder warm-gray ramp from `--liverra-primary-*`. When T464 (the
 * brand-ramp sign-off) lands, BOTH this file and theme.css must be updated
 * in the same commit.
 *
 * NEVER use Tailwind/Chakra/Facebook blues — see FORBIDDEN_COLORS below.
 *
 * @example
 * import { THEME_COLORS, STATUS_COLORS } from '../constants/theme-colors';
 *
 * // Inline style (where CSS vars are unavailable):
 * <Canvas labelColor={THEME_COLORS.primary} />
 *
 * // Status maps for chart data:
 * const colors = { 'in-progress': STATUS_COLORS.inProgress };
 */

// =============================================================================
// PRIMARY THEME COLORS
// =============================================================================

/**
 * Core brand colors — placeholder warm-gray ramp pending T464 sign-off.
 * Each value mirrors the same-named CSS variable in theme.css.
 */
export const THEME_COLORS = {
  /** Brand primary — deepest brand value. Mirrors `var(--emr-primary)` (alias of `--liverra-primary-700`). */
  primary: '#1a365d',

  /** Brand secondary — mid brand value. Mirrors `var(--emr-secondary)` (alias of `--liverra-primary-500`). */
  secondary: '#2b6cb0',

  /** Brand accent — lighter brand value, used for accents & focus. Mirrors `var(--emr-accent)` (alias of `--liverra-primary-400`). */
  accent: '#3182ce',

  /** Light accent — pale brand bg / hover tint. Mirrors `var(--emr-light-accent)` (alias of `--liverra-primary-100`). */
  lightAccent: '#bee3f8',

  /** White — inverse text, light surfaces. */
  white: '#ffffff',

  /** Primary text color (light mode). Mirrors `var(--emr-text-primary)`. */
  textPrimary: '#1f2937',

  /** Secondary text color (light mode). Mirrors `var(--emr-text-secondary)`. */
  textSecondary: '#6b7280',

  /** Inverse text — used on dark / gradient backgrounds. Mirrors `var(--emr-text-inverse)`. */
  textInverse: '#ffffff',
} as const;

// =============================================================================
// SEMANTIC COLORS (status / feedback)
// =============================================================================

/**
 * Semantic status colors. These are intentionally NOT part of the brand ramp —
 * they remain stable across brand swaps because their meaning (success/warning/
 * error) is universal.
 */
export const SEMANTIC_COLORS = {
  /** Success — completed, approved, positive. Mirrors `var(--emr-success)`. */
  success: '#38a169',
  successLight: '#c6f6d5',

  /** Warning — attention needed, pending review. Mirrors `var(--emr-warning)`. */
  warning: '#dd6b20',
  warningLight: '#feebc8',

  /** Error — failed, rejected, critical. Mirrors `var(--emr-error)`. */
  error: '#e53e3e',
  errorLight: '#fed7d7',

  /** Info — informational, neutral. Mirrors `var(--emr-info)`. */
  info: '#3182ce',
  infoLight: '#bee3f8',
} as const;

// =============================================================================
// SURFACE COLORS (light mode only)
// =============================================================================

/**
 * Surface colors for backgrounds, cards, modals. Light mode values only —
 * for components that need dark-mode-correct surfaces, use `var(--emr-bg-*)`
 * in a CSS module instead, since those auto-switch.
 */
export const SURFACE_COLORS = {
  /** Page background. Mirrors `var(--emr-bg-page)`. */
  page: '#ffffff',

  /** Card background. Mirrors `var(--emr-bg-card)`. */
  card: '#ffffff',

  /** Modal background. Mirrors `var(--emr-bg-modal)`. */
  modal: '#ffffff',

  /** Input background. Mirrors `var(--emr-bg-input)`. */
  input: '#ffffff',

  /** Hover state background. Mirrors `var(--emr-bg-hover)`. */
  hover: '#f7fafc',

  /** Default border color. Mirrors `var(--emr-border-color)`. */
  border: '#e5e7eb',
} as const;

// =============================================================================
// STATUS COLORS (for status maps & badge variants)
// =============================================================================

/**
 * Status color tokens for type-defined status indicators. Use these in
 * status-to-color maps instead of hardcoding Tailwind blues.
 *
 * @example
 * const STATUS_COLOR_MAP = {
 *   'pending':    STATUS_COLORS.pending,
 *   'in-progress':STATUS_COLORS.inProgress,
 *   'completed':  STATUS_COLORS.completed,
 * };
 */
export const STATUS_COLORS = {
  /** Pending / waiting. */
  pending: SEMANTIC_COLORS.warning,

  /** In progress / active — uses brand secondary, NOT Tailwind blue. */
  inProgress: THEME_COLORS.secondary,

  /** Completed / success. */
  completed: SEMANTIC_COLORS.success,

  /** Failed / error. */
  failed: SEMANTIC_COLORS.error,

  /** Cancelled / inactive. */
  cancelled: THEME_COLORS.textSecondary,

  /** Draft / new. */
  draft: '#9ca3af',

  /** Scheduled / upcoming — uses brand accent. */
  scheduled: THEME_COLORS.accent,

  /** Overdue / late. */
  overdue: SEMANTIC_COLORS.error,

  /** On hold / paused. */
  onHold: SEMANTIC_COLORS.warning,
} as const;

// =============================================================================
// GRADIENTS
// =============================================================================

/**
 * Gradient strings for CSS background properties.
 *
 * **Prefer `var(--emr-gradient-primary)` in CSS modules.** This export exists
 * only for TypeScript contexts (chart libs, canvas overlays).
 */
export const GRADIENTS = {
  /** Primary button gradient. Mirrors `var(--emr-gradient-primary)`. */
  primary: 'linear-gradient(135deg, #1a365d 0%, #2b6cb0 50%, #3182ce 100%)',

  /** Success gradient. */
  success: 'linear-gradient(135deg, #38a169 0%, #48bb78 100%)',

  /** Warning gradient. */
  warning: 'linear-gradient(135deg, #dd6b20 0%, #ed8936 100%)',

  /** Error gradient. */
  error: 'linear-gradient(135deg, #e53e3e 0%, #fc8181 100%)',
} as const;

// =============================================================================
// CHART COLORS
// =============================================================================

/**
 * Color series for charts and data visualization. Theme-consistent palette;
 * never use random / Tailwind colors for chart series.
 */
export const CHART_COLORS = {
  series: [
    THEME_COLORS.primary,    // 1 — brand primary
    THEME_COLORS.secondary,  // 2 — brand secondary
    THEME_COLORS.accent,     // 3 — brand accent
    SEMANTIC_COLORS.success, // 4
    SEMANTIC_COLORS.warning, // 5
    SEMANTIC_COLORS.error,   // 6
    '#805ad5',               // 7 — purple (approved accent)
    '#d69e2e',               // 8 — yellow (approved accent)
  ] as const,

  /** For positive / negative comparisons. */
  positive: SEMANTIC_COLORS.success,
  negative: SEMANTIC_COLORS.error,
  neutral: THEME_COLORS.textSecondary,
} as const;

// =============================================================================
// FORBIDDEN COLORS
// =============================================================================

/**
 * Tailwind / Chakra / Facebook blues that are banned in this codebase.
 * The frontend-designer agent runs a grep on every file it touches to flag
 * any of these. Exported here for linting + code-review tooling.
 */
export const FORBIDDEN_COLORS = [
  '#3b82f6', // Tailwind blue-500    → THEME_COLORS.secondary
  '#60a5fa', // Tailwind blue-400    → THEME_COLORS.accent
  '#2563eb', // Tailwind blue-600    → THEME_COLORS.primary
  '#93c5fd', // Tailwind blue-300    → THEME_COLORS.lightAccent
  '#1d4ed8', // Tailwind blue-700    → THEME_COLORS.primary
  '#4299e1', // Chakra blue-400      → THEME_COLORS.accent
  '#63b3ed', // Chakra blue-300      → THEME_COLORS.accent
  '#4267B2', // Facebook blue        → THEME_COLORS.secondary
  '#3b5998', // Facebook dark blue   → THEME_COLORS.primary
] as const;

/**
 * Forbidden-to-correct mapping. Useful for codemod / lint autofix tooling.
 */
export const FORBIDDEN_TO_CORRECT: Record<string, string> = {
  '#3b82f6': THEME_COLORS.secondary,
  '#60a5fa': THEME_COLORS.accent,
  '#2563eb': THEME_COLORS.primary,
  '#93c5fd': THEME_COLORS.lightAccent,
  '#1d4ed8': THEME_COLORS.primary,
  '#4299e1': THEME_COLORS.accent,
  '#63b3ed': THEME_COLORS.accent,
  '#4267B2': THEME_COLORS.secondary,
  '#3b5998': THEME_COLORS.primary,
};

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type ThemeColor = keyof typeof THEME_COLORS;
export type SemanticColor = keyof typeof SEMANTIC_COLORS;
export type SurfaceColor = keyof typeof SURFACE_COLORS;
export type StatusColor = keyof typeof STATUS_COLORS;
export type GradientName = keyof typeof GRADIENTS;
