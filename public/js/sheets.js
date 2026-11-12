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

  /* ---------- swipe a sheet down to dismiss (context + model sheets; the plus menu has its own) ---------- */
  function bindSwipe(el, close) {
    if (!el || el.dataset.swipeBound) return;
    el.dataset.swipeBound = "1";
    let g = null;
    el.addEventListener("touchstart", e => {
      if (!phone.matches || e.touches.length !== 1) return;
      g = { y: e.touches[0].clientY, last: e.touches[0].clientY, t: Date.now(), dy: 0, drag: false, top: el.scrollTop <= 0 };
    }, { passive: true });
    el.addEventListener("touchmove", e => {
      if (!g) return;
      const y = e.touches[0].clientY;
      const dy = y - g.y;
      if (!g.drag) {
        if (dy <= 6 || !g.top || el.scrollTop > 0) { if (dy < 0) g = null; return; }
        g.drag = true;
        el.style.transition = "none";
        el.style.animation = "none";
      }
      g.dy = Math.max(0, dy);
      g.last = y;
      el.style.transform = "translateY(" + g.dy + "px)";
      scrim.style.opacity = String(Math.max(0, 1 - g.dy / (el.offsetHeight || 400)));
      e.preventDefault();
    }, { passive: false });
    const end = () => {
      if (!g) return;
      const { drag, dy, t } = g; g = null;
      if (!drag) return;
      const fast = dy / Math.max(1, Date.now() - t) > 0.6;
      el.style.transition = "transform .28s var(--ease-out)";
      scrim.style.opacity = "";
      if (dy > 90 || fast) {
        el.style.transform = "translateY(100%)";
        setTimeout(() => { close(); el.style.transition = ""; el.style.transform = ""; el.style.animation = ""; sync(); }, 220);
      } else {
        el.style.transform = "translateY(0)";
        setTimeout(() => { el.style.transition = ""; el.style.transform = ""; el.style.animation = ""; }, 300);
      }
    };
    el.addEventListener("touchend", end, { passive: true });
    el.addEventListener("touchcancel", end, { passive: true });
  }
  bindSwipe(document.getElementById("contextMenu"), () => { try { closeChatContextMenu(); } catch {} });
  bindSwipe(document.getElementById("modelDropdown"), () => { try { closeModelDropdown(); } catch {} });

  const observer = new MutationObserver(sync);
  menus().forEach(m => observer.observe(m.el, { attributes: true, attributeFilter: ["class", "style"] }));
  (phone.addEventListener ? phone.addEventListener.bind(phone, "change") : phone.addListener.bind(phone))(sync);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && scrim.classList.contains("on")) closeAll(); });
})();
