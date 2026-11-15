/* Sign-in entry point, backend check and the code sandbox. The Settings screen itself is settings-ui.js. */

async function checkApiLatency() {
  let t = performance.now();
  try { await fetch("/healthz", { cache: "no-store" }); toast(`Backend reachable - ${Math.round(performance.now() - t)} ms`, "ok"); } catch { toast("Backend check failed.", "err"); }
}

/* The profile button: open Settings when signed in, otherwise the sign-in wall. */
async function handleAuthAction() {
  if (!truxAuthStateReady) {
    const restoredUser = await waitForTruxAuthState();
    if (restoredUser === undefined && !truxAuthStateReady) {
      toast("Your sign-in session is still loading. Please try again.", "err");
      return;
    }
  }
  if (!auth?.currentUser) return openLoginWall();
  openSettings();
}

function confirmSignOut() { truxSignOut().then(() => { closeSettings(); openLoginWall("signin"); }); }

function openCodeSandbox(codeId, extension) {
  const source = getEl(codeId);
  const frame = getEl("sandboxFrame");
  const codeText = source?.value || "";
  if (!source || !frame) return;

  // Preview runs in an opaque-origin iframe: scripts can run, but they
  // cannot read the parent app's DOM, Firebase session, or local storage.
  frame.setAttribute("sandbox", "allow-scripts");
  const ext = String(extension || source.dataset.extension || "html").toLowerCase();
  if (ext === "js") {
    // A bare JS code block is not an HTML document. Wrap it so the Run
    // button truly executes it and surfaces console output/runtime errors.
    const safeScript = codeText.replace(/<\/script/gi, "<\\/script");
    frame.srcdoc = [
      '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
      '<style>html,body{margin:0;min-height:100%;}body{box-sizing:border-box;padding:12px;font:13px/1.45 system-ui,sans-serif;color:#202124;background:#fff}#trux-preview-console{margin-top:12px;padding:8px;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:8px;background:#f1f2f4;color:#41444b;font:12px/1.5 ui-monospace,monospace}#trux-preview-console:empty{display:none}</style></head><body>',
      '<pre id="trux-preview-console" aria-live="polite"></pre>',
      '<script>(function(){var out=document.getElementById("trux-preview-console");var fmt=function(v){try{return typeof v==="string"?v:JSON.stringify(v)}catch(e){return String(v)}};["log","info","warn","error"].forEach(function(key){var native=console[key].bind(console);console[key]=function(){native.apply(console,arguments);var line=Array.from(arguments).map(fmt).join(" ");out.textContent+=(out.textContent?"\\n":"")+line;};});window.addEventListener("error",function(e){out.textContent+=(out.textContent?"\\n":"")+"Error: "+String(e.message||"Script failed");});})();', 
      String.fromCharCode(10),
      safeScript,
      String.fromCharCode(10),
      '</' + 'script></body></html>'
    ].join("");
  } else {
    // Full HTML previews execute inside the same restricted iframe.
    frame.srcdoc = codeText;
  }
  showOverlay(getEl("sandboxModal"));
}
function closeSandboxModal() { hideOverlay(getEl("sandboxModal")); }
