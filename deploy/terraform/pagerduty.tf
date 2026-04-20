# T382 — PagerDuty escalation + alert routing.
#
# Plain-English:
#   Two PagerDuty services feed from Prometheus AlertManager:
#
#     1. liverra-critical  — primary on-call, 5-min escalation to
#                            secondary, then to the engineering manager.
#                            Pages 24×7.
#     2. liverra-warning   — primary on-call only, business hours,
#                            auto-resolves after 4 h without escalation.
#
#   AlertManager routes by alert name:
#     chain-tampering           → critical
#     phi-scrubber-failures > 0 → critical
#     queue-depth > 20          → warning
#     cecho-failure-rate > 10%  → warning
#
# Maps to plan §Alerts and research §A.6 (Observability unified scrubber).

terraform {
  required_providers {
    pagerduty = {
      source  = "PagerDuty/pagerduty"
      version = "~> 3.13"
    }
  }
}

variable "pagerduty_token" {
  description = "PagerDuty API token (expects read/write scope)"
  type        = string
  sensitive   = true
}

variable "escalation_primary_email" {
  description = "Primary on-call PagerDuty user email"
  type        = string
}

variable "escalation_secondary_email" {
  description = "Secondary on-call PagerDuty user email"
  type        = string
}

variable "escalation_manager_email" {
  description = "Engineering manager fallback email"
  type        = string
}

provider "pagerduty" {
  token = var.pagerduty_token
}

# ---------------------------------------------------------------------
# Users — lookup by email (managed outside TF by HR).
# ---------------------------------------------------------------------

data "pagerduty_user" "primary" {
  email = var.escalation_primary_email
}

data "pagerduty_user" "secondary" {
  email = var.escalation_secondary_email
}

data "pagerduty_user" "manager" {
  email = var.escalation_manager_email
}

# ---------------------------------------------------------------------
# Critical escalation: primary → (5 min) → secondary → (15 min) → manager
# ---------------------------------------------------------------------

resource "pagerduty_escalation_policy" "liverra_critical" {
  name      = "LiverRa — Critical 24x7"
  num_loops = 2

  rule {
    escalation_delay_in_minutes = 5
    target {
      type = "user_reference"
      id   = data.pagerduty_user.primary.id
    }
  }
  rule {
    escalation_delay_in_minutes = 15
    target {
      type = "user_reference"
      id   = data.pagerduty_user.secondary.id
    }
  }
  rule {
    escalation_delay_in_minutes = 30
    target {
      type = "user_reference"
      id   = data.pagerduty_user.manager.id
    }
  }
}

# ---------------------------------------------------------------------
# Warning escalation: primary only, business-hours cadence.
# ---------------------------------------------------------------------

resource "pagerduty_escalation_policy" "liverra_warning" {
  name      = "LiverRa — Warning (business hours)"
  num_loops = 1

  rule {
    escalation_delay_in_minutes = 30
    target {
      type = "user_reference"
      id   = data.pagerduty_user.primary.id
    }
  }
}

# ---------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------

resource "pagerduty_service" "liverra_critical" {
  name                    = "liverra-critical"
  description             = "Critical alerts — audit chain, PHI exposure, data-loss risks"
  auto_resolve_timeout    = "null" # manual ack required
  acknowledgement_timeout = 600
  escalation_policy       = pagerduty_escalation_policy.liverra_critical.id
  alert_creation          = "create_alerts_and_incidents"

  incident_urgency_rule {
    type    = "constant"
    urgency = "high"
  }
}

resource "pagerduty_service" "liverra_warning" {
  name                    = "liverra-warning"
  description             = "Warning alerts — queue saturation, PACS backoff, recoverable errors"
  auto_resolve_timeout    = 14400 # 4 h
  acknowledgement_timeout = 1800
  escalation_policy       = pagerduty_escalation_policy.liverra_warning.id
  alert_creation          = "create_alerts_and_incidents"

  incident_urgency_rule {
    type    = "constant"
    urgency = "low"
  }
}

# ---------------------------------------------------------------------
# Integrations — Prometheus AlertManager pushes to each service via the
# generic Events API v2 integration key.
# ---------------------------------------------------------------------

resource "pagerduty_service_integration" "alertmanager_critical" {
  name    = "AlertManager — critical"
  service = pagerduty_service.liverra_critical.id
  type    = "events_api_v2_inbound_integration"
}

resource "pagerduty_service_integration" "alertmanager_warning" {
  name    = "AlertManager — warning"
  service = pagerduty_service.liverra_warning.id
  type    = "events_api_v2_inbound_integration"
}

# ---------------------------------------------------------------------
# Event rules — route by Prometheus alertname.
#
# Critical → chain-tampering, phi-scrubber-failures
# Warning  → queue-depth, cecho-failure-rate, pacs-backoff-saturation
# ---------------------------------------------------------------------

resource "pagerduty_event_orchestration" "liverra" {
  name        = "LiverRa AlertManager orchestration"
  description = "Routes Prometheus alerts to critical vs warning services"
}

resource "pagerduty_event_orchestration_router" "liverra" {
  event_orchestration = pagerduty_event_orchestration.liverra.id

  set {
    id = "start"

    rule {
      label = "chain-tampering → critical"
      condition {
        expression = "event.custom_details.alertname matches \"chain-tampering\""
      }
      actions {
        route_to = pagerduty_service.liverra_critical.id
      }
    }

    rule {
      label = "phi-scrubber-failures → critical"
      condition {
        expression = "event.custom_details.alertname matches \"phi-scrubber-failures\""
      }
      actions {
        route_to = pagerduty_service.liverra_critical.id
      }
    }

    rule {
      label = "queue-depth → warning"
      condition {
        expression = "event.custom_details.alertname matches \"queue-depth-high\""
      }
      actions {
        route_to = pagerduty_service.liverra_warning.id
      }
    }

    rule {
      label = "cecho-failure-rate → warning"
      condition {
        expression = "event.custom_details.alertname matches \"cecho-failure-rate-high\""
      }
      actions {
        route_to = pagerduty_service.liverra_warning.id
      }
    }

    rule {
      label = "pacs-backoff-saturation → warning"
      condition {
        expression = "event.custom_details.alertname matches \"pacs-backoff-saturation\""
      }
      actions {
        route_to = pagerduty_service.liverra_warning.id
      }
    }
  }

  catch_all {
    actions {
      route_to = pagerduty_service.liverra_warning.id
    }
  }
}

# ---------------------------------------------------------------------
# Outputs — pushed into AWS Secrets Manager by a downstream CI step so
# AlertManager config can read the integration keys without TF state
# access.
# ---------------------------------------------------------------------

output "critical_integration_key" {
  value     = pagerduty_service_integration.alertmanager_critical.integration_key
  sensitive = true
}

output "warning_integration_key" {
  value     = pagerduty_service_integration.alertmanager_warning.integration_key
  sensitive = true
}

output "critical_service_id" {
  value = pagerduty_service.liverra_critical.id
}

output "warning_service_id" {
  value = pagerduty_service.liverra_warning.id
}
