"""SQLAlchemy 2 async session factory + RLS tenant context (T059).

All database access MUST flow through :func:`tenant_session` (or the
FastAPI :func:`get_db` dependency) so that the Postgres session-local
GUC ``app.tenant_id`` is set inside the transaction. The Row-Level
Security policies installed by migration 0001 rely on that GUC to
enforce tenant isolation — no ``app.tenant_id`` means no rows.

Usage::

    async with tenant_session(tenant_id) as session:
        result = await session.execute(select(Study).where(...))

FastAPI wiring::

    @router.get("/studies")
    async def list_studies(session: AsyncSession = Depends(get_db)):
        ...

``get_db`` resolves the tenant from ``request.state.tenant_id`` — the
Cognito JWT middleware is expected to populate that earlier in the
request lifecycle.
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import AsyncIterator
from uuid import UUID

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


# ---------------------------------------------------------------------------
# Engine (lazy singleton)
# ---------------------------------------------------------------------------

def _database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL env var is required. "
            "Example: postgresql+asyncpg://liverra:pw@localhost:5432/liverra"
        )
    return url


@lru_cache(maxsize=1)
def get_engine() -> AsyncEngine:
    """Return the process-wide async engine (created on first call)."""
    return create_async_engine(
        _database_url(),
        pool_pre_ping=True,
        pool_size=10,
        max_overflow=20,
        future=True,
    )


@lru_cache(maxsize=1)
def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(
        bind=get_engine(),
        expire_on_commit=False,
        class_=AsyncSession,
    )


# ---------------------------------------------------------------------------
# Tenant-scoped session context manager
# ---------------------------------------------------------------------------

@asynccontextmanager
async def tenant_session(tenant_id: UUID) -> AsyncIterator[AsyncSession]:
    """Yield an AsyncSession with ``SET LOCAL app.tenant_id = <uuid>``.

    The setting is transaction-scoped (``SET LOCAL``) so it disappears
    when the session commits or rolls back — no cross-request leakage
    even if the underlying connection is recycled by the pool.
    """
    if not isinstance(tenant_id, UUID):
        raise TypeError(f"tenant_id must be UUID, got {type(tenant_id).__name__}")

    session_factory = get_sessionmaker()
    async with session_factory() as session:
        # Open an explicit transaction so SET LOCAL is scoped correctly.
        async with session.begin():
            await session.execute(
                text("SELECT set_config('app.tenant_id', :tid, true)"),
                {"tid": str(tenant_id)},
            )
            try:
                yield session
            except Exception:
                # session.begin() auto-rollback on exception; re-raise.
                raise


# ---------------------------------------------------------------------------
# FastAPI dependency
# ---------------------------------------------------------------------------

async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    """FastAPI dependency — resolves tenant from ``request.state``.

    Auth middleware MUST set ``request.state.tenant_id`` to the caller's
    tenant UUID before any route depending on :func:`get_db` runs.
    """
    tenant_id = getattr(request.state, "tenant_id", None)
    if tenant_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="tenant context missing",
        )
    if not isinstance(tenant_id, UUID):
        try:
            tenant_id = UUID(str(tenant_id))
        except (ValueError, TypeError):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid tenant context",
            )

    async with tenant_session(tenant_id) as session:
        yield session


__all__ = [
    "get_engine",
    "get_sessionmaker",
    "tenant_session",
    "get_db",
]
