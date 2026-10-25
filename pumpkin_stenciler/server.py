import io
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

from . import segment, uploads

STATIC_DIR = Path(__file__).resolve().parent / "static"

app = FastAPI(title="Pumpkin Stenciler")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


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


@app.get("/api/uploads/{upload_id}/pages/{page}/segmented")
def get_segmented(upload_id: str, page: int, thresholds: str, invert: bool = False):
    """The page reduced to len(thresholds) + 1 shades, e.g. ?thresholds=85,170.

    With invert=true the shades are flipped: dark areas become white and vice versa.
    """
    try:
        parsed = segment.parse_thresholds(thresholds)
    except segment.SegmentError as e:
        raise HTTPException(status_code=400, detail=str(e))
    with _open_page(upload_id, page) as image:
        result = segment.segment(image, parsed, invert)
    buffer = io.BytesIO()
    # Speed matters more than file size here: this is re-rendered as sliders move.
    result.save(buffer, format="PNG", compress_level=1)
    return Response(
        buffer.getvalue(),
        media_type="image/png",
        # Pages never change once uploaded, so a given URL is always the same image.
        headers={"Cache-Control": "private, max-age=3600"},
    )


def _open_page(upload_id: str, page: int) -> Image.Image:
    path = uploads.page_path(upload_id, page)
    if path is None:
        raise HTTPException(status_code=404, detail="Page not found.")
    return Image.open(path)


@app.delete("/api/uploads/{upload_id}", status_code=204)
def delete_upload(upload_id: str):
    if not uploads.delete_upload(upload_id):
        raise HTTPException(status_code=404, detail="Upload not found.")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
