/* "Hey TruX" wake word.
 * Android app: a native foreground service listens even when TruX is closed.
 * Browser: the page listens with on-device speech recognition while TruX is
 * open and visible (browsers don't allow background listening). Saying
 * "TruX" / "Hey TruX" opens Live. Listening pauses during Live/dictation. */
window.truxWake = (() => {
  "use strict";
  const KEY = "trux_wake_word";
  const WAKE = /\b(hey\s+)?(tru\s?x|true\s?x|trucks|truck's|trux|tracks|truex|tru ex)\b/i;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let enabled = store.getItem(KEY) === "on";
  let recog = null, running = false, restartTimer = null, backoff = 400;
  const pauses = new Set();
  const native = () => window.TruXAndroid?.setWakeWord ? window.TruXAndroid : null;

  function status(text) { const el = getEl("truxWakeStatus"); if (el) el.textContent = text; }
  function describe() {
    if (native()) return enabled ? "On. Say \"Hey TruX\" anytime, even with TruX closed." : "Say \"Hey TruX\" to start a Live conversation.";
    if (!SR) return "This browser has no speech recognition. Use Chrome, Edge or the Android app.";
    if (!enabled) return "Say \"Hey TruX\" while TruX is open to start Live. The Android app listens in the background.";
    return pauses.size ? "Paused while TruX is listening." : (running ? "Listening for \"Hey TruX\"…" : "Starting…");
  }
  function sync() {
    const t = getEl("truxWakeToggle"); if (t) t.checked = enabled;
    status(describe());
  }

  function shouldRun() { return enabled && !native() && SR && !pauses.size && document.visibilityState === "visible" && !!auth?.currentUser; }

  function startLoop() {
    clearTimeout(restartTimer);
    if (!shouldRun() || running) { sync(); return; }
    recog = new SR();
    recog.continuous = true; recog.interimResults = true;
    recog.lang = navigator.language || "en-US";
    recog.onstart = () => { running = true; backoff = 400; sync(); };
    recog.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (WAKE.test(e.results[i][0].transcript)) { wake(); return; }
      }
    };
    recog.onerror = e => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") { enabled = false; store.setItem(KEY, "off"); toast("Allow microphone access to use \"Hey TruX\".", "err"); }
      backoff = Math.min(backoff * 2, 8000);
    };
    recog.onend = () => { running = false; recog = null; if (shouldRun()) restartTimer = setTimeout(startLoop, backoff); else sync(); };
    try { recog.start(); } catch { running = false; recog = null; restartTimer = setTimeout(startLoop, 1500); }
  }

  function stopLoop() {
    clearTimeout(restartTimer);
    try { recog?.abort(); } catch {}
    recog = null; running = false;
    sync();
  }

  function wake() {
    stopLoop();
    if (navigator.vibrate) navigator.vibrate([10, 40, 10]);
    try { startTruxLiveAssistant(); } catch {}
  }

  function setEnabled(on) {
    enabled = !!on;
    store.setItem(KEY, enabled ? "on" : "off");
    const n = native();
    if (n) { try { n.setWakeWord(enabled); } catch {} sync(); return; }
    if (enabled && !SR) { toast("Speech recognition isn't available in this browser.", "err"); enabled = false; store.setItem(KEY, "off"); sync(); return; }
    enabled ? startLoop() : stopLoop();
  }

  function pause(reason) { pauses.add(reason); stopLoop(); }
  function resume(reason) { pauses.delete(reason); if (shouldRun()) restartTimer = setTimeout(startLoop, 600); else sync(); }

  window.addEventListener("trux-live-state", e => e.detail?.active ? pause("live") : resume("live"));
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" ? resume("hidden") : pause("hidden"));
  // Composer dictation uses the mic too.
  document.addEventListener("click", e => { if (e.target.closest?.("#voiceBtn")) { pause("dictation"); setTimeout(() => resume("dictation"), 9000); } }, true);

  function boot() {
    const n = native();
    if (n) {
      // The app owns the setting; its state arrives a moment after load.
      window.addEventListener("trux-native-state", () => { try { enabled = !!n.wakeWordEnabled(); store.setItem(KEY, enabled ? "on" : "off"); } catch {} sync(); });
    }
    sync();
    window.addEventListener("trux-auth", () => (shouldRun() ? startLoop() : stopLoop()));
    startLoop();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(boot, 800), { once: true });
  else setTimeout(boot, 800);

  return { setEnabled, pause, resume, sync, enabled: () => enabled };
})();
