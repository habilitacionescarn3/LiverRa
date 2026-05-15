// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * UserManagementView (T286, T436).
 *
 * Plain-English: the admin's user roster. Shows tenant users in a
 * responsive table, with "Invite user" + per-row "Suspend" / "Reset MFA"
 * actions. Backed by useAdminUsers(): list + invite + suspend mutations
 * with automatic refetch on every change.
 */
import { useMemo, useState, Suspense } from 'react';
import { Box, Group, Stack, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconUserPlus,
  IconUsers,
  IconUserOff,
  IconShieldLock,
} from '@tabler/icons-react';
import {
  EMRAlert as Alert,
  EMRBadge,
  EMRButton,
  EMRCard,
  EMREmptyState as EmptyState,
  EMRErrorBoundary,
  EMRPageHeader,
  EMRTable,
  EMRTableSkeleton as Skeleton,
} from '../../components/common';
import type { EMRTableColumn } from '../../components/common';
import UserInviteModal from '../../components/admin/UserInviteModal';
import { useAdminUsers, type AdminUserRow } from '../../hooks/useAdminUsers';
import { useTranslation } from '../../contexts/TranslationContext';

function relativeTime(iso: string | null, t: (k: string, p?: Record<string, string | number>) => string): string {
  if (!iso) return t('admin:users.lastActive.never') || 'Never';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return '—';
  const diffMs = Date.now() - ts;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return t('admin:users.lastActive.justNow') || 'Just now';
  if (minutes < 60) return t('admin:users.lastActive.minutesAgo', { n: minutes }) || `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('admin:users.lastActive.hoursAgo', { n: hours }) || `${hours} h ago`;
  const days = Math.round(hours / 24);
  return t('admin:users.lastActive.daysAgo', { n: days }) || `${days} d ago`;
}

function RoleBadge({ role }: { role: string }): React.ReactElement {
  const { t } = useTranslation();
  const palette: Record<string, { color: string; bg: string }> = {
    hpb_surgeon: { color: 'var(--emr-primary)', bg: 'var(--emr-primary-alpha-10)' },
    radiologist: { color: 'var(--emr-secondary)', bg: 'var(--emr-secondary-alpha-10)' },
    fellow: { color: 'var(--emr-accent)', bg: 'var(--emr-accent-alpha-10)' },
    ops: { color: 'var(--emr-warning)', bg: 'var(--emr-warning-alpha-10)' },
    compliance: { color: 'var(--emr-success)', bg: 'var(--emr-success-alpha-10)' },
    dpo: { color: 'var(--emr-info)', bg: 'var(--emr-secondary-alpha-10)' },
  };
  const p = palette[role] ?? { color: 'var(--emr-text-secondary)', bg: 'var(--emr-bg-hover)' };
  const label = (t(`admin:role.${role}`) as string) || role;
  return (
    <Box
      component="span"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 22,
        padding: '0 10px',
        borderRadius: 999,
        background: p.bg,
        color: p.color,
        fontSize: 'var(--emr-font-xs)',
        fontWeight: 600,
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      {label}
    </Box>
  );
}

function StatusBadge({ suspended }: { suspended: boolean }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <EMRBadge variant={suspended ? 'danger' : 'success'} size="sm">
      {suspended
        ? t('admin:users.status.suspended') || 'Suspended'
        : t('admin:users.status.active') || 'Active'}
    </EMRBadge>
  );
}

function UserCard({
  user,
  onSuspend,
  t,
}: {
  user: AdminUserRow;
  onSuspend: (id: string) => void;
  t: (k: string, p?: Record<string, string | number>) => string;
}): React.ReactElement {
  return (
    <EMRCard padding="md">
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
            <Text fz="var(--emr-font-md)" fw={600} style={{ wordBreak: 'break-word' }}>
              {user.display_name}
            </Text>
            <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)" style={{ wordBreak: 'break-all' }}>
              {user.email}
            </Text>
          </Stack>
          <StatusBadge suspended={user.suspended} />
        </Group>
        <Group gap="xs" wrap="wrap">
          <RoleBadge role={user.role} />
          <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)">
            {relativeTime(user.last_active_at, t)}
          </Text>
        </Group>
        {!user.suspended && (
          <Group justify="flex-end" gap="xs">
            <EMRButton size="sm" variant="ghost" icon={IconUserOff} onClick={() => onSuspend(user.id)}>
              {t('admin:users.suspend') || 'Suspend'}
            </EMRButton>
          </Group>
        )}
      </Stack>
    </EMRCard>
  );
}

/**
 * Build the column set for the users EMRTable. Extracted so the table
 * declaration in the JSX stays readable and the columns can be unit-tested.
 */
function getUserColumns(
  t: (k: string, p?: Record<string, string | number>) => string,
  suspend: (id: string) => void,
): EMRTableColumn<AdminUserRow>[] {
  return [
    {
      id: 'name',
      header: t('admin:users.col.name') || 'Name',
      sortable: true,
      sortFn: (a, b) => a.display_name.localeCompare(b.display_name),
      cell: (u) => (
        <Text fz="var(--emr-font-sm)" fw={600}>
          {u.display_name}
        </Text>
      ),
    },
    {
      id: 'email',
      header: t('admin:users.col.email') || 'Email',
      sortable: true,
      sortFn: (a, b) => a.email.localeCompare(b.email),
      cell: (u) => (
        <Text
          fz="var(--emr-font-sm)"
          c="var(--emr-text-secondary)"
          style={{ wordBreak: 'break-all' }}
        >
          {u.email}
        </Text>
      ),
    },
    {
      id: 'role',
      header: t('admin:users.col.role') || 'Role',
      sortable: true,
      sortFn: (a, b) => a.role.localeCompare(b.role),
      cell: (u) => <RoleBadge role={u.role} />,
    },
    {
      id: 'status',
      header: t('admin:users.col.status') || 'Status',
      sortable: true,
      sortFn: (a, b) => Number(a.suspended) - Number(b.suspended),
      cell: (u) => <StatusBadge suspended={u.suspended} />,
    },
    {
      id: 'lastActive',
      header: t('admin:users.col.lastActive') || 'Last active',
      sortable: true,
      sortFn: (a, b) => {
        const aTs = a.last_active_at ? new Date(a.last_active_at).getTime() : 0;
        const bTs = b.last_active_at ? new Date(b.last_active_at).getTime() : 0;
        return aTs - bTs;
      },
      cell: (u) => (
        <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)" style={{ whiteSpace: 'nowrap' }}>
          {relativeTime(u.last_active_at, t)}
        </Text>
      ),
    },
    {
      id: 'actions',
      header: t('admin:users.col.actions') || 'Actions',
      width: 220,
      cell: (u) => (
        <Group gap="xs" wrap="nowrap">
          {u.mfa_enrolled_at && (
            <EMRButton
              size="sm"
              variant="ghost"
              icon={IconShieldLock}
              aria-label={t('admin:users.resetMfa') || 'Reset MFA'}
              title={t('admin:users.resetMfa') || 'Reset MFA'}
              onClick={() => {
                /* Endpoint not yet wired — placeholder no-op. */
              }}
            >
              {t('admin:users.resetMfa') || 'Reset MFA'}
            </EMRButton>
          )}
          {!u.suspended && (
            <EMRButton
              size="sm"
              variant="ghost"
              icon={IconUserOff}
              onClick={() => suspend(u.id)}
            >
              {t('admin:users.suspend') || 'Suspend'}
            </EMRButton>
          )}
        </Group>
      ),
    },
  ];
}

function UserManagementInner(): React.ReactElement {
  const { t } = useTranslation();
  const isMobile = useMediaQuery('(max-width: 767px)');
  const { users, loading, error, refetch, invite, suspend } = useAdminUsers();
  const [inviteOpen, setInviteOpen] = useState(false);

  const counts = useMemo(() => {
    const active = users.filter((u) => !u.suspended).length;
    return { total: users.length, active, suspended: users.length - active };
  }, [users]);

  return (
    <Stack gap="lg" p={{ base: 'sm', md: 'lg' } as unknown as string}>
      <EMRPageHeader
        icon={IconUsers}
        title={t('admin:users.title') || 'User management'}
        subtitle={t('admin:users.subtitle') || 'Invite, suspend, and manage clinicians for your tenant.'}
        badge={users.length > 0 ? { count: counts.active, label: 'active', variant: 'success' } : undefined}
        actions={
          <EMRButton
            variant="primary"
            icon={IconUserPlus}
            onClick={() => setInviteOpen(true)}
          >
            {t('admin:users.invite') || 'Invite user'}
          </EMRButton>
        }
      />

      {error && (
        <Alert variant="error" title={t('admin:users.error') || 'Failed to load users'}>
          <Group justify="space-between" wrap="wrap" gap="sm">
            <Text fz="var(--emr-font-sm)" style={{ minWidth: 0, flex: 1 }}>
              {error.message}
            </Text>
            <EMRButton size="sm" variant="secondary" onClick={refetch}>
              {t('common:retry') || 'Retry'}
            </EMRButton>
          </Group>
        </Alert>
      )}

      {loading && users.length === 0 && <Skeleton rows={8} columns={isMobile ? 2 : 6} />}

      {!loading && !error && users.length === 0 && (
        <EmptyState
          icon={IconUsers}
          title={t('admin:users.empty.title') || 'No users yet'}
          description={
            t('admin:users.empty.description') ||
            'Invite your first clinician to bring them onto your tenant.'
          }
          action={{
            label: t('admin:users.empty.cta') || 'Invite your first user',
            onClick: () => setInviteOpen(true),
            icon: IconUserPlus,
          }}
        />
      )}

      {users.length > 0 && isMobile && (
        <Stack gap="sm">
          {users.map((u) => (
            <UserCard key={u.id} user={u} onSuspend={suspend} t={t} />
          ))}
        </Stack>
      )}

      {users.length > 0 && !isMobile && (
        <Box
          role="region"
          aria-label={t('admin:users.title') || 'User management'}
          style={{
            borderRadius: 'var(--emr-border-radius-lg)',
            border: '1px solid var(--emr-border-color)',
            overflow: 'hidden',
            background: 'var(--emr-bg-card)',
            boxShadow: 'var(--emr-shadow-sm)',
          }}
        >
          <EMRTable<AdminUserRow>
            ariaLabel={t('admin:users.title') || 'User management'}
            data={users}
            rowKey={(u) => u.id}
            columns={getUserColumns(t, suspend)}
          />
        </Box>
      )}

      <UserInviteModal
        opened={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvite={invite}
      />
    </Stack>
  );
}

export default function UserManagementView(): React.ReactElement {
  return (
    <EMRErrorBoundary>
      <Suspense fallback={<Skeleton rows={8} columns={6} />}>
        <UserManagementInner />
      </Suspense>
    </EMRErrorBoundary>
  );
}
