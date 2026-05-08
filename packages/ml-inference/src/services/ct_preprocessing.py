# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""CT preprocessing for STU-Net and the Pictorial-Couinaud Triton models.

Both models follow nnU-Net-style preprocessing: clip HU to an abdominal
window (default [-200, 250]) then z-score normalize per-volume so the
input distribution matches what the weights were trained on.

Without this step the model receives raw HU values from –1000 (air) to
+3000 (bone) — far outside the training distribution — and emits
near-uniform noise across the abdomen (e.g. parenchyma mask covering
kidneys + bowel + spine, vessel mask covering 170% of the liver).

Plain-English: imagine asking a chef to season a dish in Celsius when
their recipes are written in Fahrenheit. Same numbers, but they carry
no useful signal until you put them in the right scale.
"""
from __future__ import annotations

import os

import numpy as np

#: Default abdominal CT window. Wider than the display window
#: (`stage_render._hu_window` uses [-150, 250]) to give the model a
#: little headroom around the visible window.
DEFAULT_CLIP_LO: float = -200.0
DEFAULT_CLIP_HI: float = 250.0


def normalize_ct_for_stunet(arr: np.ndarray) -> np.ndarray:
    """Clip HU then min-max scale to [0, 1] per-volume.

    Why min-max and NOT z-score: when most voxels in the cube are air
    (outside the body), they get clipped to ``lo`` and dominate the
    mean. Z-score then maps liver tissue to extreme values and the
    model over-confidently labels everything as liver. Min-max is
    bounded and stable regardless of how much air the cube contains.

    Two normalization modes (env-tunable via ``LIVERRA_CT_NORM_MODE``):
      * ``minmax`` (default): output in [0, 1]
      * ``zscore``: output ~[-2, +2], use only when foreground
        statistics are known to be representative
    """
    lo = float(os.environ.get("LIVERRA_CT_CLIP_LO", DEFAULT_CLIP_LO))
    hi = float(os.environ.get("LIVERRA_CT_CLIP_HI", DEFAULT_CLIP_HI))
    mode = os.environ.get("LIVERRA_CT_NORM_MODE", "minmax").lower()
    clipped = np.clip(arr.astype(np.float32, copy=False), lo, hi)
    if mode == "zscore":
        mean = float(clipped.mean())
        std = float(clipped.std()) + 1e-8
        return ((clipped - mean) / std).astype(np.float32)
    # Default: min-max → [0, 1]
    span = max(hi - lo, 1e-8)
    return ((clipped - lo) / span).astype(np.float32)
