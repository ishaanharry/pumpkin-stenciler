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
// Mirrors DEFAULT_SPECKLE / DEFAULT_SMOOTHNESS in vectorize.py.
const DEFAULT_SPECKLE = 8;
const DEFAULT_SMOOTHNESS = 25;

// The currently selected source: { upload, page }. Later stencil steps read this.
const state = {
  uploads: [],
  upload: null,
  page: 1,
  view: "segmented", // "original" | "segmented" | "svg"
  // Segmentation settings per page, keyed by `${uploadId}:${page}`.
  settings: new Map(),
  histograms: new Map(),
  highlightIslands: true,
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
  const upload = state.uploads.find((u) => u.id === id);
  state.upload = upload ?? null;
  state.page = page;
  renderList();
  renderViewer();
}

function selectPage(page) {
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

  renderEditor();
  renderPreview();
  loadHistogram();
}

function setView(view) {
  state.view = view;
  renderPreview();
}

// After a segmentation change, make sure the preview shows its effect. The SVG
// view reflects segmentation too, so it stays put.
function showProcessed() {
  if (state.view === "original") state.view = "segmented";
}

tabOriginal.addEventListener("click", () => setView("original"));
tabSegmented.addEventListener("click", () => setView("segmented"));
tabSvg.addEventListener("click", () => setView("svg"));

function pageUrl() {
  return state.upload.pages[state.page - 1];
}

function segmentationQuery() {
  const s = currentSettings();
  const invert = s.invert ? "&invert=true" : "";
  return `thresholds=${s.thresholds.join(",")}${invert}`;
}

function segmentedUrl() {
  return `${pageUrl()}/segmented?${segmentationQuery()}`;
}

function svgUrl() {
  const s = currentSettings();
  return `${pageUrl()}/svg?${segmentationQuery()}&speckle=${s.speckle}&smoothness=${s.smoothness}`;
}

function renderPreview() {
  tabOriginal.setAttribute("aria-selected", String(state.view === "original"));
  tabSegmented.setAttribute("aria-selected", String(state.view === "segmented"));
  tabSvg.setAttribute("aria-selected", String(state.view === "svg"));
  const src = { original: pageUrl, segmented: segmentedUrl, svg: svgUrl }[state.view]();
  // Compare against the attribute: `.src` is normalised to an absolute URL.
  if (previewImg.getAttribute("src") !== src) {
    preview.classList.add("loading");
    previewImg.src = src;
  }
  runCheck();
}

const previewError = $("preview-error");

previewImg.addEventListener("load", () => {
  preview.classList.remove("loading");
  previewStack.hidden = false;
  previewError.hidden = true;
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
const islandList = $("island-list");
const highlightField = $("highlight-field");
const highlightToggle = $("highlight-toggle");
const MAX_LISTED_ISLANDS = 10;

let checkUrl = null;
let checkResult = null;

highlightToggle.addEventListener("change", () => {
  state.highlightIslands = highlightToggle.checked;
  renderCheck();
});

// Runs whenever the preview updates; skipped if nothing that affects it changed.
async function runCheck() {
  const s = currentSettings();
  const url = `${pageUrl()}/islands?${segmentationQuery()}&speckle=${s.speckle}`;
  if (url === checkUrl) return;
  checkUrl = url;
  checkStatus.className = "check-status";
  checkStatus.textContent = "Checking…";

  const res = await fetch(url).catch(() => null);
  const data = res?.ok ? await res.json() : null;
  if (url !== checkUrl) return; // settings changed while this was running
  checkResult = data;
  renderCheck();
}

function renderCheck() {
  const r = checkResult;
  const count = r?.islands.length ?? 0;

  checkBadge.hidden = !r;
  checkStatus.className = `check-status ${r ? (r.valid ? "ok" : "bad") : ""}`;
  if (!r) {
    checkStatus.textContent = "The stencil couldn't be checked.";
  } else if (r.valid) {
    checkBadge.className = "badge ok";
    checkBadge.textContent = "✓ No unsupported pieces";
    checkStatus.textContent = "✓ Every piece of pumpkin stays attached.";
  } else {
    const pieces = `${count} unsupported piece${count === 1 ? "" : "s"}`;
    checkBadge.className = "badge bad";
    checkBadge.textContent = `⚠ ${pieces}`;
    checkStatus.textContent = `⚠ ${pieces} would fall out.`;
  }

  const show = !!r && !r.valid && state.highlightIslands;
  highlightField.hidden = !r || r.valid;
  highlightToggle.checked = state.highlightIslands;
  islandOverlay.hidden = !show;
  if (show) islandOverlay.src = r.overlay;

  islandBoxes.replaceChildren(
    ...(show ? r.islands : []).map((island, i) => {
      const box = document.createElement("div");
      box.className = "island-box";
      box.dataset.index = i;
      Object.assign(box.style, {
        left: `${(island.x / r.width) * 100}%`,
        top: `${(island.y / r.height) * 100}%`,
        width: `${(island.width / r.width) * 100}%`,
        height: `${(island.height / r.height) * 100}%`,
      });
      return box;
    }),
  );

  const listed = r && !r.valid ? r.islands.slice(0, MAX_LISTED_ISLANDS) : [];
  islandList.replaceChildren(
    ...listed.map((island, i) => {
      const li = document.createElement("li");
      li.textContent = `${island.width}×${island.height} px (${island.area.toLocaleString()} px²)`;
      // Hovering a list entry picks out its box on the preview.
      li.addEventListener("mouseenter", () => setActiveBox(i, true));
      li.addEventListener("mouseleave", () => setActiveBox(i, false));
      return li;
    }),
  );
  if (count > listed.length) {
    const more = document.createElement("li");
    more.textContent = `…and ${count - listed.length} smaller`;
    islandList.append(more);
  }
}

function setActiveBox(index, active) {
  islandBoxes.querySelector(`[data-index="${index}"]`)?.classList.toggle("active", active);
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

function currentSettings() {
  const key = `${state.upload.id}:${state.page}`;
  if (!state.settings.has(key)) {
    state.settings.set(key, {
      shades: MIN_SHADES,
      thresholds: defaultThresholds(MIN_SHADES),
      invert: false,
      speckle: DEFAULT_SPECKLE,
      smoothness: DEFAULT_SMOOTHNESS,
    });
  }
  return state.settings.get(key);
}

function setShades(shades) {
  const s = currentSettings();
  s.shades = shades;
  s.thresholds = defaultThresholds(shades);
  showProcessed();
  renderEditor();
  renderPreview();
}

$("reset-btn").addEventListener("click", () => setShades(currentSettings().shades));

invertToggle.addEventListener("change", () => {
  currentSettings().invert = invertToggle.checked;
  showProcessed();
  renderEditor();
  renderPreview();
});

for (const [name, input, output] of [
  ["speckle", $("speckle-input"), $("speckle-output")],
  ["smoothness", $("smoothness-input"), $("smoothness-output")],
]) {
  input.addEventListener("input", () => {
    currentSettings()[name] = Number(input.value);
    output.textContent = input.value;
    state.view = "svg";
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
}

function updateDownload() {
  const base = state.upload.filename.replace(/\.[^.]+$/, "");
  const suffix = state.upload.page_count > 1 ? `-p${state.page}` : "";
  downloadBtn.href = segmentedUrl();
  downloadBtn.download = `${base}${suffix}-segmented.png`;
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

$("delete-btn").addEventListener("click", async () => {
  const u = state.upload;
  if (!u || !confirm(`Delete "${u.filename}"?`)) return;
  await fetch(`/api/uploads/${u.id}`, { method: "DELETE" });
  state.upload = null;
  await refreshList();
  renderViewer();
});

refreshList();
