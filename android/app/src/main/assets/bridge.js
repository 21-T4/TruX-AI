/* Injected by the TruX Android app at document start, ONLY into frames whose
   origin is the TruX site (WebViewCompat origin rules). Sandboxed previews and
   other origins never see window.TruXAndroid. */
(function () {
  if (window.TruXAndroid) return;
  var seq = 0, waits = new Map(), queue = [];
  var N = function () { return window.TruXNative; };
  function post(obj) { var n = N(); if (n) n.postMessage(JSON.stringify(obj)); }
  function onMessage(e) {
    var m; try { m = JSON.parse(e.data); } catch (x) { return; }
    if (m.reply != null) { var w = waits.get(m.reply); if (w) { waits.delete(m.reply); w(m.value); } return; }
    if (m.state) { window.__truxNativeState = m.state; window.dispatchEvent(new CustomEvent("trux-native-state")); }
    if (m.pending) { queue.push(m.pending); if (window.truxNative && window.truxNative.onPending) window.truxNative.onPending(); }
    if (m.frame && window.truxNativeScreenFrame) window.truxNativeScreenFrame(m.frame);
    if (m.screenStopped && window.truxNativeScreenStopped) window.truxNativeScreenStopped();
    if (m.auth && window.truxNative && window.truxNative.onAuth) window.truxNative.onAuth(m.auth.state, m.auth.verifier);
  }
  function hook() { var n = N(); if (n && !n.__hooked) { n.onmessage = onMessage; n.__hooked = true; post({ m: "ready" }); } }
  function send(m) { var args = Array.prototype.slice.call(arguments, 1); hook(); post({ m: m, args: args }); }
  function ask(m) {
    var args = Array.prototype.slice.call(arguments, 1); hook();
    return new Promise(function (resolve) { var id = ++seq; waits.set(id, resolve); post({ m: m, args: args, id: id }); setTimeout(function () { if (waits.has(id)) { waits.delete(id); resolve(""); } }, 15000); });
  }
  var state = function () { return window.__truxNativeState || {}; };
  window.TruXAndroid = Object.freeze({
    version: function () { return state().version || "1"; },
    deviceAction: function (json) { return ask("deviceAction", json); },
    permissionStatus: function () { return JSON.stringify(state().status || {}); },
    wakeWordEnabled: function () { return !!state().wake; },
    consumePending: function () { return queue.length ? queue.shift() : ""; },
    requestAllPermissions: function () { send("requestAllPermissions"); },
    openAssistantSettings: function () { send("openAssistantSettings"); },
    setWakeWord: function (on) { send("setWakeWord", !!on); },
    startScreenShare: function () { send("startScreenShare"); },
    stopScreenShare: function () { send("stopScreenShare"); },
    liveActive: function (on) { send("liveActive", !!on); },
    googleSignIn: function () { send("googleSignIn"); },
    startCircle: function () { send("startCircle"); }
  });
  hook();
  document.addEventListener("DOMContentLoaded", hook);
})();
