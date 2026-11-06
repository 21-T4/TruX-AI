/* Device actions requested by TruX (chat or Live): call, text, open apps…
   In the TruX Android app they go straight to the native bridge. In a
   browser they become tel:/sms:/mailto:/maps links shown on a small
   confirmation sheet, because browsers only open those from a tap. */
window.truxDevice = (() => {
  "use strict";
  const bridge = () => (window.TruXAndroid && typeof window.TruXAndroid.deviceAction === "function") ? window.TruXAndroid : null;

  function platform() {
    if (bridge()) return "android-app";
    const ua = navigator.userAgent || "";
    if (/Android/i.test(ua)) return "android-web";
    if (/iPhone|iPad|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios-web";
    return "desktop-web";
  }

  function info() {
    let version = "";
    try { version = bridge()?.version?.() || ""; } catch {}
    return { platform: platform(), version };
  }

  const enc = encodeURIComponent;
  const digits = value => String(value || "").replace(/[^\d+*#,;]/g, "");
  const looksLikeNumber = value => digits(value).replace(/\D/g, "").length >= 3;

  function webPlan(a) {
    const ios = platform() === "ios-web";
    switch (a.action) {
      case "call":
        if (!looksLikeNumber(a.target)) return { error: "To call " + a.target + " from the browser I need their number. In the TruX Android app I can call contacts by name." };
        return { icon: "call", title: "Call " + a.target, href: "tel:" + digits(a.target), button: "Call" };
      case "message": {
        if (!looksLikeNumber(a.target)) return { error: "To text " + a.target + " from the browser I need their number." };
        const body = a.text ? (ios ? "&body=" : "?body=") + enc(a.text) : "";
        return { icon: "sms", title: "Text " + a.target, sub: a.text, href: "sms:" + digits(a.target) + body, button: "Open Messages" };
      }
      case "email": {
        const q = [a.subject && "subject=" + enc(a.subject), a.text && "body=" + enc(a.text)].filter(Boolean).join("&");
        return { icon: "mail", title: "Email " + a.target, sub: a.subject || a.text, href: "mailto:" + a.target + (q ? "?" + q : ""), button: "Open mail" };
      }
      case "open_url": return { icon: "link", title: "Open link", sub: a.target, href: a.target, button: "Open", newTab: true };
      case "navigate": return { icon: "nav", title: "Directions to " + a.target, href: "https://www.google.com/maps/dir/?api=1&destination=" + enc(a.target), button: "Start", newTab: true };
      case "search_maps": return { icon: "nav", title: "Find " + a.target, href: "https://www.google.com/maps/search/?api=1&query=" + enc(a.target), button: "Open Maps", newTab: true };
      case "play_media": {
        const q = a.text || a.target;
        const spotify = /spotify/i.test(a.target || "");
        return { icon: "play", title: "Play " + q, href: spotify ? "https://open.spotify.com/search/" + enc(q) : "https://www.youtube.com/results?search_query=" + enc(q), button: "Play", newTab: true };
      }
      case "open_camera": return { icon: "camera", title: "Take a photo", button: "Open camera", camera: true };
      default: return { error: "That works in the TruX Android app. Install it from Settings → Assistant." };
    }
  }

  const ICONS = {
    call: '<path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/>',
    sms: '<path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z"/>',
    mail: '<path d="M3 5h18v14H3zM3 6l9 7 9-7" fill="none" stroke="currentColor" stroke-width="2"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" stroke-width="2"/>',
    nav: '<path d="M12 2 4 21l8-4 8 4z"/>',
    play: '<path d="M7 4v16l13-8z"/>',
    camera: '<path d="M4 7h3l2-3h6l2 3h3v13H4z M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/>'
  };

  let sheetTimer = null;
  function closeSheet() {
    clearTimeout(sheetTimer);
    const el = document.getElementById("truxActionSheet");
    if (!el) return;
    el.classList.remove("open");
    setTimeout(() => el.remove(), 220);
  }

  function showSheet(plan) {
    closeSheet();
    const el = document.createElement("div");
    el.id = "truxActionSheet";
    el.className = "trux-action-sheet";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", plan.title);
    el.innerHTML = '<div class="tas-icon"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + (ICONS[plan.icon] || ICONS.link) + '</svg></div>' +
      '<div class="tas-copy"><b>' + escapeHtml(plan.title) + '</b>' + (plan.sub ? '<small>' + escapeHtml(String(plan.sub).slice(0, 140)) + '</small>' : '') + '</div>' +
      '<button type="button" class="tas-cancel">Cancel</button>';
    const go = document.createElement(plan.camera ? "button" : "a");
    go.className = "tas-go";
    go.textContent = plan.button;
    if (plan.camera) {
      go.type = "button";
      go.onclick = () => { closeSheet(); try { (document.getElementById("cameraUpload") || document.querySelector('input[type=file][capture]'))?.click(); } catch {} };
    } else {
      go.href = plan.href;
      if (plan.newTab) { go.target = "_blank"; go.rel = "noopener"; }
      go.addEventListener("click", () => setTimeout(closeSheet, 50));
    }
    el.appendChild(go);
    el.querySelector(".tas-cancel").onclick = closeSheet;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("open"));
    sheetTimer = setTimeout(closeSheet, 45000);
  }

  function run(action, { source = "chat" } = {}) {
    if (!action || typeof action !== "object") return;
    const native = bridge();
    if (native) {
      return Promise.resolve(native.deviceAction(JSON.stringify(action))).then(raw => {
        let result = {};
        try { result = JSON.parse(raw || "{}"); } catch { result = { ok: false, message: "The app could not do that." }; }
        if (result.message) toast(result.message, result.ok === false ? "err" : "ok");
        return result;
      });
    }
    const plan = webPlan(action);
    if (plan.error) { if (source !== "live") toast(plan.error, "err"); return { ok: false, message: plan.error }; }
    showSheet(plan);
    return { ok: true };
  }

  document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });
  return { info, run, platform, isApp: () => !!bridge(), closeSheet };
})();
