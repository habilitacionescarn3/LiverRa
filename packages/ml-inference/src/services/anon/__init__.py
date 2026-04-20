# SPDX-License-Identifier: Apache-2.0
"""Anonymization services — triage + pixel-PHI utilities consumed by the
edge-appliance sidecar at ``pacs/anon-sidecar/``.
"""
from .triage import ScanMode, classify  # noqa: F401
