// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * HelpIndexView — `/help` hub landing (T105).
 *
 * Six-tile hub for operator-facing help resources:
 *   1. Sample case (navigate to /demo-case)
 *   2. Clinical glossary (navigate to /help/glossary)
 *   3. Keyboard shortcuts (opens modal)
 *   4. RUO policy (opens modal)
 *   5. Video tutorials (external link; "Coming soon" when env URL missing)
 *   6. Contact support (mailto)
 *
 * Additionally shows a role-aware tile strip above the grid (e.g. surgeons
 * see finalise/refinement shortcuts first). Role is read defensively from
 * `useAuth().user` — the AuthUser type does not expose `role` yet, so the
 * lookup is type-narrowed and simply skips the strip when absent or unknown.
 *
 * No API calls; all copy via `useTranslation()`; all colors via
 * `var(--emr-*)` tokens so dark mode + brand swaps propagate automatically.
 */

import { Anchor, Box, Group, Kbd, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import {
  IconBook,
  IconHelpCircle,
  IconKeyboard,
  IconMail,
  IconPlayerPlay,
  IconShield,
  IconVideo,
} from '@tabler/icons-react';
import type { ComponentType, ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  EMRErrorBoundary,
  EMRModal,
  EMRPageHeader,
} from '../../components/common';
import { useTranslation } from '../../contexts/TranslationContext';
import { useAuth } from '../../services/auth';

// ---------------------------------------------------------------------------
// Tile + shortcut config
// ---------------------------------------------------------------------------

interface IconProps {
  size?: number | string;
  stroke?: number;
}

type TileKey =
  | 'sampleCase'
  | 'glossary'
  | 'keyboard'
  | 'ruoPolicy'
  | 'tutorials'
  | 'support';

interface TileDef {
  key: TileKey;
  icon: ComponentType<IconProps>;
}

const TILES: readonly TileDef[] = [
  { key: 'sampleCase', icon: IconPlayerPlay },
  { key: 'glossary', icon: IconBook },
  { key: 'keyboard', icon: IconKeyboard },
  { key: 'ruoPolicy', icon: IconShield },
  { key: 'tutorials', icon: IconVideo },
  { key: 'support', icon: IconMail },
] as const;

/**
 * Role → tile-key ordering for the "For your role" strip.
 *
 * Mirrors the JSON in `help.json → hub.role.*` but referenced here as a
 * TS constant because `t()` returns `string` only (not arrays). Keys were
 * re-mapped from the JSON's landing-feature ids to tile ids where needed:
 *   surgeon's "finalize"/"refinement" → guide them to sampleCase + glossary
 *   radiologist's "lesionDetection" → glossary (clinical reference)
 *   admin/compliance/dpo → support + ruoPolicy (their primary touch-points)
 */
const ROLE_TILE_MAP: Readonly<Record<string, readonly TileKey[]>> = {
  surgeon: ['sampleCase', 'glossary', 'keyboard'],
  hpb_surgeon: ['sampleCase', 'glossary', 'keyboard'],
  radiologist: ['glossary', 'keyboard', 'sampleCase'],
  admin: ['support', 'ruoPolicy'],
  operations: ['support', 'ruoPolicy'],
  compliance: ['ruoPolicy', 'support'],
  dpo: ['ruoPolicy', 'support'],
  fellow: ['sampleCase', 'glossary'],
};

type ShortcutSection = 'global' | 'viewer' | 'refine';

const SHORTCUT_ROWS: Record<ShortcutSection, readonly string[]> = {
  global: ['searchCases', 'nextCase', 'prevCase'],
  viewer: ['pan', 'zoomIn', 'zoomOut', 'sliceUp', 'sliceDown'],
  refine: ['vistaAdd', 'vistaSubtract', 'lesionPrompt', 'undo', 'redo'],
};

const SUPPORT_EMAIL = 'support@liverra.ai';

// ---------------------------------------------------------------------------
// Tile button (custom; EMRCard's action-icon layout doesn't fit hub tiles)
// ---------------------------------------------------------------------------

interface TileButtonProps {
  icon: ComponentType<IconProps>;
  title: string;
  body: string;
  cta: string;
  onClick?: () => void;
  disabled?: boolean;
  disabledLabel?: string;
  compact?: boolean;
  testId?: string;
}

function TileButton({
  icon: Icon,
  title,
  body,
  cta,
  onClick,
  disabled = false,
  disabledLabel,
  compact = false,
  testId,
}: TileButtonProps): ReactElement {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (disabled || !onClick) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <Box
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={`${title} — ${body}`}
      onClick={disabled ? undefined : onClick}
      onKeyDown={handleKeyDown}
      data-testid={testId}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? 8 : 12,
        padding: compact ? '14px 16px' : '20px',
        minHeight: compact ? 96 : 180,
        background: 'var(--emr-bg-card)',
        border: '1px solid var(--emr-border-color)',
        borderRadius: 'var(--emr-border-radius-lg)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.62 : 1,
        boxShadow: 'var(--emr-shadow-card)',
        transition:
          'transform var(--emr-transition-base), box-shadow var(--emr-transition-base), border-color var(--emr-transition-base)',
        outline: 'none',
        position: 'relative',
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)';
        (e.currentTarget as HTMLDivElement).style.borderColor =
          'var(--emr-secondary-alpha-30)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)';
        (e.currentTarget as HTMLDivElement).style.borderColor =
          'var(--emr-border-color)';
      }}
    >
      <Group gap="sm" wrap="nowrap" align="center">
        <Box
          aria-hidden="true"
          style={{
            width: compact ? 32 : 44,
            height: compact ? 32 : 44,
            borderRadius: 'var(--emr-border-radius-md)',
            background: 'var(--emr-gradient-primary)',
            color: 'var(--emr-text-inverse)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            boxShadow: '0 2px 6px var(--emr-secondary-alpha-30)',
          }}
        >
          <Icon size={compact ? 18 : 22} stroke={1.8} />
        </Box>
        <Text
          fw="var(--emr-font-semibold)"
          style={{
            fontSize: compact ? 'var(--emr-font-md)' : 'var(--emr-font-lg)',
            color: 'var(--emr-text-primary)',
            lineHeight: 'var(--emr-line-height-1-2)',
            minWidth: 0,
          }}
        >
          {title}
        </Text>
      </Group>

      {!compact && (
        <Text
          style={{
            fontSize: 'var(--emr-font-sm)',
            color: 'var(--emr-text-secondary)',
            lineHeight: 'var(--emr-line-height-1-4)',
            flexGrow: 1,
          }}
        >
          {body}
        </Text>
      )}

      <Group justify="space-between" gap="xs" wrap="nowrap" mt={compact ? 0 : 'auto'}>
        <Text
          style={{
            fontSize: 'var(--emr-font-xs)',
            color: disabled ? 'var(--emr-text-secondary)' : 'var(--emr-secondary)',
            fontWeight: 'var(--emr-font-semibold)',
            letterSpacing: 'var(--emr-letter-spacing-wide)',
            textTransform: 'uppercase',
          }}
        >
          {disabled ? (disabledLabel ?? cta) : cta}
        </Text>
      </Group>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

function HelpIndexViewBody(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [ruoOpen, setRuoOpen] = useState(false);

  const tutorialsUrl = (import.meta.env.VITE_LIVERRA_TUTORIALS_URL ?? '').trim();
  const tutorialsEnabled = tutorialsUrl.length > 0;

  const version = import.meta.env.VITE_APP_VERSION ?? '0.1.0-mvp';

  // Role strip: defensive lookup — `AuthUser` does not (yet) expose `role`;
  // read via loose index + fall back to empty so we simply skip the strip.
  const role = useMemo<string | undefined>(() => {
    if (!user) return undefined;
    const raw = (user as unknown as Record<string, unknown>).role;
    return typeof raw === 'string' ? raw : undefined;
  }, [user]);
  const roleTiles = role ? ROLE_TILE_MAP[role] : undefined;

  const tileHandlers: Record<TileKey, () => void> = {
    sampleCase: () => navigate('/demo-case'),
    glossary: () => navigate('/help/glossary'),
    keyboard: () => setKeyboardOpen(true),
    ruoPolicy: () => setRuoOpen(true),
    tutorials: () => {
      if (tutorialsEnabled) window.open(tutorialsUrl, '_blank', 'noopener,noreferrer');
    },
    support: () => {
      window.location.href = `mailto:${SUPPORT_EMAIL}`;
    },
  };

  const renderTile = (def: TileDef, compact = false): ReactElement => {
    const isTutorials = def.key === 'tutorials';
    const disabled = isTutorials && !tutorialsEnabled;
    return (
      <TileButton
        key={def.key}
        icon={def.icon}
        title={t(`help:hub.tiles.${def.key}.title`)}
        body={t(`help:hub.tiles.${def.key}.body`)}
        cta={t(`help:hub.tiles.${def.key}.cta`)}
        onClick={disabled ? undefined : tileHandlers[def.key]}
        disabled={disabled}
        disabledLabel={t('help:hub.tutorials.comingSoon')}
        compact={compact}
        testId={`help-tile-${def.key}`}
      />
    );
  };

  return (
    <Box p={{ base: 'md', md: 'xl' }} style={{ maxWidth: 1280, margin: '0 auto' }}>
      <Stack gap="xl">
        <EMRPageHeader
          icon={IconHelpCircle}
          title={t('help:hub.title')}
          subtitle={t('help:hub.subtitle')}
          data-testid="help-hub-header"
        />

        {/* Role-aware strip */}
        {roleTiles && roleTiles.length > 0 && (
          <Stack gap="sm" data-testid="help-role-strip">
            <Text
              style={{
                fontSize: 'var(--emr-font-xs)',
                color: 'var(--emr-text-secondary)',
                fontWeight: 'var(--emr-font-semibold)',
                textTransform: 'uppercase',
                letterSpacing: 'var(--emr-letter-spacing-wide)',
              }}
            >
              {t('help:hub.role.label')}
            </Text>
            <Box
              style={{
                display: 'flex',
                gap: 12,
                overflowX: 'auto',
                paddingBottom: 4,
                scrollSnapType: 'x mandatory',
              }}
            >
              {roleTiles.map((tileKey) => {
                const def = TILES.find((t) => t.key === tileKey);
                if (!def) return null;
                return (
                  <Box
                    key={tileKey}
                    style={{ flex: '0 0 260px', scrollSnapAlign: 'start' }}
                  >
                    {renderTile(def, true)}
                  </Box>
                );
              })}
            </Box>
          </Stack>
        )}

        {/* Main tile grid */}
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          {TILES.map((def) => renderTile(def))}
        </SimpleGrid>

        {/* Footer */}
        <Group
          justify="space-between"
          align="center"
          pt="md"
          style={{
            borderTop: '1px solid var(--emr-border-color)',
            flexWrap: 'wrap',
            gap: 12,
          }}
          data-testid="help-footer"
        >
          <Text
            style={{
              fontSize: 'var(--emr-font-xs)',
              color: 'var(--emr-text-secondary)',
              letterSpacing: 'var(--emr-letter-spacing-wide)',
            }}
          >
            {t('help:hub.footer.version', { version })}
          </Text>
          <Anchor
            href={`mailto:${SUPPORT_EMAIL}`}
            style={{
              fontSize: 'var(--emr-font-sm)',
              color: 'var(--emr-secondary)',
              fontWeight: 'var(--emr-font-medium)',
            }}
          >
            {t('help:hub.footer.support')}
          </Anchor>
        </Group>
      </Stack>

      {/* Keyboard shortcuts modal */}
      <EMRModal
        opened={keyboardOpen}
        onClose={() => setKeyboardOpen(false)}
        size="md"
        icon={IconKeyboard}
        title={t('help:hub.modals.keyboard.title')}
        submitLabel={t('help:hub.modals.keyboard.close')}
        onSubmit={() => setKeyboardOpen(false)}
        testId="help-keyboard-modal"
      >
        <Stack gap="lg">
          {(Object.keys(SHORTCUT_ROWS) as ShortcutSection[]).map((section) => (
            <Stack key={section} gap="xs" data-testid={`kb-section-${section}`}>
              <Title
                order={4}
                style={{
                  fontSize: 'var(--emr-font-md)',
                  fontWeight: 'var(--emr-font-semibold)',
                  color: 'var(--emr-text-primary)',
                  margin: 0,
                }}
              >
                {t(`help:hub.modals.keyboard.sections.${section}`)}
              </Title>
              <Stack gap={6}>
                {SHORTCUT_ROWS[section].map((rowKey) => (
                  <Group
                    key={rowKey}
                    justify="space-between"
                    wrap="nowrap"
                    gap="md"
                    py={6}
                    px={10}
                    style={{
                      background: 'var(--emr-bg-hover)',
                      borderRadius: 'var(--emr-border-radius-md)',
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 'var(--emr-font-sm)',
                        color: 'var(--emr-text-primary)',
                      }}
                    >
                      {t(`help:hub.modals.keyboard.rows.${rowKey}.label`)}
                    </Text>
                    <Kbd>{t(`help:hub.modals.keyboard.rows.${rowKey}.keys`)}</Kbd>
                  </Group>
                ))}
              </Stack>
            </Stack>
          ))}
        </Stack>
      </EMRModal>

      {/* RUO policy modal */}
      <EMRModal
        opened={ruoOpen}
        onClose={() => setRuoOpen(false)}
        size="lg"
        icon={IconShield}
        title={t('help:hub.modals.ruo.title')}
        submitLabel={t('help:hub.modals.ruo.close2')}
        onSubmit={() => setRuoOpen(false)}
        testId="help-ruo-modal"
      >
        <Stack gap="md">
          <Text
            style={{
              fontSize: 'var(--emr-font-sm)',
              color: 'var(--emr-text-secondary)',
              lineHeight: 'var(--emr-line-height-1-5)',
            }}
          >
            {t('help:hub.modals.ruo.intro')}
          </Text>

          <Stack gap="xs">
            <Title
              order={4}
              style={{
                fontSize: 'var(--emr-font-md)',
                fontWeight: 'var(--emr-font-semibold)',
                color: 'var(--emr-text-primary)',
                margin: 0,
              }}
            >
              {t('help:hub.modals.ruo.whatItMeans')}
            </Title>
            <Box
              p="md"
              style={{
                background: 'var(--emr-bg-hover)',
                borderRadius: 'var(--emr-border-radius-md)',
                border: '1px solid var(--emr-border-color)',
              }}
            >
              <Text
                style={{
                  fontSize: 'var(--emr-font-sm)',
                  color: 'var(--emr-text-primary)',
                  lineHeight: 'var(--emr-line-height-1-5)',
                }}
              >
                {t('help:hub.modals.ruo.whatItMeansBody')}
              </Text>
            </Box>
          </Stack>

          <Stack gap="xs">
            <Title
              order={4}
              style={{
                fontSize: 'var(--emr-font-md)',
                fontWeight: 'var(--emr-font-semibold)',
                color: 'var(--emr-text-primary)',
                margin: 0,
              }}
            >
              {t('help:hub.modals.ruo.narrowing')}
            </Title>
            <Box
              p="md"
              style={{
                background: 'var(--emr-bg-hover)',
                borderRadius: 'var(--emr-border-radius-md)',
                border: '1px solid var(--emr-border-color)',
              }}
            >
              <Text
                style={{
                  fontSize: 'var(--emr-font-sm)',
                  color: 'var(--emr-text-primary)',
                  lineHeight: 'var(--emr-line-height-1-5)',
                }}
              >
                {t('help:hub.modals.ruo.narrowingBody')}
              </Text>
            </Box>
          </Stack>
        </Stack>
      </EMRModal>
    </Box>
  );
}

export default function HelpIndexView(): ReactElement {
  return (
    <EMRErrorBoundary componentName="HelpIndexView">
      <HelpIndexViewBody />
    </EMRErrorBoundary>
  );
}
