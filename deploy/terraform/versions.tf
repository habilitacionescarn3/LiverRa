# =============================================================================
# versions.tf — Terraform + provider version pinning
# -----------------------------------------------------------------------------
# LiverRa Phase 1 infrastructure scaffold.
# Pin versions explicitly so terraform plan output is reproducible across
# CI, operator workstations, and on-prem deployments (required for CE MDR
# audit trail of infrastructure provenance).
# =============================================================================

terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }

    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
