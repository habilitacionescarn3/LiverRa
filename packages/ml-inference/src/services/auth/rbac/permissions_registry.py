"""AUTO-GENERATED from packages/ml-inference/src/services/auth/rbac/matrix.yaml -- DO NOT EDIT.

Regenerate via: `npm run generate:permissions`.
"""

from __future__ import annotations

from enum import Enum


class Permission(str, Enum):
    """LiverRa permission enumeration."""

    ADMIN_TENANT_CONFIG = 'admin.tenant_config'
    ADMIN_USER_CREATE = 'admin.user_create'
    ADMIN_USER_ROLE_CHANGE = 'admin.user_role_change'
    ANALYSIS_CANCEL = 'analysis.cancel'
    ANALYSIS_RETRY = 'analysis.retry'
    ANALYSIS_VIEW = 'analysis.view'
    AUDIT_EXPORT = 'audit.export'
    AUDIT_VERIFY_CHAIN = 'audit.verify_chain'
    AUDIT_VIEW = 'audit.view'
    CLAIM_REGISTRY_ACTIVATE = 'claim_registry.activate'
    CLAIM_REGISTRY_VIEW = 'claim_registry.view'
    COMPLIANCE_SIGN_OFF = 'compliance.sign_off'
    COMPLIANCE_VIEW = 'compliance.view'
    ERASURE_APPROVE = 'erasure.approve'
    ERASURE_EXECUTE = 'erasure.execute'
    ERASURE_REQUEST = 'erasure.request'
    MBOM_UPLOAD = 'mbom.upload'
    MBOM_VIEW = 'mbom.view'
    OPS_CASE_UNSTICK = 'ops.case_unstick'
    OPS_GPU_STATUS = 'ops.gpu_status'
    OPS_QUEUE_VIEW = 'ops.queue_view'
    PACS_C_ECHO = 'pacs.c_echo'
    PACS_CONFIG_READ = 'pacs.config_read'
    PACS_CONFIG_WRITE = 'pacs.config_write'
    REPORT_DOWNLOAD = 'report.download'
    REPORT_FINALIZE = 'report.finalize'
    REPORT_PACS_PUSH = 'report.pacs_push'
    REPORT_PACS_RETRY = 'report.pacs_retry'
    REPORT_RETRACT = 'report.retract'
    REPORT_VIEW = 'report.view'
    REVIEW_FLR_ADJUST = 'review.flr_adjust'
    REVIEW_OVERRIDE_CLASSIFICATION = 'review.override_classification'
    REVIEW_REFINE_MASK = 'review.refine_mask'
    REVIEW_REPROMPT_LESION = 'review.reprompt_lesion'
    REVIEW_SEAT_TAKEOVER = 'review.seat_takeover'
    STUDY_DELETE = 'study.delete'
    STUDY_UPLOAD = 'study.upload'
    STUDY_VIEW = 'study.view'


ROLE_PERMISSIONS: dict[str, frozenset[Permission]] = {
    'admin': frozenset({
        Permission.ADMIN_TENANT_CONFIG,
        Permission.ADMIN_USER_CREATE,
        Permission.ADMIN_USER_ROLE_CHANGE,
        Permission.AUDIT_EXPORT,
        Permission.AUDIT_VIEW,
        Permission.CLAIM_REGISTRY_ACTIVATE,
        Permission.CLAIM_REGISTRY_VIEW,
        Permission.ERASURE_APPROVE,
        Permission.MBOM_UPLOAD,
        Permission.MBOM_VIEW,
        Permission.PACS_C_ECHO,
        Permission.PACS_CONFIG_READ,
        Permission.PACS_CONFIG_WRITE,
    }),
    'compliance': frozenset({
        Permission.AUDIT_EXPORT,
        Permission.AUDIT_VERIFY_CHAIN,
        Permission.AUDIT_VIEW,
        Permission.CLAIM_REGISTRY_ACTIVATE,
        Permission.CLAIM_REGISTRY_VIEW,
        Permission.COMPLIANCE_SIGN_OFF,
        Permission.COMPLIANCE_VIEW,
        Permission.ERASURE_REQUEST,
        Permission.MBOM_VIEW,
        Permission.REPORT_VIEW,
    }),
    'dpo': frozenset({
        Permission.AUDIT_EXPORT,
        Permission.AUDIT_VIEW,
        Permission.COMPLIANCE_VIEW,
        Permission.ERASURE_APPROVE,
        Permission.ERASURE_EXECUTE,
        Permission.ERASURE_REQUEST,
    }),
    'fellow': frozenset({
        Permission.ANALYSIS_VIEW,
        Permission.REPORT_VIEW,
        Permission.REVIEW_REFINE_MASK,
        Permission.STUDY_VIEW,
    }),
    'hpb_surgeon': frozenset({
        Permission.ANALYSIS_VIEW,
        Permission.REPORT_DOWNLOAD,
        Permission.REPORT_FINALIZE,
        Permission.REPORT_VIEW,
        Permission.REVIEW_FLR_ADJUST,
        Permission.REVIEW_OVERRIDE_CLASSIFICATION,
        Permission.REVIEW_REFINE_MASK,
        Permission.REVIEW_REPROMPT_LESION,
        Permission.STUDY_UPLOAD,
        Permission.STUDY_VIEW,
    }),
    'ops': frozenset({
        Permission.AUDIT_VIEW,
        Permission.OPS_CASE_UNSTICK,
        Permission.OPS_GPU_STATUS,
        Permission.OPS_QUEUE_VIEW,
        Permission.PACS_C_ECHO,
        Permission.STUDY_VIEW,
    }),
    'radiologist': frozenset({
        Permission.ANALYSIS_VIEW,
        Permission.REPORT_DOWNLOAD,
        Permission.REPORT_VIEW,
        Permission.REVIEW_FLR_ADJUST,
        Permission.REVIEW_OVERRIDE_CLASSIFICATION,
        Permission.REVIEW_REFINE_MASK,
        Permission.REVIEW_REPROMPT_LESION,
        Permission.REVIEW_SEAT_TAKEOVER,
        Permission.STUDY_VIEW,
    }),
}

STEP_UP_PERMISSIONS: frozenset[Permission] = frozenset({
    Permission.ADMIN_USER_ROLE_CHANGE,
    Permission.CLAIM_REGISTRY_ACTIVATE,
    Permission.COMPLIANCE_SIGN_OFF,
    Permission.ERASURE_APPROVE,
    Permission.ERASURE_EXECUTE,
    Permission.MBOM_UPLOAD,
    Permission.REPORT_FINALIZE,
    Permission.REPORT_RETRACT,
})

TENANT_SCOPED_PERMISSIONS: frozenset[Permission] = frozenset({
    Permission.ADMIN_TENANT_CONFIG,
    Permission.ADMIN_USER_CREATE,
    Permission.ADMIN_USER_ROLE_CHANGE,
    Permission.ANALYSIS_CANCEL,
    Permission.ANALYSIS_RETRY,
    Permission.ANALYSIS_VIEW,
    Permission.AUDIT_EXPORT,
    Permission.AUDIT_VERIFY_CHAIN,
    Permission.AUDIT_VIEW,
    Permission.ERASURE_APPROVE,
    Permission.ERASURE_EXECUTE,
    Permission.ERASURE_REQUEST,
    Permission.PACS_C_ECHO,
    Permission.PACS_CONFIG_READ,
    Permission.PACS_CONFIG_WRITE,
    Permission.REPORT_DOWNLOAD,
    Permission.REPORT_FINALIZE,
    Permission.REPORT_PACS_PUSH,
    Permission.REPORT_PACS_RETRY,
    Permission.REPORT_RETRACT,
    Permission.REPORT_VIEW,
    Permission.REVIEW_FLR_ADJUST,
    Permission.REVIEW_OVERRIDE_CLASSIFICATION,
    Permission.REVIEW_REFINE_MASK,
    Permission.REVIEW_REPROMPT_LESION,
    Permission.REVIEW_SEAT_TAKEOVER,
    Permission.STUDY_DELETE,
    Permission.STUDY_UPLOAD,
    Permission.STUDY_VIEW,
})

def role_has_permission(role: str, perm: Permission) -> bool:
    """Return True if `role` grants `perm`."""
    return perm in ROLE_PERMISSIONS.get(role, frozenset())
