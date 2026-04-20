/**
 * Tenant, User, Role, PermissionGrant, NotificationPreference,
 * ComplianceAssignment domain types.
 *
 * Source of truth: `specs/001-zero-training-mvp/data-model.md`
 * §1, §2, §15, §20, §21.
 */

/**
 * Canonical role set (data-model §2). `compliance` and `dpo` are
 * reserved for regulatory personas; `ops` covers the SRE-style operator
 * who can see queue health but not PHI.
 */
export const Role = {
  HpbSurgeon: 'hpb_surgeon',
  Radiologist: 'radiologist',
  Fellow: 'fellow',
  Admin: 'admin',
  Ops: 'ops',
  Compliance: 'compliance',
  Dpo: 'dpo',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

/** Supported UI + email locales (constitution: en/de/ka only — no ru). */
export type Locale = 'en' | 'de' | 'ka';

/** User theme preference; `system` defers to OS setting. */
export type ThemePreference = 'light' | 'dark' | 'system';

/**
 * One per design-partner hospital. `slug` is used in hosted-UI URLs;
 * `auditChainGenesisHash` seeds the tamper-evident chain (research §A.3).
 */
export interface Tenant {
  id: string;
  slug: string;
  displayName: string;
  primaryLocale: Locale;
  dataResidencyRegion: string;
  dpoContactEmail: string;
  institutionNamePreserve: boolean;
  ruoPartialCoverageOverrideEnabled: boolean;
  auditChainGenesisHash: Uint8Array;
  createdAt: string;
  updatedAt: string;
}

/**
 * Clinician, admin, ops, compliance, or DPO. Identity lives in Cognito;
 * Postgres mirrors role + tenant + MFA state + UI preferences.
 *
 * `ruoAcceptedAt` is null until onboarding step 3 completes — while null,
 * the user holds no permissions except `study.view_demo_case`
 * (enforced by `@require_permission` middleware; see data-model invariant).
 */
export interface User {
  id: string;
  cognitoSub: string;
  tenantId: string;
  role: Role;
  email: string;
  displayName: string;
  localePreference: Locale;
  themePreference: ThemePreference;
  notificationPreferenceId: string | null;
  mfaEnrolledAt: string | null;
  mfaLastChallengedAt: string | null;
  ruoAcceptedAt: string | null;
  suspendedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Materialized grant row (data-model §15). Produced by the RBAC generator
 * from `rbac_matrix.yaml`; read-only to application code.
 */
export interface PermissionGrant {
  userId: string;
  tenantId: string;
  permission: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string | null;
}

/**
 * Per-user opt-out bag (data-model §20). Critical categories (`auth`,
 * `erasure_confirmation`) cannot be opted out — enforced by schema CHECK
 * constraint in Postgres.
 */
export interface NotificationPreference {
  userId: string;
  optOutCategories: string[];
  updatedAt: string;
}

/**
 * Cross-tenant mapping for the compliance reviewer role (data-model §21).
 * The only place where a User maps to >1 Tenant; expiry-bounded.
 */
export interface ComplianceAssignment {
  userId: string;
  tenantId: string;
  assignmentStart: string;
  assignmentEnd: string;
  scope: {
    auditWindows: { from: string; to: string }[];
    permissionsScope: string[];
  };
}
