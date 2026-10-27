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

## Stencil pipeline

1. **Segment** (`segment.py`): reduce a page to 2-5 flat shades of gray by
   brightness thresholds, optionally flipped.
2. **Vectorize** (`vectorize.py`): trace the segmented shades into a stacked
   SVG with [vtracer](https://github.com/visioncortex/vtracer). The SVG has a
   background `<rect>` plus one `<g id="shade-N">` per threshold, each holding
   everything at or above that brightness, so the layers stack without gaps.
   Small blobs and holes are removed before tracing ("Remove specks").
3. **Check** (`validate.py`): find unsupported pieces, i.e. material that
   would fall out. Black is always the cut-through color; white (skin) and
   grays (shaved) are material. Any region of material not connected to the
   stencil's edge, through edge-sharing pixels rather than diagonal corners,
   is enclosed by cuts and gets flagged. It runs on the same speck-cleaned
   layers the SVG is traced from.
