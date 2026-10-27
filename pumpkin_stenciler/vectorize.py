"""Trace a brightness-segmented image into a stacked SVG.

The SVG is built bottom-up: a background rectangle in the shade of the
darkest brightness band, then one layer per threshold containing every pixel
at or above that threshold. Because each layer is a subset of the one below
it, stacking them reproduces the segmented image exactly, and shared edges
can't show hairline gaps. With invert the fills are flipped, but the layers
themselves are the same.

Each layer is traced separately as a black-and-white mask, so fills are the
exact shade values rather than colors re-estimated from anti-aliased edges.
"""

from __future__ import annotations

import io
import xml.etree.ElementTree as ET
from xml.sax.saxutils import quoteattr

import numpy as np
import vtracer
from PIL import Image
from scipy import ndimage

from . import segment

MAX_SPECKLE = 100
MAX_SMOOTHNESS = 100
DEFAULT_SPECKLE = 8
DEFAULT_SMOOTHNESS = 25

_SVG_NS = "{http://www.w3.org/2000/svg}"


class VectorizeError(ValueError):
    """The image couldn't be traced; the message is safe to show the user."""


def vectorize(
    image: Image.Image,
    thresholds: list[int],
    invert: bool = False,
    speckle: int = DEFAULT_SPECKLE,
    smoothness: int = DEFAULT_SMOOTHNESS,
) -> str:
    """Return SVG markup for the image segmented at the given thresholds.

    speckle: blobs and holes smaller than speckle x speckle pixels in area are
        removed, which also keeps very fine detail from overwhelming the tracer.
    smoothness: 0-100; higher rounds off more corners and small wiggles.
    """
    gray = np.asarray(segment.brightness(image))
    height, width = gray.shape
    shades = segment.shade_values(len(thresholds) + 1, invert)

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}">',
        f'<rect id="shade-0" width="{width}" height="{height}" fill="{_hex(shades[0])}"/>',
    ]
    layers = shade_layers(gray, thresholds, speckle)
    for level, (threshold, layer) in enumerate(zip(thresholds, layers), start=1):
        paths = _trace(layer, smoothness)
        parts.append(
            f'<g id="shade-{level}" data-min-brightness="{threshold}" '
            f'fill="{_hex(shades[level])}" fill-rule="evenodd">'
        )
        parts.extend(
            f"<path d={quoteattr(d)}"
            + (f" transform={quoteattr(transform)}" if transform else "")
            + "/>"
            for d, transform in paths
        )
        parts.append("</g>")
    parts.append("</svg>")
    return "\n".join(parts)


def shade_layers(
    gray: np.ndarray, thresholds: list[int], speckle: int
) -> list[np.ndarray]:
    """The masks traced into the SVG's shade groups, bottom to top.

    Layer k covers pixels at or above thresholds[k], with specks removed.
    Pixels covered by no layer show the background shade.
    """
    return [_despeckle(gray >= t, speckle) for t in thresholds]


def shade_levels(
    gray: np.ndarray, thresholds: list[int], speckle: int
) -> np.ndarray:
    """Per-pixel shade index of the stacked SVG (0 = background).

    Later layers paint over earlier ones, exactly as the SVG renders.
    """
    levels = np.zeros(gray.shape, dtype=np.uint8)
    for level, layer in enumerate(shade_layers(gray, thresholds, speckle), start=1):
        levels[layer] = level
    return levels


def _despeckle(layer: np.ndarray, speckle: int) -> np.ndarray:
    """Drop blobs and fill holes smaller than speckle x speckle pixels in area.

    vtracer can filter specks itself, but it fails outright on masks with too
    many separate regions (noisy or finely textured photos), so they are
    removed here before tracing.
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


def _trace(layer: np.ndarray, smoothness: int) -> list[tuple[str, str | None]]:
    """Trace the True areas of a layer into (path data, transform) pairs."""
    # vtracer's binary mode traces dark pixels, so the layer is drawn black.
    mask = Image.fromarray(np.where(layer, 0, 255).astype(np.uint8))
    buffer = io.BytesIO()
    mask.save(buffer, format="PNG", compress_level=1)
    try:
        svg = vtracer.convert_raw_image_to_svg(
            buffer.getvalue(),
            img_format="png",
            colormode="binary",
            mode="spline",
            filter_speckle=0,  # already done by _despeckle
            # Map the single smoothness knob onto vtracer's curve-fitting
            # settings. At the default of 25 these are close to its defaults.
            corner_threshold=round(30 + 1.2 * smoothness),
            length_threshold=3.5 + 0.065 * smoothness,
            splice_threshold=45,
            path_precision=2,
        )
    except BaseException as e:
        # vtracer reports internal failures as a Rust panic, which surfaces as
        # a BaseException; the known cause is a mask with too many regions.
        if type(e).__name__ != "PanicException":
            raise
        raise VectorizeError(
            "This image has too much fine detail to trace. "
            "Increase “Remove specks” or use fewer shades."
        ) from e

    # Keep each path's geometry and position (vtracer places paths with a
    # translate transform) but drop its fill so the layer's <g> sets it.
    paths = []
    for path in ET.fromstring(svg).iter(f"{_SVG_NS}path"):
        d = path.get("d", "").strip()
        if d:
            paths.append((d, path.get("transform")))
    return paths


def _hex(value: int) -> str:
    return f"#{value:02x}{value:02x}{value:02x}"
