"""The final stencil raster that every output is built from.

    brightness → shade bands → speck removal → hand edits

The segmented preview, the traced SVG and the stencil check all use this, so
they always agree with each other and with what the user painted.

Hand edits are stored as an RGBA image the size of the page: alpha marks
edited pixels and the gray value is the output shade painted there (0 = cut).
Edits are in output shades rather than brightness, so moving a threshold or
flipping colors never changes what was painted. If the number of shades
changes, each edit snaps to the nearest shade that still exists.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image
from scipy import ndimage

from . import segment

MAX_SPECKLE = 100
DEFAULT_SPECKLE = 8


@dataclass
class Stencil:
    levels: np.ndarray  # per-pixel shade index, 0 = background band
    shades: list[int]  # output gray value of each shade index
    thresholds: list[int]  # brightness where each band above the first starts

    @property
    def values(self) -> np.ndarray:
        """The output gray value of every pixel."""
        return np.array(self.shades, dtype=np.uint8)[self.levels]

    def layer(self, level: int) -> np.ndarray:
        """Pixels at shade index `level` or above (one stacked SVG group)."""
        return self.levels >= level


def build(
    image: Image.Image,
    thresholds: list[int],
    invert: bool = False,
    speckle: int = DEFAULT_SPECKLE,
    edits: Image.Image | None = None,
) -> Stencil:
    gray = np.asarray(segment.brightness(image))
    shades = segment.shade_values(len(thresholds) + 1, invert)

    # Each band's mask is cleaned separately, then stacked so later (brighter)
    # bands paint over earlier ones, exactly as the stacked SVG renders.
    levels = np.zeros(gray.shape, dtype=np.uint8)
    for level, threshold in enumerate(thresholds, start=1):
        levels[_despeckle(gray >= threshold, speckle)] = level

    # Edits go on last, so deliberate detail isn't removed as a speck.
    if edits is not None:
        rgba = np.asarray(edits.convert("RGBA"))
        if rgba.shape[:2] != levels.shape:
            raise ValueError("Edits must be the same size as the page.")
        edited = rgba[..., 3] >= 128
        painted = rgba[..., 0][edited].astype(int)
        nearest = np.abs(painted[:, None] - np.array(shades)[None, :]).argmin(axis=1)
        levels[edited] = nearest

    return Stencil(levels=levels, shades=shades, thresholds=thresholds)


def _despeckle(layer: np.ndarray, speckle: int) -> np.ndarray:
    """Drop blobs and fill holes smaller than speckle x speckle pixels in area.

    Besides tidying the stencil, this keeps very fine detail from overwhelming
    the SVG tracer, which fails outright on masks with too many regions.
    """
    if speckle <= 0:
        return layer
    min_area = speckle * speckle
    layer = _drop_small_regions(layer, min_area)
    return ~_drop_small_regions(~layer, min_area)


def _drop_small_regions(mask: np.ndarray, min_area: int) -> np.ndarray:
    labels, count = ndimage.label(mask)
    if count == 0:
        return mask
    keep = np.bincount(labels.ravel()) >= min_area
    keep[0] = False  # label 0 is everything outside the mask
    return keep[labels]
