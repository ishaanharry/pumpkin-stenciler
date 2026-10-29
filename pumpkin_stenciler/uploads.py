"""Storage for uploaded source files.

Every upload is normalised into one or more PNG "pages" so the rest of the
app only ever has to deal with images: a photo becomes a single page, a PDF
becomes one page per PDF page.

Layout on disk:
    data/uploads/<id>/meta.json
    data/uploads/<id>/page-1.png
    data/uploads/<id>/page-2.png ...
    data/uploads/<id>/edits-1.png       hand edits to page 1, if any
    data/uploads/<id>/settings-1.json   stencil settings for page 1, if saved
"""

from __future__ import annotations

import io
import json
import re
import shutil
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageOps, UnidentifiedImageError

UPLOAD_DIR = Path(__file__).resolve().parent.parent / "data" / "uploads"

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_PDF_PAGES = 20
# Longest side of a stored page. Plenty of detail for a pumpkin stencil while
# keeping later processing fast.
MAX_PAGE_SIDE = 2400

_ID_RE = re.compile(r"^[0-9a-f]{32}$")

# Refuse decompression bombs outright instead of only warning.
Image.MAX_IMAGE_PIXELS = 80_000_000


class UploadError(ValueError):
    """The uploaded file was rejected; the message is safe to show the user."""


@dataclass
class Upload:
    id: str
    filename: str
    kind: str  # "image" | "pdf"
    page_count: int
    width: int  # dimensions of the first page
    height: int
    created_at: float
    # Physical width of each page, for PDFs; images have no physical size.
    # Missing from uploads saved before this was recorded.
    page_widths_mm: list[float] | None = None

    def to_json(self) -> dict:
        data = asdict(self)
        numbers = range(1, self.page_count + 1)
        data["pages"] = [f"/api/uploads/{self.id}/pages/{n}" for n in numbers]
        # Per page, in the same order as "pages".
        data["page_sizes"] = [page_size(self.id, n) for n in numbers]
        data["edit_versions"] = [edits_version(self.id, n) for n in numbers]
        data["settings"] = [load_settings(self.id, n) for n in numbers]
        return data


def save_upload(filename: str, data: bytes) -> Upload:
    if not data:
        raise UploadError("The file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise UploadError(
            f"The file is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB."
        )

    # Sniff the content rather than trusting the browser-supplied type.
    if data[:5] == b"%PDF-":
        kind = "pdf"
        pages, page_widths_mm = _render_pdf(data)
    else:
        kind, pages, page_widths_mm = "image", [_load_image(data)], None

    upload_id = uuid.uuid4().hex
    folder = UPLOAD_DIR / upload_id
    folder.mkdir(parents=True)
    try:
        for n, page in enumerate(pages, start=1):
            page.save(folder / f"page-{n}.png", optimize=True)
        upload = Upload(
            id=upload_id,
            filename=Path(filename or "upload").name,
            kind=kind,
            page_count=len(pages),
            width=pages[0].width,
            height=pages[0].height,
            created_at=time.time(),
            page_widths_mm=page_widths_mm,
        )
        (folder / "meta.json").write_text(json.dumps(asdict(upload)))
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    return upload


def list_uploads() -> list[Upload]:
    if not UPLOAD_DIR.exists():
        return []
    uploads = []
    for meta in UPLOAD_DIR.glob("*/meta.json"):
        try:
            uploads.append(Upload(**json.loads(meta.read_text())))
        except (OSError, ValueError, TypeError):
            continue
    return sorted(uploads, key=lambda u: u.created_at, reverse=True)


def get_upload(upload_id: str) -> Upload | None:
    folder = _folder(upload_id)
    if folder is None:
        return None
    try:
        return Upload(**json.loads((folder / "meta.json").read_text()))
    except (OSError, ValueError, TypeError):
        return None


def page_path(upload_id: str, page: int) -> Path | None:
    folder = _folder(upload_id)
    if folder is None or page < 1:
        return None
    path = folder / f"page-{page}.png"
    return path if path.is_file() else None


def page_size(upload_id: str, page: int) -> tuple[int, int] | None:
    path = page_path(upload_id, page)
    if path is None:
        return None
    with Image.open(path) as image:  # reads only the header
        return image.size


# ---- Hand edits ----------------------------------------------------------
# An RGBA PNG the size of the page: alpha marks edited pixels and the gray
# value is the output shade painted there (see stencil.py).


def edits_path(upload_id: str, page: int) -> Path | None:
    """Where the page's edits are stored (whether or not there are any)."""
    return _page_file(upload_id, page, "edits-{}.png")


def load_edits(upload_id: str, page: int) -> Image.Image | None:
    path = edits_path(upload_id, page)
    if path is None or not path.is_file():
        return None
    with Image.open(path) as image:
        return image.convert("RGBA")


def save_edits(upload_id: str, page: int, data: bytes) -> str | None:
    """Store edits from PNG bytes; returns the new version, or None if empty."""
    path = edits_path(upload_id, page)
    size = page_size(upload_id, page)
    if path is None or size is None:
        raise UploadError("Page not found.")
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format != "PNG":
                raise UploadError("Edits must be a PNG.")
            if image.size != size:
                raise UploadError("Edits must be the same size as the page.")
            image = image.convert("RGBA")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise UploadError("Edits must be a PNG.")

    # Normalise: alpha is all or nothing, and unedited pixels carry no color.
    rgba = np.array(image)
    edited = rgba[..., 3] >= 128
    if not edited.any():
        delete_edits(upload_id, page)
        return None
    rgba[..., 3] = np.where(edited, 255, 0)
    rgba[~edited] = 0
    _write_atomic(path, lambda f: Image.fromarray(rgba, "RGBA").save(f, format="PNG"))
    return edits_version(upload_id, page)


def delete_edits(upload_id: str, page: int) -> None:
    path = edits_path(upload_id, page)
    if path is not None:
        path.unlink(missing_ok=True)


def edits_version(upload_id: str, page: int) -> str | None:
    """Changes whenever the edits do; used to tell clients to refetch."""
    path = edits_path(upload_id, page)
    if path is None or not path.is_file():
        return None
    return str(path.stat().st_mtime_ns)


# ---- Stencil settings -----------------------------------------------------
# Opaque to this module: the server validates them, the client interprets them.


def load_settings(upload_id: str, page: int) -> dict | None:
    path = _page_file(upload_id, page, "settings-{}.json")
    try:
        return json.loads(path.read_text()) if path else None
    except (OSError, ValueError):
        return None


def save_settings(upload_id: str, page: int, settings: dict) -> None:
    path = _page_file(upload_id, page, "settings-{}.json")
    if path is None or page_path(upload_id, page) is None:
        raise UploadError("Page not found.")
    _write_atomic(path, lambda f: f.write(json.dumps(settings).encode()))


def _page_file(upload_id: str, page: int, pattern: str) -> Path | None:
    folder = _folder(upload_id)
    if folder is None or page < 1:
        return None
    return folder / pattern.format(page)


def _write_atomic(path: Path, write) -> None:
    """Write via a temporary file so readers never see a half-written file."""
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with open(temp, "wb") as f:
            write(f)
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def delete_upload(upload_id: str) -> bool:
    folder = _folder(upload_id)
    if folder is None:
        return False
    shutil.rmtree(folder)
    return True


def _folder(upload_id: str) -> Path | None:
    # Ids are generated by us; anything else (e.g. "../") is rejected.
    if not _ID_RE.match(upload_id):
        return None
    folder = UPLOAD_DIR / upload_id
    return folder if folder.is_dir() else None


def _load_image(data: bytes) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Image.DecompressionBombError:
        raise UploadError("The image is too large.")
    except (UnidentifiedImageError, OSError):
        raise UploadError("Unsupported file. Upload an image (PNG, JPEG, ...) or a PDF.")

    # Phone photos are often stored sideways with an EXIF rotation flag.
    image = ImageOps.exif_transpose(image)
    image = image.convert("RGBA" if _has_alpha(image) else "RGB")
    image.thumbnail((MAX_PAGE_SIDE, MAX_PAGE_SIDE), Image.Resampling.LANCZOS)
    return image


def _has_alpha(image: Image.Image) -> bool:
    return image.mode in ("RGBA", "LA", "PA") or (
        image.mode == "P" and "transparency" in image.info
    )


def _render_pdf(data: bytes) -> tuple[list[Image.Image], list[float]]:
    """The rendered pages and each page's physical width in mm."""
    try:
        pdf = pdfium.PdfDocument(data)
    except pdfium.PdfiumError:
        raise UploadError("The PDF could not be read. Is it corrupted or password protected?")

    try:
        if len(pdf) == 0:
            raise UploadError("The PDF has no pages.")
        if len(pdf) > MAX_PDF_PAGES:
            raise UploadError(f"The PDF has more than {MAX_PDF_PAGES} pages.")

        pages, widths_mm = [], []
        for page in pdf:
            width, height = page.get_size()  # in points (1/72 inch)
            scale = MAX_PAGE_SIDE / max(width, height)
            # White background so transparent PDF regions don't render black.
            bitmap = page.render(scale=scale, fill_color=(255, 255, 255, 255))
            image = bitmap.to_pil().convert("RGB")
            pages.append(image)
            # From the rendered size, so rotated pages report the visible width.
            widths_mm.append(round(image.width / scale / 72 * 25.4, 2))
            page.close()
        return pages, widths_mm
    finally:
        pdf.close()
