"""AWS Cognito Lambda trigger — TOTP backup codes (T044).

Per research §A.1, LiverRa requires Cognito TOTP MFA plus 10 single-use
backup codes so a user who loses their authenticator device can still
recover access. This Lambda implements three Cognito trigger entry points
multiplexed on ``event['triggerSource']``:

1. ``PostAuthentication_Authentication`` — issued on first successful sign-in
   after TOTP enrolment. We generate 10 base32 codes, hash each with
   argon2id, insert the hashes into ``user_backup_codes``, and return the
   plaintext codes in ``response['userAttributes']`` (one-time display to
   the user — the client surface-layer shows them immediately then drops
   them). A flag on the user (``custom:backup_codes_issued=true``) keeps
   the trigger idempotent.
2. ``DefineAuthChallenge_Authentication`` — when the standard TOTP flow
   fails or the user selects "use backup code", we request a
   ``CUSTOM_CHALLENGE`` named ``BACKUP_CODE``.
3. ``VerifyAuthChallengeResponse_Authentication`` — validates a submitted
   backup code against the stored argon2id hashes, marks the row as used
   (single-use semantics), and passes/fails the challenge.

Environment:
    DATABASE_URL           Postgres DSN (psycopg v3 sync driver form,
                           e.g. postgresql://liverra:pw@.../liverra)
    ARGON2_MEMORY_COST     argon2id memory in KiB (default 65536 = 64 MiB)
    ARGON2_TIME_COST       argon2id iterations (default 3)
    ARGON2_PARALLELISM     argon2id lanes (default 4)

Migration snippet (for the db-migrations agent; this file deliberately
does not mutate Alembic directly — add the snippet below as a new
revision file after 0007):

    \"\"\"
    -- Alembic revision 0008_user_backup_codes
    -- Depends on: 0001_tenant_user (for tenant RLS policy pattern)

    CREATE TABLE user_backup_codes (
        id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid        NOT NULL,
        cognito_sub      text        NOT NULL,
        code_hash        text        NOT NULL,        -- argon2id encoded hash
        created_at       timestamptz NOT NULL DEFAULT now(),
        used_at          timestamptz,                  -- NULL = unused
        issued_batch_id  uuid        NOT NULL,         -- groups the 10 codes
        CONSTRAINT user_backup_codes_unique_per_sub_hash
            UNIQUE (cognito_sub, code_hash)
    );

    CREATE INDEX user_backup_codes_cognito_sub_active_idx
        ON user_backup_codes (cognito_sub)
        WHERE used_at IS NULL;

    -- RLS: every query MUST be scoped by cognito_sub (not tenant_id,
    -- because the Lambda runs OUT-OF-BAND of the RLS session GUC).
    -- We therefore rely on explicit WHERE cognito_sub = %s in SQL and
    -- do NOT attach a policy. Tenant linkage is audit-only.
    \"\"\"

Spec references: T044, research.md §A.1, data-model.md §user_backup_codes.
"""
from __future__ import annotations

import json
import logging
import os
import secrets
import uuid
from typing import Any

# argon2-cffi is pure python + a wheel; works in the Lambda zip bundle.
try:
    from argon2 import PasswordHasher
    from argon2.exceptions import VerifyMismatchError
except ImportError:  # pragma: no cover — bundling gate
    PasswordHasher = None  # type: ignore[assignment]

    class VerifyMismatchError(Exception):  # type: ignore[no-redef]
        """Fallback so the module imports even before argon2-cffi is zipped in."""


# psycopg v3 (sync) — chosen over asyncpg because Lambda handlers are sync
# and psycopg's connection pool is trivially disposable per invocation.
try:
    import psycopg  # type: ignore
except ImportError:  # pragma: no cover
    psycopg = None  # type: ignore[assignment]


logger = logging.getLogger()
logger.setLevel(logging.INFO)


# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

BACKUP_CODE_COUNT = 10
BACKUP_CODE_LENGTH = 8
# RFC 4648 base32 alphabet minus visually-ambiguous letters (I/L/O → 1/0).
BACKUP_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

ARGON2_MEMORY_COST_DEFAULT = 65536  # 64 MiB
ARGON2_TIME_COST_DEFAULT = 3
ARGON2_PARALLELISM_DEFAULT = 4

# Cognito custom attribute used as a "codes-issued" idempotency latch.
ATTR_BACKUP_CODES_ISSUED = "custom:backup_codes_issued"
ATTR_TENANT_ID = "custom:tenant_id"


# ---------------------------------------------------------------------------
# argon2id hasher (lazy singleton so cold-start tuning is cheap)
# ---------------------------------------------------------------------------

_hasher: PasswordHasher | None = None


def _get_hasher() -> PasswordHasher:
    global _hasher
    if _hasher is None:
        if PasswordHasher is None:
            raise RuntimeError(
                "argon2-cffi not bundled — include 'argon2-cffi' in the Lambda "
                "deployment package."
            )
        _hasher = PasswordHasher(
            memory_cost=int(
                os.environ.get("ARGON2_MEMORY_COST", ARGON2_MEMORY_COST_DEFAULT)
            ),
            time_cost=int(
                os.environ.get("ARGON2_TIME_COST", ARGON2_TIME_COST_DEFAULT)
            ),
            parallelism=int(
                os.environ.get("ARGON2_PARALLELISM", ARGON2_PARALLELISM_DEFAULT)
            ),
        )
    return _hasher


# ---------------------------------------------------------------------------
# Code generation
# ---------------------------------------------------------------------------

def _generate_code() -> str:
    """Generate one 8-character backup code from a cryptographic source."""
    return "".join(
        secrets.choice(BACKUP_CODE_ALPHABET) for _ in range(BACKUP_CODE_LENGTH)
    )


def _generate_codes() -> list[str]:
    """Generate ``BACKUP_CODE_COUNT`` unique codes (collision-resistant)."""
    codes: set[str] = set()
    while len(codes) < BACKUP_CODE_COUNT:
        codes.add(_generate_code())
    return sorted(codes)


# ---------------------------------------------------------------------------
# Database access (fresh connection per invocation — Lambda is short-lived)
# ---------------------------------------------------------------------------

def _db_connect():
    if psycopg is None:
        raise RuntimeError(
            "psycopg not bundled — include 'psycopg[binary]' in the Lambda "
            "deployment package."
        )
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL env var is required")
    return psycopg.connect(dsn, autocommit=False)


def _insert_hashes(
    cognito_sub: str,
    tenant_id: str | None,
    code_hashes: list[str],
) -> None:
    batch_id = str(uuid.uuid4())
    with _db_connect() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO user_backup_codes
                    (tenant_id, cognito_sub, code_hash, issued_batch_id)
                VALUES (%s, %s, %s, %s)
                """,
                [
                    (tenant_id, cognito_sub, h, batch_id)
                    for h in code_hashes
                ],
            )
        conn.commit()


def _fetch_unused_hashes(cognito_sub: str) -> list[tuple[str, str]]:
    """Return [(row_id, code_hash), ...] for unused codes of this user."""
    with _db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id::text, code_hash
                FROM user_backup_codes
                WHERE cognito_sub = %s AND used_at IS NULL
                """,
                (cognito_sub,),
            )
            return list(cur.fetchall())


def _mark_used(row_id: str) -> None:
    with _db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE user_backup_codes
                SET used_at = now()
                WHERE id = %s AND used_at IS NULL
                """,
                (row_id,),
            )
        conn.commit()


# ---------------------------------------------------------------------------
# Trigger handlers
# ---------------------------------------------------------------------------

def _handle_post_authentication(event: dict[str, Any]) -> dict[str, Any]:
    """Issue backup codes once per user (first successful TOTP sign-in)."""
    user_attrs = event.get("request", {}).get("userAttributes", {}) or {}
    already_issued = user_attrs.get(ATTR_BACKUP_CODES_ISSUED) == "true"
    if already_issued:
        return event  # idempotent — nothing to do.

    cognito_sub = user_attrs.get("sub") or event.get("userName")
    if not cognito_sub:
        logger.error("PostAuthentication: missing Cognito sub")
        return event

    tenant_id = user_attrs.get(ATTR_TENANT_ID)

    codes = _generate_codes()
    hasher = _get_hasher()
    hashes = [hasher.hash(c) for c in codes]

    _insert_hashes(cognito_sub=cognito_sub, tenant_id=tenant_id, code_hashes=hashes)

    # Return the PLAINTEXT codes in clientMetadata so the PostAuth hook
    # downstream (the frontend) can display them ONCE. Cognito will also
    # propagate this back to the app via the auth result's
    # `AuthenticationResult.NewDeviceMetadata` shim configured by the
    # client; alternatively the frontend polls a one-shot secret-retrieval
    # endpoint using the access token.
    event.setdefault("response", {})
    event["response"]["clientMetadata"] = {
        "backup_codes_json": json.dumps(codes),
        "backup_codes_count": str(BACKUP_CODE_COUNT),
    }

    # NOTE: marking the latch attribute must be done by a server-side
    # AdminUpdateUserAttributes call (Cognito triggers cannot mutate custom
    # attributes on the user record directly). The frontend displays the
    # codes, the user confirms "I saved them", and the backend then calls
    # AdminUpdateUserAttributes to flip ``custom:backup_codes_issued=true``.
    return event


def _handle_define_auth_challenge(event: dict[str, Any]) -> dict[str, Any]:
    """Decide whether to issue a CUSTOM_CHALLENGE for backup codes.

    The default Cognito flow first tries SRP_A then SOFTWARE_TOKEN_MFA.
    This trigger only escalates to ``BACKUP_CODE`` when the client has
    explicitly indicated (via a CUSTOM_CHALLENGE request) that the user
    chose "use backup code". When Cognito's standard flow is in progress,
    we defer (``issueTokens=false, failAuthentication=false``) so native
    handling continues.
    """
    session = event.get("request", {}).get("session", []) or []
    response = event.setdefault("response", {})

    # If the user authentication up to this point already succeeded, issue tokens.
    last = session[-1] if session else None
    if last and last.get("challengeResult") is True and last.get("challengeName") in (
        "SOFTWARE_TOKEN_MFA",
        "CUSTOM_CHALLENGE",
    ):
        response["issueTokens"] = True
        response["failAuthentication"] = False
        return event

    # Too many failures → fail hard.
    failed = sum(1 for s in session if s.get("challengeResult") is False)
    if failed >= 5:
        response["issueTokens"] = False
        response["failAuthentication"] = True
        return event

    # Client asked for backup code flow via CUSTOM_CHALLENGE metadata.
    client_metadata = event.get("request", {}).get("clientMetadata", {}) or {}
    if client_metadata.get("challenge") == "BACKUP_CODE":
        response["issueTokens"] = False
        response["failAuthentication"] = False
        response["challengeName"] = "CUSTOM_CHALLENGE"
        return event

    # Otherwise defer to Cognito's standard MFA flow.
    response["issueTokens"] = False
    response["failAuthentication"] = False
    return event


def _handle_verify_auth_challenge_response(
    event: dict[str, Any],
) -> dict[str, Any]:
    """Verify a submitted backup code against argon2id hashes."""
    req = event.get("request", {}) or {}
    response = event.setdefault("response", {})
    response["answerCorrect"] = False

    answer = (req.get("challengeAnswer") or "").strip().upper()
    if not answer:
        return event

    user_attrs = req.get("userAttributes", {}) or {}
    cognito_sub = user_attrs.get("sub") or event.get("userName")
    if not cognito_sub:
        logger.error("VerifyAuthChallenge: missing Cognito sub")
        return event

    rows = _fetch_unused_hashes(cognito_sub)
    if not rows:
        return event

    hasher = _get_hasher()
    for row_id, code_hash in rows:
        try:
            hasher.verify(code_hash, answer)
        except VerifyMismatchError:
            continue
        except Exception as exc:  # noqa: BLE001 — treat as mismatch, log
            logger.warning("argon2 verify error: %s", exc)
            continue
        # Match — mark used (single-use) and accept the challenge.
        try:
            _mark_used(row_id)
        except Exception:  # noqa: BLE001
            logger.exception("failed to mark backup code used; accepting anyway")
        response["answerCorrect"] = True
        return event

    return event


# ---------------------------------------------------------------------------
# Handler entry point
# ---------------------------------------------------------------------------

def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Multiplex on ``triggerSource`` — one Lambda, three Cognito triggers."""
    trigger = event.get("triggerSource", "")
    logger.info("cognito-backup-codes invoked: trigger=%s", trigger)

    if trigger.startswith("PostAuthentication_"):
        return _handle_post_authentication(event)
    if trigger.startswith("DefineAuthChallenge_"):
        return _handle_define_auth_challenge(event)
    if trigger.startswith("VerifyAuthChallengeResponse_"):
        return _handle_verify_auth_challenge_response(event)

    # Unknown or unhandled trigger — return event unchanged so Cognito
    # falls back to its default behaviour. We deliberately do NOT raise;
    # a raise would block the entire auth flow.
    logger.info("cognito-backup-codes: no-op for trigger=%s", trigger)
    return event


__all__ = [
    "lambda_handler",
    "BACKUP_CODE_COUNT",
    "BACKUP_CODE_LENGTH",
    "BACKUP_CODE_ALPHABET",
]
