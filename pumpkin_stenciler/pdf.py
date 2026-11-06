"""Write the traced stencil as a vector PDF at its printed size.

Printed at 100% ("Actual size"), the stencil comes out exactly as wide as the
printed width setting. The page is the stencil's own size; print dialogs
centre it on the paper.

The shapes are the same ones the SVG is built from (vectorize.trace), written
straight out as PDF drawing operators, so no SVG renderer is needed.
"""

from __future__ import annotations

import re
import zlib

from . import vectorize
from .stencil import Stencil

_TOKEN = re.compile(r"[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
_TRANSLATE = re.compile(r"\s*translate\(\s*([^\s,)]+)[\s,]+([^\s,)]+)\s*\)\s*")
# vtracer writes absolute moveto, lineto, curveto and closepath commands only.
_ARITY = {"M": 2, "L": 2, "C": 6, "Z": 0}
_OPERATOR = {"M": "m", "L": "l", "C": "c", "Z": "h"}


def render(stencil: Stencil, smoothness: int, width_mm: float) -> bytes:
    height, width = stencil.levels.shape
    scale = width_mm / 25.4 * 72 / width  # PDF points per stencil pixel
    page_w, page_h = width * scale, height * scale

    # Draw in stencil pixels with y pointing down, as in the SVG.
    ops = [f"{_num(scale)} 0 0 {_num(-scale)} 0 {_num(page_h)} cm"]
    ops.append(f"{_gray(stencil.shades[0])} g 0 0 {width} {height} re f")
    for layer in vectorize.trace(stencil, smoothness):
        ops.append(f"{_gray(layer.shade)} g")
        # Each path is filled on its own with the even-odd rule, like the SVG.
        ops.extend(_path(d, transform) + " f*" for d, transform in layer.paths)
    content = zlib.compress("\n".join(ops).encode())

    return _document(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {_num(page_w)} {_num(page_h)}] "
            f"/Resources << >> /Contents 4 0 R >>".encode(),
            f"<< /Length {len(content)} /Filter /FlateDecode >>\nstream\n".encode()
            + content
            + b"\nendstream",
        ]
    )


def _path(d: str, transform: str | None) -> str:
    """Convert SVG path data, offset by its translate transform, to PDF operators."""
    dx = dy = 0.0
    if transform:
        match = _TRANSLATE.fullmatch(transform)
        if not match:
            raise ValueError(f"Unsupported transform: {transform}")
        dx, dy = float(match[1]), float(match[2])

    tokens = _TOKEN.findall(d)
    ops = []
    command = None
    i = 0
    while i < len(tokens):
        if tokens[i].isalpha():
            command = tokens[i]
            i += 1
            if command not in _ARITY:
                raise ValueError(f"Unsupported path command: {command}")
        elif command in (None, "Z"):
            raise ValueError("Path data has numbers without a command.")
        count = _ARITY[command]
        values = [float(t) for t in tokens[i : i + count]]
        i += count
        coords = [v + (dx if k % 2 == 0 else dy) for k, v in enumerate(values)]
        ops.append(" ".join([*map(_num, coords), _OPERATOR[command]]))
        if command == "M":
            command = "L"  # further coordinate pairs after a moveto are linetos
    return " ".join(ops)


def _document(objects: list[bytes]) -> bytes:
    """A PDF file from its objects, numbered from 1 in order."""
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref}\n%%EOF\n".encode()
    )
    return bytes(out)


def _gray(value: int) -> str:
    return _num(value / 255)


def _num(value: float) -> str:
    return f"{value:.3f}".rstrip("0").rstrip(".") or "0"
