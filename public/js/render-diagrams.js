/* Diagrams: Mermaid and raw SVG drawings shown in a square, zoomable viewer.
   Everything renders as an <img> from a blob URL, so model-written SVG can use
   any styling, gradients, animation or foreignObject without being able to run
   script or reach the page. */
let truxMermaidRenderSequence = 0;
let truxMermaidRenderQueue = Promise.resolve();
let truxMermaidLoader = null;


function normalizeTruxMermaidSource(raw){
  let source=String(raw||"").replace(/^\uFEFF/,"").replace(/\r\n?/g,"\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g,"'")
    .replace(/[\u201C\u201D\u201E\u201F]/g,'"').trim();
  const fence = String.fromCharCode(96).repeat(3);
  source=source.replace(new RegExp("^\\s*"+fence+"(?:[\\w+#.-]+)?[ \\t]*\\n?","i"),"").replace(new RegExp("\\n?\\s*"+fence+"\\s*$"),"").trim();
  source=source.replace(/&nbsp;/gi," ").replace(/<br\s*\/?\s*>/gi," ");
  const lines=source.split("\n");
  const first=lines.findIndex(line=>/^\s*(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|quadrantChart|xychart-beta|block-beta|architecture-beta|gitGraph|sankey-beta|zenuml|requirementDiagram)\b/i.test(line));
  if(first>0) source=lines.slice(first).join("\n");
  return source.trim();
}
function repairTruxMermaidSource(raw){
  let source=normalizeTruxMermaidSource(raw);
  if(!/^(?:flowchart|graph)\b/i.test(source))return source;
  // Recover common model-generated flowchart slips without changing valid edge syntax.
  source=source.replace(/^(\s*(?:flowchart|graph))\s*$/im,"$1 TD");
  source=source.replace(/(?<![-.])-(?![-.])>/g,"-->");
  source=source.split("\n").map(line=>line.replace(
    /^(\s*[A-Za-z_][\w-]*\s*)\[([^\]\n]*)\](.*)$/,
    (whole,id,label,tail)=>{
      const value=label.trim();
      const alreadyQuoted=/^(?:"(?:\\.|[^"\\\\])*"|'(?:\\.|[^'\\\\])*'|`[^`]*`)$/.test(value);
      return /[():,;|{}]/.test(value)&&!alreadyQuoted
        ? id+"["+JSON.stringify(value)+"]"+tail : whole;
    }
  )).join("\n");
  return source;
}

function normalizeTruxSvgSource(raw) {
  let source = String(raw || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  const fence = String.fromCharCode(96).repeat(3);
  source = source.replace(new RegExp("^\\s*" + fence + "(?:svg|xml)?[ \\t]*\\n?", "i"), "")
    .replace(new RegExp("\\n?\\s*" + fence + "\\s*$"), "").trim();
  const start = source.search(/<(?:[A-Za-z_][\w.-]*:)?svg\b/i);
  if (start > 0) source = source.slice(start).trim();
  const end = source.toLowerCase().lastIndexOf("</svg>");
  if (end >= 0) source = source.slice(0, end + 6);
  return source;
}
function isTruxSvgDrawing(raw) {
  return /^\s*(?:<\?xml[\s\S]*?\?>\s*)?<(?:[A-Za-z_][\w.-]*:)?svg\b/i.test(normalizeTruxSvgSource(raw));
}
function isTruxDiagram(lang, code) {
  const label = String(lang || "").trim().toLowerCase(), source = String(code || "").trim();
  if (label === "mermaid" || label === "svg") return true;
  if ((label === "xml" || label === "html" || !label) && isTruxSvgDrawing(source) && /^\s*(?:<\?xml[\s\S]*?\?>\s*)?<svg\b/i.test(source)) return true;
  if (label && label !== "mermaid") return false;
  return /^(?:flowchart|graph|sequencediagram|classdiagram|statediagram(?:-v2)?|erdiagram|journey|gantt|pie(?:\s|$)|mindmap|timeline|quadrantchart|xychart-beta|block-beta|architecture-beta|gitgraph|sankey-beta|zenuml|requirementdiagram|packet-beta|kanban|radar-beta)\b/i.test(source);
}

const TDG_ICON = {
  minus: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg>',
  fit: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 12h6"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/></svg>',
  code: '<svg viewBox="0 0 24 24"><path d="m9 8-4 4 4 4M15 8l4 4-4 4"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>'
};

function buildTruxDiagramCard(source, pending = false) {
  const b = (action, label, icon, text) => `<button type="button" data-trux-diagram-action="${action}" title="${label}" aria-label="${label}">${icon}${text ? `<span>${text}</span>` : ""}</button>`;
  return '<div class="trux-diagram" data-trux-diagram' + (pending ? ' data-trux-diagram-pending="true"' : '') + '>' +
    '<div class="tdg-view" tabindex="0" role="img" aria-label="Diagram. Pinch or Ctrl + scroll to zoom, drag to move.">' +
      '<img class="tdg-img" alt="" draggable="false" hidden>' +
      '<div class="tdg-status"><span class="tdg-spinner"></span><span>Drawing…</span></div>' +
    '</div>' +
    '<div class="tdg-bar">' +
      b("zoom-out", "Zoom out", TDG_ICON.minus) + '<output class="tdg-zoom">100%</output>' + b("zoom-in", "Zoom in", TDG_ICON.plus) +
      b("fit", "Fit to view", TDG_ICON.fit) + b("full", "Full screen", TDG_ICON.full) +
      '<span class="tdg-gap"></span>' +
      b("edit", "Edit source", TDG_ICON.code) + b("svg", "Download SVG", TDG_ICON.down, "SVG") + b("png", "Download PNG", TDG_ICON.down, "PNG") +
    '</div>' +
    '<div class="trux-diagram-editor" hidden><textarea spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Diagram source"></textarea>' +
      '<div class="trux-diagram-editor-actions"><button type="button" data-trux-diagram-action="cancel">Cancel</button><button type="button" data-trux-diagram-action="apply">Apply</button></div></div>' +
    '<pre class="trux-diagram-source" hidden>' + escapeHtml(String(source || "")) + '</pre>' +
    '<div class="trux-diagram-error" hidden></div></div>';
}

/* ---------- Rendering ---------- */
function truxCssVar(name, fallback) {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
}

function getTruxMermaidApi() {
  const root = window.mermaid;
  if (root?.default && typeof root.default.render === "function") return root.default;
  if (root && typeof root.render === "function") return root;
  return null;
}

function loadTruxMermaid() {
  const api = getTruxMermaidApi();
  if (api) return Promise.resolve(api);
  if (truxMermaidLoader) return truxMermaidLoader;
  truxMermaidLoader = new Promise(resolve => {
    const deadline = Date.now() + 12000;
    const poll = () => {
      const ready = getTruxMermaidApi();
      if (ready) return resolve(ready);
      if (Date.now() > deadline) {
        const script = document.createElement("script");
        script.src = "https://unpkg.com/mermaid@11/dist/mermaid.min.js";
        script.onload = () => resolve(getTruxMermaidApi());
        script.onerror = () => resolve(null);
        document.head.appendChild(script);
        return;
      }
      setTimeout(poll, 120);
    };
    poll();
  }).then(api => { if (!api) truxMermaidLoader = null; return api; });
  return truxMermaidLoader;
}

async function renderTruxMermaid(source) {
  const api = await loadTruxMermaid();
  if (!api) throw new Error("The diagram engine could not load. Check your connection and try again.");
  const light = document.documentElement.dataset.scheme === "light";
  const bg = truxCssVar("--bg-2", light ? "#f2f2f4" : "#141416");
  const surface = truxCssVar("--bg-3", light ? "#e8e8ec" : "#1c1c20");
  const text = truxCssVar("--txt", light ? "#111" : "#eee");
  const line = truxCssVar("--txt-3", "#888");
  api.initialize({
    startOnLoad: false, securityLevel: "strict", theme: "base", deterministicIds: true, htmlLabels: false,
    themeVariables: {
      darkMode: !light, background: bg, primaryColor: surface, primaryTextColor: text, primaryBorderColor: line,
      secondaryColor: surface, tertiaryColor: bg, lineColor: line, textColor: text, mainBkg: surface,
      clusterBkg: bg, clusterBorder: line, edgeLabelBackground: bg, noteBkgColor: surface, noteTextColor: text,
      noteBorderColor: line, fontFamily: "Arial, Helvetica, sans-serif", fontSize: "16px"
    },
    flowchart: { htmlLabels: false, useMaxWidth: false, curve: "basis", padding: 16 },
    sequence: { useMaxWidth: false }, gantt: { useMaxWidth: false }, er: { useMaxWidth: false },
    class: { htmlLabels: false }, mindmap: { useMaxWidth: false }, timeline: { useMaxWidth: false }
  });
  const job = async () => {
    let last = null;
    for (const candidate of [...new Set([normalizeTruxMermaidSource(source), repairTruxMermaidSource(source)])].filter(Boolean)) {
      try {
        // Measure text in a neutral box so labels match the standalone image.
        const box = document.createElement("div");
        box.style.cssText = "position:fixed;left:-99999px;top:0;width:1600px;font:400 16px Arial,Helvetica,sans-serif;letter-spacing:normal;word-spacing:normal;text-transform:none";
        document.body.appendChild(box);
        try {
          const { svg } = await api.render("trux-mmd-" + (++truxMermaidRenderSequence), candidate, box);
          return svg;
        } finally { box.remove(); }
      } catch (error) { last = error; }
    }
    throw last || new Error("Mermaid could not read this diagram.");
  };
  const run = truxMermaidRenderQueue.then(job, job);
  truxMermaidRenderQueue = run.catch(() => {});
  const svg = await run;
  return truxPrepareSvg(svg, bg);
}

/* Give the SVG an explicit size (images need one) and an optional backdrop. */
function truxPrepareSvg(raw, backdrop) {
  const doc = new DOMParser().parseFromString(raw, "image/svg+xml");
  const svg = doc.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) {
    const err = doc.querySelector("parsererror")?.textContent || "";
    throw new Error("The drawing has broken SVG markup" + (err ? ": " + err.split("\n")[0].slice(0, 140) : "."));
  }
  if (!svg.getAttribute("xmlns")) svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  let vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 && !/%/.test(String(v)) ? n : 0; };
  let w = num(svg.getAttribute("width")), h = num(svg.getAttribute("height"));
  if (vb.length !== 4 || vb.some(n => !Number.isFinite(n)) || vb[2] <= 0 || vb[3] <= 0) {
    vb = [0, 0, w || 1200, h || 1200];
    svg.setAttribute("viewBox", vb.join(" "));
  }
  if (!w || !h) { w = vb[2]; h = vb[3]; }
  // Scale small drawings up so they stay sharp when zoomed.
  const k = Math.max(1, 1600 / Math.max(w, h));
  svg.setAttribute("width", String(Math.round(w * k)));
  svg.setAttribute("height", String(Math.round(h * k)));
  svg.removeAttribute("style");
  if (backdrop) {
    const rect = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
    for (const [key, value] of Object.entries({ x: vb[0], y: vb[1], width: vb[2], height: vb[3], fill: backdrop })) rect.setAttribute(key, value);
    svg.insertBefore(rect, svg.firstChild);
  }
  return { svg: new XMLSerializer().serializeToString(svg), width: Math.round(w * k), height: Math.round(h * k) };
}

async function renderTruxDiagramElement(card) {
  if (!card?.isConnected || card.dataset.truxDiagramPending === "true" || card.dataset.truxDiagramState) return;
  card.dataset.truxDiagramState = "rendering";
  const source = card.querySelector(".trux-diagram-source")?.textContent || "";
  const view = card.querySelector(".tdg-view"), img = card.querySelector(".tdg-img");
  const status = card.querySelector(".tdg-status"), errorNode = card.querySelector(".trux-diagram-error");
  try {
    const drawing = isTruxSvgDrawing(source) ? truxPrepareSvg(normalizeTruxSvgSource(source), "") : await renderTruxMermaid(source);
    if (!card.isConnected) return;
    if (card._tdgUrl) URL.revokeObjectURL(card._tdgUrl);
    card._tdgSvg = drawing.svg;
    card._tdgUrl = URL.createObjectURL(new Blob([drawing.svg], { type: "image/svg+xml" }));
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error("The browser could not draw this SVG.")); img.src = card._tdgUrl; });
    img.hidden = false;
    status.hidden = true;
    errorNode.hidden = true;
    card.dataset.truxDiagramState = "done";
    truxDiagramViewer(card).fit();
  } catch (error) {
    card.dataset.truxDiagramState = "failed";
    status.hidden = true;
    errorNode.hidden = false;
    errorNode.textContent = String(error?.message || error || "This diagram could not be drawn.").replace(/\s+/g, " ").slice(0, 260);
    view.classList.add("tdg-failed");
  }
}

function renderTruxDiagrams(root) {
  if (!root?.querySelectorAll) return;
  const cards = [...root.querySelectorAll(".trux-diagram[data-trux-diagram]")];
  if (root instanceof Element && root.matches(".trux-diagram[data-trux-diagram]")) cards.unshift(root);
  cards.forEach(renderTruxDiagramElement);
}

/* ---------- Pan and zoom ---------- */
function truxDiagramViewer(card) {
  if (card._tdg) return card._tdg;
  const view = card.querySelector(".tdg-view"), img = card.querySelector(".tdg-img"), out = card.querySelector(".tdg-zoom");
  const st = { s: 1, x: 0, y: 0, fitS: 1 };
  const MIN = 0.05, MAX = 40;
  const apply = () => {
    img.style.transform = `translate(${st.x}px,${st.y}px) scale(${st.s})`;
    out.textContent = Math.round(st.s / st.fitS * 100) + "%";
    view.classList.toggle("tdg-zoomed", st.s > st.fitS * 1.01);
  };
  const fit = () => {
    const r = view.getBoundingClientRect(), w = img.naturalWidth || 1, h = img.naturalHeight || 1;
    if (!r.width) return;
    st.fitS = Math.min(r.width / w, r.height / h) * 0.96;
    st.s = st.fitS;
    st.x = (r.width - w * st.s) / 2;
    st.y = (r.height - h * st.s) / 2;
    apply();
  };
  const zoomAt = (factor, cx, cy) => {
    const r = view.getBoundingClientRect();
    if (cx == null) { cx = r.width / 2; cy = r.height / 2; }
    const next = Math.min(MAX, Math.max(MIN, st.s * factor));
    const k = next / st.s;
    st.x = cx - (cx - st.x) * k;
    st.y = cy - (cy - st.y) * k;
    st.s = next;
    apply();
  };
  const local = e => { const r = view.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  view.addEventListener("wheel", e => {
    const full = card.classList.contains("tdg-full") || document.fullscreenElement === card;
    if (!e.ctrlKey && !e.metaKey && !full) { // plain scroll keeps scrolling the chat
      view.classList.add("tdg-hint");
      clearTimeout(view._hint); view._hint = setTimeout(() => view.classList.remove("tdg-hint"), 1200);
      return;
    }
    e.preventDefault();
    const [x, y] = local(e);
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), x, y);
  }, { passive: false });

  const pts = new Map();
  let pinch = null, moved = false;
  view.addEventListener("pointerdown", e => {
    if (e.button && e.button !== 0) return;
    pts.set(e.pointerId, local(e));
    moved = false;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: st.s };
    }
    if (e.pointerType === "mouse" || pts.size === 2 || view.classList.contains("tdg-zoomed")) {
      try { view.setPointerCapture(e.pointerId); } catch {}
    }
  });
  view.addEventListener("pointermove", e => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId), cur = local(e);
    pts.set(e.pointerId, cur);
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt((pinch.s * d / pinch.d) / st.s, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      moved = true;
      return;
    }
    // One finger only pans once zoomed in, so the chat still scrolls at fit.
    if (e.pointerType !== "mouse" && !view.classList.contains("tdg-zoomed")) return;
    st.x += cur[0] - prev[0];
    st.y += cur[1] - prev[1];
    if (Math.abs(cur[0] - prev[0]) + Math.abs(cur[1] - prev[1]) > 0) moved = true;
    apply();
  });
  const end = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
  view.addEventListener("pointerup", end);
  view.addEventListener("pointercancel", end);
  view.addEventListener("dblclick", e => { const [x, y] = local(e); if (view.classList.contains("tdg-zoomed")) fit(); else zoomAt(2.5, x, y); });
  view.addEventListener("keydown", e => {
    const step = 40;
    if (e.key === "+" || e.key === "=") zoomAt(1.25);
    else if (e.key === "-") zoomAt(0.8);
    else if (e.key === "0") fit();
    else if (e.key === "ArrowLeft") { st.x += step; apply(); }
    else if (e.key === "ArrowRight") { st.x -= step; apply(); }
    else if (e.key === "ArrowUp") { st.y += step; apply(); }
    else if (e.key === "ArrowDown") { st.y -= step; apply(); }
    else return;
    e.preventDefault();
  });
  if (window.ResizeObserver) {
    let last = 0;
    new ResizeObserver(() => { const w = view.clientWidth; if (w && Math.abs(w - last) > 1) { last = w; fit(); } }).observe(view);
  }
  card._tdg = { fit, zoomAt };
  return card._tdg;
}

/* ---------- Toolbar ---------- */
function truxDiagramDownload(card, kind) {
  const svg = card._tdgSvg;
  if (!svg) return;
  const name = "trux-diagram-" + Date.now();
  const save = (blob, ext) => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${name}.${ext}`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };
  if (kind === "svg") return save(new Blob([svg], { type: "image/svg+xml" }), "svg");
  const img = card.querySelector(".tdg-img");
  const scale = Math.min(2, 4096 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  try {
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => blob ? save(blob, "png") : toast("PNG export is not available for this drawing. Download the SVG instead.", "err"), "image/png");
  } catch { toast("PNG export is not available for this drawing. Download the SVG instead.", "err"); }
}

function truxDiagramFullscreen(card) {
  const exit = () => { card.classList.remove("tdg-full"); document.body.classList.remove("tdg-lock"); requestAnimationFrame(() => card._tdg?.fit()); };
  if (document.fullscreenElement === card) { document.exitFullscreen?.(); return; }
  if (card.classList.contains("tdg-full")) { exit(); return; }
  card.classList.add("tdg-full");
  document.body.classList.add("tdg-lock");
  const done = () => requestAnimationFrame(() => card._tdg?.fit());
  if (card.requestFullscreen) {
    card.requestFullscreen().then(done).catch(done);
    const onChange = () => { if (document.fullscreenElement !== card) { document.removeEventListener("fullscreenchange", onChange); exit(); } };
    document.addEventListener("fullscreenchange", onChange);
  } else done();
}

document.addEventListener("click", event => {
  const button = event.target?.closest?.("[data-trux-diagram-action]");
  const card = button?.closest(".trux-diagram");
  if (!card) return;
  const action = button.dataset.truxDiagramAction;
  const viewer = card._tdg;
  const editor = card.querySelector(".trux-diagram-editor"), textarea = editor?.querySelector("textarea");
  const sourceNode = card.querySelector(".trux-diagram-source");
  if (action === "zoom-in") viewer?.zoomAt(1.3);
  else if (action === "zoom-out") viewer?.zoomAt(1 / 1.3);
  else if (action === "fit") viewer?.fit();
  else if (action === "full") truxDiagramFullscreen(card);
  else if (action === "svg" || action === "png") truxDiagramDownload(card, action);
  else if (action === "edit") { textarea.value = sourceNode.textContent || ""; editor.hidden = !editor.hidden; if (!editor.hidden) textarea.focus(); }
  else if (action === "cancel") editor.hidden = true;
  else if (action === "apply") {
    const value = textarea.value.trim();
    if (!value) return;
    sourceNode.textContent = value;
    editor.hidden = true;
    delete card.dataset.truxDiagramState;
    card.querySelector(".tdg-status").hidden = false;
    card.querySelector(".tdg-view").classList.remove("tdg-failed");
    renderTruxDiagramElement(card);
  }
});
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  const open = document.querySelector(".trux-diagram.tdg-full");
  if (open && document.fullscreenElement !== open) truxDiagramFullscreen(open);
});

// Mermaid colours come from the theme, so redraw them when it changes.
window.addEventListener("trux-theme", () => {
  document.querySelectorAll('.trux-diagram[data-trux-diagram-state="done"]').forEach(card => {
    if (isTruxSvgDrawing(card.querySelector(".trux-diagram-source")?.textContent || "")) return;
    delete card.dataset.truxDiagramState;
    renderTruxDiagramElement(card);
  });
});
