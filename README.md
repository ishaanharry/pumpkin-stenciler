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

Black is always the cut-through color; white is uncarved skin; grays are
shaved partway.

1. **Build the stencil** (`stencil.py`): reduce a page to 2-5 flat shades of
   gray by brightness thresholds (`segment.py`), optionally flipped; remove
   blobs and holes smaller than "Remove specks"; then apply the page's hand
   edits. Everything below works from this final raster.
2. **Hand edits** (`static/editor.js`): paint on the Stencil tab with a
   brush, eraser (paints uncarved skin over anything), restore (removes
   hand edits, back to automatic) or fill. Clicking a piece the check
   highlighted fills exactly that piece. Edits are stored per page as
   `edits-N.png` (gray = shade painted, alpha = edited), in output shades, so
   moving thresholds or flipping colors never changes them. Stencil settings
   are saved per page as `settings-N.json`.
3. **Vectorize** (`vectorize.py`): trace the stencil into a stacked SVG with
   [vtracer](https://github.com/visioncortex/vtracer). The SVG has a
   background `<rect>` plus one `<g id="shade-N">` per higher shade, each
   holding everything at or above it, so the layers stack without gaps.
4. **Check** (`validate.py`): find unsupported pieces, i.e. material that
   would fall out. Black is always the cut-through color; white (skin) and
   grays (shaved) are material. Any region of material not connected to the
   stencil's edge, through edge-sharing pixels rather than diagonal corners,
   is enclosed by cuts and gets flagged. It runs on the same final stencil
   the SVG is traced from.

   Given the printed stencil width and a minimum bridge width, it also flags
   *fragile* pieces: connected, but only through bridges narrower than the
   minimum. The material is eroded by half the minimum width (via a
   Euclidean distance transform); pieces whose eroded core no longer reaches
   the edge hang by thin bridges, which are highlighted. Thin dead ends are
   ignored, since losing one doesn't drop a piece. PDFs default to their
   physical page width; images default to 8 in.

## Editor shortcuts

| Key | Action |
| --- | --- |
| B / E / R / F | Brush / eraser (to uncarved skin) / restore (remove edits) / fill |
| [ / ] | Smaller / larger brush |
| ⌘Z / ⇧⌘Z | Undo / redo |
| + / − / 0 | Zoom in / out / fit (also ⌘-scroll or pinch) |
| Space + drag, middle-drag | Pan |
