# Pumpkin Stenciler

A web app that turns images into jack-o'-lantern carving stencils.

## Running

```sh
uv run main.py            # http://127.0.0.1:8000
uv run main.py --reload   # restart automatically while developing
```

## Uploads

Images (PNG, JPEG, WebP, GIF, ...) and PDFs up to 25 MB can be uploaded by
drag-and-drop, the file picker, or pasting from the clipboard. Every upload is
normalised into PNG pages under `data/uploads/<id>/`: an image becomes one
page, a PDF becomes one page per PDF page (max 20).
