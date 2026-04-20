# =============================================================================
# cognito.tf — AWS Cognito user pool (T015)
# -----------------------------------------------------------------------------
# Per research §A.1:
#   - eu-central-1 user pool (GDPR residency)
#   - TOTP MFA REQUIRED for all users (no SMS — SS7 hijack + EU delivery cost)
#   - custom:tenant_id required attribute (injected into JWT via pre-token-gen
#     Lambda; wired in variables.tf:pre_token_generation_lambda_arn)
#   - Per-tenant federation (SAML/OIDC) attached out-of-band by auth agent.
#   - Backup codes (10 single-use) issued via custom Lambda trigger
#     (variables.tf:backup_codes_lambda_arn) — FR-014 Zero-training MVP.
# =============================================================================

resource "aws_cognito_user_pool" "liverra" {
  name = "${local.name_prefix}-users"

  # ---------------------------------------------------------------------------
  # MFA configuration — TOTP required (software authenticator apps only)
  # ---------------------------------------------------------------------------
  mfa_configuration = "ON"

  software_token_mfa_configuration {
    enabled = true
  }

  # Explicitly disable SMS MFA (SS7 hijack risk + EU delivery cost)
  # aws_cognito_user_pool does not expose an sms_mfa=false flag; omitting
  # the sms_configuration block disables SMS by default.

  # ---------------------------------------------------------------------------
  # Password policy — NIST 800-63B + BSI TR-03116 aligned
  # ---------------------------------------------------------------------------
  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 3
  }

  # ---------------------------------------------------------------------------
  # Account recovery — email only (no SMS)
  # ---------------------------------------------------------------------------
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  # ---------------------------------------------------------------------------
  # Schema: required custom:tenant_id for every user
  # ---------------------------------------------------------------------------
  schema {
    name                     = "tenant_id"
    attribute_data_type      = "String"
    required                 = false # Cognito forbids required=true on custom attrs
    mutable                  = false # immutable once set — prevents cross-tenant hop
    developer_only_attribute = false

    string_attribute_constraints {
      min_length = 1
      max_length = 64
    }
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true

    string_attribute_constraints {
      min_length = 3
      max_length = 254
    }
  }

  # ---------------------------------------------------------------------------
  # Username config — email as username, case-insensitive
  # ---------------------------------------------------------------------------
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  username_configuration {
    case_sensitive = false
  }

  # ---------------------------------------------------------------------------
  # Lambda triggers — wired to the in-repo backup-codes Lambda (T044/T045)
  # plus the out-of-band pre-token-generation Lambda (injected via variable)
  # ---------------------------------------------------------------------------
  lambda_config {
    pre_sign_up                    = aws_lambda_function.cognito_backup_codes.arn
    post_authentication            = aws_lambda_function.cognito_backup_codes.arn
    define_auth_challenge          = aws_lambda_function.cognito_backup_codes.arn
    verify_auth_challenge_response = aws_lambda_function.cognito_backup_codes.arn
    create_auth_challenge          = aws_lambda_function.cognito_backup_codes.arn
    pre_token_generation           = var.pre_token_generation_lambda_arn
  }

  # ---------------------------------------------------------------------------
  # Deletion protection (prod only — dev/staging may need tear-down)
  # ---------------------------------------------------------------------------
  deletion_protection = var.environment == "prod" ? "ACTIVE" : "INACTIVE"

  tags = local.common_tags
}

# =============================================================================
# App client — OIDC Authorization Code flow (no implicit, no client_credentials
# for user-facing app)
# =============================================================================
resource "aws_cognito_user_pool_client" "liverra_web" {
  name         = "${local.name_prefix}-web"
  user_pool_id = aws_cognito_user_pool.liverra.id

  generate_secret = true # secret stored in Secrets Manager (see kms.tf)

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]

  supported_identity_providers = ["COGNITO"]

  callback_urls = [
    "https://${var.environment}.${var.liverra_domain}/auth/callback",
  ]
  logout_urls = [
    "https://${var.environment}.${var.liverra_domain}/auth/logout",
  ]

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  # Token lifetimes — short access token, sliding refresh
  access_token_validity  = 60     # 1 hour
  id_token_validity      = 60     # 1 hour
  refresh_token_validity = 30     # 30 days
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
}

# =============================================================================
# Backup-codes Lambda (T044/T045) — three Cognito triggers in one function
# -----------------------------------------------------------------------------
# Source:  packages/ml-inference/src/lambda/cognito-backup-codes.py
# Runtime: Python 3.11
# Secrets: DATABASE_URL wired via AWS Secrets Manager / SSM (out-of-band);
#          placeholder here references a variable so the module stays decoupled.
# =============================================================================

data "archive_file" "cognito_backup_codes" {
  type        = "zip"
  source_file = "${path.module}/../../packages/ml-inference/src/lambda/cognito-backup-codes.py"
  output_path = "${path.module}/.build/cognito-backup-codes.zip"
}

resource "aws_iam_role" "cognito_backup_codes" {
  name = "${local.name_prefix}-cognito-backup-codes"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "cognito_backup_codes_basic" {
  role       = aws_iam_role.cognito_backup_codes.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# VPC access so the Lambda can reach RDS Postgres in a private subnet.
resource "aws_iam_role_policy_attachment" "cognito_backup_codes_vpc" {
  role       = aws_iam_role.cognito_backup_codes.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_lambda_function" "cognito_backup_codes" {
  function_name = "${local.name_prefix}-cognito-backup-codes"
  role          = aws_iam_role.cognito_backup_codes.arn
  handler       = "cognito-backup-codes.lambda_handler"
  runtime       = "python3.11"
  timeout       = 10
  memory_size   = 512

  filename         = data.archive_file.cognito_backup_codes.output_path
  source_code_hash = data.archive_file.cognito_backup_codes.output_base64sha256

  environment {
    variables = {
      DATABASE_URL        = var.cognito_backup_codes_database_url
      ARGON2_MEMORY_COST  = "65536"
      ARGON2_TIME_COST    = "3"
      ARGON2_PARALLELISM  = "4"
    }
  }

  # VPC config is supplied via a variable so this module can be used both
  # standalone (no VPC — dev) and in production (RDS in private subnets).
  dynamic "vpc_config" {
    for_each = length(var.cognito_backup_codes_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.cognito_backup_codes_subnet_ids
      security_group_ids = var.cognito_backup_codes_security_group_ids
    }
  }

  tags = local.common_tags
}

resource "aws_lambda_permission" "cognito_backup_codes_invoke" {
  statement_id  = "AllowCognitoInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cognito_backup_codes.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.liverra.arn
}

output "cognito_backup_codes_lambda_arn" {
  value = aws_lambda_function.cognito_backup_codes.arn
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.liverra.id
}

output "cognito_user_pool_arn" {
  value = aws_cognito_user_pool.liverra.arn
}

output "cognito_web_client_id" {
  value = aws_cognito_user_pool_client.liverra_web.id
}
