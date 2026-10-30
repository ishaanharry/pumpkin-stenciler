"""A preview of the carved pumpkin lit from inside by a candle.

Cuts (black) let the light straight through and glow bright orange, shaved
areas (grays) glow red through the thinned skin, dimmer the more skin is left,
and uncarved skin (white) stays dark. Light bleeds a little past the edges of
everything that glows, as it does on a real pumpkin.
"""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageFilter

from .stencil import Stencil

CUT_EDGE = (255, 118, 14)  # orange where a cut meets the pumpkin wall
CUT_CORE = (255, 160, 40)  # hotter orange in the middle of wide cuts
SHAVED_THIN = (232, 60, 14)  # the lightest shave: a gray just above black
SHAVED_THICK = (78, 10, 3)  # the heaviest: a gray just below white
SKIN = (24, 12, 6)

# Radius of the "deep in the cut" falloff, as a fraction of the image size.
CORE_RADIUS = 0.012
# (blur radius as a fraction of the image size, strength) for each halo.
BLOOM = [(0.004, 0.55), (0.02, 0.35)]


def render(stencil: Stencil) -> Image.Image:
    values = stencil.values.astype(np.float32) / 255
    size = max(values.shape)
    cut = values == 0
    skin = values == 1

    # Grays run from bright red (barely shaved) to dark red (barely touched).
    rgb = _lerp(SHAVED_THIN, SHAVED_THICK, values)
    # Wide openings look hotter in the middle, where you see further inside.
    depth = np.clip(2 * _blur(cut.astype(np.float32), CORE_RADIUS * size) - 1, 0, 1)
    rgb[cut] = _lerp(CUT_EDGE, CUT_CORE, depth[cut])
    rgb[skin] = np.array(SKIN, dtype=np.float32) / 255

    light = np.where(skin[..., None], 0, rgb)
    halo = sum(strength * _blur(light, radius * size) for radius, strength in BLOOM)
    # Screen blending: adds light without ever overshooting white.
    out = 1 - (1 - rgb) * (1 - np.clip(halo, 0, 1))
    return Image.fromarray(np.round(out * 255).astype(np.uint8))


def _lerp(a, b, t: np.ndarray) -> np.ndarray:
    a = np.array(a, dtype=np.float32) / 255
    b = np.array(b, dtype=np.float32) / 255
    return a + (b - a) * t[..., None]


def _blur(array: np.ndarray, radius: float) -> np.ndarray:
    """Gaussian blur of a 0-1 float image (2-D, or 3-D with RGB channels)."""
    image = Image.fromarray(np.round(array * 255).astype(np.uint8))
    blurred = image.filter(ImageFilter.GaussianBlur(max(radius, 0.5)))
    return np.asarray(blurred, dtype=np.float32) / 255
