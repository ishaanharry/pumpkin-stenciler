import base64
import io
from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field

from . import glow, pdf, segment, stencil, uploads, validate, vectorize

STATIC_DIR = Path(__file__).resolve().parent / "static"

app = FastAPI(title="Pumpkin Stenciler")

# The frontend files change whenever the app does. Without this, browsers may
# reuse a stale cached app.js alongside a fresh index.html. "no-cache" still
# lets them keep a copy, but they revalidate it (cheaply, via ETag) each load.
_NO_CACHE = {"Cache-Control": "no-cache"}


class _RevalidatedStaticFiles(StaticFiles):
    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers.update(_NO_CACHE)
        return response


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html", headers=_NO_CACHE)


# Plain `def` endpoints run in FastAPI's threadpool, so image decoding and
# PDF rendering don't block the event loop.
@app.post("/api/uploads", status_code=201)
def create_upload(file: UploadFile):
    data = file.file.read(uploads.MAX_UPLOAD_BYTES + 1)
    try:
        upload = uploads.save_upload(file.filename or "upload", data)
    except uploads.UploadError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return upload.to_json()


@app.get("/api/uploads")
def list_uploads():
    return [u.to_json() for u in uploads.list_uploads()]


@app.get("/api/uploads/{upload_id}")
def get_upload(upload_id: str):
    upload = uploads.get_upload(upload_id)
    if upload is None:
        raise HTTPException(status_code=404, detail="Upload not found.")
    return upload.to_json()


@app.get("/api/uploads/{upload_id}/pages/{page}")
def get_page(upload_id: str, page: int):
    path = uploads.page_path(upload_id, page)
    if path is None:
        raise HTTPException(status_code=404, detail="Page not found.")
    return FileResponse(path, media_type="image/png")


@app.get("/api/uploads/{upload_id}/pages/{page}/histogram")
def get_histogram(upload_id: str, page: int):
    """256 pixel counts, one per brightness value."""
    with _open_page(upload_id, page) as image:
        return segment.histogram(image)


# The rendered outputs below all start from the same final stencil
# (stencil.build): segmented, speck-cleaned, with the page's hand edits
# applied. Their URLs are cached, so clients add a `v` query parameter with
# the page's edits version; the server ignores it, but it changes the URL
# whenever the edits do.


@app.get("/api/uploads/{upload_id}/pages/{page}/segmented")
def get_segmented(
    upload_id: str,
    page: int,
    thresholds: str,
    invert: bool = False,
    speckle: int = Query(stencil.DEFAULT_SPECKLE, ge=0, le=stencil.MAX_SPECKLE),
    edits: bool = True,
):
    """The stencil as a flat-shaded PNG, e.g. ?thresholds=85,170.

    With invert=true the shades are flipped. edits=false leaves out the hand
    edits, which the editor draws on top itself.
    """
    result = _build_stencil(upload_id, page, thresholds, invert, speckle, edits)
    buffer = io.BytesIO()
    # Speed matters more than file size here: this is re-rendered as sliders move.
    Image.fromarray(result.values).save(buffer, format="PNG", compress_level=1)
    return Response(buffer.getvalue(), media_type="image/png", headers=_CACHE_HEADERS)


@app.get("/api/uploads/{upload_id}/pages/{page}/glow")
def get_glow(
    upload_id: str,
    page: int,
    thresholds: str,
    invert: bool = False,
    speckle: int = Query(stencil.DEFAULT_SPECKLE, ge=0, le=stencil.MAX_SPECKLE),
):
    """A PNG of how the carved pumpkin looks lit from inside."""
    result = _build_stencil(upload_id, page, thresholds, invert, speckle)
    buffer = io.BytesIO()
    glow.render(result).save(buffer, format="PNG", compress_level=1)
    return Response(buffer.getvalue(), media_type="image/png", headers=_CACHE_HEADERS)


@app.get("/api/uploads/{upload_id}/pages/{page}/svg")
def get_svg(
    upload_id: str,
    page: int,
    thresholds: str,
    invert: bool = False,
    speckle: int = Query(stencil.DEFAULT_SPECKLE, ge=0, le=stencil.MAX_SPECKLE),
    smoothness: int = Query(
        vectorize.DEFAULT_SMOOTHNESS, ge=0, le=vectorize.MAX_SMOOTHNESS
    ),
):
    """The stencil traced to a stacked SVG, one <g> per shade."""
    result = _build_stencil(upload_id, page, thresholds, invert, speckle)
    try:
        svg = vectorize.vectorize(result, smoothness)
    except vectorize.VectorizeError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return Response(svg, media_type="image/svg+xml", headers=_CACHE_HEADERS)


@app.get("/api/uploads/{upload_id}/pages/{page}/pdf")
def get_pdf(
    upload_id: str,
    page: int,
    thresholds: str,
    width_mm: float = Query(gt=0, le=5000),
    invert: bool = False,
    speckle: int = Query(stencil.DEFAULT_SPECKLE, ge=0, le=stencil.MAX_SPECKLE),
    smoothness: int = Query(
        vectorize.DEFAULT_SMOOTHNESS, ge=0, le=vectorize.MAX_SMOOTHNESS
    ),
):
    """The traced stencil as a vector PDF, width_mm wide when printed at 100%."""
    result = _build_stencil(upload_id, page, thresholds, invert, speckle)
    try:
        data = pdf.render(result, smoothness, width_mm)
    except vectorize.VectorizeError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return Response(data, media_type="application/pdf", headers=_CACHE_HEADERS)


@app.get("/api/uploads/{upload_id}/pages/{page}/check")
def check_stencil(
    upload_id: str,
    page: int,
    thresholds: str,
    invert: bool = False,
    speckle: int = Query(stencil.DEFAULT_SPECKLE, ge=0, le=stencil.MAX_SPECKLE),
    width_mm: float | None = Query(None, gt=0, le=5000),
    min_bridge_mm: float | None = Query(None, ge=0, le=500),
):
    """Pieces that won't survive carving: islands enclosed by black cuts, and
    (when the printed width_mm and min_bridge_mm are given) fragile pieces
    held on only by bridges narrower than min_bridge_mm.

    overlay is a data: URL of a transparent PNG highlighting them, or null.
    """
    result = _build_stencil(upload_id, page, thresholds, invert, speckle)
    min_bridge_px = 0.0
    if width_mm and min_bridge_mm:
        min_bridge_px = min_bridge_mm * result.levels.shape[1] / width_mm
    report = validate.check_stencil(result, min_bridge_px)
    overlay = None
    if report.overlay:
        overlay = "data:image/png;base64," + base64.b64encode(report.overlay).decode()
    return JSONResponse(
        {
            "valid": report.valid,
            "width": report.width,
            "height": report.height,
            "islands": [asdict(p) for p in report.islands],
            "fragile": [asdict(p) for p in report.fragile],
            "overlay": overlay,
        },
        headers=_CACHE_HEADERS,
    )


# Pages never change once uploaded, and edits are versioned in the URL (see
# above), so a given URL always yields the same result.
_CACHE_HEADERS = {"Cache-Control": "private, max-age=3600"}


def _build_stencil(
    upload_id: str,
    page: int,
    thresholds: str,
    invert: bool,
    speckle: int,
    with_edits: bool = True,
) -> stencil.Stencil:
    parsed = _parse_thresholds(thresholds)
    edits = uploads.load_edits(upload_id, page) if with_edits else None
    with _open_page(upload_id, page) as image:
        return stencil.build(image, parsed, invert, speckle, edits)


def _parse_thresholds(raw: str) -> list[int]:
    try:
        return segment.parse_thresholds(raw)
    except segment.SegmentError as e:
        raise HTTPException(status_code=400, detail=str(e))


def _open_page(upload_id: str, page: int) -> Image.Image:
    path = uploads.page_path(upload_id, page)
    if path is None:
        raise HTTPException(status_code=404, detail="Page not found.")
    return Image.open(path)


# ---- Hand edits and saved settings ----------------------------------------


@app.get("/api/uploads/{upload_id}/pages/{page}/edits")
def get_edits(upload_id: str, page: int):
    """The page's hand edits as an RGBA PNG (see stencil.py), or 404 if none."""
    if uploads.edits_version(upload_id, page) is None:
        raise HTTPException(status_code=404, detail="No edits.")
    return FileResponse(uploads.edits_path(upload_id, page), media_type="image/png")


@app.put("/api/uploads/{upload_id}/pages/{page}/edits")
async def put_edits(upload_id: str, page: int, request: Request):
    """Replace the page's edits with the PNG in the request body.

    Returns the new edits version (null if the PNG had no edited pixels).
    """
    if uploads.page_path(upload_id, page) is None:
        raise HTTPException(status_code=404, detail="Page not found.")
    data = await request.body()
    if len(data) > uploads.MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Edits are too large.")
    try:
        version = await run_in_threadpool(uploads.save_edits, upload_id, page, data)
    except uploads.UploadError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"version": version}


@app.delete("/api/uploads/{upload_id}/pages/{page}/edits", status_code=204)
def delete_edits(upload_id: str, page: int):
    if uploads.page_path(upload_id, page) is None:
        raise HTTPException(status_code=404, detail="Page not found.")
    uploads.delete_edits(upload_id, page)


class PageSettings(BaseModel):
    """Stencil settings for one page, as the editor uses them."""

    model_config = ConfigDict(extra="forbid")

    shades: int = Field(ge=segment.MIN_SHADES, le=segment.MAX_SHADES)
    thresholds: list[int]
    invert: bool
    speckle: int = Field(ge=0, le=stencil.MAX_SPECKLE)
    smoothness: int = Field(ge=0, le=vectorize.MAX_SMOOTHNESS)
    widthMm: float = Field(gt=0, le=5000)
    minBridgeMm: float = Field(ge=0, le=500)


@app.put("/api/uploads/{upload_id}/pages/{page}/settings", status_code=204)
def put_settings(upload_id: str, page: int, settings: PageSettings):
    parsed = _parse_thresholds(",".join(map(str, settings.thresholds)))
    if len(parsed) != settings.shades - 1:
        raise HTTPException(status_code=400, detail="Wrong number of thresholds.")
    try:
        uploads.save_settings(upload_id, page, settings.model_dump())
    except uploads.UploadError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.delete("/api/uploads/{upload_id}", status_code=204)
def delete_upload(upload_id: str):
    if not uploads.delete_upload(upload_id):
        raise HTTPException(status_code=404, detail="Upload not found.")


app.mount("/static", _RevalidatedStaticFiles(directory=STATIC_DIR), name="static")
