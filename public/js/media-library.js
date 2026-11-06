/* Media library: an on-device index (IndexedDB) of images and videos TruX
   generated. The files themselves stay private in Cloud Storage and are
   fetched through /api/media with the user's ID token. */
let mediaDbPromise = null;
let currentMediaFilter = "all";

function openTruxMediaDB() {
  if (mediaDbPromise) return mediaDbPromise;
  mediaDbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("IndexedDB is unavailable."));
    const request = indexedDB.open("trux_media_library", 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains("media")) db.deleteObjectStore("media"); // old data-URL entries
      db.createObjectStore("media", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Media library unavailable."));
  });
  return mediaDbPromise;
}

async function mediaTx(mode, fn) {
  const db = await openTruxMediaDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("media", mode);
    const result = fn(tx.objectStore("media"));
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error || new Error("Media library error."));
  });
}

async function saveGeneratedMedia(item) {
  if (!item?.objectKey) return;
  try {
    await mediaTx("readwrite", s => s.put({
      id: item.objectKey, uid: auth?.currentUser?.uid || "", type: item.type === "video" ? "video" : "image",
      objectKey: item.objectKey, prompt: String(item.prompt || "").slice(0, 1200), createdAt: Date.now()
    }));
  } catch {}
}

async function listGeneratedMedia(filter) {
  try {
    const rows = await mediaTx("readonly", s => s.getAll());
    const uid = auth?.currentUser?.uid || "";
    return (rows || [])
      .filter(r => r.uid === uid && (!filter || filter === "all" || r.type === filter))
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch { return []; }
}

async function deleteGeneratedMedia(id) {
  try { await mediaTx("readwrite", s => s.delete(id)); } catch {}
  renderMediaLibrary(currentMediaFilter);
}

async function downloadGeneratedMedia(item) {
  try {
    const url = await truxMediaObjectUrl(item.objectKey);
    const a = document.createElement("a");
    a.href = url; a.download = `trux-${item.type}-${Date.now()}.${item.type === "video" ? "mp4" : "png"}`;
    document.body.appendChild(a); a.click(); a.remove();
  } catch { toast("Media is not available for download.", "err"); }
}

async function openMediaLibrary(filter) {
  currentMediaFilter = filter || "all";
  const modal = getEl("mediaLibraryModal");
  if (!modal) return;
  setSidebarOpen(false);
  modal.classList.add("open");
  document.querySelectorAll("[data-media-filter]").forEach(x => x.classList.toggle("active", x.dataset.mediaFilter === currentMediaFilter));
  await renderMediaLibrary(currentMediaFilter);
}

async function renderMediaLibrary(filter) {
  const grid = getEl("mediaLibraryGrid");
  if (!grid) return;
  grid.innerHTML = '<div class="media-empty">Loading library…</div>';
  const rows = await listGeneratedMedia(filter);
  if (!rows.length) { grid.innerHTML = '<div class="media-empty">No generated media yet.<br>Ask TruX for an image or video and it will appear here.</div>'; return; }
  grid.innerHTML = "";
  rows.forEach((m, index) => {
    const card = document.createElement("article");
    card.className = "media-card";
    card.style.animationDelay = Math.min(index * 25, 300) + "ms";
    const host = document.createElement("div");
    const el = document.createElement(m.type === "video" ? "video" : "img");
    el.className = "media-card-media";
    if (m.type === "video") { el.controls = true; el.preload = "metadata"; el.playsInline = true; } else el.alt = m.prompt || "Generated image";
    host.appendChild(el);
    truxMediaObjectUrl(m.objectKey).then(u => { el.src = u; }).catch(() => { host.textContent = "Unavailable"; });
    const body = document.createElement("div"); body.className = "media-card-body";
    const kind = document.createElement("div"); kind.className = "media-card-kind"; kind.textContent = m.type === "video" ? "VIDEO" : "IMAGE";
    const p = document.createElement("div"); p.className = "media-card-prompt"; p.textContent = m.prompt || "Generated media";
    const actions = document.createElement("div"); actions.className = "media-card-actions";
    const openBtn = document.createElement("button"); openBtn.textContent = "Open";
    openBtn.onclick = () => truxMediaObjectUrl(m.objectKey).then(u => window.open(u, "_blank", "noopener"));
    const dl = document.createElement("button"); dl.textContent = "Download"; dl.onclick = () => downloadGeneratedMedia(m);
    const del = document.createElement("button"); del.textContent = "Delete"; del.onclick = () => deleteGeneratedMedia(m.id);
    actions.append(openBtn, dl, del);
    body.append(kind, p, actions);
    card.append(host, body);
    grid.appendChild(card);
  });
}

function closeMediaLibrary() { getEl("mediaLibraryModal")?.classList.remove("open"); }
