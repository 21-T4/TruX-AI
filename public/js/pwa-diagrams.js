/* PWA install prompt and diagram rendering hooks. */
(() => {
  "use strict";

  let deferredInstallPrompt = null;
  const byId = id => document.getElementById(id);

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    window.toast?.("TruX-Omni is installed.", "ok");
  });

  function closeInstallHelp() {
    byId("truxPwaInstallHelp")?.remove();
  }

  function showInstallHelp() {
    let modal = byId("truxPwaInstallHelp");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "truxPwaInstallHelp";
      modal.className = "modal active";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-label", "Install TruX-Omni PWA");
      modal.innerHTML =
        '<div class="card" style="width:min(520px,100%);max-height:82vh;overflow:auto;text-align:left">' +
          '<button class="close" type="button" aria-label="Close">×</button>' +
          '<div class="mtitle">Install TruX-Omni</div>' +
          '<div class="msub">Add the complete TruX-Omni workspace to your device as a PWA. No separate app download is required.</div>' +
          '<div style="display:grid;gap:12px;margin-top:18px;font-size:13px;line-height:1.55;color:var(--txt-2)">' +
            '<div><b style="color:var(--txt)">Android / Chrome</b><br>Open the browser menu, then choose Install app or Add to Home screen.</div>' +
            '<div><b style="color:var(--txt)">iPhone / iPad</b><br>In Safari, open Share and choose Add to Home Screen.</div>' +
            '<div><b style="color:var(--txt)">Desktop</b><br>Use the install icon in the address bar, or choose Install TruX-Omni from the browser menu.</div>' +
          '</div>' +
          '<button type="button" class="mbtn" style="width:100%;margin-top:20px">Close</button>' +
        '</div>';
      modal.querySelector(".close").addEventListener("click", closeInstallHelp);
      modal.querySelector(".mbtn").addEventListener("click", closeInstallHelp);
      modal.addEventListener("click", event => { if (event.target === modal) closeInstallHelp(); });
      document.body.appendChild(modal);
    }
  }

  async function installPwa() {
    if (window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true) {
      window.toast?.("TruX-Omni is already installed.", "ok");
      return;
    }
    if (!deferredInstallPrompt) {
      showInstallHelp();
      return;
    }
    const prompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice?.outcome === "accepted") window.toast?.("TruX-Omni is being installed.", "ok");
      else showInstallHelp();
    } catch {
      showInstallHelp();
    }
  }

  function bindInstallButton() {
    const button = byId("sidebarInstallBtn");
    if (!button || button.dataset.pwaInstallBound === "true") return;
    button.dataset.pwaInstallBound = "true";
    button.setAttribute("aria-label", "Install TruX-Omni");
    button.title = "Install TruX-Omni";
    button.addEventListener("click", installPwa);
  }

  function makeDiagramStatic(stage, svg, cursor) {
    if (cursor) {
      cursor.hidden = true;
      cursor.style.setProperty("display", "none", "important");
    }
    if (stage) {
      stage.style.setProperty("width", "100%", "important");
      stage.style.setProperty("min-width", "0", "important");
      stage.style.setProperty("min-height", "0", "important");
      stage.style.setProperty("height", "auto", "important");
    }
    if (!svg) return;
    ["width", "min-width", "max-width", "height", "min-height"].forEach((prop, index) => {
      const value = ["100%", "0", "100%", "auto", "0"][index];
      svg.style.setProperty(prop, value, "important");
    });
    svg.style.setProperty("display", "block", "important");
    svg.style.setProperty("overflow", "visible", "important");
    svg.style.setProperty("background", "#151515", "important");
    svg.style.setProperty("background-color", "#151515", "important");
    svg.querySelectorAll("text,foreignObject,.edgeLabel,.nodeLabel,.cluster-label").forEach(label => {
      label.style.visibility = "";
    });
  }

  function stabilizeDiagramCard(card) {
    if (!card?.matches?.(".trux-diagram")) return;
    const stage = card.querySelector(".trux-diagram-stage");
    const slot = card.querySelector(".trux-diagram-svg");
    const svg = slot?.querySelector("svg");
    const cursor = card.querySelector(".trux-diagram-cursor");
    makeDiagramStatic(stage, svg, cursor);
    const toolbar = card.querySelector(".trux-diagram-toolbar");
    if (toolbar) toolbar.style.position = "static";
  }

  function bindDiagramRendering() {
    const style = document.createElement("style");
    style.id = "trux-pwa-static-diagrams";
    style.textContent =
      '.trux-diagram{width:100%!important;max-width:100%!important;min-width:0!important;overflow:hidden!important;background:#151515!important}' +
      '.trux-diagram-stage{display:block!important;width:100%!important;min-width:0!important;min-height:0!important;height:auto!important;background:#151515!important}' +
      '.trux-diagram-svg{display:block!important;width:100%!important;min-width:0!important;max-width:100%!important;background:#151515!important}' +
      '.trux-diagram-svg svg{display:block!important;width:100%!important;min-width:0!important;max-width:100%!important;height:auto!important;min-height:0!important;background:#151515!important}' +
      '.trux-diagram-cursor{display:none!important}' +
      '.trux-diagram-toolbar{position:static!important}' +
      '@media(prefers-reduced-motion:reduce){.trux-diagram *{animation:none!important;transition:none!important}}';
    document.head.appendChild(style);

    // The existing renderer calls this after inserting SVG. Replace only the
    // drawing animation; the AI's SVG geometry and arbitrary labels stay intact.
    window.animateTruxDiagramDrawing = makeDiagramStatic;

    const scan = node => {
      if (!(node instanceof Element)) return;
      if (node.matches(".trux-diagram")) stabilizeDiagramCard(node);
      node.querySelectorAll?.(".trux-diagram").forEach(stabilizeDiagramCard);
    };
    scan(document.body);
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === "childList") record.addedNodes.forEach(scan);
        else if (record.target instanceof Element) scan(record.target.closest(".trux-diagram") || record.target);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function run() {
    bindInstallButton();
    bindDiagramRendering();
    const observer = new MutationObserver(() => {
      bindInstallButton();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
})();
