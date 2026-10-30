import { StencilEditor } from "./editor.js";

const $ = (id) => document.getElementById(id);

const dropzone = $("dropzone");
const fileInput = $("file-input");
const statusList = $("upload-status");
const uploadList = $("upload-list");
const emptyList = $("empty-list");
const viewer = $("viewer");
const placeholder = $("placeholder");
const pageStrip = $("page-strip");
const previewImg = $("preview-img");
const tabOriginal = $("tab-original");
const tabSegmented = $("tab-segmented");
const tabSvg = $("tab-svg");
const tabGlow = $("tab-glow");
const preview = document.querySelector(".preview");
const previewStack = $("preview-stack");
const shadeButtons = $("shade-buttons");
const histogramCanvas = $("histogram");
const thresholdSliders = $("threshold-sliders");
const downloadBtn = $("download-btn");
const invertToggle = $("invert-toggle");
const downloadSvgBtn = $("download-svg-btn");

// Mirrors MIN_SHADES / MAX_SHADES in segment.py.
const MIN_SHADES = 2;
const MAX_SHADES = 5;
// Mirror DEFAULT_SPECKLE in stencil.py and DEFAULT_SMOOTHNESS in vectorize.py.
const DEFAULT_SPECKLE = 8;
const DEFAULT_SMOOTHNESS = 25;

// The currently selected source: { upload, page }. Later stencil steps read this.
const state = {
  uploads: [],
  upload: null,
  page: 1,
  view: "segmented", // "original" | "segmented" (the editable stencil) | "svg" | "glow"
  // Stencil settings per page, keyed by `${uploadId}:${page}`; saved on the server.
  settings: new Map(),
  histograms: new Map(),
  highlightIslands: true,
  zoom: null, // null = fit to view, else image pixels → CSS pixels
};

// ---- Uploading ----------------------------------------------------------

fileInput.addEventListener("change", () => {
  uploadFiles(fileInput.files);
  fileInput.value = "";
});

for (const type of ["dragenter", "dragover"]) {
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragging");
  });
}
for (const type of ["dragleave", "drop"]) {
  dropzone.addEventListener(type, () => dropzone.classList.remove("dragging"));
}
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadFiles(e.dataTransfer.files);
});

// Let people paste an image straight from the clipboard.
document.addEventListener("paste", (e) => {
  const files = [...e.clipboardData.files];
  if (files.length) uploadFiles(files);
});

async function uploadFiles(files) {
  let last = null;
  for (const file of files) {
    const row = document.createElement("li");
    row.textContent = `Uploading ${file.name}…`;
    statusList.prepend(row);

    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/uploads", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `Upload failed (${res.status}).`);
      last = data;
      row.remove();
    } catch (err) {
      row.classList.add("error");
      row.textContent = `${file.name}: ${err.message}`;
      setTimeout(() => row.remove(), 8000);
    }
  }
  await refreshList();
  if (last) select(last.id);
}

// ---- Upload list --------------------------------------------------------

async function refreshList() {
  const res = await fetch("/api/uploads");
  state.uploads = res.ok ? await res.json() : [];
  renderList();
}

function renderList() {
  uploadList.replaceChildren(
    ...state.uploads.map((u) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("aria-current", String(u.id === state.upload?.id));
      btn.addEventListener("click", () => select(u.id));

      const img = document.createElement("img");
      img.src = u.pages[0];
      img.alt = "";
      img.loading = "lazy";

      const info = document.createElement("span");
      info.className = "info";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = u.filename;
      const sub = document.createElement("span");
      sub.className = "sub";
      sub.textContent = describe(u);
      info.append(name, sub);

      btn.append(img, info);
      li.append(btn);
      return li;
    }),
  );
  emptyList.hidden = state.uploads.length > 0;
}

function describe(u) {
  if (u.kind === "pdf") return `PDF · ${u.page_count} page${u.page_count === 1 ? "" : "s"}`;
  return `Image · ${u.width}×${u.height}`;
}

// ---- Viewer -------------------------------------------------------------

function select(id, page = 1) {
  saveEdits(); // starts saving the current page's edits before they're replaced
  const upload = state.uploads.find((u) => u.id === id);
  state.upload = upload ?? null;
  state.page = page;
  renderList();
  renderViewer();
}

function selectPage(page) {
  saveEdits();
  state.page = page;
  renderViewer();
}

function renderViewer() {
  const u = state.upload;
  viewer.hidden = !u;
  placeholder.hidden = !!u;
  if (!u) return;

  $("viewer-title").textContent = u.filename;
  $("viewer-meta").textContent =
    u.kind === "pdf" ? `${describe(u)} · showing page ${state.page}` : describe(u);

  pageStrip.hidden = u.page_count < 2;
  pageStrip.replaceChildren(
    ...u.pages.map((src, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("aria-current", String(i + 1 === state.page));
      btn.setAttribute("aria-label", `Page ${i + 1}`);
      btn.addEventListener("click", () => selectPage(i + 1));
      const img = document.createElement("img");
      img.src = src;
      img.alt = "";
      img.loading = "lazy";
      const label = document.createElement("span");
      label.textContent = i + 1;
      btn.append(img, label);
      return btn;
    }),
  );

  if (editorPage !== settingsKey()) {
    state.zoom = null;
    openPageInEditor();
  }
  renderEditor();
  renderPreview();
  loadHistogram();
}

function setView(view) {
  state.view = view;
  renderPreview();
}

// After a segmentation change, make sure the preview shows its effect. The SVG
// and glow views reflect segmentation too, so they stay put.
function showProcessed() {
  if (state.view === "original") state.view = "segmented";
}

tabOriginal.addEventListener("click", () => setView("original"));
tabSegmented.addEventListener("click", () => setView("segmented"));
tabSvg.addEventListener("click", () => setView("svg"));
tabGlow.addEventListener("click", () => setView("glow"));

function pageUrl() {
  return state.upload.pages[state.page - 1];
}

// Everything that shapes the automatic stencil (but not the hand edits).
function stencilQuery() {
  const s = currentSettings();
  const invert = s.invert ? "&invert=true" : "";
  return `thresholds=${s.thresholds.join(",")}${invert}&speckle=${s.speckle}`;
}

// Outputs that include hand edits are cached by URL, so their URLs carry the
// page's edits version and change whenever the edits do.
function editsQuery() {
  const version = state.upload.edit_versions?.[state.page - 1];
  return version ? `&v=${version}` : "";
}

// The automatic stencil without edits: the editor paints over it.
function stencilBaseUrl() {
  return `${pageUrl()}/segmented?${stencilQuery()}&edits=false`;
}

function segmentedUrl() {
  return `${pageUrl()}/segmented?${stencilQuery()}${editsQuery()}`;
}

function svgUrl() {
  const s = currentSettings();
  return `${pageUrl()}/svg?${stencilQuery()}&smoothness=${s.smoothness}${editsQuery()}`;
}

// The carved pumpkin lit from inside (glow.py).
function glowUrl() {
  return `${pageUrl()}/glow?${stencilQuery()}${editsQuery()}`;
}

function renderPreview() {
  tabOriginal.setAttribute("aria-selected", String(state.view === "original"));
  tabSegmented.setAttribute("aria-selected", String(state.view === "segmented"));
  tabSvg.setAttribute("aria-selected", String(state.view === "svg"));
  tabGlow.setAttribute("aria-selected", String(state.view === "glow"));
  // Problem highlights would spoil the look of the lit pumpkin.
  previewStack.classList.toggle("glow-view", state.view === "glow");
  const src = { original: pageUrl, segmented: stencilBaseUrl, svg: svgUrl, glow: glowUrl }[
    state.view
  ]();
  // Compare against the attribute: `.src` is normalised to an absolute URL.
  if (previewImg.getAttribute("src") !== src) {
    preview.classList.add("loading");
    previewImg.src = src;
  }
  editor.setBaseUrl(stencilBaseUrl());
  renderEditMode();
  runCheck();
}

const previewError = $("preview-error");

previewImg.addEventListener("load", () => {
  preview.classList.remove("loading");
  previewStack.hidden = false;
  previewError.hidden = true;
  applyZoom();
});

// An <img> can't read the error body, so fetch it to show the server's reason.
previewImg.addEventListener("error", async () => {
  const src = previewImg.getAttribute("src");
  const res = await fetch(src).catch(() => null);
  const data = await res?.json().catch(() => ({}));
  if (previewImg.getAttribute("src") !== src) return; // superseded meanwhile
  preview.classList.remove("loading");
  previewStack.hidden = true;
  previewError.hidden = false;
  previewError.textContent = data?.detail || "The preview couldn't be generated.";
});

// ---- Stencil check ------------------------------------------------------

const checkBadge = $("check-badge");
const checkStatus = $("check-status");
const islandOverlay = $("island-overlay");
const islandBoxes = $("island-boxes");
const pieceLists = $("piece-lists");
const highlightField = $("highlight-field");
const highlightToggle = $("highlight-toggle");
const checkLegend = $("check-legend");
const stencilWidthInput = $("stencil-width");
const minBridgeInput = $("min-bridge");
const unitSelect = $("unit-select");
const MAX_LISTED_PIECES = 8;

const MM_PER_UNIT = { in: 25.4, cm: 10 };
// Defaults for images, which have no physical size; PDFs use their page width.
const DEFAULT_WIDTH_MM = 8 * 25.4;
const DEFAULT_MIN_BRIDGE_MM = 6.35; // ¼ in

let checkUrl = null;
let checkResult = null;

// The unit is a per-viewer preference, so remember it across visits.
try {
  state.unit = localStorage.getItem("unit") === "cm" ? "cm" : "in";
} catch {
  state.unit = "in";
}

function toUnit(mm) {
  return String(Math.round((mm / MM_PER_UNIT[state.unit]) * 100) / 100);
}

function renderSizeFields() {
  const s = currentSettings();
  unitSelect.value = state.unit;
  stencilWidthInput.value = toUnit(s.widthMm);
  minBridgeInput.value = toUnit(s.minBridgeMm);
  $("min-bridge-unit").textContent = state.unit;
}

unitSelect.addEventListener("change", () => {
  state.unit = unitSelect.value;
  try {
    localStorage.setItem("unit", state.unit);
  } catch {}
  renderSizeFields();
  renderCheck();
});

for (const [input, key, min] of [
  [stencilWidthInput, "widthMm", 0.1],
  [minBridgeInput, "minBridgeMm", 0],
]) {
  input.addEventListener("input", () => {
    const value = Number(input.value);
    if (input.value === "" || !(value >= min)) return; // leave the last valid value
    currentSettings()[key] = value * MM_PER_UNIT[state.unit];
    settingsChanged();
    scheduleCheck();
  });
  // Tidy up rejected or unrounded entries once the field is left.
  input.addEventListener("change", renderSizeFields);
}

highlightToggle.addEventListener("change", () => {
  state.highlightIslands = highlightToggle.checked;
  renderCheck();
});

let checkTimer = null;
function scheduleCheck() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runCheck, 300);
}

// Runs whenever the preview updates; skipped if nothing that affects it changed.
async function runCheck() {
  const s = currentSettings();
  const url =
    `${pageUrl()}/check?${stencilQuery()}${editsQuery()}` +
    `&width_mm=${s.widthMm.toFixed(2)}&min_bridge_mm=${s.minBridgeMm.toFixed(2)}`;
  if (url === checkUrl) return;
  checkUrl = url;
  checkStatus.replaceChildren(statusLine("", "Checking…"));

  const res = await fetch(url).catch(() => null);
  const data = res?.ok ? await res.json() : null;
  if (url !== checkUrl) return; // settings changed while this was running
  checkResult = data && { ...data, widthMm: s.widthMm, minBridgeMm: s.minBridgeMm };
  renderCheck();
}

function statusLine(kind, text) {
  const p = document.createElement("p");
  p.className = kind;
  p.textContent = text;
  return p;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function renderCheck() {
  const r = checkResult;
  const islands = r?.islands ?? [];
  const fragile = r?.fragile ?? [];

  checkBadge.hidden = !r;
  if (!r) {
    checkStatus.replaceChildren(statusLine("bad", "The stencil couldn't be checked."));
  } else if (r.valid) {
    checkBadge.className = "badge ok";
    checkBadge.textContent = "✓ Stencil OK";
    checkStatus.replaceChildren(
      statusLine("ok", "✓ Every piece stays attached by bridges wide enough to carve."),
    );
  } else {
    const parts = [];
    if (islands.length) parts.push(`${islands.length} unsupported`);
    if (fragile.length) parts.push(`${fragile.length} fragile`);
    checkBadge.className = `badge ${islands.length ? "bad" : "warn"}`;
    checkBadge.textContent = `⚠ ${parts.join(" · ")}`;
    const lines = [];
    if (islands.length) {
      lines.push(statusLine("bad", `⚠ ${plural(islands.length, "piece")} would fall out.`));
    }
    if (fragile.length) {
      const min = `${toUnit(r.minBridgeMm)} ${state.unit}`;
      lines.push(
        statusLine(
          "warn",
          `⚠ ${plural(fragile.length, "piece")} ${fragile.length === 1 ? "hangs" : "hang"} ` +
            `by bridges under ${min}.`,
        ),
      );
    }
    checkStatus.replaceChildren(...lines);
  }

  const show = !!r && !r.valid && state.highlightIslands;
  highlightField.hidden = checkLegend.hidden = !r || r.valid;
  highlightToggle.checked = state.highlightIslands;
  islandOverlay.hidden = !show;
  if (show) islandOverlay.src = r.overlay;
  editor.setProblemsUrl(r?.overlay ?? null);

  const pieces = [
    ...islands.map((piece, i) => ({ piece, kind: "island", id: `island-${i}` })),
    ...fragile.map((piece, i) => ({ piece, kind: "fragile", id: `fragile-${i}` })),
  ];
  islandBoxes.replaceChildren(
    ...(show ? pieces : []).map(({ piece, kind, id }) => {
      const box = document.createElement("div");
      box.className = `island-box ${kind}`;
      box.dataset.id = id;
      Object.assign(box.style, {
        left: `${(piece.x / r.width) * 100}%`,
        top: `${(piece.y / r.height) * 100}%`,
        width: `${(piece.width / r.width) * 100}%`,
        height: `${(piece.height / r.height) * 100}%`,
      });
      return box;
    }),
  );

  pieceLists.replaceChildren(
    ...(r ? [pieceList("Falls out", islands, "island", r), pieceList("Fragile", fragile, "fragile", r)] : [])
      .flat(),
  );
}

// A titled list of pieces with their printed size; empty if there are none.
function pieceList(title, pieces, kind, r) {
  if (!pieces.length) return [];
  const heading = document.createElement("p");
  heading.className = "piece-list-title";
  heading.textContent = title;

  const mmPerPx = r.widthMm / r.width;
  const list = document.createElement("ol");
  list.className = "island-list";
  const listed = pieces.slice(0, MAX_LISTED_PIECES);
  list.append(
    ...listed.map((piece, i) => {
      const li = document.createElement("li");
      li.textContent =
        `${toUnit(piece.width * mmPerPx)} × ${toUnit(piece.height * mmPerPx)} ${state.unit}`;
      // Hovering a list entry picks out its box on the preview.
      const id = `${kind}-${i}`;
      li.addEventListener("mouseenter", () => setActiveBox(id, true));
      li.addEventListener("mouseleave", () => setActiveBox(id, false));
      return li;
    }),
  );
  if (pieces.length > listed.length) {
    const more = document.createElement("li");
    more.textContent = `…and ${pieces.length - listed.length} smaller`;
    list.append(more);
  }
  return [heading, list];
}

function setActiveBox(id, active) {
  islandBoxes.querySelector(`[data-id="${id}"]`)?.classList.toggle("active", active);
}

// Slider drags fire many input events; only fetch the image once they settle.
let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 120);
}

// ---- Segmentation editor ------------------------------------------------

function defaultThresholds(shades) {
  return Array.from({ length: shades - 1 }, (_, i) => Math.round((256 * (i + 1)) / shades));
}

function shadeValues(shades, invert = false) {
  const values = Array.from({ length: shades }, (_, i) => Math.round((255 * i) / (shades - 1)));
  return invert ? values.reverse() : values;
}

function gray(v) {
  return `rgb(${v}, ${v}, ${v})`;
}

function settingsKey() {
  return state.upload ? `${state.upload.id}:${state.page}` : null;
}

function currentSettings() {
  const key = settingsKey();
  if (!state.settings.has(key)) {
    state.settings.set(key, {
      shades: MIN_SHADES,
      thresholds: defaultThresholds(MIN_SHADES),
      invert: false,
      speckle: DEFAULT_SPECKLE,
      smoothness: DEFAULT_SMOOTHNESS,
      widthMm: state.upload.page_widths_mm?.[state.page - 1] ?? DEFAULT_WIDTH_MM,
      minBridgeMm: DEFAULT_MIN_BRIDGE_MM,
      // Saved settings win; the server validated them when they were saved.
      ...state.upload.settings?.[state.page - 1],
    });
  }
  return state.settings.get(key);
}

// Settings are saved shortly after they stop changing, per page.
const unsavedSettings = new Set();
let settingsTimer = null;

function settingsChanged() {
  unsavedSettings.add(settingsKey());
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(saveSettings, 600);
}

function saveSettings() {
  clearTimeout(settingsTimer);
  for (const key of unsavedSettings) {
    const [id, page] = key.split(":");
    fetch(`/api/uploads/${id}/pages/${page}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.settings.get(key)),
      keepalive: true, // lets a save started while leaving the page finish
    }).catch(() => {});
  }
  unsavedSettings.clear();
}

function setShades(shades) {
  const s = currentSettings();
  s.shades = shades;
  s.thresholds = defaultThresholds(shades);
  settingsChanged();
  showProcessed();
  renderEditor();
  renderPreview();
}

$("reset-btn").addEventListener("click", () => setShades(currentSettings().shades));

invertToggle.addEventListener("change", () => {
  currentSettings().invert = invertToggle.checked;
  settingsChanged();
  showProcessed();
  renderEditor();
  renderPreview();
});

// Speck removal shapes the stencil itself; smoothness only affects the SVG.
for (const [name, input, output, showView] of [
  ["speckle", $("speckle-input"), $("speckle-output"), showProcessed],
  ["smoothness", $("smoothness-input"), $("smoothness-output"), () => (state.view = "svg")],
]) {
  input.addEventListener("input", () => {
    currentSettings()[name] = Number(input.value);
    output.textContent = input.value;
    settingsChanged();
    showView();
    updateDownload();
    schedulePreview();
  });
}

function describeShades(shades) {
  const grays = shades - 2;
  if (grays === 0) return "Black and white.";
  return `Black, white and ${grays} shade${grays === 1 ? "" : "s"} of gray.`;
}

function renderEditor() {
  const s = currentSettings();

  shadeButtons.replaceChildren(
    ...Array.from({ length: MAX_SHADES - MIN_SHADES + 1 }, (_, i) => {
      const n = MIN_SHADES + i;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.role = "radio";
      btn.textContent = n;
      btn.setAttribute("aria-checked", String(n === s.shades));
      btn.addEventListener("click", () => setShades(n));
      return btn;
    }),
  );
  $("shades-desc").textContent = describeShades(s.shades);
  invertToggle.checked = s.invert;
  $("speckle-input").value = $("speckle-output").textContent = s.speckle;
  $("smoothness-input").value = $("smoothness-output").textContent = s.smoothness;
  renderSizeFields();

  const shades = shadeValues(s.shades, s.invert);
  thresholdSliders.replaceChildren(
    ...s.thresholds.map((value, i) => {
      const row = document.createElement("label");
      row.className = "threshold-row";

      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.setProperty("--below", gray(shades[i]));
      swatch.style.setProperty("--above", gray(shades[i + 1]));

      const input = document.createElement("input");
      input.type = "range";
      input.min = 1;
      input.max = 255;
      input.value = value;
      input.setAttribute("aria-label", `Threshold ${i + 1}`);

      const output = document.createElement("output");
      output.textContent = value;

      input.addEventListener("input", () => {
        // Keep thresholds strictly increasing so every shade keeps a band.
        const lo = (s.thresholds[i - 1] ?? 0) + 1;
        const hi = (s.thresholds[i + 1] ?? 256) - 1;
        const v = Math.min(hi, Math.max(lo, Number(input.value)));
        input.value = v;
        output.textContent = v;
        s.thresholds[i] = v;
        settingsChanged();
        showProcessed();
        drawHistogram();
        updateDownload();
        schedulePreview();
      });

      row.append(swatch, input, output);
      return row;
    }),
  );

  drawHistogram();
  updateDownload();
  renderPaintSwatches();
}

function updateDownload() {
  const base = state.upload.filename.replace(/\.[^.]+$/, "");
  const suffix = state.upload.page_count > 1 ? `-p${state.page}` : "";
  downloadBtn.href = segmentedUrl();
  downloadBtn.download = `${base}${suffix}-stencil.png`;
  downloadSvgBtn.href = svgUrl();
  downloadSvgBtn.download = `${base}${suffix}-stencil.svg`;
}

// ---- Histogram ----------------------------------------------------------

async function loadHistogram() {
  const url = pageUrl();
  if (!state.histograms.has(url)) {
    const res = await fetch(`${url}/histogram`);
    if (!res.ok) return;
    state.histograms.set(url, await res.json());
  }
  // The user may have switched pages while this was loading.
  if (state.upload && url === pageUrl()) drawHistogram();
}

function drawHistogram() {
  const ctx = histogramCanvas.getContext("2d");
  const { width, height } = histogramCanvas;
  const s = currentSettings();
  const shades = shadeValues(s.shades, s.invert);
  const x = (value) => (value / 256) * width;

  // Background bands, each filled with the shade that range maps to.
  const edges = [0, ...s.thresholds, 256];
  for (let i = 0; i < shades.length; i++) {
    ctx.fillStyle = gray(shades[i]);
    ctx.fillRect(x(edges[i]), 0, x(edges[i + 1]) - x(edges[i]), height);
  }

  // Square-root scale so a large flat background doesn't flatten everything else.
  const counts = state.histograms.get(pageUrl());
  if (counts) {
    const max = Math.sqrt(Math.max(...counts)) || 1;
    ctx.fillStyle = "rgba(242, 140, 40, 0.85)";
    const barWidth = width / 256;
    counts.forEach((count, value) => {
      const h = (Math.sqrt(count) / max) * (height - 4);
      ctx.fillRect(x(value), height - h, barWidth, h);
    });
  }

  ctx.fillStyle = "#ff9f43";
  for (const t of s.thresholds) ctx.fillRect(x(t) - 1, 0, 2, height);
}

// ---- Hand editing -------------------------------------------------------

const editCanvas = $("edit-canvas");
const editToolbar = $("edit-toolbar");
const paintSwatches = $("paint-swatches");
const brushSize = $("brush-size");
const brushCursor = $("brush-cursor");
const undoBtn = $("undo-btn");
const redoBtn = $("redo-btn");
const clearEditsBtn = $("clear-edits-btn");
const editStatus = $("edit-status");

const editor = new StencilEditor({ canvas: editCanvas, cursor: brushCursor, onEdit: editsChanged });

let editorPage = null; // settingsKey() of the page loaded into the editor
let editsReady = false; // false until the page's saved edits have loaded
let editsUnsaved = false;
let pendingSaves = 0;
let saveTimer = null;
let saveQueue = Promise.resolve();

async function openPageInEditor() {
  const key = settingsKey();
  editorPage = key;
  editsReady = false;
  editsUnsaved = false;
  const [width, height] = state.upload.page_sizes[state.page - 1];
  editor.reset(width, height);
  setEditStatus("");

  const version = state.upload.edit_versions?.[state.page - 1];
  if (version) {
    try {
      const res = await fetch(`${pageUrl()}/edits?v=${version}`);
      if (!res.ok) throw new Error();
      const bitmap = await createImageBitmap(await res.blob(), {
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      });
      if (editorPage !== key) return; // switched pages meanwhile
      editor.loadEdits(bitmap);
    } catch {
      // Stay read-only: saving now would overwrite the edits we couldn't load.
      if (editorPage === key) setEditStatus("Couldn't load this page's edits. Reload to try again.");
      return;
    }
  }
  if (editorPage !== key) return;
  editsReady = true;
  renderEditMode();
}

// Paintable shades, darkest first whatever the flip setting: black is cut.
function paintShades() {
  return shadeValues(currentSettings().shades);
}

function shadeName(value) {
  if (value === 0) return "Cut (black)";
  if (value === 255) return "Skin (white)";
  return `Shave (gray ${value})`;
}

function renderPaintSwatches() {
  const shades = paintShades();
  editor.setShades(shades);
  paintSwatches.replaceChildren(
    ...shades.map((value) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.role = "radio";
      btn.style.background = gray(value);
      btn.title = shadeName(value);
      btn.setAttribute("aria-label", shadeName(value));
      btn.setAttribute("aria-checked", String(editor.color === value));
      btn.addEventListener("click", () => {
        editor.color = value;
        if (editor.tool !== "fill") editor.setTool("brush");
        renderPaintSwatches();
        renderEditMode();
      });
      return btn;
    }),
  );
}

function renderEditMode() {
  const editing = state.view === "segmented";
  editToolbar.hidden = !editing;
  editCanvas.hidden = !editing;
  editor.setEnabled(editing && editsReady && !spaceHeld);
  for (const btn of editToolbar.querySelectorAll("[data-tool]")) {
    btn.setAttribute("aria-checked", String(btn.dataset.tool === editor.tool));
  }
  $("brush-size-field").hidden = editor.tool === "fill";
  brushSize.value = editor.size;
  $("brush-size-output").textContent = `${editor.size} px`;
  undoBtn.disabled = !editor.canUndo;
  redoBtn.disabled = !editor.canRedo;
  clearEditsBtn.disabled = !editsReady || !editor.hasEdits();
}

function setTool(tool) {
  editor.setTool(tool);
  renderEditMode();
}

function setBrushSize(size) {
  editor.size = Math.min(200, Math.max(1, Math.round(size)));
  renderEditMode();
}

for (const btn of editToolbar.querySelectorAll("[data-tool]")) {
  btn.addEventListener("click", () => setTool(btn.dataset.tool));
}
brushSize.addEventListener("input", () => setBrushSize(Number(brushSize.value)));
undoBtn.addEventListener("click", () => editor.undo());
redoBtn.addEventListener("click", () => editor.redo());
clearEditsBtn.addEventListener("click", () => {
  if (confirm("Remove all hand edits on this page? You can undo this.")) editor.clear();
});

function setEditStatus(text) {
  editStatus.textContent = text;
}

function editsChanged() {
  editsUnsaved = true;
  setEditStatus("Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveEdits, 400);
  renderEditMode();
}

// Saves are queued so they reach the server in order. The editor's pixels are
// captured immediately, so it's safe to switch pages right after calling this.
function saveEdits() {
  clearTimeout(saveTimer);
  if (!editsUnsaved || editorPage !== settingsKey()) return saveQueue;
  editsUnsaved = false;
  const upload = state.upload;
  const page = state.page;
  const url = `${upload.pages[page - 1]}/edits`;
  const blob = editor.toBlob();
  const isCurrent = () => state.upload?.id === upload.id && state.page === page;

  pendingSaves++;
  saveQueue = saveQueue
    .then(async () => {
      const data = await blob;
      const res = data
        ? await fetch(url, { method: "PUT", headers: { "Content-Type": "image/png" }, body: data })
        : await fetch(url, { method: "DELETE" });
      if (!res.ok) throw new Error(`Saving edits failed (${res.status}).`);
      const version = data ? (await res.json()).version : null;
      // The list may have been refreshed since, so update both copies.
      for (const u of new Set([upload, state.uploads.find((x) => x.id === upload.id)])) {
        if (u) u.edit_versions[page - 1] = version;
      }
      if (isCurrent()) {
        if (!editsUnsaved) setEditStatus("All edits saved");
        updateDownload();
        renderPreview(); // the SVG and the check now include the edits
      }
    })
    .catch(() => {
      if (!isCurrent()) return;
      editsUnsaved = true;
      setEditStatus("Couldn't save edits. They'll be retried with your next change.");
    })
    .finally(() => pendingSaves--);
  return saveQueue;
}

window.addEventListener("beforeunload", (e) => {
  saveSettings();
  if (editsUnsaved || pendingSaves) {
    saveEdits();
    e.preventDefault(); // asks the browser to confirm leaving
  }
});

// ---- Zoom and pan -------------------------------------------------------

const zoomFitBtn = $("zoom-fit");
let spaceHeld = false;
let pan = null;

function currentZoom() {
  return state.zoom ?? previewImg.clientWidth / (previewImg.naturalWidth || 1);
}

function applyZoom() {
  const zoomed = state.zoom !== null && previewImg.naturalWidth > 0;
  preview.classList.toggle("zoomed", zoomed);
  previewImg.style.width = zoomed ? `${previewImg.naturalWidth * state.zoom}px` : "";
  zoomFitBtn.textContent = state.zoom === null ? "Fit" : `${Math.round(state.zoom * 100)}%`;
}

// Zoom keeping the image point under `anchor` (default: the view's centre) still.
function setZoom(zoom, anchor = null) {
  const view = preview.getBoundingClientRect();
  const point = anchor ?? { x: view.left + view.width / 2, y: view.top + view.height / 2 };
  const before = previewStack.getBoundingClientRect();
  state.zoom = zoom === null ? null : Math.min(8, Math.max(0.05, zoom));
  applyZoom();
  if (!before.width) return;
  const after = previewStack.getBoundingClientRect();
  preview.scrollLeft += after.left + ((point.x - before.left) / before.width) * after.width - point.x;
  preview.scrollTop += after.top + ((point.y - before.top) / before.height) * after.height - point.y;
}

$("zoom-in").addEventListener("click", () => setZoom(currentZoom() * 1.25));
$("zoom-out").addEventListener("click", () => setZoom(currentZoom() / 1.25));
zoomFitBtn.addEventListener("click", () => setZoom(null));

// Ctrl/⌘ + scroll, and trackpad pinch (which browsers report the same way).
preview.addEventListener(
  "wheel",
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setZoom(currentZoom() * Math.exp(-e.deltaY * 0.002), { x: e.clientX, y: e.clientY });
  },
  { passive: false },
);

// Drag with the middle button, or with Space held, to pan. Runs in the capture
// phase so a pan never also starts a brush stroke.
preview.addEventListener(
  "pointerdown",
  (e) => {
    if (!(e.button === 1 || (e.button === 0 && spaceHeld))) return;
    e.preventDefault();
    e.stopPropagation();
    pan = { x: e.clientX, y: e.clientY, left: preview.scrollLeft, top: preview.scrollTop };
    preview.setPointerCapture(e.pointerId);
    preview.classList.add("panning");
  },
  true,
);
preview.addEventListener("pointermove", (e) => {
  if (!pan) return;
  preview.scrollLeft = pan.left - (e.clientX - pan.x);
  preview.scrollTop = pan.top - (e.clientY - pan.y);
});
for (const type of ["pointerup", "pointercancel"]) {
  preview.addEventListener(type, () => {
    pan = null;
    preview.classList.toggle("panning", spaceHeld);
  });
}

// ---- Keyboard shortcuts -------------------------------------------------

function isTyping(target) {
  return !!target.closest?.("input:not([type=range]):not([type=checkbox]), select, textarea");
}

document.addEventListener("keydown", (e) => {
  if (!state.upload || isTyping(e.target)) return;
  const editing = state.view === "segmented";
  const key = e.key.toLowerCase();

  if (e.code === "Space") {
    e.preventDefault(); // don't scroll the page
    if (!spaceHeld) {
      spaceHeld = true;
      brushCursor.hidden = true;
      preview.classList.add("panning");
      renderEditMode();
    }
    return;
  }
  if (e.metaKey || e.ctrlKey) {
    if (editing && (key === "z" || key === "y")) {
      e.preventDefault();
      if (key === "y" || e.shiftKey) editor.redo();
      else editor.undo();
    }
    return;
  }
  if (e.altKey) return;

  const actions = {
    "+": () => setZoom(currentZoom() * 1.25),
    "=": () => setZoom(currentZoom() * 1.25),
    "-": () => setZoom(currentZoom() / 1.25),
    0: () => setZoom(null),
  };
  if (editing) {
    Object.assign(actions, {
      b: () => setTool("brush"),
      e: () => setTool("eraser"),
      r: () => setTool("restore"),
      f: () => setTool("fill"),
      "[": () => setBrushSize(Math.min(editor.size - 1, editor.size / 1.25)),
      "]": () => setBrushSize(Math.max(editor.size + 1, editor.size * 1.25)),
    });
  }
  if (!actions[key]) return;
  e.preventDefault();
  actions[key]();
});

document.addEventListener("keyup", (e) => {
  if (e.code !== "Space" || !spaceHeld) return;
  spaceHeld = false;
  if (!pan) preview.classList.remove("panning");
  renderEditMode();
});

$("delete-btn").addEventListener("click", async () => {
  const u = state.upload;
  if (!u || !confirm(`Delete "${u.filename}"?`)) return;
  // Its edits are going too, so don't try to save them.
  clearTimeout(saveTimer);
  editsUnsaved = false;
  editorPage = null;
  await fetch(`/api/uploads/${u.id}`, { method: "DELETE" });
  state.upload = null;
  await refreshList();
  renderViewer();
});

refreshList();
