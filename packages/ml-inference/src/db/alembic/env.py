"""Alembic async environment for LiverRa (T051).

Reads ``DATABASE_URL`` from the process environment (must use the
``postgresql+asyncpg://`` driver). All migrations in this tree are raw-SQL
based (via ``op.execute``) so we intentionally pass ``target_metadata=None``
— no SQLAlchemy MetaData autogeneration is used.

Run online:
    alembic upgrade head

Generate offline SQL (for regulated deploys where DBAs apply migrations):
    alembic upgrade head --sql > liverra.sql
"""
from __future__ import annotations

import asyncio
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config, create_async_engine

# ---------------------------------------------------------------------------
# Alembic config / logging
# ---------------------------------------------------------------------------

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Raw-SQL migrations — no autogenerate.
target_metadata = None


def _database_url() -> str:
    """Resolve DATABASE_URL from env and validate it uses the async driver."""
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL env var is required for Alembic. "
            "Example: postgresql+asyncpg://liverra:pw@localhost:5432/liverra"
        )
    if "+asyncpg" not in url:
        # Permit sync URL but warn — Alembic env below uses async engine.
        # If operator explicitly wants sync, they can flip driver in env.py.
        raise RuntimeError(
            "DATABASE_URL must use the asyncpg driver "
            "(postgresql+asyncpg://...). Got: "
            + url.split("://", 1)[0]
        )
    return url


# ---------------------------------------------------------------------------
# Offline mode — emits SQL to stdout without a live DB connection.
# ---------------------------------------------------------------------------

def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode (emit SQL)."""
    context.configure(
        url=_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


# ---------------------------------------------------------------------------
# Online mode — real async engine.
# ---------------------------------------------------------------------------

def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """Create an async engine and dispatch migrations on a sync connection."""
    connectable = create_async_engine(
        _database_url(),
        poolclass=pool.NullPool,
        future=True,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
