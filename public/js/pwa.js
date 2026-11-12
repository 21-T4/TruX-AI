/* PWA install prompt. */
(() => {
  "use strict";

  let deferredInstallPrompt = null;
  const byId = id => document.getElementById(id);

  const INSTALLED_KEY = "trux_pwa_installed";
  const isStandalone = () => !!(window.matchMedia?.("(display-mode: standalone)").matches ||
    window.matchMedia?.("(display-mode: fullscreen)").matches || navigator.standalone === true);
  const readInstalled = () => { try { return localStorage.getItem(INSTALLED_KEY) === "1"; } catch { return false; } };
  const markInstalled = () => { try { localStorage.setItem(INSTALLED_KEY, "1"); } catch {} };

  /* The install button exists only while the app is not installed (never inside the installed app). */
  function syncInstallButton() {
    const button = byId("homeInstallBtn");
    if (!button) return;
    if (isStandalone()) markInstalled();
    button.hidden = isStandalone() || readInstalled();
  }

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    try { localStorage.removeItem(INSTALLED_KEY); } catch {}   /* the browser offers it again, so it was removed */
    syncInstallButton();
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    markInstalled();
    syncInstallButton();
    window.toast?.("TruX-Omni is installed.", "ok");
  });
  window.matchMedia?.("(display-mode: standalone)").addEventListener?.("change", syncInstallButton);

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
    const button = byId("homeInstallBtn");
    if (!button || button.dataset.pwaInstallBound === "true") return;
    button.dataset.pwaInstallBound = "true";
    button.setAttribute("aria-label", "Install TruX-Omni");
    button.title = "Install TruX-Omni";
    button.addEventListener("click", installPwa);
    syncInstallButton();
  }

  function run() {
    bindInstallButton();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
})();
