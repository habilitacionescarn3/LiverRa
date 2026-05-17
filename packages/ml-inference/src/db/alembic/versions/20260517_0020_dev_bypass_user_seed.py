"""dev-bypass user + tenant seed (idempotent).

Revision ID: 0020_dev_bypass_user_seed
Revises: 0019_reviewer_marker
Create Date: 2026-05-17

Plain-English:
    When `LIVERRA_AUTH_BYPASS=true` (local dev + staging gates), the auth
    middleware synthesizes a request.state.user with id
    ``00000000-0000-0000-0000-0000000000aa`` and tenant_id
    ``00000000-0000-0000-0000-000000000001``. Any handler that writes a
    row keyed on user_id (surgeon_review.user_id, reviewer_marker.
    created_by, ...) will FK-violate if those two rows don't exist.

    Seat acquire silently 500s otherwise, which blocks the refine page,
    the marker tool, every classification override, and FLR edits.
    Discovered the hard way via a Playwright run.

    The migration is idempotent (ON CONFLICT DO NOTHING on both inserts)
    so re-running it is safe, and it skips itself in production where
    LIVERRA_AUTH_BYPASS is forbidden (auth_middleware.py:128) — those
    UUIDs are never used outside dev anyway, so a no-op seed there is
    harmless.

    Why a migration and not a one-shot seed script: the dev workflow
    runs alembic upgrade head as part of `make dev` and the local
    Docker stack. A seed script would be a separate manual step the
    next person on the project misses, as I did.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0020_dev_bypass_user_seed"
down_revision: Union[str, None] = "0019_reviewer_marker"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Mirror the constants in src/middleware/auth_middleware.py — keep these
# in sync if those values ever change (they shouldn't).
DEV_TENANT_ID = "00000000-0000-0000-0000-000000000001"
DEV_USER_ID = "00000000-0000-0000-0000-0000000000aa"


def upgrade() -> None:
    # Tenant first — the user FKs to it.
    op.execute(
        f"""
        INSERT INTO tenant (id, name, status, locale_default)
        VALUES ('{DEV_TENANT_ID}', 'LiverRa Local Dev', 'active', 'en')
        ON CONFLICT (id) DO NOTHING
        """
    )
    op.execute(
        f"""
        INSERT INTO "user" (id, tenant_id, cognito_sub, email, role)
        VALUES (
            '{DEV_USER_ID}',
            '{DEV_TENANT_ID}',
            '{DEV_USER_ID}',
            'dev@liverra.local',
            'hpb_surgeon'
        )
        ON CONFLICT (id) DO NOTHING
        """
    )


def downgrade() -> None:
    # No-op — removing the dev user from production would be wrong; from
    # dev it's harmless to leave. If a fresh start is needed, drop the
    # database and re-run upgrade head.
    pass
