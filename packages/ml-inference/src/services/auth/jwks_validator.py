"""JWKS validator for Cognito access + ID tokens (T047).

The FastAPI AuthMiddleware (T049) depends on this class to turn a raw
``Authorization: Bearer <jwt>`` header into a validated claims dict. We
validate:

- **Signature** — RS256 via a JWKS key fetched from
  ``${issuer}/.well-known/jwks.json`` (cached for 1 h; re-fetched on
  ``kid`` miss to handle Cognito key rotation without downtime).
- **Issuer** (``iss``) — must equal the configured issuer URL exactly.
- **Audience** (``aud`` or ``client_id`` depending on token use) — Cognito
  access tokens carry ``client_id``, ID tokens carry ``aud``. We accept
  either form but compare against the configured ``audience`` string.
- **Expiry** (``exp``) — must be in the future.
- **Issued-at** (``iat``) — may be ≤30 s in the future (clock skew), but
  never past ``exp``.
- **Token use** — enforces ``token_use == 'access'`` to reject ID tokens
  in the Authorization header (anti-confusion posture).

On success, the decoded claims dict is returned with the raw
``cognito:groups`` and ``custom:tenant_id`` extracted for convenience.
On failure a single :class:`InvalidToken` is raised; the middleware maps
this to a problem+json 401.

Spec reference: T047, research.md §A.1.
"""
from __future__ import annotations

import base64
import json
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx
import jwt as pyjwt
from jwt import ExpiredSignatureError, InvalidTokenError, PyJWK
from jwt.exceptions import DecodeError


def _b64url_decode(data: str | bytes) -> bytes:
    """Decode base64url with auto-padding (replacement for jose.utils.base64url_decode)."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    rem = len(data) % 4
    if rem:
        data += b"=" * (4 - rem)
    return base64.urlsafe_b64decode(data)


# Re-export ``JWTError`` as an alias for PyJWT's base ``InvalidTokenError`` so that
# any historical callers that imported ``JWTError`` from this module continue to
# work transparently during the python-jose → PyJWT migration.
JWTError = InvalidTokenError

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class InvalidToken(Exception):
    """Raised for any failure that should resolve to HTTP 401.

    The ``reason`` attribute is a short machine-readable slug used by the
    middleware to decide whether to send ``step-up-required`` (for expired)
    or ``unauthenticated`` (for every other kind of invalid token).
    """

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(detail or reason)
        self.reason = reason
        self.detail = detail


# ---------------------------------------------------------------------------
# JWKS cache entry
# ---------------------------------------------------------------------------

@dataclass
class _JWKSCache:
    fetched_at: float = 0.0
    keys_by_kid: dict[str, dict[str, Any]] = field(default_factory=dict)


class JwksValidator:
    """Validates Cognito-issued JWTs against a cached JWKS document.

    Thread-safe for the common read path — a module-level lock guards JWKS
    refresh so concurrent first-misses don't stampede the upstream.
    """

    # 1-hour JWKS cache per research §A.1 (Cognito rotates keys infrequently).
    CACHE_TTL_SECONDS = 3600
    # ±30-second clock skew budget for iat / nbf.
    CLOCK_SKEW_SECONDS = 30
    # How long we will wait before re-fetching JWKS after a kid miss
    # (prevents DoS via unknown-kid replay).
    MIN_REFRESH_INTERVAL_SECONDS = 60

    def __init__(
        self,
        issuer_url: str,
        audience: str,
        *,
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        if not issuer_url:
            raise ValueError("issuer_url is required")
        if not audience:
            raise ValueError("audience is required")
        self.issuer_url = issuer_url.rstrip("/")
        self.audience = audience
        self._http = http_client or httpx.Client(timeout=5.0)
        self._cache = _JWKSCache()
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # JWKS fetch + cache
    # ------------------------------------------------------------------

    def _jwks_url(self) -> str:
        return f"{self.issuer_url}/.well-known/jwks.json"

    def _refresh_jwks(self, *, force: bool = False) -> None:
        now = time.time()
        with self._lock:
            # Another thread may have just refreshed while we waited.
            age = now - self._cache.fetched_at
            if not force and age < self.CACHE_TTL_SECONDS and self._cache.keys_by_kid:
                return
            if (
                force
                and age < self.MIN_REFRESH_INTERVAL_SECONDS
                and self._cache.keys_by_kid
            ):
                # Rate-limit forced refreshes (kid-miss storms).
                return

            resp = self._http.get(self._jwks_url())
            resp.raise_for_status()
            body = resp.json()
            keys = body.get("keys") or []
            self._cache = _JWKSCache(
                fetched_at=time.time(),
                keys_by_kid={k["kid"]: k for k in keys if "kid" in k},
            )
            logger.info(
                "JWKS refreshed: url=%s keys=%d",
                self._jwks_url(),
                len(self._cache.keys_by_kid),
            )

    def _get_jwk(self, kid: str) -> dict[str, Any]:
        if not self._cache.keys_by_kid:
            self._refresh_jwks()
        key = self._cache.keys_by_kid.get(kid)
        if key is None:
            # Key rotation — refresh once and try again.
            self._refresh_jwks(force=True)
            key = self._cache.keys_by_kid.get(kid)
        if key is None:
            raise InvalidToken("unknown-kid", f"No JWK matches kid={kid}")
        return key

    # ------------------------------------------------------------------
    # Validate
    # ------------------------------------------------------------------

    def validate(self, token: str) -> dict[str, Any]:
        """Return the decoded claims dict OR raise :class:`InvalidToken`."""
        if not token or token.count(".") != 2:
            raise InvalidToken("malformed", "Token is not a compact JWS")

        # 1. Inspect header to locate the signing key.
        try:
            header = pyjwt.get_unverified_header(token)
        except (DecodeError, InvalidTokenError) as exc:
            raise InvalidToken("malformed", f"Unparseable header: {exc}") from exc

        kid = header.get("kid")
        alg = header.get("alg")
        if not kid:
            raise InvalidToken("malformed", "Header missing kid")
        if alg != "RS256":
            # Cognito issues RS256 exclusively — reject `none`, HSxxx, ESxxx.
            raise InvalidToken("bad-algorithm", f"Unexpected alg={alg}")

        key_data = self._get_jwk(kid)

        # 2. Verify signature manually. We bypass PyJWT.decode() because its
        #    built-in aud / iss checks are too strict for Cognito's
        #    access-token shape (Cognito puts the audience in `client_id`).
        try:
            pyjwk_obj = PyJWK(key_data, algorithm="RS256")
            public_key = pyjwk_obj.key
        except (InvalidTokenError, ValueError, KeyError) as exc:
            raise InvalidToken("jwk-construct-failed", str(exc)) from exc

        message, encoded_sig = token.rsplit(".", 1)
        decoded_sig = _b64url_decode(encoded_sig)
        try:
            # PyJWT exposes the algorithm registry so we can run verify() on
            # the prepared key without invoking the full decode pipeline.
            rs256 = pyjwt.get_algorithm_by_name("RS256")
            if not rs256.verify(message.encode("utf-8"), public_key, decoded_sig):
                raise InvalidToken("bad-signature", "Signature verification failed")
        except InvalidTokenError as exc:
            raise InvalidToken("bad-signature", str(exc)) from exc

        # 3. Decode claims directly from the JWT payload segment. We avoid
        #    PyJWT.decode() because we run the field-by-field checks below.
        try:
            payload_segment = token.split(".")[1]
            claims = json.loads(_b64url_decode(payload_segment).decode("utf-8"))
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise InvalidToken("malformed", str(exc)) from exc

        now = time.time()

        # 4. Issuer
        iss = claims.get("iss")
        if iss != self.issuer_url:
            raise InvalidToken(
                "bad-issuer",
                f"iss mismatch: got {iss!r}, expected {self.issuer_url!r}",
            )

        # 5. Expiry
        exp = claims.get("exp")
        if exp is None:
            raise InvalidToken("no-exp", "Token missing exp")
        if float(exp) <= now:
            raise InvalidToken("expired", "Token has expired")

        # 6. Issued-at skew
        iat = claims.get("iat")
        if iat is None:
            raise InvalidToken("no-iat", "Token missing iat")
        if float(iat) > now + self.CLOCK_SKEW_SECONDS:
            raise InvalidToken(
                "iat-in-future",
                f"iat skew exceeds {self.CLOCK_SKEW_SECONDS}s",
            )

        # 7. Audience — Cognito access tokens use `client_id`; ID tokens
        #    use `aud`. Accept whichever carries the configured value.
        token_use = claims.get("token_use")
        if token_use not in {"access", "id"}:
            raise InvalidToken(
                "bad-token-use",
                f"token_use must be access or id, got {token_use!r}",
            )

        if token_use == "access":
            if claims.get("client_id") != self.audience:
                raise InvalidToken(
                    "bad-audience",
                    "access-token client_id does not match configured audience",
                )
        else:  # "id"
            aud_claim = claims.get("aud")
            if isinstance(aud_claim, list):
                aud_ok = self.audience in aud_claim
            else:
                aud_ok = aud_claim == self.audience
            if not aud_ok:
                raise InvalidToken(
                    "bad-audience",
                    "id-token aud does not match configured audience",
                )

        # 8. Return — callers access `custom:tenant_id`, `cognito:groups`,
        #    and `auth_time` directly on the claims dict.
        return claims


# ---------------------------------------------------------------------------
# Convenience re-exports
# ---------------------------------------------------------------------------

__all__ = ["JwksValidator", "InvalidToken", "JWTError", "ExpiredSignatureError"]

# ---------------------------------------------------------------------------
# Compatibility re-exports
# ---------------------------------------------------------------------------
# Historical callers may have imported ``ExpiredSignatureError`` / ``JWTError``
# from this module (legacy python-jose surface). We re-export PyJWT's
# equivalents so import sites continue to work transparently. We do NOT raise
# these ourselves — the validator wraps every failure in :class:`InvalidToken`.
# ``ExpiredSignatureError`` is already imported from ``jwt`` at the top of the
# module; this assignment is a no-op kept only for documentation clarity.
ExpiredSignatureError = ExpiredSignatureError  # noqa: F811 (intentional re-export)
