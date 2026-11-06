/* Video studio: options, idea chips, recent videos and the live storyboard
   card shown while Argon plans and Veo/Omni render. */
(function () {
  const KEY = "trux_video_options";
  let opts = { length: "auto", aspectRatio: "16:9" };
  try { opts = { ...opts, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch {}

  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function syncSegments() {
    document.querySelectorAll("[data-video-opt]").forEach(group => {
      const key = group.dataset.videoOpt;
      group.querySelectorAll("button").forEach(b => {
        const on = b.dataset.value === String(opts[key]);
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    });
  }

  function bind() {
    document.querySelectorAll("[data-video-opt]").forEach(group => {
      group.addEventListener("click", e => {
        const b = e.target.closest("button[data-value]");
        if (!b) return;
        opts[group.dataset.videoOpt] = b.dataset.value;
        try { localStorage.setItem(KEY, JSON.stringify(opts)); } catch {}
        syncSegments();
      });
    });
    getEl("videoIdeas")?.addEventListener("click", e => {
      const b = e.target.closest("button[data-idea]");
      if (!b) return;
      const input = getEl("promptInput");
      input.value = b.dataset.idea;
      input.focus();
      handleInputChange();
    });
    syncSegments();
  }

  async function refresh() {
    syncSegments();
    const box = getEl("videoRecent"), grid = getEl("videoRecentGrid");
    if (!box || !grid || typeof listGeneratedMedia !== "function") return;
    const items = (await listGeneratedMedia("video").catch(() => [])).slice(0, 6);
    box.hidden = !items.length;
    grid.innerHTML = "";
    for (const item of items) {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "vs-tile";
      tile.title = item.prompt || "Video";
      tile.innerHTML = `<video muted playsinline preload="metadata"></video><span>${esc((item.prompt || "Video").slice(0, 70))}</span>`;
      tile.onclick = () => openMediaLibrary("video");
      const video = tile.querySelector("video");
      tile.onmouseenter = () => video.play().catch(() => {});
      tile.onmouseleave = () => { video.pause(); video.currentTime = 0; };
      grid.appendChild(tile);
      truxMediaObjectUrl(item.objectKey).then(url => { video.src = url + "#t=0.5"; }).catch(() => tile.remove());
    }
  }

  function card(row) {
    let el = row?.querySelector(".trux-storyboard");
    if (!el && row) {
      el = document.createElement("div");
      el.className = "trux-storyboard";
      row.querySelector(".bubble")?.before(el);
    }
    return el;
  }

  function storyboard(row, plan) {
    if (!plan || !row) return;
    const el = card(row);
    const shots = Array.isArray(plan.shots) ? plan.shots : [];
    el.innerHTML = `
      <div class="sb-head"><b>${esc(plan.title || "Storyboard")}</b><span>${esc(plan.aspectRatio || "")} · ${shots.length} shot${shots.length === 1 ? "" : "s"}</span></div>
      ${plan.look ? `<p class="sb-look">${esc(plan.look)}</p>` : ""}
      <ol class="sb-shots">${shots.map((s, i) => `<li data-shot="${i}"><i>${i + 1}</i><span>${esc(s.caption || s.prompt || "")}</span></li>`).join("")}</ol>`;
  }

  function progress(row, ev) {
    const el = row?.querySelector(".trux-storyboard");
    if (!el || ev.shot == null) return;
    el.querySelectorAll("[data-shot]").forEach(li => {
      const n = Number(li.dataset.shot);
      li.classList.toggle("done", n < ev.shot);
      li.classList.toggle("active", n === ev.shot);
    });
  }

  window.truxVideoStudio = {
    options: () => ({ length: opts.length === "auto" ? "auto" : Number(opts.length), aspectRatio: opts.aspectRatio }),
    refresh, storyboard, progress
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind); else bind();
})();
