/* Glue between the web app and the TruX Android app (window.TruXAndroid,
   see android/app/src/main/java/ai/trux/assistant/Bridge.kt). Everything
   here is a no-op in a normal browser. */
window.truxNative = (() => {
  "use strict";
  const app = () => window.TruXAndroid || null;
  const call = (name, ...args) => { try { const fn = app()?.[name]; return typeof fn === "function" ? fn.apply(app(), args) : undefined; } catch { return undefined; } };
  const queue = [];
  let ready = false;

  const PERMISSIONS = {
    microphone: "Microphone", camera: "Camera", phone: "Phone calls", contacts: "Contacts",
    notifications: "Notifications", location: "Location", overlay: "Display over other apps",
    battery: "Run in background", assistant: "Default digital assistant"
  };

  function refreshAssistantSettings() {
    const inApp = !!app();
    const appCard = getEl("truxAssistantAppCard"), nativeCard = getEl("truxAssistantNativeCard");
    if (appCard) appCard.hidden = inApp;
    if (nativeCard) nativeCard.hidden = !inApp;
    const hint = getEl("truxCircleHint");
    if (hint) hint.textContent = inApp
      ? "Hold the side button (or home button) anywhere on your phone, then circle or tap what you want to know."
      : (navigator.mediaDevices?.getDisplayMedia ? "Pick a screen or window, then circle or tap anything on it." : "Install the Android app to circle anything on your phone.");
    try { window.truxWake?.sync(); } catch {}
    if (!inApp) return;
    let status = {};
    try { status = JSON.parse(call("permissionStatus") || "{}"); } catch {}
    const role = getEl("truxAssistantRoleStatus");
    if (role) role.textContent = status.assistant ? "TruX is your digital assistant. Hold the side button to use it." : "Not set. Tap Open settings → Digital assistant app → TruX.";
    const list = getEl("truxPermissionList");
    if (list) {
      list.innerHTML = Object.entries(PERMISSIONS).map(([key, label]) =>
        '<span class="perm-chip ' + (status[key] ? "on" : "off") + '">' + (status[key] ? "✓ " : "") + escapeHtml(label) + "</span>").join("");
    }
  }

  async function redeemAuth(state, verifier) {
    try {
      await initFirebase();
      const res = await fetch("/api/native-auth/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state, verifier }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.googleIdToken) throw new Error(data.error || "Sign-in expired. Please try again.");
      await auth.signInWithCredential(firebase.auth.GoogleAuthProvider.credential(data.googleIdToken));
      try { closeLoginWall?.(); } catch {}
    } catch (error) {
      try { setLoginAuthMessage(friendlyAuthError?.(error) || error.message, "err"); } catch {}
      toast(error.message || "Google sign-in failed.", "err");
    }
  }

  function handle(payload) {
    if (!payload?.type) return;
    switch (payload.type) {
      case "auth": if (payload.state && payload.verifier) redeemAuth(payload.state, payload.verifier); break;
      case "live": try { startTruxLiveAssistant(); } catch {} break;
      case "circle":
        if (!auth?.currentUser) { openLoginWall("signin"); queue.push(payload); return; }
        if (payload.image) window.truxCircle.attachAndSend(payload.image, payload.text || "What is this? Search it and tell me what matters.");
        break;
      case "share": {
        if (payload.image) { window.truxCircle.attachAndSend(payload.image, payload.text || "What's this?"); break; }
        const input = getEl("promptInput");
        if (input && payload.text) {
          input.value = payload.text; try { handleInputChange(); } catch {}
          if (payload.send && auth?.currentUser) setTimeout(() => { try { sendPrompt(); } catch {} }, 30); else input.focus();
        }
        break;
      }
      case "settings": try { openSettingsModal?.("assistant"); } catch {} break;
      default: break;
    }
  }

  function drain() {
    if (!ready) return;
    for (;;) {
      const raw = call("consumePending");
      if (!raw) break;
      try { handle(JSON.parse(raw)); } catch {}
    }
    const waiting = queue.splice(0);
    waiting.forEach(handle);
  }

  function boot() {
    if (!app()) { refreshAssistantSettings(); return; }
    document.documentElement.classList.add("trux-android-app");
    // Google blocks sign-in inside WebViews, so the app signs in via a Custom Tab.
    window.handleGoogleLogin = async () => { try { await initFirebase(); } catch {} call("googleSignIn"); };
    refreshAssistantSettings();
    // Wait for Firebase to know who's signed in before running queued intents.
    const go = () => { ready = true; drain(); };
    if (typeof truxAuthStateReady !== "undefined" && truxAuthStateReady) go();
    else { window.addEventListener("trux-auth", go, { once: true }); setTimeout(go, 6000); }
  }

  window.addEventListener("focus", refreshAssistantSettings);
  window.addEventListener("trux-native-state", refreshAssistantSettings);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { refreshAssistantSettings(); drain(); } });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();

  return {
    isApp: () => !!app(),
    onPending: drain, // called by the app when a new intent arrives
    onAuth: (state, verifier) => redeemAuth(state, verifier),
    refreshAssistantSettings,
    openAssistantSettings: () => (app() ? call("openAssistantSettings") : toast("Install the TruX Android app first.", "err")),
    requestAllPermissions: () => (app() ? call("requestAllPermissions") : toast("Install the TruX Android app first.", "err"))
  };
})();
