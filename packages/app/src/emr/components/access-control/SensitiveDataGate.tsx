// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * SensitiveDataGate — LiverRa sensitive-data access gate (T100).
 *
 * Plain-English: wraps UI that shows restricted content (e.g. full PHI,
 * erased-case context). If the user lacks the required LiverRa permission,
 * renders a polite "access restricted" alert instead of the content.
 *
 * LiverRa sensitive categories are simpler than MediMind's — LiverRa only
 * worries about full PHI visibility vs. de-identified mode. The permission
 * check is therefore a single `study.view` or `study.upload` lookup by
 * default; callers can override with `permission`.
 *
 * TODO: swap raw Mantine `Alert`/`Paper` for `EMRAlert`/`EMRPaper` when
 * those land in the common library.
 */

import type { ReactNode, ReactElement } from 'react';
import { Alert, Paper, Stack, Text } from '@mantine/core';
import { IconShieldLock } from '@tabler/icons-react';

import { useHasPermission } from '../../contexts/PermissionContext';
import { useTranslation } from '../../contexts/TranslationContext';
import type { LiverraPermission } from '../../constants/permissions.gen';

export interface SensitiveDataGateProps {
  /** Permission guarding the sensitive content. */
  permission: LiverraPermission;
  /** Content shown when access is granted. */
  children: ReactNode;
  /** Optional override for the blocked view. */
  fallback?: ReactNode;
  /** Optional explanatory label (translation key) describing the category. */
  categoryLabelKey?: string;
}

export function SensitiveDataGate({
  permission,
  children,
  fallback,
  categoryLabelKey,
}: SensitiveDataGateProps): ReactElement {
  const allowed = useHasPermission(permission);
  const { t } = useTranslation();

  if (allowed) {
    return <>{children}</>;
  }

  if (fallback) {
    return <>{fallback}</>;
  }

  return (
    <Paper p="md" withBorder radius="md">
      <Alert
        icon={<IconShieldLock size={16} />}
        color="orange"
        title={t('common:sensitiveData.restricted')}
      >
        <Stack gap="xs">
          <Text size="sm">{t('common:sensitiveData.restrictedMessage')}</Text>
          {categoryLabelKey && (
            <Text size="xs" c="var(--emr-text-secondary)">
              {t(categoryLabelKey)}
            </Text>
          )}
        </Stack>
      </Alert>
    </Paper>
  );
}

export default SensitiveDataGate;
