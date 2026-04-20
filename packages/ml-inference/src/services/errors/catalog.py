# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Canonical RFC 7807 Problem-Details catalogue (T405).

Plain-English:
    Every error the API emits needs a machine-readable "slug" so the
    frontend can map it to a concrete UX action (open the step-up
    modal, show a toast, bounce to a retry banner, etc.). This module
    owns that list and provides a helper that builds the exact
    ``application/problem+json`` body from RFC 7807.

Why a fixed enum?
    FR-032a (cross-tenant non-disclosure) + FR-028a (bypass hardening)
    both require that every error path use a vetted string. A typo in
    ``type`` field silently breaks error-handling in the frontend.
    Using an ``Enum`` makes any new slug a visible code change.

References:
    - plan.md §Error Handling & Resilience §Server-side
    - spec.md §FR-032a (forbidden slug surfaced as not-found)
"""
from __future__ import annotations

import logging
from enum import Enum
from typing import Any, Dict, Optional
from uuid import UUID

try:  # pragma: no cover — FastAPI is a hard dep at runtime, not tests
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse

    _FASTAPI_AVAILABLE = True
except ImportError:  # pragma: no cover
    FastAPI = None  # type: ignore[assignment]
    Request = None  # type: ignore[assignment]
    JSONResponse = None  # type: ignore[assignment]
    _FASTAPI_AVAILABLE = False


logger = logging.getLogger(__name__)


class ErrorSlug(str, Enum):
    """All canonical error types. Values become the tail of the
    ``type`` field: ``https://liverra.ai/errors/<slug>``.

    18 slugs total — the 17 defined in plan.md §Error Handling plus
    ``rate-limit-exceeded`` (added in T408 for slowapi 429 responses).
    """

    NOT_FOUND = "not-found"
    FORBIDDEN = "forbidden"  # internal only; rendered as NOT_FOUND externally
    VALIDATION = "validation"
    STEP_UP_REQUIRED = "step-up-required"
    SEAT_TAKEN = "seat-taken"
    ANALYSIS_EXPIRED = "analysis-expired"
    ANALYSIS_FAILED = "analysis-failed"
    ANALYSIS_TIMEOUT = "analysis-timeout"
    ANALYSIS_IMPLAUSIBLE_OUTPUT = "analysis-implausible-output"
    PACS_UNREACHABLE = "pacs-unreachable"
    PACS_REJECTED = "pacs-rejected"
    RUO_ACCEPTANCE_REQUIRED = "ruo-acceptance-required"
    LICENSE_HASH_DRIFT = "license-hash-drift"
    AUDIT_WRITE_FAILED = "audit-write-failed"
    SCRUBBER_FAILED = "scrubber-failed"
    ERASURE_IN_PROGRESS = "erasure-in-progress"
    ERASURE_MFA_STALE = "erasure-mfa-stale"
    RATE_LIMIT_EXCEEDED = "rate-limit-exceeded"


# Human-readable titles per slug (kept short; detail carries the specifics).
_DEFAULT_TITLES: Dict[ErrorSlug, str] = {
    ErrorSlug.NOT_FOUND: "Not Found",
    ErrorSlug.FORBIDDEN: "Forbidden",
    ErrorSlug.VALIDATION: "Validation Failed",
    ErrorSlug.STEP_UP_REQUIRED: "Step-Up Authentication Required",
    ErrorSlug.SEAT_TAKEN: "Reviewer Seat Taken",
    ErrorSlug.ANALYSIS_EXPIRED: "Analysis Expired",
    ErrorSlug.ANALYSIS_FAILED: "Analysis Failed",
    ErrorSlug.ANALYSIS_TIMEOUT: "Analysis Timed Out",
    ErrorSlug.ANALYSIS_IMPLAUSIBLE_OUTPUT: "Analysis Produced Implausible Output",
    ErrorSlug.PACS_UNREACHABLE: "PACS Unreachable",
    ErrorSlug.PACS_REJECTED: "PACS Rejected Push",
    ErrorSlug.RUO_ACCEPTANCE_REQUIRED: "RUO Disclaimer Acceptance Required",
    ErrorSlug.LICENSE_HASH_DRIFT: "Model License Hash Drift Detected",
    ErrorSlug.AUDIT_WRITE_FAILED: "Audit Write Failed",
    ErrorSlug.SCRUBBER_FAILED: "PHI Scrubber Failure",
    ErrorSlug.ERASURE_IN_PROGRESS: "GDPR Erasure In Progress",
    ErrorSlug.ERASURE_MFA_STALE: "Erasure MFA Token Stale",
    ErrorSlug.RATE_LIMIT_EXCEEDED: "Rate Limit Exceeded",
}


LIVERRA_ERROR_TYPE_PREFIX = "https://liverra.ai/errors/"


def problem_detail(
    slug: ErrorSlug,
    status: int,
    detail: str,
    instance: str,
    tenant_id: Optional[UUID] = None,
    claim_key: Optional[str] = None,
    title: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build an RFC 7807 ``application/problem+json`` body.

    - ``slug`` — enum value; stringified into ``type`` field.
    - ``status`` — HTTP status code.
    - ``detail`` — PHI-scrubbed human explanation. Callers MUST NOT
      include MRN, patient names, study UIDs, etc.
    - ``instance`` — AuditEvent UUID (or any UUID that identifies
      this request). Shown to the user as an "incident reference".
    - ``tenant_id`` / ``claim_key`` — optional extensions per plan.

    Example:
        >>> problem_detail(ErrorSlug.NOT_FOUND, 404, "Resource missing.",
        ...                instance="abc")
        {'type': 'https://liverra.ai/errors/not-found', 'title': 'Not Found', ...}
    """
    body: Dict[str, Any] = {
        "type": f"{LIVERRA_ERROR_TYPE_PREFIX}{slug.value}",
        "title": title or _DEFAULT_TITLES.get(slug, slug.value),
        "status": int(status),
        "detail": detail,
        "instance": instance,
    }
    if tenant_id is not None:
        body["x-tenant-id"] = str(tenant_id)
    if claim_key is not None:
        body["x-claim-key"] = claim_key
    if extra:
        body.update(extra)
    return body


class ProblemDetailException(Exception):
    """Raise from any route to short-circuit into a problem+json response.

    Usage::

        raise ProblemDetailException(
            ErrorSlug.SEAT_TAKEN, 409, "Another reviewer is editing.",
            instance=str(audit_event_id),
        )
    """

    def __init__(
        self,
        slug: ErrorSlug,
        status: int,
        detail: str,
        instance: str,
        tenant_id: Optional[UUID] = None,
        claim_key: Optional[str] = None,
        title: Optional[str] = None,
        headers: Optional[Dict[str, str]] = None,
    ):
        super().__init__(f"{slug.value}: {detail}")
        self.slug = slug
        self.status = int(status)
        self.detail = detail
        self.instance = instance
        self.tenant_id = tenant_id
        self.claim_key = claim_key
        self.title = title
        self.headers = headers or {}

    def to_body(self) -> Dict[str, Any]:
        return problem_detail(
            slug=self.slug,
            status=self.status,
            detail=self.detail,
            instance=self.instance,
            tenant_id=self.tenant_id,
            claim_key=self.claim_key,
            title=self.title,
        )


async def _problem_exception_handler(request: "Request", exc: ProblemDetailException):  # type: ignore[name-defined]
    """FastAPI exception handler — emits ``application/problem+json``."""
    body = exc.to_body()
    headers = dict(exc.headers)
    # FR-032a: forbidden responses MUST render as not-found externally.
    # The internal body keeps the real slug for audit; we override only
    # the outbound representation for status=403.
    if exc.slug is ErrorSlug.FORBIDDEN:
        body = problem_detail(
            slug=ErrorSlug.NOT_FOUND,
            status=404,
            detail="Resource not found.",
            instance=exc.instance,
        )
        status_code = 404
    else:
        status_code = exc.status

    if JSONResponse is None:  # pragma: no cover
        raise RuntimeError("FastAPI is required to render problem+json")
    return JSONResponse(
        content=body,
        status_code=status_code,
        media_type="application/problem+json",
        headers=headers,
    )


def register_exception_handler(app: Any) -> None:
    """Attach the problem-detail handler to a FastAPI app.

    Safe to call multiple times. No-op if FastAPI isn't importable
    (e.g. in a unit-test stub environment).
    """
    if not _FASTAPI_AVAILABLE or app is None:  # pragma: no cover
        return
    app.add_exception_handler(ProblemDetailException, _problem_exception_handler)


__all__ = [
    "ErrorSlug",
    "LIVERRA_ERROR_TYPE_PREFIX",
    "ProblemDetailException",
    "problem_detail",
    "register_exception_handler",
]
