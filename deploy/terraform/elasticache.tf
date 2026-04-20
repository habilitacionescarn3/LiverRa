# =============================================================================
# elasticache.tf — Redis 7 Multi-AZ replication group (T016)
# -----------------------------------------------------------------------------
# Per research §A.7:
#   - Redis 7 Multi-AZ with automatic failover (for Celery broker + cache)
#   - TLS in-transit + at-rest encryption with dedicated KMS key
#   - AOF persistence for in-flight-job recovery (pipeline_checkpoint mirror)
#   - Subnet group across the same private subnets as RDS
# =============================================================================

# -----------------------------------------------------------------------------
# KMS key for Redis at-rest encryption
# -----------------------------------------------------------------------------
resource "aws_kms_key" "elasticache" {
  description             = "KMS key for LiverRa Elasticache Redis (${var.environment})"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-redis"
  })
}

resource "aws_kms_alias" "elasticache" {
  name          = "alias/${local.name_prefix}-redis"
  target_key_id = aws_kms_key.elasticache.key_id
}

# -----------------------------------------------------------------------------
# Subnet group — same private subnets as RDS
# -----------------------------------------------------------------------------
resource "aws_elasticache_subnet_group" "liverra" {
  count       = length(var.private_subnet_ids) > 0 ? 1 : 0
  name        = "${local.name_prefix}-redis"
  description = "LiverRa Redis subnet group (Multi-AZ)"
  subnet_ids  = var.private_subnet_ids

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Parameter group — Redis 7 with AOF + notify-keyspace-events for Celery
# -----------------------------------------------------------------------------
resource "aws_elasticache_parameter_group" "liverra" {
  name        = "${local.name_prefix}-redis7"
  family      = "redis7"
  description = "LiverRa Redis 7 — AOF + Celery-friendly keyspace events"

  parameter {
    name  = "appendonly"
    value = "yes"
  }

  parameter {
    name  = "notify-keyspace-events"
    value = "Ex" # expired events — Celery periodic task cleanup
  }

  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"
  }

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Auth token for TLS in-transit authentication
# -----------------------------------------------------------------------------
resource "random_password" "redis_auth" {
  length  = 64
  special = false # Redis AUTH tokens reject punctuation
}

# -----------------------------------------------------------------------------
# Replication group — 1 primary + 1 replica across 2 AZs
# -----------------------------------------------------------------------------
resource "aws_elasticache_replication_group" "liverra" {
  replication_group_id = "${local.name_prefix}-redis"
  description          = "LiverRa Redis 7 Multi-AZ (Celery broker + cache)"

  engine                = "redis"
  engine_version        = "7.1"
  node_type             = var.environment == "prod" ? "cache.r7g.large" : "cache.t4g.small"
  port                  = 6379
  parameter_group_name  = aws_elasticache_parameter_group.liverra.name
  subnet_group_name     = length(aws_elasticache_subnet_group.liverra) > 0 ? aws_elasticache_subnet_group.liverra[0].name : null

  # Topology — Multi-AZ with automatic failover
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true

  # Encryption — TLS in-transit + at-rest
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  kms_key_id                 = aws_kms_key.elasticache.arn
  auth_token                 = random_password.redis_auth.result
  auth_token_update_strategy = "ROTATE"

  # Backups (RDB snapshot) — AOF provides the real durability
  snapshot_retention_limit = 7
  snapshot_window          = "02:00-03:00" # UTC, after RDS backup window

  # Maintenance
  maintenance_window         = "sun:04:00-sun:05:00"
  auto_minor_version_upgrade = true
  apply_immediately          = false

  # Logging
  log_delivery_configuration {
    destination      = "/aws/elasticache/${local.name_prefix}/slowlog"
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-redis"
  })

  lifecycle {
    ignore_changes = [auth_token] # rotated by Secrets Manager
  }
}

output "redis_primary_endpoint" {
  value     = aws_elasticache_replication_group.liverra.primary_endpoint_address
  sensitive = true
}

output "redis_reader_endpoint" {
  value     = aws_elasticache_replication_group.liverra.reader_endpoint_address
  sensitive = true
}
