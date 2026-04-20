# =============================================================================
# variables.tf — Input variables shared by all modules
# -----------------------------------------------------------------------------
# Names are always scoped by ${var.environment} (dev / staging / prod) so
# multi-environment deployments don't collide on global resource names
# (S3 buckets, Cognito pool domains, SES identities).
# =============================================================================

variable "environment" {
  description = "Deployment environment (dev, staging, prod). Scopes all resource names."
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "tenant_id" {
  description = "LiverRa tenant identifier (hospital / customer). Used for tagging + Cognito custom attribute scoping. Single-tenant deployments in Phase 1 per plan.md."
  type        = string
  default     = "default"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,62}$", var.tenant_id))
    error_message = "tenant_id must be lowercase alphanumeric with hyphens, 2-63 chars."
  }
}

variable "liverra_domain" {
  description = "Base public domain for LiverRa tenant (used for SES identity + Cognito callback URLs)."
  type        = string
  default     = "liverra.ai"
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone ID for liverra_domain. Required for SES DKIM/SPF/DMARC records. Placeholder — populate after zone creation."
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# Cognito hook placeholders (wired up by the auth agent in a later phase)
# -----------------------------------------------------------------------------
variable "backup_codes_lambda_arn" {
  description = "DEPRECATED — kept for module-compat; Lambda is now built in-repo (see aws_lambda_function.cognito_backup_codes). Leave as null."
  type        = string
  default     = null
}

variable "pre_token_generation_lambda_arn" {
  description = "ARN of Lambda that injects tenant_id + role claims into JWT. Null during initial scaffold."
  type        = string
  default     = null
}

variable "cognito_backup_codes_database_url" {
  description = "DATABASE_URL for the backup-codes Lambda (psycopg DSN form). Production deployments MUST source this from Secrets Manager via a data block; this variable exists so the module can be driven from terraform.tfvars during bootstrap."
  type        = string
  default     = ""
  sensitive   = true
}

variable "cognito_backup_codes_subnet_ids" {
  description = "Private subnet IDs for the backup-codes Lambda's VPC config (required in prod to reach RDS). Leave empty to deploy the Lambda without VPC attachment (dev only)."
  type        = list(string)
  default     = []
}

variable "cognito_backup_codes_security_group_ids" {
  description = "Security groups for the backup-codes Lambda. Must allow egress to the RDS security group on 5432."
  type        = list(string)
  default     = []
}

# -----------------------------------------------------------------------------
# Networking placeholders (filled by a later VPC module)
# -----------------------------------------------------------------------------
variable "vpc_id" {
  description = "VPC ID for RDS + Elasticache placement. Placeholder — wire up once VPC module lands."
  type        = string
  default     = null
}

variable "private_subnet_ids" {
  description = "Private subnet IDs (Multi-AZ) for RDS + Elasticache subnet groups."
  type        = list(string)
  default     = []
}

# -----------------------------------------------------------------------------
# Derived locals
# -----------------------------------------------------------------------------
locals {
  name_prefix = "${var.environment}-liverra"

  common_tags = {
    Project     = "LiverRa"
    Environment = var.environment
    TenantId    = var.tenant_id
    ManagedBy   = "Terraform"
  }
}
