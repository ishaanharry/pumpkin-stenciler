"""Find unsupported pieces: pumpkin that would fall out once the stencil is cut.

Convention: black is cut all the way through; every other shade is material
(white is untouched skin, grays are shaved but keep their flesh). Only the
output shade matters, so flipping colors never changes what counts as cut.

The pumpkin beyond the stencil's edge is uncut and holds up anything touching
it. A connected region of material that never reaches the edge is therefore
enclosed by cuts and falls out. Material only counts as connected through
shared pixel edges, never diagonal corners, since a corner touch is a
zero-width bridge.

The check runs on the same speck-cleaned layers the SVG is traced from, so
it judges exactly what gets printed.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import numpy as np
from PIL import Image
from scipy import ndimage

from . import segment, vectorize

# Red, mostly opaque: readable over black, white and gray alike.
_HIGHLIGHT = (255, 48, 48, 200)


@dataclass
class Island:
    area: int  # pixels
    x: int  # bounding box
    y: int
    width: int
    height: int


@dataclass
class Report:
    width: int
    height: int
    islands: list[Island]  # largest first
    overlay: bytes | None  # RGBA PNG with islands highlighted, if any

    @property
    def valid(self) -> bool:
        return not self.islands


def find_islands(
    image: Image.Image,
    thresholds: list[int],
    invert: bool = False,
    speckle: int = vectorize.DEFAULT_SPECKLE,
) -> Report:
    gray = np.asarray(segment.brightness(image))
    height, width = gray.shape
    levels = vectorize.shade_levels(gray, thresholds, speckle)
    shades = np.array(segment.shade_values(len(thresholds) + 1, invert))
    material = shades[levels] != 0

    # ndimage.label's default structure is 4-connectivity (edges, not corners).
    labels, count = ndimage.label(material)
    border = np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    supported = np.zeros(count + 1, dtype=bool)
    supported[border] = True
    supported[0] = True  # label 0 is the cut area, not a piece

    areas = np.bincount(labels.ravel(), minlength=count + 1)
    islands = []
    for label, box in enumerate(ndimage.find_objects(labels), start=1):
        if supported[label] or box is None:
            continue
        rows, cols = box
        islands.append(
            Island(
                area=int(areas[label]),
                x=cols.start,
                y=rows.start,
                width=cols.stop - cols.start,
                height=rows.stop - rows.start,
            )
        )
    islands.sort(key=lambda i: i.area, reverse=True)

    overlay = None
    if islands:
        rgba = np.zeros((height, width, 4), dtype=np.uint8)
        rgba[~supported[labels]] = _HIGHLIGHT
        buffer = io.BytesIO()
        Image.fromarray(rgba, "RGBA").save(buffer, format="PNG", compress_level=1)
        overlay = buffer.getvalue()

    return Report(width=width, height=height, islands=islands, overlay=overlay)
