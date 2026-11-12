/* ============================================================
   Phone bottom sheets + stable viewport.
   - Plus menu, conversation (3-dots) menu and model menu open as bottom sheets
     on phones. CSS does the layout; this file owns the dimming scrim.
   - --app-h follows the visual viewport so the typing bar never ends up under
     the browser bar / keyboard, and the document itself can never scroll.
   ============================================================ */
(function () {
  const phone = window.matchMedia("(max-width: 720px)");

  /* ---------- stable viewport height ---------- */
  function syncViewport() {
    const vv = window.visualViewport;
    const h = Math.round(vv ? vv.height : window.innerHeight);
    document.documentElement.style.setProperty("--app-h", h + "px");
    if (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop) window.scrollTo(0, 0);
  }
  syncViewport();
  window.addEventListener("resize", syncViewport, { passive: true });
  window.addEventListener("orientationchange", syncViewport, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncViewport, { passive: true });
    window.visualViewport.addEventListener("scroll", syncViewport, { passive: true });
  }

  /* ---------- sheets ---------- */
  const scrim = document.createElement("div");
  scrim.id = "sheetScrim";
  scrim.setAttribute("aria-hidden", "true");
  document.body.appendChild(scrim);

  /* a fixed menu inside the (transformed) composer would be sized against the bar, not the screen */
  const dd = document.getElementById("modelDropdown");
  if (dd && dd.parentElement !== document.body) document.body.appendChild(dd);

  const menus = () => [
    { el: document.getElementById("attachmentMenu"), open: el => el.classList.contains("open") },
    { el: document.getElementById("contextMenu"), open: el => el.style.display === "block" },
    { el: document.getElementById("modelDropdown"), open: el => el.classList.contains("open") },
  ].filter(m => m.el);

  function sync() {
    const anyOpen = phone.matches && menus().some(m => m.open(m.el));
    scrim.classList.toggle("on", anyOpen);
    document.body.classList.toggle("sheet-open", anyOpen);
  }

  function closeAll() {
    try { if (typeof closeAttachmentMenu === "function") closeAttachmentMenu(); } catch {}
    try { if (typeof closeChatContextMenu === "function") closeChatContextMenu(); } catch {}
    try { if (typeof closeModelDropdown === "function") closeModelDropdown(); } catch {}
    sync();
  }

  scrim.addEventListener("click", closeAll);
  scrim.addEventListener("touchmove", e => e.preventDefault(), { passive: false });

  const observer = new MutationObserver(sync);
  menus().forEach(m => observer.observe(m.el, { attributes: true, attributeFilter: ["class", "style"] }));
  (phone.addEventListener ? phone.addEventListener.bind(phone, "change") : phone.addListener.bind(phone))(sync);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && scrim.classList.contains("on")) closeAll(); });
})();
