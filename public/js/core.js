/* Core helpers: element lookup, toasts, gesture guards, service worker, safe localStorage. */

const getEl = (id) => document.getElementById(id);

/* ---------- toasts ----------
   Replaces the blocking window dialogs, which froze the page and looked
   nothing like the rest of the app. */
function toast(msg, kind) {
  let host = getEl("toastHost");
  if(!host) return;
  let t = document.createElement("div");
  t.className = "toast" + (kind ? " " + kind : "");
  t.innerHTML = '<i></i><span></span>';
  t.querySelector("span").textContent = String(msg);
  host.appendChild(t);
  let life = Math.min(7000, 2600 + String(msg).length * 28);
  setTimeout(() => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 300);
  }, life);
  while(host.children.length > 3) host.firstElementChild.remove();
}

/* iOS Safari honours neither user-scalable=no nor maximum-scale, so pinch
   and double-tap zoom are cancelled by hand. Wheel+ctrl (trackpad pinch on
   desktop) is blocked too, which is what a native app shell feels like. */
["gesturestart", "gesturechange", "gestureend"].forEach(function(t) {
  document.addEventListener(t, function(e) { e.preventDefault(); }, { passive: false });
});
document.addEventListener("touchmove", function(e) {
  if(e.touches && e.touches.length > 1) e.preventDefault();
}, { passive: false });
document.addEventListener("wheel", function(e) {
  if(e.ctrlKey) e.preventDefault();
}, { passive: false });
let lastTouchEnd = 0;
document.addEventListener("touchend", function(e) {
  let now = Date.now();
  /* Controls keep their native double-tap behaviour (touch-action:
     manipulation already kills zoom there) so fast repeat taps still work. */
  let interactive = e.target.closest && e.target.closest("button, a, input, textarea, select, label, [contenteditable]");
  if(!interactive && now - lastTouchEnd <= 320) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

addEventListener("load", () => { try { if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js?v=20261025-consolidated-v5", { updateViaCache: "none" }).catch(() => {}); } catch (e) {} });
/* ============ Auth: sign-in wall only shown on demand ============ */

const store = (() => {
  let backing = null;
  let persistent = false;
  try {
    localStorage.setItem("__trux_probe", "1");
    localStorage.removeItem("__trux_probe");
    backing = localStorage;
    persistent = true;
  } catch (e) {
    const mem = new Map();
    backing = {
      getItem: k => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: k => mem.delete(k)
    };
  }
  return {
    available: persistent,
    getItem(k) { try { return backing.getItem(k); } catch (e) { return null; } },
    setItem(k, v) { try { backing.setItem(k, v); return true; } catch (e) { return false; } },
    removeItem(k) { try { backing.removeItem(k); } catch (e) {} },
    // Parse JSON defensively: one corrupted entry must not brick the app.
    json(k, fallback) {
      try {
        const raw = backing.getItem(k);
        if (raw === null || raw === "") return fallback;
        const parsed = JSON.parse(raw);
        return parsed === null || parsed === undefined ? fallback : parsed;
      } catch (e) { return fallback; }
    }
  };
})();
