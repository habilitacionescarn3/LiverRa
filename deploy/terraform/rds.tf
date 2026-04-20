# =============================================================================
# rds.tf — RDS Postgres 16 Multi-AZ (T016)
# -----------------------------------------------------------------------------
# Per research §A.7:
#   - Postgres 16 Multi-AZ (eu-central-1a + eu-central-1b failover)
#   - 5-min Point-In-Time-Recovery via continuous WAL shipping
#   - 35-day backup retention (near-maximum for CE MDR post-market audit)
#   - Storage encrypted with per-environment KMS key
#   - deletion_protection=true (prod); final_snapshot on destroy
#   - Parameter group forces TLS + logs all DDL for audit-chain reconstruction
# =============================================================================

# -----------------------------------------------------------------------------
# KMS key dedicated to RDS storage encryption
# -----------------------------------------------------------------------------
resource "aws_kms_key" "rds" {
  description             = "KMS key for LiverRa RDS storage + snapshots (${var.environment})"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-rds"
  })
}

resource "aws_kms_alias" "rds" {
  name          = "alias/${local.name_prefix}-rds"
  target_key_id = aws_kms_key.rds.key_id
}

# -----------------------------------------------------------------------------
# DB subnet group — Multi-AZ private subnets
# -----------------------------------------------------------------------------
resource "aws_db_subnet_group" "liverra" {
  count       = length(var.private_subnet_ids) > 0 ? 1 : 0
  name        = "${local.name_prefix}-db"
  description = "LiverRa Postgres subnet group (Multi-AZ)"
  subnet_ids  = var.private_subnet_ids

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Parameter group — Postgres 16, TLS required, audit-friendly logging
# -----------------------------------------------------------------------------
resource "aws_db_parameter_group" "liverra" {
  name        = "${local.name_prefix}-pg16"
  family      = "postgres16"
  description = "LiverRa Postgres 16 tuning + audit logging"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_statement"
    value = "ddl"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "500" # ms — slow-query threshold
  }

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Password — ephemeral random; rotate via Secrets Manager rotation Lambda
# (wired up out-of-band by security agent)
# -----------------------------------------------------------------------------
resource "random_password" "rds_master" {
  length      = 32
  special     = true
  min_lower   = 2
  min_upper   = 2
  min_numeric = 2
  min_special = 2
  override_special = "!#$%^&*()-_=+[]{}"
}

# -----------------------------------------------------------------------------
# Primary DB instance
# -----------------------------------------------------------------------------
resource "aws_db_instance" "liverra" {
  identifier     = "${local.name_prefix}-pg"
  engine         = "postgres"
  engine_version = "16.4"
  instance_class = var.environment == "prod" ? "db.r6g.xlarge" : "db.t4g.medium"

  # Storage
  allocated_storage     = 100
  max_allocated_storage = 1000
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.rds.arn

  # Credentials
  db_name  = "liverra"
  username = "liverra_admin"
  password = random_password.rds_master.result

  # Networking
  db_subnet_group_name = length(aws_db_subnet_group.liverra) > 0 ? aws_db_subnet_group.liverra[0].name : null
  publicly_accessible  = false
  # vpc_security_group_ids wired up once security module lands

  # High availability — Multi-AZ synchronous standby
  multi_az = true

  # Backups — 35-day retention + 5-min PITR (default continuous WAL shipping)
  backup_retention_period   = 35
  backup_window             = "01:00-02:00" # UTC — quiet hour for EU
  maintenance_window        = "sun:03:00-sun:04:00"
  copy_tags_to_snapshot     = true
  delete_automated_backups  = false
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name_prefix}-pg-final-${formatdate("YYYYMMDD-hhmm", timestamp())}"

  # Monitoring
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.rds.arn
  performance_insights_retention_period = 7
  monitoring_interval                   = 60
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]

  # Parameters
  parameter_group_name = aws_db_parameter_group.liverra.name

  # Protection
  deletion_protection      = var.environment == "prod"
  auto_minor_version_upgrade = true
  apply_immediately          = false

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-pg"
  })

  lifecycle {
    ignore_changes = [
      # final_snapshot_identifier uses timestamp() → always diffs; ignore
      final_snapshot_identifier,
      # Password rotation handled by Secrets Manager Lambda
      password,
    ]
  }
}

output "rds_endpoint" {
  value     = aws_db_instance.liverra.endpoint
  sensitive = true
}

output "rds_arn" {
  value = aws_db_instance.liverra.arn
}
