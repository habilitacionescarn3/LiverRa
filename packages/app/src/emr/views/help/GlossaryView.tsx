// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * GlossaryView — clinical terminology reference (T105 / help shell).
 *
 * Plain-English: a searchable reference page listing every clinical term
 * LiverRa uses — Couinaud segments, vessels, lesion classes, CT phases,
 * abbreviations. Think of it as an in-app medical dictionary so a surgeon
 * or radiologist can look up "what does segment III mean again?" without
 * leaving the workflow.
 *
 * All content is driven by the `glossary` translation namespace — NO
 * hardcoded clinical strings live in this file. The structure is fixed
 * (categories × term keys) but every visible name/latin/role/abbr string
 * flows through `t()` so translators can localise.
 *
 * Features:
 *   - Debounced search (200ms) across name / Latin / role / abbr
 *   - Category filter (All / Couinaud / Vessels / Lesions / Phases / Abbr.)
 *   - Accordion rows (Mantine handles ARIA)
 *   - Deep-link anchors: `/help/glossary#couinaud-III`
 *   - Empty state with "Clear filter" CTA
 *   - Respects `prefers-reduced-motion` (accordion transitionDuration=0)
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Accordion,
  Box,
  Group,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedValue, useMediaQuery, useReducedMotion } from '@mantine/hooks';
import { IconBook, IconSearch, IconX } from '@tabler/icons-react';

import {
  EMRErrorBoundary,
  EMRPageHeader,
  EMRTableEmptyState,
} from '../../components/common';
import { useTranslation } from '../../contexts/TranslationContext';

// ---------------------------------------------------------------------------
// Static term-key structure
// ---------------------------------------------------------------------------
//
// We list only the *keys* here — every human-readable string is pulled from
// the translation bundle at render time. If a translator adds/removes a key
// in `glossary.json`, update this table and the UI will follow.
//
// Keys mirror `packages/app/src/emr/translations/en/glossary.json`.

type GlossaryCategory =
  | 'couinaud'
  | 'vessels'
  | 'lesions'
  | 'phases'
  | 'abbreviations';

const CATEGORY_ORDER: readonly GlossaryCategory[] = [
  'couinaud',
  'vessels',
  'lesions',
  'phases',
  'abbreviations',
] as const;

const TERM_KEYS: Record<GlossaryCategory, readonly string[]> = {
  couinaud: ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'],
  vessels: ['portal', 'hepatic'],
  lesions: ['hcc', 'icc', 'metastasis', 'fnh', 'hemangioma', 'cyst'],
  phases: ['native', 'arterial', 'portal', 'venous', 'delayed'],
  abbreviations: [
    'flr',
    'alpps',
    'ruo',
    'mrn',
    'sop_uid',
    'dicom_seg',
    'dicom_sr',
    'pacs',
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ResolvedTerm {
  anchorId: string;
  category: GlossaryCategory;
  termKey: string;
  name: string;
  /** Latin anatomical name (vessels, couinaud) */
  latin?: string;
  /** Short form (abbreviations, lesion classes) */
  abbr?: string;
  /** Plain-language role/definition */
  role?: string;
  /** Haystack for filtering (pre-lowercased). */
  haystack: string;
}

/**
 * Translation resolver that treats "key === returnedValue" as "missing" and
 * returns `undefined` so the caller can render a muted em-dash. The
 * TranslationContext falls back to the key string when a bundle is missing
 * or the path is unknown — we don't want to display `glossary:couinaud.I.name`
 * to a clinician.
 */
function makeResolver(
  t: (key: string, params?: Record<string, unknown>) => string,
) {
  return (key: string): string | undefined => {
    const v = t(key);
    return v === key ? undefined : v;
  };
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export default function GlossaryView(): JSX.Element {
  return (
    <EMRErrorBoundary componentName="GlossaryView">
      <GlossaryViewInner />
    </EMRErrorBoundary>
  );
}

function GlossaryViewInner(): JSX.Element {
  const { t } = useTranslation();
  const resolve = useMemo(() => makeResolver(t), [t]);

  const [query, setQuery] = useState('');
  const [debouncedQuery] = useDebouncedValue(query, 200);
  const [category, setCategory] = useState<'all' | GlossaryCategory>('all');

  const prefersReducedMotion = useReducedMotion();
  const isMobile = useMediaQuery('(max-width: 768px)');

  // Build the full resolved term list once per locale change.
  const allTerms = useMemo<ResolvedTerm[]>(() => {
    const list: ResolvedTerm[] = [];
    for (const cat of CATEGORY_ORDER) {
      for (const termKey of TERM_KEYS[cat]) {
        const name =
          resolve(`glossary:${cat}.${termKey}.name`) ?? '';
        const latin = resolve(`glossary:${cat}.${termKey}.latin`);
        const abbr = resolve(`glossary:${cat}.${termKey}.abbr`);
        const role = resolve(`glossary:${cat}.${termKey}.role`);

        const haystack = [name, latin, abbr, role]
          .filter((s): s is string => Boolean(s))
          .join(' ')
          .toLowerCase();

        list.push({
          anchorId: `${cat}-${termKey}`,
          category: cat,
          termKey,
          name,
          latin,
          abbr,
          role,
          haystack,
        });
      }
    }
    return list;
  }, [resolve]);

  // Apply search + category filter.
  const filteredTerms = useMemo<ResolvedTerm[]>(() => {
    const needle = debouncedQuery.trim().toLowerCase();
    return allTerms.filter((term) => {
      if (category !== 'all' && term.category !== category) return false;
      if (needle && !term.haystack.includes(needle)) return false;
      return true;
    });
  }, [allTerms, category, debouncedQuery]);

  // Group filtered terms by category for rendering.
  const groupedTerms = useMemo(() => {
    const groups: Record<GlossaryCategory, ResolvedTerm[]> = {
      couinaud: [],
      vessels: [],
      lesions: [],
      phases: [],
      abbreviations: [],
    };
    for (const term of filteredTerms) groups[term.category].push(term);
    return groups;
  }, [filteredTerms]);

  // ── Deep-link handling ────────────────────────────────────────────────
  // If the URL has a hash (e.g. #couinaud-III), scroll that row into view
  // after the terms render. We re-run on hash change too so in-app links
  // still work without a full reload.
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const scrollToHash = (): void => {
      const hash = window.location.hash.replace(/^#/, '');
      if (!hash) return;
      // containerRef.current may be null if the inner view unmounted.
      const root = containerRef.current ?? document;
      const el = root.querySelector<HTMLElement>(
        `[data-glossary-anchor="${CSS.escape(hash)}"]`,
      );
      if (el) {
        el.scrollIntoView({
          behavior: prefersReducedMotion ? 'auto' : 'smooth',
          block: 'start',
        });
      }
    };

    // Defer once past render so accordion items are in the DOM.
    const id = window.setTimeout(scrollToHash, 0);
    window.addEventListener('hashchange', scrollToHash);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('hashchange', scrollToHash);
    };
  }, [filteredTerms.length, prefersReducedMotion]);

  const handleClearFilter = (): void => {
    setQuery('');
    setCategory('all');
  };

  const hasAnyResults = filteredTerms.length > 0;
  const totalCount = allTerms.length;
  const shownCount = filteredTerms.length;

  // Segmented control data. `glossary:categories.all` → "All".
  const categoryData = useMemo(
    () => [
      { value: 'all' as const, label: t('glossary:categories.all') },
      ...CATEGORY_ORDER.map((cat) => ({
        value: cat,
        label: t(`glossary:categories.${cat}`),
      })),
    ],
    [t],
  );

  return (
    <Box
      ref={containerRef}
      style={{
        padding: isMobile ? '16px' : '24px',
        maxWidth: '1100px',
        margin: '0 auto',
      }}
      data-testid="glossary-view"
    >
      <EMRPageHeader
        icon={IconBook}
        title={t('glossary:page.title')}
        subtitle={t('glossary:page.subtitle')}
      />

      {/* Search + filter controls */}
      <Stack gap="md" mb="lg">
        <TextInput
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder={t('glossary:page.searchPlaceholder')}
          aria-label={t('glossary:page.searchPlaceholder')}
          leftSection={<IconSearch size={16} stroke={1.8} />}
          rightSection={
            query ? (
              <IconX
                size={16}
                stroke={1.8}
                role="button"
                aria-label={t('glossary:page.clearFilter')}
                onClick={() => setQuery('')}
                style={{ cursor: 'pointer', color: 'var(--emr-text-secondary)' }}
              />
            ) : null
          }
          styles={{
            input: {
              fontSize: 'var(--emr-font-md)',
              height: 44,
              borderRadius: 'var(--emr-border-radius-md)',
            },
          }}
          data-testid="glossary-search"
        />

        <Box
          style={{
            overflowX: isMobile ? 'auto' : 'visible',
            WebkitOverflowScrolling: 'touch',
          }}
        >
          <SegmentedControl
            value={category}
            onChange={(v) => setCategory(v as 'all' | GlossaryCategory)}
            data={categoryData}
            fullWidth={!isMobile}
            styles={{
              root: {
                background: 'var(--emr-bg-hover)',
                borderRadius: 'var(--emr-border-radius-md)',
                minWidth: isMobile ? 'max-content' : undefined,
              },
              label: {
                fontSize: 'var(--emr-font-sm)',
                fontWeight: 'var(--emr-font-medium)',
                whiteSpace: 'nowrap',
              },
            }}
            data-testid="glossary-category-filter"
          />
        </Box>

        {/* Results count pill */}
        <Group justify="space-between" gap="sm" wrap="wrap">
          <Text
            size="sm"
            style={{
              color: 'var(--emr-text-secondary)',
              fontSize: 'var(--emr-font-sm)',
            }}
            data-testid="glossary-results-count"
          >
            {t('glossary:page.resultsCount', {
              count: shownCount,
              total: totalCount,
            })}
          </Text>
        </Group>
      </Stack>

      {/* Results */}
      {hasAnyResults ? (
        <Stack gap="xl">
          {CATEGORY_ORDER.map((cat) => {
            const terms = groupedTerms[cat];
            if (terms.length === 0) return null;
            return (
              <CategorySection
                key={cat}
                category={cat}
                label={t(`glossary:categories.${cat}`)}
                terms={terms}
                reducedMotion={Boolean(prefersReducedMotion)}
              />
            );
          })}
        </Stack>
      ) : (
        <Box data-testid="glossary-empty-state">
          <EMRTableEmptyState
            icon={IconSearch}
            title={t('glossary:page.noMatches')}
            action={{
              label: t('glossary:page.clearFilter'),
              onClick: handleClearFilter,
            }}
          />
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Category section + term row
// ---------------------------------------------------------------------------

interface CategorySectionProps {
  category: GlossaryCategory;
  label: string;
  terms: ResolvedTerm[];
  reducedMotion: boolean;
}

function CategorySection({
  category,
  label,
  terms,
  reducedMotion,
}: CategorySectionProps): JSX.Element {
  return (
    <Box data-testid={`glossary-category-section-${category}`}>
      <Title
        order={2}
        style={{
          fontSize: 'var(--emr-font-lg)',
          fontWeight: 'var(--emr-font-semibold)',
          color: 'var(--emr-text-primary)',
          marginBottom: '12px',
          letterSpacing: 'var(--emr-letter-spacing-tight)',
        }}
      >
        {label}
      </Title>

      <Accordion
        multiple
        variant="separated"
        radius="md"
        chevronPosition="right"
        transitionDuration={reducedMotion ? 0 : 200}
        styles={{
          item: {
            background: 'var(--emr-bg-card)',
            border: '1px solid var(--emr-border-color)',
            borderRadius: 'var(--emr-border-radius-md)',
            overflow: 'hidden',
          },
          control: {
            padding: '12px 16px',
          },
          content: {
            padding: '0 16px 16px',
            color: 'var(--emr-text-primary)',
            fontSize: 'var(--emr-font-sm)',
            lineHeight: 'var(--emr-line-height-1-5)',
          },
        }}
      >
        {terms.map((term) => (
          <TermRow key={term.anchorId} term={term} />
        ))}
      </Accordion>
    </Box>
  );
}

interface TermRowProps {
  term: ResolvedTerm;
}

function TermRow({ term }: TermRowProps): JSX.Element {
  // Muted em-dash when a secondary translation is missing. We still render
  // the row so the structural list of terms matches the spec.
  const MISSING = '—';
  const secondary = term.latin ?? term.abbr ?? undefined;

  return (
    <Accordion.Item
      value={term.anchorId}
      data-glossary-anchor={term.anchorId}
      id={term.anchorId}
      data-testid={`glossary-term-${term.anchorId}`}
    >
      <Accordion.Control>
        <Group
          justify="space-between"
          wrap="wrap"
          gap="sm"
          style={{ width: '100%' }}
        >
          <Text
            style={{
              fontSize: 'var(--emr-font-md)',
              fontWeight: 'var(--emr-font-medium)',
              color: 'var(--emr-text-primary)',
              minWidth: 0,
            }}
          >
            {term.name || MISSING}
          </Text>
          <Text
            component="span"
            style={{
              fontFamily: 'var(--emr-font-mono, ui-monospace, SFMono-Regular, monospace)',
              fontSize: 'var(--emr-font-xs)',
              color: 'var(--emr-text-secondary)',
              fontStyle: term.latin ? 'italic' : 'normal',
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
          >
            {secondary ?? MISSING}
          </Text>
        </Group>
      </Accordion.Control>
      <Accordion.Panel>
        <Text
          style={{
            color: 'var(--emr-text-secondary)',
            fontSize: 'var(--emr-font-sm)',
          }}
        >
          {term.role ?? MISSING}
        </Text>
      </Accordion.Panel>
    </Accordion.Item>
  );
}
