// Paint editor for hand edits on the stencil raster.
//
// Edits live in two arrays the size of the page: `value` (the output shade
// painted there) and `mask` (1 where the pixel has been edited). Unedited
// pixels show the automatic stencil underneath. They're drawn on a canvas
// laid over the stencil image and saved as an RGBA PNG: gray = shade,
// alpha = edited (see stencil.py on the server).
//
// Painting is done pixel by pixel rather than with canvas strokes, so edges
// are hard and every painted pixel is exactly one of the stencil's shades.

const MAX_UNDO_BYTES = 200 * 1024 * 1024;

export class StencilEditor {
  constructor({ canvas, cursor, onEdit }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cursor = cursor;
    this.onEdit = onEdit;

    // brush: paint `color`; eraser: paint uncarved skin (white);
    // restore: remove hand edits, back to the automatic stencil; fill: flood.
    this.tool = "brush"; // "brush" | "eraser" | "restore" | "fill"
    this.color = 0; // shade value to paint
    this.size = 20; // brush diameter, image pixels
    this.enabled = false;

    this.width = 0;
    this.height = 0;
    this.shades = [0, 255];
    this.snap = snapTable(this.shades);
    this.undoStack = [];
    this.redoStack = [];
    this.stroke = null;

    this.baseUrl = null;
    this.base = null; // { url, data } — the automatic stencil, for filling
    this.problemsUrl = null;
    this.problems = null; // { url, data } — the check's highlight overlay

    canvas.addEventListener("pointerdown", (e) => this.#pointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.#pointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.#pointerUp(e));
    canvas.addEventListener("pointercancel", (e) => this.#pointerUp(e));
    canvas.addEventListener("pointerleave", () => (this.cursor.hidden = true));
  }

  // ---- Setup ---------------------------------------------------------------

  /** Start editing a page, discarding any current edits and history. */
  reset(width, height) {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.value = new Uint8Array(width * height);
    this.mask = new Uint8Array(width * height);
    this.display = this.ctx.createImageData(width, height);
    this.undoStack = [];
    this.redoStack = [];
    this.stroke = null;
    this.base = this.problems = null;
    this.ctx.clearRect(0, 0, width, height);
  }

  /** Load saved edits (an ImageBitmap of the edits PNG) into the current page. */
  loadEdits(bitmap) {
    const pixels = readPixels(bitmap);
    for (let i = 0, p = 0; i < this.value.length; i++, p += 4) {
      this.mask[i] = pixels[p + 3] >= 128 ? 1 : 0;
      this.value[i] = this.mask[i] ? pixels[p] : 0;
    }
    this.#redraw(0, 0, this.width, this.height);
  }

  /** The output shades currently in use; edits display snapped to them. */
  setShades(shades) {
    this.shades = [...shades];
    this.snap = snapTable(this.shades);
    this.color = this.snap[this.color];
    if (this.width) this.#redraw(0, 0, this.width, this.height);
  }

  /** URL of the automatic stencil without edits; the fill tool reads it. */
  setBaseUrl(url) {
    this.baseUrl = url;
  }

  /** Data URL of the check's highlight overlay (or null). */
  setProblemsUrl(url) {
    this.problemsUrl = url;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.canvas.classList.toggle("editing", enabled);
    this.canvas.dataset.tool = this.tool;
    if (!enabled) this.cursor.hidden = true;
  }

  setTool(tool) {
    this.tool = tool;
    this.canvas.dataset.tool = tool;
  }

  // ---- State ---------------------------------------------------------------

  hasEdits() {
    return this.mask?.some((m) => m === 1) ?? false;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.#restore(entry, "before");
    this.redoStack.push(entry);
    this.onEdit();
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.#restore(entry, "after");
    this.undoStack.push(entry);
    this.onEdit();
  }

  /** Remove every edit (undoable). */
  clear() {
    if (!this.hasEdits()) return;
    const before = this.#snapshot();
    this.mask.fill(0);
    this.value.fill(0);
    this.#commit(before, { x0: 0, y0: 0, x1: this.width, y1: this.height });
  }

  /**
   * The edits as a PNG blob, or null if there are none. The pixels are
   * captured synchronously, so editing may continue while it encodes.
   */
  toBlob() {
    if (!this.hasEdits()) return Promise.resolve(null);
    const out = new ImageData(this.width, this.height);
    for (let i = 0, p = 0; i < this.value.length; i++, p += 4) {
      if (!this.mask[i]) continue;
      out.data[p] = out.data[p + 1] = out.data[p + 2] = this.value[i];
      out.data[p + 3] = 255;
    }
    const canvas = document.createElement("canvas");
    canvas.width = this.width;
    canvas.height = this.height;
    canvas.getContext("2d").putImageData(out, 0, 0);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }

  // ---- Pointer handling ----------------------------------------------------

  #imagePoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * this.width) / rect.width,
      y: ((e.clientY - rect.top) * this.height) / rect.height,
    };
  }

  #pointerDown(e) {
    if (!this.enabled || e.button !== 0) return;
    e.preventDefault();
    const p = this.#imagePoint(e);
    if (this.tool === "fill") {
      this.#fill(Math.floor(p.x), Math.floor(p.y));
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    this.stroke = {
      before: this.#snapshot(),
      dirty: { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
      last: p,
    };
    this.#stamp(p.x, p.y);
  }

  #pointerMove(e) {
    if (!this.enabled) return;
    this.#moveCursor(e);
    if (!this.stroke) return;
    // Coalesced events give smoother lines on fast drags where supported.
    for (const event of e.getCoalescedEvents?.() ?? [e]) {
      const p = this.#imagePoint(event);
      const { last } = this.stroke;
      const distance = Math.hypot(p.x - last.x, p.y - last.y);
      const steps = Math.max(1, Math.ceil(distance / Math.max(1, this.size / 4)));
      for (let i = 1; i <= steps; i++) {
        this.#stamp(last.x + ((p.x - last.x) * i) / steps, last.y + ((p.y - last.y) * i) / steps);
      }
      this.stroke.last = p;
    }
  }

  #pointerUp() {
    if (!this.stroke) return;
    const { before, dirty } = this.stroke;
    this.stroke = null;
    if (dirty.x1 > dirty.x0) this.#commit(before, dirty);
  }

  #moveCursor(e) {
    const brush = this.tool !== "fill";
    this.cursor.hidden = !brush;
    if (!brush) return;
    const rect = this.canvas.getBoundingClientRect();
    const parent = this.cursor.offsetParent?.getBoundingClientRect() ?? rect;
    const diameter = (this.size * rect.width) / this.width;
    Object.assign(this.cursor.style, {
      width: `${diameter}px`,
      height: `${diameter}px`,
      left: `${e.clientX - parent.left - diameter / 2}px`,
      top: `${e.clientY - parent.top - diameter / 2}px`,
    });
  }

  // ---- Painting ------------------------------------------------------------

  /** Apply the current tool in a filled circle centred on an image point. */
  #stamp(cx, cy) {
    const r = this.size / 2;
    const tool = this.tool;
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + r));
    let minX = Infinity;
    let maxX = -Infinity;
    for (let y = y0; y <= y1; y++) {
      // Pixels whose centres fall inside the circle.
      const dy = y + 0.5 - cy;
      if (dy * dy > r * r) continue;
      const half = Math.sqrt(r * r - dy * dy);
      const xs = Math.max(0, Math.ceil(cx - half - 0.5));
      const xe = Math.min(this.width - 1, Math.floor(cx + half - 0.5));
      for (let x = xs; x <= xe; x++) this.#set(y * this.width + x, tool);
      minX = Math.min(minX, xs);
      maxX = Math.max(maxX, xe);
    }
    // A brush smaller than a pixel still paints the pixel under it.
    const px = Math.floor(cx);
    const py = Math.floor(cy);
    if (px >= 0 && py >= 0 && px < this.width && py < this.height) {
      this.#set(py * this.width + px, tool);
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
    }
    if (maxX < minX) return;
    const rect = { x0: minX, y0: Math.min(y0, py), x1: maxX + 1, y1: Math.max(y1, py) + 1 };
    this.#redraw(rect.x0, rect.y0, rect.x1, rect.y1);
    grow(this.stroke.dirty, rect);
  }

  #set(i, tool) {
    if (tool === "restore") {
      this.mask[i] = 0;
      this.value[i] = 0;
    } else {
      this.mask[i] = 1;
      // Erasing leaves the pumpkin uncarved, whatever was there before.
      this.value[i] = tool === "eraser" ? 255 : this.color;
    }
  }

  /**
   * Fill the region under (x, y). On a piece the check highlighted, that's
   * exactly the piece, so one click fixes a floating or fragile piece.
   * Elsewhere it's the connected area of the same shade, like a paint bucket.
   */
  async #fill(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const [base, problems] = await Promise.all([
      this.#decoded("base", this.baseUrl),
      this.#decoded("problems", this.problemsUrl),
    ]);
    if (!base) return;

    const start = y * this.width + x;
    let same;
    if (problems && problems[start * 4 + 3] > 0 && !isBridge(problems, start * 4)) {
      const key = colorKey(problems, start * 4);
      same = (i) => problems[i * 4 + 3] > 0 && colorKey(problems, i * 4) === key;
    } else {
      const shade = (i) => (this.mask[i] ? this.snap[this.value[i]] : base[i * 4]);
      const target = shade(start);
      same = (i) => shade(i) === target;
    }

    const before = this.#snapshot();
    const dirty = floodFill(this.width, this.height, start, same, (i) => this.#set(i, "fill"));
    this.#redraw(dirty.x0, dirty.y0, dirty.x1, dirty.y1);
    this.#commit(before, dirty);
  }

  /** Pixel data for the base image or problem overlay, decoded once per URL. */
  async #decoded(which, url) {
    if (!url) return null;
    if (this[which]?.url !== url) {
      try {
        const res = await fetch(url);
        const bitmap = await createImageBitmap(await res.blob(), {
          premultiplyAlpha: "none",
          colorSpaceConversion: "none",
        });
        this[which] = { url, data: readPixels(bitmap) };
      } catch {
        return null;
      }
    }
    // Ignore stale data if the page changed size while it loaded.
    return this[which].data.length === this.width * this.height * 4 ? this[which].data : null;
  }

  // ---- History -------------------------------------------------------------

  #snapshot() {
    return { value: this.value.slice(), mask: this.mask.slice() };
  }

  /** Record the change within `rect` since `before` as one undo step. */
  #commit(before, rect) {
    const entry = { rect, before: crop(before, rect, this.width), after: crop(this, rect, this.width) };
    this.undoStack.push(entry);
    this.redoStack = [];
    let bytes = this.undoStack.reduce((sum, e) => sum + e.before.value.length * 4, 0);
    while (bytes > MAX_UNDO_BYTES && this.undoStack.length > 1) {
      bytes -= this.undoStack.shift().before.value.length * 4;
    }
    this.onEdit();
  }

  #restore(entry, which) {
    const { rect } = entry;
    paste(this, entry[which], rect, this.width);
    this.#redraw(rect.x0, rect.y0, rect.x1, rect.y1);
  }

  // ---- Display -------------------------------------------------------------

  #redraw(x0, y0, x1, y1) {
    const d = this.display.data;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * this.width + x;
        const p = i * 4;
        if (this.mask[i]) {
          d[p] = d[p + 1] = d[p + 2] = this.snap[this.value[i]];
          d[p + 3] = 255;
        } else {
          d[p + 3] = 0;
        }
      }
    }
    this.ctx.putImageData(this.display, 0, 0, x0, y0, x1 - x0, y1 - y0);
  }
}

// ---- Helpers ---------------------------------------------------------------

/** Lookup table from any gray value to the nearest of the given shades. */
function snapTable(shades) {
  const table = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    table[v] = shades.reduce((best, s) => (Math.abs(s - v) < Math.abs(best - v) ? s : best));
  }
  return table;
}

function readPixels(bitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

function colorKey(data, p) {
  return (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
}

// Thin bridges are highlighted in yellow; filling one would just paint the
// bridge, so clicks on them fall through to an ordinary fill.
function isBridge(data, p) {
  return data[p] > 200 && data[p + 1] > 200 && data[p + 2] < 50;
}

/** 4-connected flood fill from `start`; returns the bounding rect touched. */
function floodFill(width, height, start, same, set) {
  const seen = new Uint8Array(width * height);
  const stack = [start];
  seen[start] = 1;
  const rect = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  while (stack.length) {
    const i = stack.pop();
    const x = i % width;
    const y = (i - x) / width;
    set(i);
    grow(rect, { x0: x, y0: y, x1: x + 1, y1: y + 1 });
    for (const [n, ok] of [
      [i - 1, x > 0],
      [i + 1, x < width - 1],
      [i - width, y > 0],
      [i + width, y < height - 1],
    ]) {
      if (ok && !seen[n] && same(n)) {
        seen[n] = 1;
        stack.push(n);
      }
    }
  }
  return rect;
}

function grow(rect, other) {
  rect.x0 = Math.min(rect.x0, other.x0);
  rect.y0 = Math.min(rect.y0, other.y0);
  rect.x1 = Math.max(rect.x1, other.x1);
  rect.y1 = Math.max(rect.y1, other.y1);
}

function crop(source, rect, width) {
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  const out = { value: new Uint8Array(w * h), mask: new Uint8Array(w * h) };
  for (let y = 0; y < h; y++) {
    const from = (rect.y0 + y) * width + rect.x0;
    out.value.set(source.value.subarray(from, from + w), y * w);
    out.mask.set(source.mask.subarray(from, from + w), y * w);
  }
  return out;
}

function paste(target, piece, rect, width) {
  const w = rect.x1 - rect.x0;
  for (let y = 0; y < rect.y1 - rect.y0; y++) {
    const to = (rect.y0 + y) * width + rect.x0;
    target.value.set(piece.value.subarray(y * w, y * w + w), to);
    target.mask.set(piece.mask.subarray(y * w, y * w + w), to);
  }
}
