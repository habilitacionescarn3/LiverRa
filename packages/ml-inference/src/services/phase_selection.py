# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Reference-phase selection for cascade tasks.

All cascade stages (parenchyma, vessels, couinaud, lesions, FLR) MUST
write their output masks at the same patient-space grid so they can be
overlaid on a single CT background in the report. Without a shared
reference phase each task picks independently and masks come out at
different Z-extents (e.g. parenchyma at arterial Z=674, vessels at
portal_venous Z=649) — overlay contours then drift along Z and trace
fat / kidneys / bowel instead of the liver.

`LIVERRA_REFERENCE_PHASE` (default `portal_venous`) names the phase used
as the geometry reference for all uploaded masks. portal_venous is the
radiology gold-standard for liver assessment.
"""
from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_REFERENCE_PHASE = "portal_venous"
PHASE_ENV_VAR = "LIVERRA_REFERENCE_PHASE"


def select_reference_phase(
    source_images: list[Any],
    phase_names: list[str],
) -> Any:
    """Pick the SimpleITK image to use as the cascade-wide reference grid.

    Prefers the phase named by ``LIVERRA_REFERENCE_PHASE`` (default
    ``portal_venous``). Falls back to the largest-by-pixel-count phase
    only when the preferred phase is missing. Both lists must be in
    parallel order; entries for missing phases must be omitted from
    BOTH lists (do not pad with None).

    Raises ``ValueError`` if both lists are empty.
    """
    if len(source_images) != len(phase_names):
        raise ValueError(
            f"source_images ({len(source_images)}) and phase_names "
            f"({len(phase_names)}) must be the same length"
        )
    if not source_images:
        raise ValueError("no source images available to pick a reference from")

    preferred = os.environ.get(PHASE_ENV_VAR, DEFAULT_REFERENCE_PHASE)
    for img, name in zip(source_images, phase_names, strict=True):
        if name == preferred:
            logger.info(
                "phase_selection: using preferred phase=%s size=%s",
                name, img.GetSize(),
            )
            return img

    fallback = max(source_images, key=lambda im: im.GetNumberOfPixels())
    fallback_name = phase_names[source_images.index(fallback)]
    logger.warning(
        "phase_selection: preferred phase '%s' missing — falling back to "
        "largest-by-pixel-count phase=%s size=%s",
        preferred, fallback_name, fallback.GetSize(),
    )
    return fallback
