# =============================================================================
# providers.tf — AWS provider + remote state backend
# -----------------------------------------------------------------------------
# All LiverRa infrastructure runs in eu-central-1 (Frankfurt) per GDPR data
# residency requirements (research.md §A.1, Constitution Principle VII).
# No multi-region replication outside the EU is permitted in Phase 1.
#
# Remote state backend is commented out until the bootstrap S3 bucket +
# DynamoDB lock table are created out-of-band (chicken-and-egg problem).
# Operator workflow:
#   1. `aws s3api create-bucket --bucket liverra-tfstate-eu-central-1 ...`
#   2. `aws dynamodb create-table --table-name liverra-tfstate-lock ...`
#   3. Uncomment the backend "s3" block below and run `terraform init`.
# =============================================================================

provider "aws" {
  region = "eu-central-1"

  default_tags {
    tags = {
      Project     = "LiverRa"
      Environment = var.environment
      TenantId    = var.tenant_id
      ManagedBy   = "Terraform"
      Compliance  = "GDPR-CE-MDR"
      DataClass   = "PHI"
    }
  }
}

# -----------------------------------------------------------------------------
# Remote state backend (uncomment after bootstrap bucket + lock table exist)
# -----------------------------------------------------------------------------
# terraform {
#   backend "s3" {
#     bucket         = "liverra-tfstate-eu-central-1"
#     key            = "envs/${var.environment}/terraform.tfstate"
#     region         = "eu-central-1"
#     encrypt        = true
#     kms_key_id     = "alias/liverra/tfstate"   # placeholder — create KMS key
#     dynamodb_table = "liverra-tfstate-lock"
#   }
# }

# -----------------------------------------------------------------------------
# Data sources used across modules
# -----------------------------------------------------------------------------
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
