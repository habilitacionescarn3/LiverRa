# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""DEPRECATED — backward-compat re-export shim.

H-CLIN-5 fix (audit 2026-05-14): this module is mis-named. It never
implemented LI-RADS v2018 — it is a tumor-type classifier. Renamed to
:mod:`src.orchestrator.tumor_type_classifier`. This shim keeps the
existing import paths working while we migrate call sites.

NEW IMPORTS should write::

    from src.orchestrator.tumor_type_classifier import classify_lesion

The LR-M (indeterminate-but-probably-malignant) category lives on the
classifier output as ``lirads_category`` — that single LI-RADS-flavoured
derivation is semantically distinct from the full v2018 rule set.
"""
from __future__ import annotations

from src.orchestrator.tumor_type_classifier import (  # noqa: F401
    CLASS_ORDER,
    classify_lesion,
)

__all__ = ["classify_lesion", "CLASS_ORDER"]
