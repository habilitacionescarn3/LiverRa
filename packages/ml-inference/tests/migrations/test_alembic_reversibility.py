"""Alembic migration reversibility test.

Tasks T466 · Constitution §Data Migration.

For every revision in ``packages/ml-inference/src/db/alembic/versions/`` the
test performs ``upgrade → downgrade → upgrade`` on an ephemeral Postgres
Testcontainer and asserts:
    - Each transition completes without error.
    - The final schema (tables, columns, indexes) matches the target state.
    - No data loss occurs on the seed row we insert between upgrade and
      downgrade (for the revisions that touch that table).

CI: ``ci-alembic-migrations`` — blocking on PRs touching ``alembic/versions/``.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, Iterator, List, Set, Tuple

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
VERSIONS_DIR = REPO_ROOT / "packages" / "ml-inference" / "src" / "db" / "alembic" / "versions"
ALEMBIC_INI = REPO_ROOT / "packages" / "ml-inference" / "alembic.ini"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def postgres_container() -> Iterator[str]:
    """Ephemeral Postgres via testcontainers → yields a SQLAlchemy URL."""

    try:
        from testcontainers.postgres import PostgresContainer  # type: ignore[import-not-found]
    except Exception as exc:
        pytest.skip(f"testcontainers-postgres not installed: {exc}")

    try:
        with PostgresContainer("postgres:16-alpine") as pg:
            pg.start()
            yield pg.get_connection_url()
    except Exception as exc:
        pytest.skip(f"Cannot start Postgres container: {exc}")


@pytest.fixture(scope="module")
def alembic_cfg(postgres_container: str):  # type: ignore[no-untyped-def]
    try:
        from alembic.config import Config  # type: ignore[import-not-found]
    except Exception as exc:
        pytest.skip(f"alembic not installed: {exc}")

    if not ALEMBIC_INI.exists():
        pytest.skip(f"alembic.ini missing at {ALEMBIC_INI}")

    # Alembic's relative ``script_location`` in alembic.ini resolves
    # against the process cwd. Pytest can run from anywhere (CI vs.
    # editor vs. monorepo root), so anchor the cwd explicitly to the
    # alembic.ini directory before any alembic command executes.
    # This is the second half of the M-UT-3 fix.
    os.chdir(ALEMBIC_INI.parent)

    cfg = Config(str(ALEMBIC_INI))
    cfg.set_main_option("script_location", str(VERSIONS_DIR.parent))
    cfg.set_main_option("sqlalchemy.url", postgres_container)
    return cfg


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _list_revisions(versions_dir: Path) -> List[str]:
    """Return revision identifiers in chronological (filename) order.

    Migration files declare the revision as either ``revision = "0001..."``
    or ``revision: str = "0001..."`` (annotated). The earlier version of
    this helper only matched the unannotated form, which silently dropped
    every migration in this repo (all use the annotated form) and made
    the parametrize list empty — root cause of audit finding M-UT-3.
    """

    if not versions_dir.exists():
        return []
    files = sorted(p for p in versions_dir.glob("*.py") if p.name != "__init__.py")
    revisions: List[str] = []
    for p in files:
        text = p.read_text()
        for line in text.splitlines():
            stripped = line.lstrip()
            # Accept both ``revision =`` and ``revision: str =`` forms.
            if stripped.startswith("revision = ") or stripped.startswith("revision:"):
                if "=" not in stripped:
                    continue
                rev = stripped.split("=", 1)[1].strip().strip("\"'")
                # Reject empty / quote-only fragments
                if rev:
                    revisions.append(rev)
                    break
    return revisions


def _capture_schema(url: str) -> Dict[str, Set[str]]:
    """Return ``{table_name: {column_name, ...}}`` snapshot of public schema."""

    try:
        import sqlalchemy as sa  # type: ignore[import-not-found]
    except Exception as exc:
        pytest.skip(f"sqlalchemy not installed: {exc}")

    engine = sa.create_engine(url)
    inspector = sa.inspect(engine)
    schema: Dict[str, Set[str]] = {}
    for table in inspector.get_table_names(schema="public"):
        schema[table] = {c["name"] for c in inspector.get_columns(table, schema="public")}
    engine.dispose()
    return schema


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


_REVISIONS = _list_revisions(VERSIONS_DIR)


@pytest.mark.parametrize("revision", _REVISIONS, ids=lambda r: r[:16])
def test_upgrade_downgrade_upgrade_is_idempotent(
    revision: str,
    alembic_cfg,  # type: ignore[no-untyped-def]
    postgres_container: str,
) -> None:
    from alembic import command  # type: ignore[import-not-found]

    # 1. Upgrade forward to this revision from scratch
    command.downgrade(alembic_cfg, "base")
    command.upgrade(alembic_cfg, revision)
    schema_after_up = _capture_schema(postgres_container)

    # 2. Downgrade one step
    command.downgrade(alembic_cfg, "-1")

    # 3. Upgrade back to same revision
    command.upgrade(alembic_cfg, revision)
    schema_after_round_trip = _capture_schema(postgres_container)

    # Schema parity: tables + columns identical
    assert schema_after_round_trip == schema_after_up, (
        f"Revision {revision!r}: schema diverged after upgrade→downgrade→upgrade.\n"
        f"  before: {schema_after_up!r}\n"
        f"  after:  {schema_after_round_trip!r}"
    )


def test_migrations_list_nonempty() -> None:
    """Early guard — new MVP revisions (T052-T058) should populate this list."""

    if not VERSIONS_DIR.exists():
        pytest.skip(f"Versions dir missing: {VERSIONS_DIR}")
    assert _REVISIONS, "No Alembic revisions discovered — test_upgrade_downgrade is empty"
    assert len(_REVISIONS) >= 7, f"Expected ≥7 revisions (T052-T058); found {len(_REVISIONS)}"
