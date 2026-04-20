# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""ZIP-archive safety + DICOM tag sanitisation (FR-001a / FR-001c).

Plain-English:
    Uploads can arrive as a ZIP of DICOM files. ZIP archives are one of
    the classic attack surfaces: zip bombs (a 42 kB archive that expands
    to 4 GB), encrypted archives (we can't scan them for PHI), path
    traversal (``../../etc/passwd`` inside the ZIP), and null-byte
    filenames. After we've verified the archive itself, we also check
    each DICOM file: refuse NUL bytes or raw control characters inside
    any tag value, because those tag values later appear in UI strings,
    PDF reports, and S3 paths (FR-001c).

References:
    - specs/001-zero-training-mvp/spec.md §FR-001a, §FR-001c
"""
from __future__ import annotations

import asyncio
import io
import logging
import re
import zipfile
from pathlib import Path
from typing import Any, Iterable

try:
    import pydicom  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover
    pydicom = None  # type: ignore[assignment]


logger = logging.getLogger(__name__)

MAX_RATIO = 100  # compressed:uncompressed; > 100 is zip-bomb territory
MAX_UNCOMPRESSED_BYTES = 6 * 1024 * 1024 * 1024  # 6 GB — matches FR-001b cap + buffer
MAX_ENTRIES = 50_000  # sanity cap; a 4-phase CT study rarely exceeds 5,000 slices

# Filenames: reject traversal, absolute paths, NUL, backslash, shell metas.
_FILENAME_BAD = re.compile(r"[\x00\x1f-\x01\x7f\\]|^/|\.\.")

# Tag values: reject NUL + control chars (except tab/newline which some
# legitimate LT / UT VRs carry).
_TAG_BAD = re.compile(r"[\x00\x01-\x08\x0b\x0c\x0e-\x1f]")


class ZipSafetyError(Exception):
    """Raised on any ZIP / DICOM safety violation."""

    def __init__(self, slug: str, detail: str) -> None:
        super().__init__(detail)
        self.slug = slug
        self.detail = detail


# ---------------------------------------------------------------------------
# ZIP-level checks
# ---------------------------------------------------------------------------


def _check_archive(zf: zipfile.ZipFile) -> None:
    entries = zf.infolist()
    if len(entries) > MAX_ENTRIES:
        raise ZipSafetyError(
            "too_many_entries",
            f"archive contains {len(entries)} entries; max {MAX_ENTRIES}",
        )

    total_uncompressed = 0
    total_compressed = 0
    for info in entries:
        # Encrypted entries → reject. Bit 0 of the general-purpose flag.
        if info.flag_bits & 0x1:
            raise ZipSafetyError(
                "encrypted_archive",
                "archive contains encrypted / password-protected entries",
            )

        # Filename sanity (path traversal, absolute paths, null bytes).
        if _FILENAME_BAD.search(info.filename) or info.filename.startswith("/"):
            raise ZipSafetyError(
                "unsafe_filename",
                f"archive entry has unsafe filename (length={len(info.filename)})",
            )

        # Directories are fine — but skip aggregation.
        if info.is_dir():
            continue

        total_uncompressed += info.file_size
        total_compressed += info.compress_size

    if total_uncompressed > MAX_UNCOMPRESSED_BYTES:
        raise ZipSafetyError(
            "archive_too_large",
            f"uncompressed size {total_uncompressed} exceeds cap {MAX_UNCOMPRESSED_BYTES}",
        )

    # Zip-bomb ratio guard; avoid div/0 on empty compressed size.
    if total_compressed > 0 and (total_uncompressed / total_compressed) > MAX_RATIO:
        raise ZipSafetyError(
            "zip_bomb_ratio",
            f"compression ratio {total_uncompressed / total_compressed:.0f}:1 > {MAX_RATIO}:1",
        )


# ---------------------------------------------------------------------------
# DICOM-level checks
# ---------------------------------------------------------------------------


def _sanitize_dicom_tag_values(ds: Any, *, filename: str) -> None:
    """Iterate every string-VR tag and reject control-char injection."""
    if pydicom is None or ds is None:
        return
    for elem in ds.iterall():
        if elem.VR not in {"PN", "LO", "SH", "UT", "LT", "ST", "UC", "UI", "CS", "DS", "IS"}:
            continue
        value = elem.value
        candidates: Iterable[Any]
        if isinstance(value, (list, tuple)):
            candidates = value
        else:
            candidates = [value]
        for v in candidates:
            if not isinstance(v, str):
                continue
            if _TAG_BAD.search(v):
                raise ZipSafetyError(
                    "malformed_dicom_tag",
                    f"DICOM file {filename!r} tag {elem.tag} contains control chars",
                )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def validate_zip(zip_path: Path) -> None:
    """Validate a ZIP archive on-disk asynchronously.

    Offloads the synchronous zipfile / pydicom work to a thread so the
    ingest coroutine stays responsive.
    """
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, _validate_zip_sync, zip_path)


def _validate_zip_sync(zip_path: Path) -> None:
    if not zip_path.is_file():
        raise ZipSafetyError("missing_upload", f"path not a file: {zip_path}")
    try:
        with zipfile.ZipFile(zip_path) as zf:
            _check_archive(zf)
            if pydicom is None:
                return  # archive-level checks only in minimal install
            for info in zf.infolist():
                if info.is_dir():
                    continue
                try:
                    with zf.open(info) as fh:
                        blob = fh.read()
                except RuntimeError as exc:
                    raise ZipSafetyError(
                        "unsafe_extraction",
                        f"zip entry could not be read: {type(exc).__name__}",
                    )
                # Some ZIPs contain non-DICOM siblings (readme, thumbnail);
                # FR-001a says those are ignored with a summary. We only
                # sanitise entries that parse as DICOM.
                try:
                    ds = pydicom.dcmread(
                        io.BytesIO(blob), stop_before_pixels=True, force=True
                    )
                except Exception:
                    continue
                _sanitize_dicom_tag_values(ds, filename=info.filename)
    except zipfile.BadZipFile as exc:
        raise ZipSafetyError("malformed_archive", f"not a valid zip: {exc}") from exc


__all__ = [
    "MAX_RATIO",
    "MAX_UNCOMPRESSED_BYTES",
    "MAX_ENTRIES",
    "ZipSafetyError",
    "validate_zip",
]
