#!/usr/bin/env python3
"""T400 — verify-ruo-watermark.

Plain-English summary: before any demo case can ship or any release can
be tagged we must prove every exported artifact carries the Research
Use Only (RUO) banner. This script walks each demo case's exported
artifacts (PDF report, DICOM SEG, DICOM SR) and asserts the watermark
is present.

SC-009: "RUO watermark present on all exports".

Exit codes:
    0 - all artifacts verified
    1 - one or more artifacts missing watermark (see report)
    2 - usage error (bad args, missing dependency)
    3 - environment error (cannot reach Medplum / S3 / demo data)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import pathlib
import re
import sys
from dataclasses import dataclass, field
from typing import Iterable

WATERMARK_PATTERNS = [
    re.compile(r"RESEARCH\s+USE\s+ONLY", re.IGNORECASE),
    re.compile(r"NOT\s+FOR\s+(?:PRIMARY\s+)?DIAGNOSIS", re.IGNORECASE),
]

logger = logging.getLogger("verify-ruo-watermark")


@dataclass
class ArtifactResult:
    case_id: str
    kind: str  # pdf | dicom_seg | dicom_sr
    location: str
    passed: bool
    detail: str = ""


@dataclass
class Report:
    results: list[ArtifactResult] = field(default_factory=list)

    @property
    def failed(self) -> list[ArtifactResult]:
        return [r for r in self.results if not r.passed]

    def to_dict(self) -> dict:
        return {
            "summary": {
                "total": len(self.results),
                "passed": len(self.results) - len(self.failed),
                "failed": len(self.failed),
            },
            "artifacts": [r.__dict__ for r in self.results],
        }


def _check_pdf(path: pathlib.Path) -> tuple[bool, str]:
    try:
        import pytesseract  # type: ignore
        from pdf2image import convert_from_path  # type: ignore
    except Exception as exc:  # noqa: BLE001
        return False, f"missing deps: {exc}"

    try:
        pages = convert_from_path(str(path), dpi=150, fmt="png")
    except Exception as exc:  # noqa: BLE001
        return False, f"pdf2image failure: {exc}"

    if not pages:
        return False, "no pages rendered"

    for idx, img in enumerate(pages, start=1):
        text = pytesseract.image_to_string(img)
        if any(p.search(text) for p in WATERMARK_PATTERNS):
            continue
        return False, f"watermark missing on page {idx}"
    return True, f"ok ({len(pages)} pages)"


def _check_dicom_sr(path: pathlib.Path) -> tuple[bool, str]:
    try:
        from pydicom import dcmread  # type: ignore
    except Exception as exc:  # noqa: BLE001
        return False, f"missing pydicom: {exc}"
    try:
        ds = dcmread(str(path), stop_before_pixels=True)
    except Exception as exc:  # noqa: BLE001
        return False, f"dcmread failure: {exc}"

    # DICOM-SR: look for leading TextContentItem containing RUO.
    for elem in getattr(ds, "ContentSequence", []):
        text_value = getattr(elem, "TextValue", "") or ""
        if any(p.search(text_value) for p in WATERMARK_PATTERNS):
            return True, "SR leading content matches RUO"
        break  # only leading item counts
    # Fallback: SeriesDescription or StudyComments often carry banner.
    for attr in ("SeriesDescription", "StudyDescription", "ImageComments"):
        value = getattr(ds, attr, "") or ""
        if any(p.search(value) for p in WATERMARK_PATTERNS):
            return True, f"{attr} carries RUO"
    return False, "no leading RUO TextContentItem"


def _check_dicom_seg(path: pathlib.Path) -> tuple[bool, str]:
    try:
        from pydicom import dcmread  # type: ignore
    except Exception as exc:  # noqa: BLE001
        return False, f"missing pydicom: {exc}"
    try:
        ds = dcmread(str(path), stop_before_pixels=True)
    except Exception as exc:  # noqa: BLE001
        return False, f"dcmread failure: {exc}"
    for attr in ("SeriesDescription", "StudyDescription", "ImageComments"):
        value = getattr(ds, attr, "") or ""
        if any(p.search(value) for p in WATERMARK_PATTERNS):
            return True, f"{attr} carries RUO"
    return False, "no RUO banner in SEG descriptive fields"


def _classify(path: pathlib.Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return "pdf"
    name = path.name.lower()
    if "seg" in name:
        return "dicom_seg"
    if "sr" in name:
        return "dicom_sr"
    # Fallback: inspect DICOM Modality tag if possible.
    return "dicom_sr"


def discover_artifacts(case_id: str, root: pathlib.Path) -> Iterable[pathlib.Path]:
    case_dir = root / case_id
    if not case_dir.is_dir():
        return []
    for ext in ("*.pdf", "*.dcm", "*.SEG.dcm", "*.SR.dcm"):
        yield from case_dir.rglob(ext)


def verify_case(case_id: str, root: pathlib.Path) -> list[ArtifactResult]:
    results: list[ArtifactResult] = []
    found = 0
    for artifact in discover_artifacts(case_id, root):
        found += 1
        kind = _classify(artifact)
        if kind == "pdf":
            ok, detail = _check_pdf(artifact)
        elif kind == "dicom_seg":
            ok, detail = _check_dicom_seg(artifact)
        else:
            ok, detail = _check_dicom_sr(artifact)
        results.append(
            ArtifactResult(
                case_id=case_id,
                kind=kind,
                location=str(artifact),
                passed=ok,
                detail=detail,
            )
        )
    if found == 0:
        results.append(
            ArtifactResult(
                case_id=case_id,
                kind="none",
                location=str(root / case_id),
                passed=False,
                detail="no artifacts discovered for case",
            )
        )
    return results


def load_demo_case_ids(root: pathlib.Path, explicit: list[str]) -> list[str]:
    if explicit:
        return explicit
    if not root.is_dir():
        logger.error("demo artifact root not found: %s", root)
        return []
    return sorted(p.name for p in root.iterdir() if p.is_dir())


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--demo-case-id",
        action="append",
        default=[],
        help="UUID of a specific demo case (repeatable).",
    )
    parser.add_argument(
        "--all-demo-cases",
        action="store_true",
        help="Verify every demo case discovered under --artifacts-root.",
    )
    parser.add_argument(
        "--artifacts-root",
        type=pathlib.Path,
        default=pathlib.Path(os.environ.get("LIVERRA_DEMO_ARTIFACTS", ".tmp/demo-artifacts")),
        help="Directory holding <case_id>/*.pdf|dcm exports.",
    )
    parser.add_argument(
        "--report-path",
        type=pathlib.Path,
        default=pathlib.Path(".tmp/verify-ruo-watermark-report.json"),
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
    )

    if not (args.demo_case_id or args.all_demo_cases):
        parser.error("either --demo-case-id or --all-demo-cases is required")

    case_ids = load_demo_case_ids(
        args.artifacts_root,
        [] if args.all_demo_cases else args.demo_case_id,
    )
    if not case_ids:
        logger.error("no demo cases to verify (root=%s)", args.artifacts_root)
        return 3

    report = Report()
    for case_id in case_ids:
        logger.info("verifying case %s", case_id)
        for result in verify_case(case_id, args.artifacts_root):
            report.results.append(result)
            logger.info(
                "  %s %-10s %s %s",
                "PASS" if result.passed else "FAIL",
                result.kind,
                result.location,
                result.detail,
            )

    args.report_path.parent.mkdir(parents=True, exist_ok=True)
    args.report_path.write_text(json.dumps(report.to_dict(), indent=2))
    logger.info("report: %s", args.report_path)

    failed = report.failed
    if failed:
        logger.error("RUO watermark FAIL: %d artifact(s)", len(failed))
        for r in failed:
            logger.error("  %s (%s): %s", r.location, r.kind, r.detail)
        return 1

    logger.info("RUO watermark PASS: %d artifact(s)", len(report.results))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
