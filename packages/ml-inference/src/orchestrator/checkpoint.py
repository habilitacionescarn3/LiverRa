# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Pipeline-checkpoint writer (T160).

One row per cascade stage, written **in the same Postgres transaction
that releases the GPU lease** (research §X.2 + §C.2). This atomicity
guarantees that if the GPU-release write rolls back, the checkpoint
also rolls back — the orchestrator never sees a checkpoint without a
released lease or vice versa.

Plain-English analogy:
    Imagine each cascade stage as a relay runner handing off a baton.
    The checkpoint row is the official stamp that says "leg 3 done,
    baton passed cleanly." We staple the stamp to the same envelope
    as the handoff receipt — if the envelope is lost, both go
    together. No partial history, no orphaned stamps.

Schema (from migration ``20260419_0002_study_series_analysis.py``)::

    pipeline_checkpoint(
        analysis_id uuid NOT NULL,
        stage_no integer NOT NULL,
        stage text NOT NULL,
        output_uri text NOT NULL,
        written_at timestamptz NOT NULL DEFAULT now(),
        model_version text NOT NULL,
        model_license_hash text NOT NULL,
        PRIMARY KEY (analysis_id, stage_no)
    )

The ``model_version`` + ``model_license_hash`` pair is sourced from the
MBoM (Model Bill of Materials — research §X.4). Callers may inject a
pre-loaded MBoM reader so unit tests do not need the JSON on disk.
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

try:
    from prometheus_client import Histogram  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    Histogram = None  # type: ignore[assignment]


logger = logging.getLogger(__name__)


if Histogram is not None:  # pragma: no branch
    _CHECKPOINT_WRITE = Histogram(
        "pipeline_checkpoint_write_seconds",
        "Time spent INSERTing a pipeline_checkpoint row.",
        labelnames=("stage",),
        buckets=(0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0),
    )
else:  # pragma: no cover
    _CHECKPOINT_WRITE = None


DEFAULT_MBOM_PATH = Path(
    os.environ.get("LIVERRA_MBOM_PATH", "MBoM.json")
).resolve()


# ---------------------------------------------------------------------------
# MBoM reader
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MBoMEntry:
    """One model's entry in ``MBoM.json`` (subset of fields needed here)."""

    name: str
    pinned_commit_sha: str
    license_text_hash: str

    @property
    def version(self) -> str:
        """Short version stamp used in checkpoint + AuditEvent rows."""
        # Keep the commit sha short for readability; callers that need
        # the full SHA can look up the MBoM entry directly.
        return f"{self.name}@{self.pinned_commit_sha[:12]}"


class MBoMReader(Protocol):
    """Minimal read-only interface the checkpoint writer needs."""

    def get(self, model_name: str) -> MBoMEntry:  # pragma: no cover - protocol
        ...


class FileMBoMReader:
    """Reads ``MBoM.json`` from disk once and caches the result.

    File format (produced by ``scripts/model-bom.sh``)::

        {
          "generated_at": "2026-04-19T...",
          "models": [
            { "name": "...", "pinned_commit_sha": "...",
              "license_text_hash": "...", ... },
            ...
          ]
        }
    """

    def __init__(self, path: Path | str = DEFAULT_MBOM_PATH) -> None:
        self._path = Path(path)
        self._cache: dict[str, MBoMEntry] | None = None

    def _load(self) -> dict[str, MBoMEntry]:
        if self._cache is not None:
            return self._cache
        if not self._path.exists():
            # Fail-soft in dev: return empty dict. Production callers
            # should ship MBoM.json at the repo root.
            logger.warning(
                "MBoM file %s missing; checkpoints will use stub values",
                self._path,
            )
            self._cache = {}
            return self._cache
        data = json.loads(self._path.read_text(encoding="utf-8"))
        models = data.get("models", [])
        self._cache = {
            m["name"]: MBoMEntry(
                name=m["name"],
                pinned_commit_sha=m.get("pinned_commit_sha", ""),
                license_text_hash=m.get("license_text_hash", ""),
            )
            for m in models
        }
        return self._cache

    def get(self, model_name: str) -> MBoMEntry:
        cache = self._load()
        entry = cache.get(model_name)
        if entry is None:
            # Dev-mode placeholder; still persistable but flagged.
            return MBoMEntry(
                name=model_name,
                pinned_commit_sha="unknown",
                license_text_hash="unknown",
            )
        return entry


class _ServicesMBoMAdapter:
    """Adapts ``services.mbom.reader.MBoMReader`` to the local Protocol.

    T414 centralised MBoM loading in ``services/mbom/reader.py`` so that
    the SEG/SR builders (T257) share the same mtime-invalidated cache.
    This adapter lets the existing checkpoint call-sites keep their
    ``MBoMEntry`` shape with no churn.
    """

    def __init__(self) -> None:
        self._inner = None

    def _resolve(self):  # type: ignore[no-untyped-def]
        if self._inner is None:
            from ..services.mbom.reader import get_default_reader  # lazy

            self._inner = get_default_reader()
        return self._inner

    def get(self, model_name: str) -> "MBoMEntry":
        info = self._resolve().get(model_name)
        return MBoMEntry(
            name=info.name,
            pinned_commit_sha=info.pinned_commit_sha,
            license_text_hash=info.license_hash,
        )


try:
    _DEFAULT_READER: MBoMReader = _ServicesMBoMAdapter()  # type: ignore[assignment]
except Exception:  # pragma: no cover — fall back during bootstrap
    _DEFAULT_READER = FileMBoMReader()  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Writer
# ---------------------------------------------------------------------------


async def write(
    analysis_id: UUID,
    stage_no: int,
    stage: str,
    output_uri: str,
    model_version: str | None,
    session: AsyncSession,
    *,
    model_license_hash: str | None = None,
    mbom: MBoMReader | None = None,
    model_name: str | None = None,
) -> None:
    """INSERT a pipeline_checkpoint row in the caller's transaction.

    Parameters
    ----------
    analysis_id:
        Owner analysis (FK to ``analysis.id``).
    stage_no:
        Monotonic stage number (1..7 for the v1 cascade).
    stage:
        Stage name from the enum in data-model §6
        (``anonymization`` | ``parenchyma`` | ``vessels`` |
        ``couinaud`` | ``lesion_detection`` | ``classification`` |
        ``flr_init``).
    output_uri:
        S3 URI of the stage's output artifact.
    model_version:
        Pre-computed version string. If ``None``, the writer looks up
        ``model_name`` in the injected MBoM.
    model_license_hash:
        SHA-256 of the model's LICENSE file. Overrides MBoM lookup when
        non-None.
    mbom:
        Custom MBoM reader; defaults to :data:`FileMBoMReader` loading
        ``MBoM.json`` at the repo root.
    model_name:
        Required if ``model_version`` or ``model_license_hash`` is None
        — used to look up the MBoM row.

    The write participates in the caller's transaction. We do NOT
    commit — that is the orchestrator's job (in the same transaction
    that releases the GPU lease).
    """
    reader = mbom or _DEFAULT_READER

    if model_version is None or model_license_hash is None:
        if model_name is None:
            raise ValueError(
                "Either model_version+model_license_hash or model_name must "
                "be provided"
            )
        entry = reader.get(model_name)
        model_version = model_version or entry.version
        model_license_hash = model_license_hash or entry.license_text_hash

    # Defensive: these NOT NULLs are enforced by the DB, but a clear
    # Python error beats an opaque asyncpg one.
    if not model_version:
        raise ValueError("model_version must be non-empty")
    if not model_license_hash:
        raise ValueError("model_license_hash must be non-empty")

    start = time.monotonic()
    try:
        await session.execute(
            text(
                """
                INSERT INTO pipeline_checkpoint (
                    analysis_id,
                    stage_no,
                    stage,
                    output_uri,
                    model_version,
                    model_license_hash
                )
                VALUES (
                    :analysis_id,
                    :stage_no,
                    :stage,
                    :output_uri,
                    :model_version,
                    :model_license_hash
                )
                """
            ),
            {
                "analysis_id": str(analysis_id),
                "stage_no": stage_no,
                "stage": stage,
                "output_uri": output_uri,
                "model_version": model_version,
                "model_license_hash": model_license_hash,
            },
        )
    finally:
        elapsed = time.monotonic() - start
        if _CHECKPOINT_WRITE is not None:
            _CHECKPOINT_WRITE.labels(stage=stage).observe(elapsed)

    logger.info(
        "pipeline_checkpoint written analysis=%s stage=%s stage_no=%d",
        analysis_id,
        stage,
        stage_no,
    )


__all__ = [
    "FileMBoMReader",
    "MBoMEntry",
    "MBoMReader",
    "write",
]
