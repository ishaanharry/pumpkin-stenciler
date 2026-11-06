"""Trace the final stencil raster into a stacked SVG.

The SVG is built bottom-up: a background rectangle in the shade of shade
index 0, then one group per higher shade index containing every pixel at or
above it. Because each group is a subset of the one below it, stacking them
reproduces the stencil exactly, and shared edges can't show hairline gaps.

Each group is traced separately as a black-and-white mask, so fills are the
exact shade values rather than colors re-estimated from anti-aliased edges.
"""

from __future__ import annotations

import io
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from xml.sax.saxutils import quoteattr

import numpy as np
import vtracer
from PIL import Image

from .stencil import Stencil

MAX_SMOOTHNESS = 100
DEFAULT_SMOOTHNESS = 25

_SVG_NS = "{http://www.w3.org/2000/svg}"


class VectorizeError(ValueError):
    """The image couldn't be traced; the message is safe to show the user."""


@dataclass
class Layer:
    level: int  # shade index; the layer holds every pixel at or above it
    threshold: int  # brightness where this shade's band starts
    shade: int  # output gray value
    paths: list[tuple[str, str | None]]  # (SVG path data, transform or None)


def trace(stencil: Stencil, smoothness: int = DEFAULT_SMOOTHNESS) -> list[Layer]:
    """Trace each shade above the background into paths, bottom-up.

    smoothness: 0-100; higher rounds off more corners and small wiggles.
    """
    return [
        Layer(level, threshold, stencil.shades[level], _trace(stencil.layer(level), smoothness))
        for level, threshold in enumerate(stencil.thresholds, start=1)
    ]


def vectorize(stencil: Stencil, smoothness: int = DEFAULT_SMOOTHNESS) -> str:
    """Return SVG markup for the stencil."""
    height, width = stencil.levels.shape

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}">',
        f'<rect id="shade-0" width="{width}" height="{height}" fill="{_hex(stencil.shades[0])}"/>',
    ]
    for layer in trace(stencil, smoothness):
        parts.append(
            f'<g id="shade-{layer.level}" data-min-brightness="{layer.threshold}" '
            f'fill="{_hex(layer.shade)}" fill-rule="evenodd">'
        )
        parts.extend(
            f"<path d={quoteattr(d)}"
            + (f" transform={quoteattr(transform)}" if transform else "")
            + "/>"
            for d, transform in layer.paths
        )
        parts.append("</g>")
    parts.append("</svg>")
    return "\n".join(parts)


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
            filter_speckle=0,  # already done when building the stencil
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
