// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * UserManagementView (T286, T436).
 *
 * Plain-English: the admin's user roster. Shows tenant users in a
 * responsive table, with "Invite user" and per-row "Suspend" actions.
 * Backed by useAdminUsers(): list + invite + suspend mutations with
 * automatic refetch on every change.
 */
import { useState, Suspense } from 'react';
import { Box, Group, Stack, Table, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconUserPlus, IconUsers, IconUserOff } from '@tabler/icons-react';
import {
  EMRAlert as Alert,
  EMRButton,
  EMREmptyState as EmptyState,
  EMRErrorBoundary,
  EMRPageHeader,
  EMRTableSkeleton as Skeleton,
} from '../../components/common';
import UserInviteModal from '../../components/admin/UserInviteModal';
import { useAdminUsers } from '../../hooks/useAdminUsers';
import { useTranslation } from '../../contexts/TranslationContext';

function UserManagementInner(): React.ReactElement {
  const { t } = useTranslation();
  const isMobile = useMediaQuery('(max-width: 767px)');
  const { users, loading, error, refetch, invite, suspend } = useAdminUsers();
  const [inviteOpen, setInviteOpen] = useState(false);

  return (
    <Stack gap="lg" p={{ base: 'sm', md: 'lg' } as unknown as string}>
      <EMRPageHeader
        icon={IconUsers}
        title={t('admin:users.title') || 'User management'}
        subtitle={t('admin:users.subtitle') || 'Invite, suspend, and manage clinicians for your tenant.'}
        badge={{ count: users.length, variant: 'primary' }}
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

      {loading && users.length === 0 && <Skeleton rows={8} columns={isMobile ? 2 : 5} />}

      {!loading && !error && users.length === 0 && (
        <EmptyState
          title={t('admin:users.empty.title') || 'No users yet'}
          description={
            t('admin:users.empty.description') ||
            'Send your first invite to bring a clinician onto your tenant.'
          }
          action={{
            label: t('admin:users.invite') || 'Invite user',
            onClick: () => setInviteOpen(true),
            icon: IconUserPlus,
          }}
        />
      )}

      {users.length > 0 && (
        <Box
          style={{
            borderRadius: 'var(--emr-border-radius-lg)',
            border: '1px solid var(--emr-gray-200)',
            overflow: 'hidden',
            background: 'var(--emr-bg-card)',
          }}
        >
          <Table striped highlightOnHover verticalSpacing="sm" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('admin:users.col.name') || 'Name'}</Table.Th>
                <Table.Th>{t('admin:users.col.email') || 'Email'}</Table.Th>
                <Table.Th>{t('admin:users.col.role') || 'Role'}</Table.Th>
                <Table.Th>{t('admin:users.col.status') || 'Status'}</Table.Th>
                <Table.Th style={{ width: 140 }}>{t('admin:users.col.actions') || 'Actions'}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {users.map((u) => (
                <Table.Tr key={u.id}>
                  <Table.Td>
                    <Text fz="var(--emr-font-sm)" fw={500}>
                      {u.display_name}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
                      {u.email}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text fz="var(--emr-font-sm)">{u.role}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text
                      fz="var(--emr-font-xs)"
                      fw={600}
                      c={u.suspended ? 'var(--emr-error)' : 'var(--emr-success)'}
                      style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                    >
                      {u.suspended
                        ? t('admin:users.status.suspended') || 'Suspended'
                        : t('admin:users.status.active') || 'Active'}
                    </Text>
                  </Table.Td>
                  <Table.Td>
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
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
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
      <Suspense fallback={<Skeleton rows={8} columns={5} />}>
        <UserManagementInner />
      </Suspense>
    </EMRErrorBoundary>
  );
}
