// AUTO-GENERATED from packages/ml-inference/src/services/auth/rbac/matrix.yaml — DO NOT EDIT
// Regenerate via: `npm run generate:permissions`


export type LiverraPermission =
  | 'admin.tenant_config'
  | 'admin.user_create'
  | 'admin.user_role_change'
  | 'analysis.cancel'
  | 'analysis.retry'
  | 'analysis.view'
  | 'audit.export'
  | 'audit.verify_chain'
  | 'audit.view'
  | 'claim_registry.activate'
  | 'claim_registry.view'
  | 'compliance.sign_off'
  | 'compliance.view'
  | 'erasure.approve'
  | 'erasure.execute'
  | 'erasure.request'
  | 'mbom.upload'
  | 'mbom.view'
  | 'ops.case_unstick'
  | 'ops.gpu_status'
  | 'ops.queue_view'
  | 'pacs.c_echo'
  | 'pacs.config_read'
  | 'pacs.config_write'
  | 'report.download'
  | 'report.finalize'
  | 'report.pacs_push'
  | 'report.pacs_retry'
  | 'report.retract'
  | 'report.view'
  | 'review.flr_adjust'
  | 'review.override_classification'
  | 'review.refine_mask'
  | 'review.reprompt_lesion'
  | 'review.seat_takeover'
  | 'study.delete'
  | 'study.upload'
  | 'study.view';

export const LIVERRA_PERMISSIONS: readonly LiverraPermission[] = [
  'admin.tenant_config',
  'admin.user_create',
  'admin.user_role_change',
  'analysis.cancel',
  'analysis.retry',
  'analysis.view',
  'audit.export',
  'audit.verify_chain',
  'audit.view',
  'claim_registry.activate',
  'claim_registry.view',
  'compliance.sign_off',
  'compliance.view',
  'erasure.approve',
  'erasure.execute',
  'erasure.request',
  'mbom.upload',
  'mbom.view',
  'ops.case_unstick',
  'ops.gpu_status',
  'ops.queue_view',
  'pacs.c_echo',
  'pacs.config_read',
  'pacs.config_write',
  'report.download',
  'report.finalize',
  'report.pacs_push',
  'report.pacs_retry',
  'report.retract',
  'report.view',
  'review.flr_adjust',
  'review.override_classification',
  'review.refine_mask',
  'review.reprompt_lesion',
  'review.seat_takeover',
  'study.delete',
  'study.upload',
  'study.view',
] as const;

export type LiverraRole =
  | 'admin'
  | 'compliance'
  | 'dpo'
  | 'fellow'
  | 'hpb_surgeon'
  | 'ops'
  | 'radiologist';

export const LIVERRA_ROLES: readonly LiverraRole[] = [
  'admin',
  'compliance',
  'dpo',
  'fellow',
  'hpb_surgeon',
  'ops',
  'radiologist',
] as const;

export const ROLE_PERMISSIONS: Record<LiverraRole, readonly LiverraPermission[]> = {
  admin: [
    'admin.tenant_config',
    'admin.user_create',
    'admin.user_role_change',
    'audit.export',
    'audit.view',
    'claim_registry.activate',
    'claim_registry.view',
    'erasure.approve',
    'mbom.upload',
    'mbom.view',
    'pacs.c_echo',
    'pacs.config_read',
    'pacs.config_write',
  ],
  compliance: [
    'audit.export',
    'audit.verify_chain',
    'audit.view',
    'claim_registry.activate',
    'claim_registry.view',
    'compliance.sign_off',
    'compliance.view',
    'erasure.request',
    'mbom.view',
    'report.view',
  ],
  dpo: [
    'audit.export',
    'audit.view',
    'compliance.view',
    'erasure.approve',
    'erasure.execute',
    'erasure.request',
  ],
  fellow: [
    'analysis.view',
    'report.view',
    'review.refine_mask',
    'study.view',
  ],
  hpb_surgeon: [
    'analysis.view',
    'report.download',
    'report.finalize',
    'report.view',
    'review.flr_adjust',
    'review.override_classification',
    'review.refine_mask',
    'review.reprompt_lesion',
    'study.upload',
    'study.view',
  ],
  ops: [
    'audit.view',
    'ops.case_unstick',
    'ops.gpu_status',
    'ops.queue_view',
    'pacs.c_echo',
    'study.view',
  ],
  radiologist: [
    'analysis.view',
    'report.download',
    'report.view',
    'review.flr_adjust',
    'review.override_classification',
    'review.refine_mask',
    'review.reprompt_lesion',
    'review.seat_takeover',
    'study.view',
  ],
} as const;

export const STEP_UP_PERMISSIONS: ReadonlySet<LiverraPermission> =
  new Set<LiverraPermission>([
    'admin.user_role_change',
    'claim_registry.activate',
    'compliance.sign_off',
    'erasure.approve',
    'erasure.execute',
    'mbom.upload',
    'report.finalize',
    'report.retract',
  ]);

export function roleHasPermission(role: LiverraRole, perm: LiverraPermission): boolean {
  return ROLE_PERMISSIONS[role].includes(perm);
}
