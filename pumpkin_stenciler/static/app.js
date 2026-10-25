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

// The currently selected source: { upload, page }. Later stencil steps read this.
const state = { uploads: [], upload: null, page: 1 };

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
  previewImg.src = u.pages[state.page - 1];

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
