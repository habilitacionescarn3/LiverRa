"""Compatibility shim — re-exports :class:`AuthMiddleware` from
``auth_middleware`` (T049/T050).

Exists so ``src.main`` can ``from src.middleware.auth import AuthMiddleware``
without coupling main.py to the longer filename.
"""
from __future__ import annotations

from .auth_middleware import AuthMiddleware, DEFAULT_EXCLUDED_PREFIXES

__all__ = ["AuthMiddleware", "DEFAULT_EXCLUDED_PREFIXES"]
