"""Check a stencil for pieces of pumpkin that won't survive carving.

Convention: black is cut all the way through; every other shade is material
(white is untouched skin, grays are shaved but keep their flesh). Only the
output shade matters, so flipping colors never changes what counts as cut.

The pumpkin beyond the stencil's edge is uncut and holds up anything touching
it. Two kinds of problem are reported:

- Unsupported pieces (islands): material not connected to the edge at all,
  i.e. enclosed by cuts. These fall out. Material only counts as connected
  through shared pixel edges, never diagonal corners, since a corner touch is
  a zero-width bridge.

- Fragile pieces: material that is connected to the edge, but only through
  bridges narrower than a minimum width, which will likely snap. Found by
  eroding the material by half that width (distance to the nearest cut, so
  widths are Euclidean and diagonal bridges are measured correctly). Thin
  bridges vanish, and a piece whose eroded core no longer reaches the edge
  hangs by thin bridges only. Thin dead ends (spikes, tips) also vanish under
  erosion, but losing one doesn't drop a piece, so they aren't reported.

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

# Overlay colors, chosen to read over black, white and gray alike.
_ISLAND_COLOR = (255, 48, 48, 200)  # red
_FRAGILE_COLOR = (255, 150, 0, 150)  # orange
_BRIDGE_COLOR = (255, 230, 0, 255)  # yellow

_EIGHT_CONNECTED = np.ones((3, 3), dtype=bool)


@dataclass
class Piece:
    area: int  # pixels
    x: int  # bounding box
    y: int
    width: int
    height: int


@dataclass
class Report:
    width: int
    height: int
    islands: list[Piece]  # largest first
    fragile: list[Piece]  # largest first; empty if bridges weren't checked
    overlay: bytes | None  # RGBA PNG highlighting problems, if any

    @property
    def valid(self) -> bool:
        return not self.islands and not self.fragile


def check_stencil(
    image: Image.Image,
    thresholds: list[int],
    invert: bool = False,
    speckle: int = vectorize.DEFAULT_SPECKLE,
    min_bridge_px: float = 0,
) -> Report:
    """min_bridge_px: narrowest safe bridge, in image pixels; 0 skips that check."""
    gray = np.asarray(segment.brightness(image))
    height, width = gray.shape
    levels = vectorize.shade_levels(gray, thresholds, speckle)
    shades = np.array(segment.shade_values(len(thresholds) + 1, invert))
    material = shades[levels] != 0

    islands = _find_islands(material)
    fragile = np.zeros_like(islands)
    bridges = np.zeros_like(material)
    # Islands are already lost, so only look for weak links in the rest.
    remaining = material & (islands == 0)
    if min_bridge_px >= 1 and remaining.any() and not remaining.all():
        fragile, bridges = _find_fragile(remaining, min_bridge_px / 2)

    overlay = None
    if islands.any() or fragile.any():
        rgba = np.zeros((height, width, 4), dtype=np.uint8)
        rgba[fragile > 0] = _FRAGILE_COLOR
        rgba[islands > 0] = _ISLAND_COLOR
        rgba[bridges] = _BRIDGE_COLOR
        buffer = io.BytesIO()
        Image.fromarray(rgba, "RGBA").save(buffer, format="PNG", compress_level=1)
        overlay = buffer.getvalue()

    return Report(
        width=width,
        height=height,
        islands=_pieces(islands),
        fragile=_pieces(fragile),
        overlay=overlay,
    )


def _find_islands(material: np.ndarray) -> np.ndarray:
    """Label image of material regions that don't reach the edge (0 elsewhere)."""
    # ndimage.label's default structure is 4-connectivity (edges, not corners).
    labels, count = ndimage.label(material)
    supported = np.zeros(count + 1, dtype=bool)
    supported[_edges(labels)] = True
    return np.where(supported[labels], 0, labels)


def _find_fragile(
    material: np.ndarray, radius: float
) -> tuple[np.ndarray, np.ndarray]:
    """Pieces held on only by bridges narrower than 2 * radius.

    Returns a label image of those pieces and a mask of the thin bridges
    holding them.
    """
    # Surround the image with material: the pumpkin beyond the stencil is
    # uncut, so erosion mustn't eat inward from the image border.
    pad = int(np.ceil(radius)) + 1
    padded = np.pad(material, pad, constant_values=True)

    # The core is everything at least `radius` from a cut; thin parts vanish.
    core = ndimage.distance_transform_edt(padded) >= radius
    core_labels, count = ndimage.label(core)
    supported = np.zeros(count + 1, dtype=bool)
    supported[_edges(core_labels)] = True

    # A strip almost exactly the minimum width erodes into a dotted line of
    # tiny core fragments. Those are part of a borderline bridge, not pieces
    # in their own right, so drop core regions narrower than about half the
    # radius; their pixels then count as thin material.
    min_core_area = np.pi * (radius / 4) ** 2
    tiny = (np.bincount(core_labels.ravel()) < min_core_area) & ~supported
    tiny[0] = False
    core &= ~tiny[core_labels]
    core_labels[~core] = 0

    # Grow each core region back by `radius` (a morphological opening), with
    # each pixel taking the label of its nearest core pixel.
    distance, (iy, ix) = ndimage.distance_transform_edt(~core, return_indices=True)
    reach = padded & (distance <= radius)
    grown = np.where(reach, core_labels[iy, ix], 0)

    # Regions: 1 = solidly supported, 2+ = a fragile piece (core label + 1).
    regions = np.where(supported[grown], 1, grown + 1) * reach
    fragile = np.where(regions >= 2, grown, 0)

    # Thin material is whatever the opening didn't restore. A thin part is a
    # bridge holding a fragile piece if it touches that piece and something
    # else (the supported area or another fragile piece); thin parts touching
    # just one region are dead ends.
    thin_labels, _ = ndimage.label(padded & ~reach, structure=_EIGHT_CONNECTED)
    touching = _touching_regions(thin_labels, regions)
    bridge_ids = [
        thin_id
        for thin_id, region_ids in touching.items()
        if len(region_ids) >= 2 and max(region_ids) >= 2
    ]
    bridges = np.isin(thin_labels, bridge_ids)

    crop = (slice(pad, -pad), slice(pad, -pad))
    return fragile[crop], bridges[crop]


def _touching_regions(
    thin_labels: np.ndarray, regions: np.ndarray
) -> dict[int, set[int]]:
    """For each thin component, the set of regions its pixels border."""
    height, width = thin_labels.shape
    padded_regions = np.pad(regions, 1)
    stride = int(regions.max()) + 1
    codes = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy == dx == 0:
                continue
            neighbor = padded_regions[1 + dy : 1 + dy + height, 1 + dx : 1 + dx + width]
            hit = (thin_labels > 0) & (neighbor > 0)
            codes.append(thin_labels[hit].astype(np.int64) * stride + neighbor[hit])
    touching: dict[int, set[int]] = {}
    for code in np.unique(np.concatenate(codes)):
        touching.setdefault(int(code // stride), set()).add(int(code % stride))
    return touching


def _pieces(labels: np.ndarray) -> list[Piece]:
    areas = np.bincount(labels.ravel())
    pieces = []
    for label, box in enumerate(ndimage.find_objects(labels), start=1):
        if box is None:
            continue
        rows, cols = box
        pieces.append(
            Piece(
                area=int(areas[label]),
                x=cols.start,
                y=rows.start,
                width=cols.stop - cols.start,
                height=rows.stop - rows.start,
            )
        )
    return sorted(pieces, key=lambda p: p.area, reverse=True)


def _edges(array: np.ndarray) -> np.ndarray:
    return np.concatenate([array[0], array[-1], array[:, 0], array[:, -1]])
