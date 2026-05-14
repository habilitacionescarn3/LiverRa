// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * NotificationPreferencesView.
 *
 * Plain-English: per-user email opt-out page. A simple list of switches,
 * grouped by category — clinical, operational, security — so reviewers
 * can silence the notifications they don't want without touching their
 * inbox filters. The PHI-incident switch is locked ON because compliance
 * policy mandates every user receive breach-adjacent alerts.
 *
 * Route: /settings/notifications (auth only).
 *
 * Error behavior: toggling a switch triggers an optimistic update. If
 * the server rejects, the switch reverts and a dismissable banner tells
 * the user the save failed.
 */

import React, { useMemo, useState } from 'react';
import {
  Badge,
  Box,
  Divider,
  Group,
  Loader,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { EMRSwitch } from '../../components/shared/EMRFormFields';
import {
  IconAlertTriangle,
  IconBell,
  IconSettings,
  IconShield,
  IconStethoscope,
} from '@tabler/icons-react';
import type { ComponentType } from 'react';

import {
  EMRAlert,
  EMRButton,
  EMRErrorBoundary,
  EMRPageHeader,
  EMRSkeleton,
} from '../../components/common';
import { useTranslation } from '../../contexts/TranslationContext';
import {
  useNotificationPreferences,
  type NotificationPreference,
} from '../../hooks/useNotificationPreferences';

/** Display metadata for a notification group card. */
interface GroupDef {
  id: 'clinical' | 'operational' | 'security';
  icon: ComponentType<{ size?: number | string; stroke?: number }>;
  events: readonly string[];
}

/**
 * Ordering is intentional and tested: clinical → operational → security.
 * Event order within each group also matters for screen readers.
 */
const GROUPS: readonly GroupDef[] = [
  {
    id: 'clinical',
    icon: IconStethoscope,
    events: ['analysis_complete', 'analysis_failed'],
  },
  {
    id: 'operational',
    icon: IconSettings,
    events: ['queued_long', 'pacs_failed', 'maintenance_window'],
  },
  {
    id: 'security',
    icon: IconShield,
    events: [
      'mfa_reset',
      'invite_accepted',
      'erasure_confirmed',
      'phi_incident',
    ],
  },
] as const;

interface PreferenceRowProps {
  pref: NotificationPreference;
  saving: boolean;
  onToggle: (optedOut: boolean) => void;
}

function PreferenceRow({
  pref,
  saving,
  onToggle,
}: PreferenceRowProps): React.ReactElement {
  const { t } = useTranslation();
  const locked = pref.locked === true;

  // Locked rows are visually ON regardless of any `opted_out` value the
  // server sent — compliance policy wins.
  const checked = locked ? true : !pref.opted_out;

  const label = t(`notifications:prefs.events.${pref.event_type}.label`);
  const description = t(
    `notifications:prefs.events.${pref.event_type}.description`,
  );

  const switchElement = (
    <EMRSwitch
      data-testid={`pref-switch-${pref.event_type}`}
      checked={checked}
      disabled={locked || saving}
      // EMRSwitch onChange signature: `(checked: boolean) => void`.
      // Switch "checked" maps to "opted_out=false".
      onChange={(next) => {
        onToggle(!next);
      }}
      aria-label={label}
      size="md"
      style={{ flexShrink: 0, width: 'auto' }}
    />
  );

  return (
    <Group
      align="flex-start"
      justify="space-between"
      wrap="nowrap"
      gap="md"
      style={{ padding: '12px 0' }}
      data-testid={`pref-row-${pref.event_type}`}
    >
      <Stack gap={4} style={{ flex: '1 1 auto', minWidth: 0 }}>
        <Group gap="xs" wrap="wrap" align="center">
          <Text
            style={{
              fontSize: 'var(--emr-font-md)',
              fontWeight: 'var(--emr-font-semibold)',
              color: 'var(--emr-text-primary)',
              lineHeight: 'var(--emr-line-height-1-4)',
              minWidth: 0,
            }}
          >
            {label}
          </Text>
          {locked && (
            <Tooltip
              label={t('notifications:prefs.phiLocked.tooltip')}
              withArrow
              position="top"
            >
              <Badge
                data-testid={`pref-locked-badge-${pref.event_type}`}
                variant="light"
                radius="sm"
                leftSection={<IconAlertTriangle size={12} stroke={2} />}
                style={{
                  backgroundColor: 'var(--emr-warning-alpha-10)',
                  color: 'var(--emr-warning)',
                  fontWeight: 'var(--emr-font-semibold)',
                  fontSize: 'var(--emr-font-xs)',
                  border: '1px solid var(--emr-warning-alpha-20)',
                  textTransform: 'none',
                  flexShrink: 0,
                }}
              >
                {t('notifications:prefs.phiLocked.badge')}
              </Badge>
            </Tooltip>
          )}
        </Group>
        <Text
          style={{
            fontSize: 'var(--emr-font-sm)',
            color: 'var(--emr-text-secondary)',
            lineHeight: 'var(--emr-line-height-1-4)',
          }}
        >
          {description}
        </Text>
      </Stack>

      <Group gap="xs" wrap="nowrap" align="center" style={{ flexShrink: 0 }}>
        {saving && (
          <Loader
            size="xs"
            data-testid={`pref-saving-${pref.event_type}`}
            aria-label={t('notifications:prefs.page.saving')}
          />
        )}
        {locked ? (
          <Tooltip
            label={t('notifications:prefs.phiLocked.tooltip')}
            withArrow
            position="left"
          >
            <Box style={{ display: 'inline-flex' }}>{switchElement}</Box>
          </Tooltip>
        ) : (
          switchElement
        )}
      </Group>
    </Group>
  );
}

interface GroupCardProps {
  group: GroupDef;
  preferences: NotificationPreference[];
  savingEventType: string | null;
  onToggle: (eventType: string, optedOut: boolean) => void;
}

function GroupCard({
  group,
  preferences,
  savingEventType,
  onToggle,
}: GroupCardProps): React.ReactElement | null {
  const { t } = useTranslation();
  const Icon = group.icon;

  // Preserve the intentional ordering within the group rather than the
  // arbitrary order the server may return.
  const ordered = group.events
    .map((eventType) => preferences.find((p) => p.event_type === eventType))
    .filter((p): p is NotificationPreference => Boolean(p));

  if (ordered.length === 0) return null;

  return (
    <Box
      data-testid={`pref-group-${group.id}`}
      style={{
        background: 'var(--emr-bg-card)',
        border: '1px solid var(--emr-border-color)',
        borderRadius: 'var(--emr-border-radius-xl)',
        boxShadow: 'var(--emr-shadow-card)',
        padding: '20px 24px',
      }}
    >
      <Group gap="sm" wrap="nowrap" align="center" mb="sm">
        <Box
          style={{
            width: 36,
            height: 36,
            borderRadius: 'var(--emr-border-radius)',
            background: 'var(--emr-secondary-alpha-10)',
            color: 'var(--emr-secondary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <Icon size={20} stroke={1.8} />
        </Box>
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Text
            style={{
              fontSize: 'var(--emr-font-lg)',
              fontWeight: 'var(--emr-font-semibold)',
              color: 'var(--emr-text-primary)',
              lineHeight: 1.2,
            }}
          >
            {t(`notifications:prefs.groups.${group.id}.title`)}
          </Text>
          <Text
            style={{
              fontSize: 'var(--emr-font-sm)',
              color: 'var(--emr-text-secondary)',
              lineHeight: 1.4,
            }}
          >
            {t(`notifications:prefs.groups.${group.id}.description`)}
          </Text>
        </Stack>
      </Group>
      <Divider color="var(--emr-border-color)" />
      <Stack gap={0} mt="xs" style={{ divideY: true }}>
        {ordered.map((pref, idx) => (
          <Box key={pref.event_type}>
            {idx > 0 && <Divider color="var(--emr-border-color)" />}
            <PreferenceRow
              pref={pref}
              saving={savingEventType === pref.event_type}
              onToggle={(optedOut) => onToggle(pref.event_type, optedOut)}
            />
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

function LoadingSkeleton(): React.ReactElement {
  return (
    <Stack gap="lg" data-testid="pref-loading-skeleton">
      {GROUPS.map((group) => (
        <Box
          key={group.id}
          style={{
            background: 'var(--emr-bg-card)',
            border: '1px solid var(--emr-border-color)',
            borderRadius: 'var(--emr-border-radius-xl)',
            boxShadow: 'var(--emr-shadow-card)',
            padding: '20px 24px',
          }}
        >
          <Group gap="sm" wrap="nowrap" mb="md">
            <EMRSkeleton height={36} width={36} radius="md" />
            <Stack gap={6} style={{ flex: 1 }}>
              <EMRSkeleton height={16} width="40%" />
              <EMRSkeleton height={12} width="70%" />
            </Stack>
          </Group>
          <Stack gap="md">
            {group.events.map((evt) => (
              <Group key={evt} justify="space-between" wrap="nowrap">
                <Stack gap={6} style={{ flex: 1 }}>
                  <EMRSkeleton height={14} width="50%" />
                  <EMRSkeleton height={12} width="80%" />
                </Stack>
                <EMRSkeleton height={24} width={44} radius="xl" />
              </Group>
            ))}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}

function NotificationPreferencesInner(): React.ReactElement {
  const { t } = useTranslation();
  const { preferences, isLoading, error, toggle, refetch } =
    useNotificationPreferences();
  const [savingEventType, setSavingEventType] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const header = (
    <EMRPageHeader
      icon={IconBell}
      title={t('notifications:prefs.page.title')}
      subtitle={t('notifications:prefs.page.subtitle')}
    />
  );

  const handleToggle = async (
    eventType: string,
    optedOut: boolean,
  ): Promise<void> => {
    setSaveError(null);
    setSavingEventType(eventType);
    try {
      await toggle(eventType, optedOut);
    } catch {
      setSaveError(t('notifications:prefs.page.saveError'));
    } finally {
      // Small delay so the spinner is visible even for fast responses;
      // keeps the UX calm rather than flashing.
      window.setTimeout(() => {
        setSavingEventType((current) =>
          current === eventType ? null : current,
        );
      }, 300);
    }
  };

  const content = useMemo(() => {
    if (isLoading) return <LoadingSkeleton />;
    if (error) {
      return (
        <EMRAlert
          variant="error"
          title={t('common.somethingWentWrong')}
          data-testid="pref-fetch-error"
        >
          <Stack gap="sm">
            <Text size="sm">{error.message}</Text>
            <Box>
              <EMRButton
                variant="secondary"
                size="sm"
                onClick={() => refetch()}
              >
                {t('common.retry')}
              </EMRButton>
            </Box>
          </Stack>
        </EMRAlert>
      );
    }
    if (preferences.length === 0) {
      return (
        <EMRAlert
          variant="info"
          title={t('notifications:prefs.page.title')}
          data-testid="pref-empty"
        >
          {t('notifications:prefs.page.subtitle')}
        </EMRAlert>
      );
    }
    return (
      <Stack gap="lg">
        {GROUPS.map((group) => (
          <GroupCard
            key={group.id}
            group={group}
            preferences={preferences}
            savingEventType={savingEventType}
            onToggle={(eventType, optedOut) => {
              void handleToggle(eventType, optedOut);
            }}
          />
        ))}
      </Stack>
    );
    // M-HOOK-5 justification: ``handleToggle`` and ``refetch`` are
    // referenced inside the closure but are stable across renders
    // (handleToggle is recreated each render but only invokes via
    // local setState + the stable ``toggle`` API). Adding them would
    // rebuild the rendered list on every parent render; the deps
    // listed are the data inputs the rendered tree actually reacts to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, error, preferences, savingEventType, t]);

  return (
    <Box
      style={{
        width: '100%',
        maxWidth: 960,
        margin: '0 auto',
        padding: 'var(--emr-space-lg, 24px)',
      }}
    >
      <Stack gap="lg">
        {header}
        {saveError && (
          <EMRAlert
            variant="error"
            withCloseButton
            onClose={() => setSaveError(null)}
            data-testid="pref-save-error"
          >
            {saveError}
          </EMRAlert>
        )}
        {content}
      </Stack>
    </Box>
  );
}

export default function NotificationPreferencesView(): React.ReactElement {
  return (
    <EMRErrorBoundary componentName="NotificationPreferencesView">
      <NotificationPreferencesInner />
    </EMRErrorBoundary>
  );
}

