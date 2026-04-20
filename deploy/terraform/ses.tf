# =============================================================================
# ses.tf — AWS SES sending identity + DKIM/SPF/DMARC (T019)
# -----------------------------------------------------------------------------
# Per research §A.5:
#   - AWS SES in eu-central-1 (GDPR residency)
#   - Domain identity: liverra.ai
#   - From address: notifications@liverra.ai
#   - DKIM: 3 CNAME records published to Route 53
#   - SPF: TXT record authorizing amazonses.com
#   - DMARC: TXT record at _dmarc.liverra.ai (p=quarantine initially, tighten
#     to p=reject once bounce hygiene is proven in prod)
#   - Bounce/complaint feedback via SNS → Celery (wired up Phase 2)
# =============================================================================

# -----------------------------------------------------------------------------
# Domain identity
# -----------------------------------------------------------------------------
resource "aws_ses_domain_identity" "liverra" {
  domain = var.liverra_domain
}

# DKIM — SES auto-generates 3 CNAME tokens
resource "aws_ses_domain_dkim" "liverra" {
  domain = aws_ses_domain_identity.liverra.domain
}

# MAIL FROM subdomain — improves deliverability by aligning the bounce
# address domain with the From domain
resource "aws_ses_domain_mail_from" "liverra" {
  domain           = aws_ses_domain_identity.liverra.domain
  mail_from_domain = "bounce.${var.liverra_domain}"
}

# =============================================================================
# Route 53 records — DKIM + SPF + DMARC + MAIL FROM MX
# -----------------------------------------------------------------------------
# NOTE: All r53 resources are gated on var.route53_zone_id being non-null.
# If the zone is managed elsewhere (e.g. Cloudflare), operators publish these
# records manually using the outputs below.
# =============================================================================

# -----------------------------------------------------------------------------
# DKIM — 3 CNAME records
# -----------------------------------------------------------------------------
resource "aws_route53_record" "dkim" {
  count = var.route53_zone_id != null ? 3 : 0

  zone_id = var.route53_zone_id
  name    = "${aws_ses_domain_dkim.liverra.dkim_tokens[count.index]}._domainkey.${var.liverra_domain}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_ses_domain_dkim.liverra.dkim_tokens[count.index]}.dkim.amazonses.com"]
}

# -----------------------------------------------------------------------------
# SPF — authorizes amazonses.com to send on behalf of liverra.ai
# -----------------------------------------------------------------------------
resource "aws_route53_record" "spf" {
  count = var.route53_zone_id != null ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.liverra_domain
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com -all"]
}

# -----------------------------------------------------------------------------
# DMARC — quarantine policy initially; tighten to p=reject in prod Phase 2
# -----------------------------------------------------------------------------
resource "aws_route53_record" "dmarc" {
  count = var.route53_zone_id != null ? 1 : 0

  zone_id = var.route53_zone_id
  name    = "_dmarc.${var.liverra_domain}"
  type    = "TXT"
  ttl     = 600
  records = [
    "v=DMARC1; p=${var.environment == "prod" ? "quarantine" : "none"}; rua=mailto:dmarc-reports@${var.liverra_domain}; ruf=mailto:dmarc-forensic@${var.liverra_domain}; fo=1; adkim=s; aspf=s"
  ]
}

# -----------------------------------------------------------------------------
# MAIL FROM — MX + SPF for the bounce.liverra.ai subdomain
# -----------------------------------------------------------------------------
resource "aws_route53_record" "mail_from_mx" {
  count = var.route53_zone_id != null ? 1 : 0

  zone_id = var.route53_zone_id
  name    = aws_ses_domain_mail_from.liverra.mail_from_domain
  type    = "MX"
  ttl     = 600
  records = ["10 feedback-smtp.eu-central-1.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  count = var.route53_zone_id != null ? 1 : 0

  zone_id = var.route53_zone_id
  name    = aws_ses_domain_mail_from.liverra.mail_from_domain
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com -all"]
}

# =============================================================================
# Email identity (from address) + configuration set for bounce/complaint SNS
# =============================================================================
resource "aws_ses_email_identity" "notifications" {
  email = "notifications@${var.liverra_domain}"
}

resource "aws_ses_configuration_set" "liverra" {
  name = "${local.name_prefix}-default"

  reputation_metrics_enabled = true
  sending_enabled            = true

  delivery_options {
    tls_policy = "Require"
  }
}

# -----------------------------------------------------------------------------
# Outputs — expose DKIM tokens for operators using external DNS
# -----------------------------------------------------------------------------
output "ses_dkim_tokens" {
  description = "3 DKIM tokens. If Route 53 is not used, publish these as CNAME records manually: <token>._domainkey.liverra.ai -> <token>.dkim.amazonses.com"
  value       = aws_ses_domain_dkim.liverra.dkim_tokens
}

output "ses_domain_verification_token" {
  value = aws_ses_domain_identity.liverra.verification_token
}

output "ses_from_address" {
  value = aws_ses_email_identity.notifications.email
}

output "ses_configuration_set" {
  value = aws_ses_configuration_set.liverra.name
}
