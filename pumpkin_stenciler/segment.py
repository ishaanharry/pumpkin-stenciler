"""Brightness segmentation: reduce an image to a few flat shades of gray.

With N shades there are N-1 thresholds. A pixel's shade index is the number
of thresholds its brightness is >= to, so with the single threshold 128,
brightness 0-127 becomes black and 128-255 becomes white. Output shades are
spaced evenly from black (0) to white (255), or from white to black when
inverted.
"""

from __future__ import annotations

from PIL import Image

MIN_SHADES = 2  # black and white
MAX_SHADES = 5  # black, three grays, white


class SegmentError(ValueError):
    """Invalid segmentation settings; the message is safe to show the user."""


def default_thresholds(shades: int) -> list[int]:
    """Thresholds that split the brightness range into equal bands."""
    return [round(256 * i / shades) for i in range(1, shades)]


def shade_values(shades: int, invert: bool = False) -> list[int]:
    values = [round(255 * i / (shades - 1)) for i in range(shades)]
    return values[::-1] if invert else values


def parse_thresholds(raw: str) -> list[int]:
    try:
        thresholds = [int(part) for part in raw.split(",")]
    except ValueError:
        raise SegmentError("Thresholds must be comma-separated integers.")
    shades = len(thresholds) + 1
    if not MIN_SHADES <= shades <= MAX_SHADES:
        raise SegmentError(
            f"Use between {MIN_SHADES - 1} and {MAX_SHADES - 1} thresholds."
        )
    if any(not 1 <= t <= 255 for t in thresholds):
        raise SegmentError("Thresholds must be between 1 and 255.")
    if any(a >= b for a, b in zip(thresholds, thresholds[1:])):
        raise SegmentError("Thresholds must be strictly increasing.")
    return thresholds


def brightness(image: Image.Image) -> Image.Image:
    """Grayscale brightness, with transparent areas treated as white."""
    if image.mode == "RGBA":
        background = Image.new("RGBA", image.size, (255, 255, 255, 255))
        image = Image.alpha_composite(background, image)
    return image.convert("L")


def segment(
    image: Image.Image, thresholds: list[int], invert: bool = False
) -> Image.Image:
    shades = shade_values(len(thresholds) + 1, invert)
    lut = [shades[sum(value >= t for t in thresholds)] for value in range(256)]
    return brightness(image).point(lut)


def histogram(image: Image.Image) -> list[int]:
    return brightness(image).histogram()
