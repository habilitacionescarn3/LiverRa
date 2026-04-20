# =============================================================================
# s3.tf — Imaging + audit-anchor buckets (T017)
# -----------------------------------------------------------------------------
# Per research §A.3 + §A.7:
#
#   1. liverra-imaging-eu-central-1
#      - DICOM studies + intermediate inference artifacts
#      - Versioning + Same-Region Replication (SRR) to replica bucket
#      - SSE-KMS, block public access, server access logging
#
#   2. liverra-audit-anchors-eu-central-1
#      - Daily Merkle roots of per-tenant SHA-256 audit chains
#      - S3 Object Lock COMPLIANCE mode, 6-year retention (CE MDR post-market)
#      - Cannot be deleted or shortened by anyone, including root account
# =============================================================================

# -----------------------------------------------------------------------------
# KMS key for S3 encryption (shared across imaging + audit-anchors)
# -----------------------------------------------------------------------------
resource "aws_kms_key" "s3" {
  description             = "KMS key for LiverRa S3 buckets (${var.environment})"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-s3"
  })
}

resource "aws_kms_alias" "s3" {
  name          = "alias/${local.name_prefix}-s3"
  target_key_id = aws_kms_key.s3.key_id
}

# -----------------------------------------------------------------------------
# Server-access-log bucket (holds logs from imaging + audit buckets)
# -----------------------------------------------------------------------------
resource "aws_s3_bucket" "access_logs" {
  bucket = "${local.name_prefix}-s3-access-logs-eu-central-1"

  tags = merge(local.common_tags, { Purpose = "s3-access-logs" })
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket                  = aws_s3_bucket.access_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# =============================================================================
# BUCKET 1 — liverra-imaging-eu-central-1 (primary) + replica
# =============================================================================
resource "aws_s3_bucket" "imaging" {
  bucket        = "${local.name_prefix}-imaging-eu-central-1"
  force_destroy = false # never silently drop PHI

  tags = merge(local.common_tags, { Purpose = "dicom-imaging" })
}

resource "aws_s3_bucket" "imaging_replica" {
  bucket        = "${local.name_prefix}-imaging-eu-central-1-replica"
  force_destroy = false

  tags = merge(local.common_tags, { Purpose = "dicom-imaging-replica" })
}

resource "aws_s3_bucket_versioning" "imaging" {
  bucket = aws_s3_bucket.imaging.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_versioning" "imaging_replica" {
  bucket = aws_s3_bucket.imaging_replica.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "imaging" {
  bucket = aws_s3_bucket.imaging.id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "imaging_replica" {
  bucket = aws_s3_bucket.imaging_replica.id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "imaging" {
  bucket                  = aws_s3_bucket.imaging.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "imaging_replica" {
  bucket                  = aws_s3_bucket.imaging_replica.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_logging" "imaging" {
  bucket        = aws_s3_bucket.imaging.id
  target_bucket = aws_s3_bucket.access_logs.id
  target_prefix = "imaging/"
}

# -----------------------------------------------------------------------------
# IAM role for S3 replication (same-region)
# -----------------------------------------------------------------------------
resource "aws_iam_role" "s3_replication" {
  name = "${local.name_prefix}-s3-replication"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "s3.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy" "s3_replication" {
  role = aws_iam_role.s3_replication.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetReplicationConfiguration",
          "s3:ListBucket",
          "s3:GetObjectVersionForReplication",
          "s3:GetObjectVersionAcl",
          "s3:GetObjectVersionTagging",
        ]
        Resource = [
          aws_s3_bucket.imaging.arn,
          "${aws_s3_bucket.imaging.arn}/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:ReplicateObject",
          "s3:ReplicateDelete",
          "s3:ReplicateTags",
        ]
        Resource = "${aws_s3_bucket.imaging_replica.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.s3.arn
      },
    ]
  })
}

resource "aws_s3_bucket_replication_configuration" "imaging" {
  depends_on = [
    aws_s3_bucket_versioning.imaging,
    aws_s3_bucket_versioning.imaging_replica,
  ]

  role   = aws_iam_role.s3_replication.arn
  bucket = aws_s3_bucket.imaging.id

  rule {
    id     = "full-bucket-srr"
    status = "Enabled"

    filter {}

    delete_marker_replication {
      status = "Enabled"
    }

    destination {
      bucket        = aws_s3_bucket.imaging_replica.arn
      storage_class = "STANDARD"

      encryption_configuration {
        replica_kms_key_id = aws_kms_key.s3.arn
      }
    }

    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }
  }
}

# =============================================================================
# BUCKET 2 — liverra-audit-anchors-eu-central-1 (Object Lock COMPLIANCE 6y)
# =============================================================================
resource "aws_s3_bucket" "audit_anchors" {
  bucket              = "${local.name_prefix}-audit-anchors-eu-central-1"
  object_lock_enabled = true # MUST be set at creation; cannot be toggled later
  force_destroy       = false

  tags = merge(local.common_tags, { Purpose = "audit-chain-anchors" })
}

resource "aws_s3_bucket_versioning" "audit_anchors" {
  bucket = aws_s3_bucket.audit_anchors.id
  versioning_configuration {
    status = "Enabled" # required for Object Lock
  }
}

resource "aws_s3_bucket_object_lock_configuration" "audit_anchors" {
  bucket = aws_s3_bucket.audit_anchors.id

  rule {
    default_retention {
      mode  = "COMPLIANCE" # research §A.3 — not even root can shorten
      years = 6            # CE MDR post-market surveillance window
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit_anchors" {
  bucket = aws_s3_bucket.audit_anchors.id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "audit_anchors" {
  bucket                  = aws_s3_bucket.audit_anchors.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_logging" "audit_anchors" {
  bucket        = aws_s3_bucket.audit_anchors.id
  target_bucket = aws_s3_bucket.access_logs.id
  target_prefix = "audit-anchors/"
}

output "imaging_bucket" {
  value = aws_s3_bucket.imaging.id
}

output "imaging_replica_bucket" {
  value = aws_s3_bucket.imaging_replica.id
}

output "audit_anchors_bucket" {
  value = aws_s3_bucket.audit_anchors.id
}
