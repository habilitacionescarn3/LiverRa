// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * PermissionButton — LiverRa permission-aware button (T098).
 *
 * Plain-English: a button that only fires when the user has the required
 * permission. If they don't, it can either render disabled (with an optional
 * tooltip explaining why) or disappear entirely (`hiddenIfDenied`).
 *
 * TODO: swap the raw Mantine `Button` for `EMRButton` from `../common`
 * once that component is ported into LiverRa.
 */

import type { ReactNode } from 'react';
import { Tooltip } from '@mantine/core';

import { EMRButton } from '../common';
import type { EMRButtonProps } from '../common/EMRButton';
import { useHasPermission } from '../../contexts/PermissionContext';
import { useTranslation } from '../../contexts/TranslationContext';
import type { LiverraPermission } from '../../constants/permissions.gen';

export interface PermissionButtonProps extends Omit<EMRButtonProps, 'disabled'> {
  /** Permission code required to enable this button. */
  permission: LiverraPermission;
  /** Hide button completely if permission denied (default: false). */
  hiddenIfDenied?: boolean;
  /** Tooltip text when disabled due to permission denial. */
  deniedTooltip?: string;
  /** Click handler — only fires if permission granted. */
  onClick?: () => void;
  /** Button label / content. */
  children: ReactNode;
}

/** Fail-closed: disabled while permission is still loading or denied. */
export function PermissionButton({
  permission,
  hiddenIfDenied = false,
  deniedTooltip,
  onClick,
  children,
  ...buttonProps
}: PermissionButtonProps): JSX.Element | null {
  const hasPermission = useHasPermission(permission);
  const { t } = useTranslation();

  if (!hasPermission && hiddenIfDenied) {
    return null;
  }

  const handleClick = (): void => {
    if (hasPermission && onClick) onClick();
  };

  const button = (
    <EMRButton {...buttonProps} disabled={!hasPermission} onClick={handleClick}>
      {children}
    </EMRButton>
  );

  if (!hasPermission) {
    const label = deniedTooltip ?? t('common:permission.accessDenied');
    return (
      <Tooltip label={label} withArrow>
        <span>{button}</span>
      </Tooltip>
    );
  }

  return button;
}

export default PermissionButton;
