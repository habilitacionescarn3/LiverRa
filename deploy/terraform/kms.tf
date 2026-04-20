# =============================================================================
# kms.tf — Per-case KMS alias template + Secrets Manager entries (T018)
# -----------------------------------------------------------------------------
# Per research §A.1 + §X.1 (crypto-shred):
#
#   Per-case KMS keys enable GDPR Article 17 crypto-shred erasure in < 1 hour
#   without rewriting S3 objects. Each patient case gets a dedicated CMK,
#   aliased `alias/liverra/case/<case-uuid>`. Deleting the CMK renders all
#   DICOM + report ciphertext permanently unreadable.
#
#   NOTE: Actual per-case CMKs are created at ingest time by the Python
#   `crypto_shred_service.py` (Phase 11). This file documents the naming
#   contract only — NOT declaring thousands of keys in Terraform.
# =============================================================================

# -----------------------------------------------------------------------------
# Template / documentation-only alias. Real aliases follow the
# alias/liverra/case/<uuid> pattern at runtime.
#
# This sentinel exists so `terraform plan` surfaces the alias prefix
# allocation and operators can grep for it; it is NOT used by application
# code.
# -----------------------------------------------------------------------------
resource "aws_kms_key" "case_template_sentinel" {
  description             = "SENTINEL — documents per-case alias pattern. Not used for encryption. Per-case CMKs are created by crypto_shred_service at ingest time under alias/liverra/case/<uuid>."
  deletion_window_in_days = 7
  enable_key_rotation     = false

  tags = merge(local.common_tags, {
    Name    = "${local.name_prefix}-case-sentinel"
    Purpose = "alias-pattern-documentation"
  })
}

resource "aws_kms_alias" "case_template_sentinel" {
  # Alias pattern: alias/liverra/case/<uuid-v4>
  # This sentinel pins the namespace so no other system can claim it.
  name          = "alias/liverra/case/_sentinel"
  target_key_id = aws_kms_key.case_template_sentinel.key_id
}

# =============================================================================
# Secrets Manager entries — bootstrap placeholders
# -----------------------------------------------------------------------------
# Rotation Lambdas are attached in a later phase by the security agent.
# Here we only declare the secret envelopes so application code has a
# stable ARN to reference via env var (LIVERRA_UID_ROOT_SECRET_ARN etc.).
# =============================================================================

# -----------------------------------------------------------------------------
# LIVERRA_UID_ROOT — DICOM UID root prefix (e.g. 1.2.826.0.1.3680043.<assigned>)
# Provisioned once, never rotated (UID roots are immutable by DICOM standard).
# -----------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "uid_root" {
  name        = "liverra/uid-root"
  description = "DICOM UID root prefix for LiverRa-generated SOP/Series/Study UIDs. Format: '1.2.826.0.1.3680043.X' where X is the DICOM Standards Committee-assigned node."

  kms_key_id              = aws_kms_key.s3.arn
  recovery_window_in_days = 30

  tags = merge(local.common_tags, {
    Purpose = "dicom-uid-root"
  })
}

# -----------------------------------------------------------------------------
# MEDPLUM_CLIENT_SECRET — if FHIR layer runs on Medplum Cloud (vs self-hosted)
# -----------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "medplum_client_secret" {
  name        = "liverra/medplum-client-secret"
  description = "Medplum Cloud OAuth client secret. Rotated quarterly by rotation Lambda (Phase 2). Null if self-hosted FHIR is chosen instead."

  kms_key_id              = aws_kms_key.s3.arn
  recovery_window_in_days = 30

  tags = merge(local.common_tags, {
    Purpose = "medplum-oauth"
  })
}

# -----------------------------------------------------------------------------
# COGNITO_CLIENT_SECRET — mirrors the secret baked into the app client
# -----------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "cognito_client_secret" {
  name        = "liverra/cognito-client-secret"
  description = "AWS Cognito app client secret (mirrors aws_cognito_user_pool_client.liverra_web). Kept here so backend services can fetch via a stable ARN instead of reading the Cognito resource directly."

  kms_key_id              = aws_kms_key.s3.arn
  recovery_window_in_days = 30

  tags = merge(local.common_tags, {
    Purpose = "cognito-oauth"
  })
}

# Seed the Cognito secret with the generated client secret so the app can
# bootstrap on first deploy. Rotation is handled by Cognito's own rotation
# flow + a pre-token-gen Lambda in a later phase.
resource "aws_secretsmanager_secret_version" "cognito_client_secret" {
  secret_id = aws_secretsmanager_secret.cognito_client_secret.id
  secret_string = jsonencode({
    client_id     = aws_cognito_user_pool_client.liverra_web.id
    client_secret = aws_cognito_user_pool_client.liverra_web.client_secret
    user_pool_id  = aws_cognito_user_pool.liverra.id
    issuer        = "https://cognito-idp.eu-central-1.amazonaws.com/${aws_cognito_user_pool.liverra.id}"
  })
}

output "secret_uid_root_arn" {
  value = aws_secretsmanager_secret.uid_root.arn
}

output "secret_medplum_arn" {
  value = aws_secretsmanager_secret.medplum_client_secret.arn
}

output "secret_cognito_arn" {
  value = aws_secretsmanager_secret.cognito_client_secret.arn
}
