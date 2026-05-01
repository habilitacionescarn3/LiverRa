// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * NotFoundView — friendly 404 surface.
 *
 * Plain-English: when a user lands on a route that doesn't exist (typo,
 * stale bookmark, link from an old release) we show this page rather
 * than a blank screen. Two actions: the primary "Back to home" CTA
 * returns them to the landing page, and a secondary mailto link lets
 * them flag a bad link to support.
 *
 * Renders with no chrome / no nav. It also doesn't trigger any auth
 * gating on its own — the route is intentionally `EXEMPT_PREFIXES` in
 * useOnboardingStatus so signed-out users hitting a typo URL can still
 * see this and click their way home.
 */

import { Box, Center, Group, Stack, Text } from '@mantine/core';
import {
  IconAlertCircle,
  IconArrowLeft,
  IconHelpHexagon,
  IconHome,
  IconMessageReport,
} from '@tabler/icons-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { ReactElement } from 'react';

import { LIVERRA_ROUTES } from '../../constants/routes';
import { EMRButton } from '../../components/common';
import { useTranslation } from '../../contexts/TranslationContext';

export default function NotFoundView(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const supportSubject = encodeURIComponent(
    t('auth:notFound.reportSubject', { path: location.pathname }),
  );
  const supportBody = encodeURIComponent(
    t('auth:notFound.reportBody', { path: location.pathname }),
  );
  const mailto = `mailto:support@liverra.ai?subject=${supportSubject}&body=${supportBody}`;

  return (
    <Box
      data-testid="not-found-view"
      style={{
        minHeight: '100vh',
        width: '100%',
        position: 'relative',
        background:
          'radial-gradient(ellipse 90% 50% at 50% 0%, var(--emr-secondary-alpha-08) 0%, transparent 60%), var(--emr-bg-page)',
        padding: 'clamp(24px, 6vw, 48px) 16px',
        display: 'flex',
      }}
    >
      <Center style={{ flex: 1, width: '100%' }}>
        <Stack gap="lg" style={{ width: '100%', maxWidth: 520 }} align="center">
          {/* Big "404" with anatomical mark */}
          <Box
            aria-hidden
            style={{
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text
              style={{
                fontSize: 'clamp(96px, 18vw, 152px)',
                fontWeight: 800,
                letterSpacing: '-0.05em',
                lineHeight: 1,
                backgroundImage:
                  'linear-gradient(135deg, var(--emr-primary) 0%, var(--emr-secondary) 60%, var(--emr-accent) 100%)',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                userSelect: 'none',
              }}
            >
              404
            </Text>
          </Box>

          <Stack gap={8} align="center" style={{ textAlign: 'center' }}>
            <Group gap={6} align="center">
              <IconAlertCircle
                size={16}
                color="var(--emr-secondary)"
                aria-hidden
              />
              <Text
                size="xs"
                style={{
                  color: 'var(--emr-secondary)',
                  fontWeight: 'var(--emr-font-semibold)',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                }}
              >
                {t('auth:notFound.kicker')}
              </Text>
            </Group>
            <Text
              style={{
                fontSize: 'clamp(22px, 3vw, 28px)',
                fontWeight: 700,
                color: 'var(--emr-text-primary)',
                lineHeight: 1.2,
                letterSpacing: '-0.01em',
              }}
            >
              {t('auth:notFound.title')}
            </Text>
            <Text
              size="sm"
              style={{
                color: 'var(--emr-text-secondary)',
                lineHeight: 1.55,
                maxWidth: 460,
              }}
            >
              {t('auth:notFound.body')}
            </Text>
            {location.pathname && (
              <Text
                size="xs"
                style={{
                  color: 'var(--emr-text-tertiary)',
                  fontFamily:
                    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
                  background: 'var(--emr-bg-hover)',
                  border: '1px solid var(--emr-border-color)',
                  borderRadius: 6,
                  padding: '4px 8px',
                  marginTop: 4,
                  wordBreak: 'break-all',
                  maxWidth: '100%',
                }}
                data-testid="not-found-path"
              >
                {location.pathname}
              </Text>
            )}
          </Stack>

          {/* Actions */}
          <Group gap="sm" wrap="wrap" justify="center">
            <EMRButton
              variant="primary"
              icon={IconHome}
              onClick={() => navigate(LIVERRA_ROUTES.LANDING)}
              data-testid="not-found-home"
            >
              {t('auth:notFound.homeCta')}
            </EMRButton>
            <EMRButton
              variant="secondary"
              icon={IconArrowLeft}
              onClick={() => navigate(-1)}
              data-testid="not-found-back"
            >
              {t('auth:notFound.backCta')}
            </EMRButton>
          </Group>

          {/* Secondary helpers */}
          <Group gap="lg" wrap="wrap" justify="center" mt={4}>
            <Box
              component={Link}
              to={LIVERRA_ROUTES.HELP}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 4px',
                color: 'var(--emr-text-secondary)',
                textDecoration: 'none',
                fontSize: 'var(--emr-font-sm)',
              }}
              data-testid="not-found-help"
            >
              <IconHelpHexagon size={14} stroke={1.8} />
              {t('auth:notFound.helpLink')}
            </Box>
            <Box
              component="a"
              href={mailto}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 4px',
                color: 'var(--emr-text-secondary)',
                textDecoration: 'none',
                fontSize: 'var(--emr-font-sm)',
              }}
              data-testid="not-found-report"
            >
              <IconMessageReport size={14} stroke={1.8} />
              {t('auth:notFound.reportLink')}
            </Box>
          </Group>
        </Stack>
      </Center>
    </Box>
  );
}
