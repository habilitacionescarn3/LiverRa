# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""AWS SES adapter (T281, T435).

Plain-English:
    Sends transactional emails (invite, analysis complete, PACS failed,
    etc.) through AWS SES. Every template is:
      - rendered by Jinja2 from `templates/{locale}/{name}.html`
      - PHI-clean (no patient identifiers — only case ids & action URLs)
      - DKIM-signed by SES at the MAIL FROM level
    Before sending, we always consult ``notification_preference`` — if
    the recipient opted out of this template, we log a
    ``notification_suppressed`` metric and skip the send (T435).

Cross-refs:
    - research.md §A.5 (SES notification architecture)
    - spec.md §FR-039 (admin invite email)
    - data-model.md §NotificationPreference
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional
from uuid import UUID

from jinja2 import Environment, FileSystemLoader, select_autoescape
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

SUPPORTED_LOCALES = ("en", "de", "ka")
TEMPLATE_ROOT = Path(__file__).parent / "templates"


@dataclass(frozen=True)
class SendOutcome:
    sent: bool
    message_id: Optional[str]
    suppressed_reason: Optional[str] = None


class SESAdapter:
    """Thin boto3-ses client + Jinja2 renderer + opt-out guard."""

    def __init__(
        self,
        *,
        ses_client: Any = None,
        from_address: str,
        configuration_set: Optional[str] = None,
    ) -> None:
        self._ses = ses_client
        self._from = from_address
        self._cfg_set = configuration_set
        self._env = Environment(
            loader=FileSystemLoader(str(TEMPLATE_ROOT)),
            autoescape=select_autoescape(["html", "xml"]),
            lstrip_blocks=True,
            trim_blocks=True,
        )

    # ------------------------------------------------------------------
    # Factory
    # ------------------------------------------------------------------

    @classmethod
    def from_app_state(cls, state: Any) -> "SESAdapter":
        existing = getattr(state, "ses_adapter", None)
        if isinstance(existing, cls):
            return existing
        ses_client = getattr(state, "ses_client", None)
        if ses_client is None:
            try:
                import boto3  # type: ignore

                ses_client = boto3.client(
                    "sesv2",
                    region_name=os.environ.get("AWS_REGION", "eu-central-1"),
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("boto3 SES unavailable (%s) — using dry-run mode", exc)
                ses_client = None
        return cls(
            ses_client=ses_client,
            from_address=os.environ.get(
                "LIVERRA_SES_FROM", "noreply@notify.liverra.ai"
            ),
            configuration_set=os.environ.get("LIVERRA_SES_CONFIG_SET"),
        )

    # ------------------------------------------------------------------
    # Opt-out (T435)
    # ------------------------------------------------------------------

    async def _opted_out(
        self,
        session: AsyncSession,
        *,
        email: str,
        template: str,
    ) -> bool:
        try:
            r = await session.execute(
                text(
                    """
                    SELECT 1 FROM notification_preference np
                    JOIN "user" u ON u.id = np.user_id
                    WHERE u.email = :email
                      AND np.event_type = :evt
                      AND np.opted_out = true
                    LIMIT 1
                    """
                ),
                {"email": email.strip().lower(), "evt": template},
            )
            return r.first() is not None
        except Exception as exc:  # noqa: BLE001
            logger.debug("opt-out check skipped: %s", exc)
            return False

    # ------------------------------------------------------------------
    # Render + send
    # ------------------------------------------------------------------

    def _render(self, template: str, locale: str, ctx: dict[str, Any]) -> tuple[str, str]:
        """Return (html_body, subject) for the template."""
        if locale not in SUPPORTED_LOCALES:
            locale = "en"
        tpl = self._env.get_template(f"{locale}/{template}.html")
        rendered = tpl.render(**ctx)
        # Convention: subject is in the first <title> tag, or a metadata block.
        subject = ctx.get("subject") or _extract_subject(rendered) or template.replace("_", " ").title()
        return rendered, subject

    async def send(
        self,
        *,
        session: AsyncSession,
        to: str,
        template: str,
        locale: str,
        ctx: dict[str, Any],
        tenant_id: Optional[UUID] = None,
    ) -> SendOutcome:
        # T435: honour opt-out preferences first.
        if await self._opted_out(session, email=to, template=template):
            logger.info(
                "notification_suppressed",
                extra={"template": template, "tenant_id": str(tenant_id) if tenant_id else None},
            )
            return SendOutcome(sent=False, message_id=None, suppressed_reason="opted_out")

        body_html, subject = self._render(template, locale, ctx)

        if self._ses is None:  # dev/test path
            logger.info(
                "SES dry-run: to=%s template=%s subject=%s", _mask(to), template, subject
            )
            return SendOutcome(sent=True, message_id="dryrun-0000")

        params: dict[str, Any] = {
            "FromEmailAddress": self._from,
            "Destination": {"ToAddresses": [to]},
            "Content": {
                "Simple": {
                    "Subject": {"Data": subject, "Charset": "UTF-8"},
                    "Body": {"Html": {"Data": body_html, "Charset": "UTF-8"}},
                }
            },
        }
        if self._cfg_set:
            params["ConfigurationSetName"] = self._cfg_set
        resp = self._ses.send_email(**params)
        return SendOutcome(sent=True, message_id=resp.get("MessageId"))


def _extract_subject(html: str) -> Optional[str]:
    # Cheap title-tag extraction — avoids a full HTML parser dependency here.
    low = html.lower()
    i = low.find("<title>")
    j = low.find("</title>")
    if i != -1 and j != -1 and j > i:
        return html[i + 7 : j].strip()
    return None


def _mask(email: str) -> str:
    """Audit-friendly email mask (never log PHI addresses)."""
    if "@" not in email:
        return "***"
    local, _, domain = email.partition("@")
    return f"{local[:1]}***@{domain}"
