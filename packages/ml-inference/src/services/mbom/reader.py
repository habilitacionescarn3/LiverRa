# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""MBoM.json reader (T414).

Plain-English:
    The "MBoM" (Model Bill of Materials) is a single JSON file at the
    repo root that lists every ML model we ship: its name, pinned git
    commit SHA, weights SHA-256, license-text hash, and Apache-2.0
    compatibility. Checkpoints + DICOM-SEG/SR exports MUST stamp the
    version + license hash from this file — that's how regulators will
    trace a finalized report back to the exact weights that produced it.

This module is the thin, cached reader other code uses:

    from src.services.mbom.reader import get_default_reader

    reader = get_default_reader()
    info = reader.get("stu-net-v1")
    checkpoint.write(..., model_version=info.version,
                     model_license_hash=info.license_hash)

Caching: the file's mtime is checked on every ``get(...)``; if the
file was rewritten (e.g. by ``scripts/model-bom.sh``) we reload
transparently. This is cheap (one ``stat()`` per call) and safe —
no stale data survives a regeneration.

Spec: FR-038, research.md §X.4.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


DEFAULT_MBOM_PATH = Path(
    os.environ.get("LIVERRA_MBOM_PATH", "MBoM.json")
).resolve()


@dataclass(frozen=True)
class MBoMModelInfo:
    """One model's MBoM projection used by checkpoint + SEG/SR builders."""

    name: str
    pinned_commit_sha: str
    license_hash: str
    weights_sha256: Optional[str] = None
    license_spdx: Optional[str] = None

    @property
    def version(self) -> str:
        """Short version stamp — e.g. ``stu-net-v1@0aabbccddeef``."""
        return f"{self.name}@{self.pinned_commit_sha[:12] or 'unknown'}"


class MBoMReader:
    """mtime-invalidated cache over a single ``MBoM.json`` on disk.

    Thread-safe: reads are guarded by a single lock so two workers can
    call ``get`` concurrently without fighting over cache writes.
    """

    def __init__(self, path: Path | str = DEFAULT_MBOM_PATH) -> None:
        self._path: Path = Path(path)
        self._cache: dict[str, MBoMModelInfo] = {}
        self._cache_mtime: float = -1.0
        self._lock = threading.Lock()

    # ---- Public API -------------------------------------------------------

    @property
    def path(self) -> Path:
        return self._path

    def get(self, model_name: str) -> MBoMModelInfo:
        """Return the MBoM projection for ``model_name``.

        If the file is missing OR the model isn't listed, we return a
        ``MBoMModelInfo`` with ``pinned_commit_sha='unknown'`` so callers
        can still persist SOMETHING — combined with the drift check
        (T258 / ``LICENSE_HASH_DRIFT``), unknown entries surface as a
        release blocker rather than silently corrupting the audit trail.
        """
        self._refresh_if_stale()
        entry = self._cache.get(model_name)
        if entry is not None:
            return entry
        logger.warning(
            "MBoM entry missing for model %s; using placeholder", model_name
        )
        return MBoMModelInfo(
            name=model_name, pinned_commit_sha="unknown", license_hash="unknown"
        )

    def all(self) -> dict[str, MBoMModelInfo]:
        """Return the full cached map (read-only snapshot copy)."""
        self._refresh_if_stale()
        return dict(self._cache)

    # ---- Internals --------------------------------------------------------

    def _refresh_if_stale(self) -> None:
        try:
            mtime = self._path.stat().st_mtime
        except FileNotFoundError:
            with self._lock:
                self._cache = {}
                self._cache_mtime = -1.0
            return

        if mtime == self._cache_mtime and self._cache:
            return

        with self._lock:
            # Double-check under lock to avoid thundering-herd reloads.
            try:
                mtime = self._path.stat().st_mtime
            except FileNotFoundError:
                self._cache = {}
                self._cache_mtime = -1.0
                return
            if mtime == self._cache_mtime and self._cache:
                return
            try:
                data = json.loads(self._path.read_text(encoding="utf-8"))
            except Exception as exc:  # noqa: BLE001
                logger.error("Failed to load MBoM %s: %s", self._path, exc)
                self._cache = {}
                self._cache_mtime = mtime
                return
            self._cache = {
                m["name"]: MBoMModelInfo(
                    name=m["name"],
                    pinned_commit_sha=m.get("pinned_commit_sha", ""),
                    license_hash=m.get("license_text_hash")
                    or m.get("license_hash", ""),
                    weights_sha256=m.get("weights_sha256"),
                    license_spdx=m.get("license_spdx"),
                )
                for m in data.get("models", [])
            }
            self._cache_mtime = mtime
            logger.info(
                "MBoM reloaded: %d models from %s",
                len(self._cache),
                self._path,
            )


# ---------------------------------------------------------------------------
# Process-wide singleton
# ---------------------------------------------------------------------------


_DEFAULT_READER: Optional[MBoMReader] = None
_DEFAULT_READER_LOCK = threading.Lock()


def get_default_reader(path: Path | str | None = None) -> MBoMReader:
    """Return the process-wide MBoM reader (created lazily).

    The FastAPI lifespan hook calls this to warm the singleton; every
    other caller (checkpoint writer, SEG/SR builders) goes through this
    accessor so tests can monkeypatch the singleton cleanly.
    """
    global _DEFAULT_READER
    with _DEFAULT_READER_LOCK:
        if _DEFAULT_READER is None:
            _DEFAULT_READER = MBoMReader(
                path if path is not None else DEFAULT_MBOM_PATH
            )
        return _DEFAULT_READER


def reset_default_reader() -> None:
    """Clear the singleton (tests only)."""
    global _DEFAULT_READER
    with _DEFAULT_READER_LOCK:
        _DEFAULT_READER = None


__all__ = [
    "DEFAULT_MBOM_PATH",
    "MBoMModelInfo",
    "MBoMReader",
    "get_default_reader",
    "reset_default_reader",
]
