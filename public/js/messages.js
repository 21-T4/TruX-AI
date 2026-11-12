/* Message rows: icons, sources, user actions, stream renderer. */
const BOLT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 3 5.5 13.5H11l-1 7.5 8-10.5h-5.5l1-7.5Z"/></svg>';
const SPARK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l1.6 4.4 4.4 1.6-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6L12 3.5Z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/></svg>';

/* Inline icon set - keeps the action bar in the same visual language
   as the rest of the chrome instead of mixed-metric emoji. */
const ICON = (() => {
  const w = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  return {
    speak:  w('<path d="M11 5 6.5 9H4v6h2.5L11 19V5Z"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
    copy:   w('<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5"/>'),
    edit:   w('<path d="m4.5 16.8-.9 3.6 3.6-.9L18.7 8a2.2 2.2 0 0 0-3.1-3.1L4.5 16.8Z"/><path d="m14.5 6.5 3 3"/>'),
    pin:    w('<path d="M7 4.5h10v15l-5-3.8-5 3.8v-15Z"/>'),
    redo:   w('<path d="M20 11a8 8 0 1 0-2.6 5.9"/><path d="M20 4.5V11h-6"/>'),
    down:   w('<path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14"/>'),
    check:  w('<path d="m5 13 4.5 4.5L19 7"/>'),
    trash:  w('<path d="M5 7h14M10 7V5h4v2M7 7l.8 12a1 1 0 0 0 1 1h6.4a1 1 0 0 0 1-1L17 7"/>')
  };
})();

/* Assistant rows are text-only; app icons remain PWA/metadata assets. */
const BRAND_LABEL = 'TruX-Omni';

/* Grounding URIs come back as Vertex redirect links, so the readable domain
   lives in the title. Prefer a real hostname when the URI has one. */
function sourceDomain(src) {
  const cleanDomain = value => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "https://" + raw;
      return new URL(candidate).hostname.replace(/^www\./i, "").toLowerCase();
    } catch (e) {
      return raw.split(/[/?#]/)[0].replace(/^www\./i, "").toLowerCase();
    }
  };
  const explicitDomain = cleanDomain(src?.domain);
  if (explicitDomain && !/vertexaisearch|googleapis|grounding-api-redirect/i.test(explicitDomain)) {
    return explicitDomain;
  }
  const host = cleanDomain(src?.uri);
  if (host && !/vertexaisearch|googleapis|grounding-api-redirect|(^|\.)google\.com$/i.test(host)) {
    return host;
  }
  const title = String(src?.title || "");
  const match = title.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i);
  return match ? match[1].replace(/^www\./i, "").toLowerCase() : "";
}
function buildSourcesStrip(sources) {
  if(!Array.isArray(sources) || !sources.length) return null;
  const wrap = document.createElement("div");
  wrap.className = "sources";
  const seen = new Set();
  sources.slice(0, 12).forEach(function(src) {
    if(!src || !src.uri || seen.has(src.uri)) return;
    seen.add(src.uri);
    const dom = sourceDomain(src);
    const a = document.createElement("a");
    a.className = "source-chip";
    /* Keep the exact grounded URL so a tap opens that source, not a
       reconstructed homepage or a generic search results page. */
    a.href = src.uri;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.setAttribute("aria-label", "Open source website");
    const ico = document.createElement("img");
    ico.src = dom
      ? "https://www.google.com/s2/favicons?sz=64&domain=" + encodeURIComponent(dom)
      : "https://www.google.com/s2/favicons?sz=64&domain_url=" + encodeURIComponent(src.uri);
    ico.alt = "";
    ico.loading = "lazy";
    ico.referrerPolicy = "no-referrer";
    /* Retry with a second favicon provider before using a neutral fallback. */
    ico.onerror = function() {
      if (dom && !ico.dataset.directFallback) {
        ico.dataset.directFallback = "1";
        ico.src = "https://icons.duckduckgo.com/ip3/" + encodeURIComponent(dom) + ".ico";
        return;
      }
      const dot = document.createElement("span");
      dot.className = "sc-dot";
      dot.setAttribute("aria-hidden", "true");
      ico.replaceWith(dot);
    };
    a.appendChild(ico);
    wrap.appendChild(a);
  });
  return wrap.children.length ? wrap : null;
}
/* Sources sit between the answer and its action row. */
function attachSources(row, sources) {
  if(!row) return;
  row.querySelector(".sources")?.remove();
  const strip = buildSourcesStrip(sources);
  if(!strip) return;

  /* .actions is nested inside .trux-response-stack, not a direct child
     of the outer .row. Insert relative to its actual parent; otherwise
     insertBefore throws NotFoundError and aborts response finalization. */
  const actions = row.querySelector(".actions");
  if(actions?.parentNode) actions.parentNode.insertBefore(strip, actions);
  else row.appendChild(strip);
}

function findStoppedMessageIndex(userRow, fallbackText = "") {
  const session = chatSessions[currentChatId];
  if (!session?.messages) return -1;
  const indexed = Number(userRow?.dataset?.messageIndex);
  if (Number.isInteger(indexed) && indexed >= 0 && indexed < session.messages.length) {
    const candidate = session.messages[indexed];
    if (candidate?.role === "user") return indexed;
  }
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m?.role === "user" && String(m.text || "") === String(fallbackText || "")) return i;
  }
  return -1;
}

function attachUserMessageActions(userRow, messageIndex, promptText) {
  if (!userRow) return;
  userRow.classList.remove("user-actions-visible");
  userRow.querySelector(".user-message-actions")?.remove();
  userRow.querySelector(".user-stopped-actions")?.remove();
  const index = Number.isInteger(messageIndex) ? messageIndex : findStoppedMessageIndex(userRow, promptText);
  const actions = document.createElement("div");
  actions.className = "actions user-message-actions user-stopped-actions";

  const getPromptText = () => {
    const message = chatSessions[currentChatId]?.messages?.[index];
    if (message?.role === "user") return String(message.text || "");
    return String(promptText ?? userRow.querySelector(".user-bubble")?.innerText ?? "");
  };

  const copyBtn = document.createElement("button");
  copyBtn.className = "act";
  copyBtn.type = "button";
  copyBtn.title = "Copy your message";
  copyBtn.innerHTML = ICON.copy + "Copy";
  copyBtn.onclick = () => copyTextMessage(getPromptText(), copyBtn);

  const resendBtn = document.createElement("button");
  resendBtn.className = "act";
  resendBtn.type = "button";
  resendBtn.title = "Resend this message";
  resendBtn.innerHTML = ICON.redo + "Resend";
  resendBtn.onclick = () => {
    if (isGenerating) return toast("Stop the current generation first.", "err");
    const session = chatSessions[currentChatId];
    const message = session?.messages?.[index];
    if (!message || message.role !== "user") {
      return toast("This message is no longer available.", "err");
    }

    const text = String(message.text || "");
    const savedAttachments = (Array.isArray(message.attachments) ? message.attachments : [])
      .filter(item => item && item.objectKey);
    if (!text.trim() && !savedAttachments.length) {
      return toast("This message has no text or saved attachments to resend.", "err");
    }

    // Replace this turn and any later turns, then submit the same prompt
    // again so the transcript never contains duplicate user messages.
    
    session.messages.splice(index);
    saveChatSessions();
    let node = userRow;
    while (node) {
      const next = node.nextElementSibling;
      node.remove();
      node = next;
    }

    selectedImageBase64 = null;
    pastedTextBlocks = [];
    fileAttachments = savedAttachments.map(item => ({
      name: String(item.name || "attachment"),
      size: Number(item.size || 0),
      mimeType: String(item.mimeType || "application/octet-stream"),
      objectKey: String(item.objectKey),
      processedKey: item.processedKey || null,
      processing: false
    }));
    const input = getEl("promptInput");
    input.value = text;
    renderFileChips();
    handleInputChange();
    sendPrompt();
  };

  actions.append(copyBtn, resendBtn);
  userRow.appendChild(actions);

  if (userRow.dataset.longPressActionsBound !== "true") {
    userRow.dataset.longPressActionsBound = "true";
    let holdTimer = null;
    let holdStartX = 0;
    let holdStartY = 0;
    const clearHoldTimer = () => {
      if (holdTimer !== null) clearTimeout(holdTimer);
      holdTimer = null;
    };

    userRow.addEventListener("pointerdown", event => {
      const target = event.target;
      if (target instanceof Element && target.closest(".user-message-actions")) return;
      if (event.isPrimary === false || (typeof event.button === "number" && event.button !== 0)) return;
      clearHoldTimer();
      holdStartX = event.clientX;
      holdStartY = event.clientY;
      holdTimer = window.setTimeout(() => {
        holdTimer = null;
        document.querySelectorAll(".user-row.user-actions-visible").forEach(other => {
          if (other !== userRow) other.classList.remove("user-actions-visible");
        });
        userRow.classList.add("user-actions-visible");
        if (event.pointerType === "touch" && typeof navigator.vibrate === "function") {
          navigator.vibrate(12);
        }
      }, 450);
    });
    userRow.addEventListener("pointermove", event => {
      if (holdTimer !== null &&
          (Math.abs(event.clientX - holdStartX) > 12 || Math.abs(event.clientY - holdStartY) > 12)) {
        clearHoldTimer();
      }
    });
    userRow.addEventListener("pointerup", clearHoldTimer);
    userRow.addEventListener("pointercancel", clearHoldTimer);
    userRow.addEventListener("pointerleave", clearHoldTimer);
    userRow.addEventListener("click", event => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".user-bubble")) return;
      if (window.getSelection && String(window.getSelection()).length) return;
      const show = !userRow.classList.contains("user-actions-visible");
      document.querySelectorAll(".user-row.user-actions-visible").forEach(o => o.classList.remove("user-actions-visible"));
      if (show) userRow.classList.add("user-actions-visible");
    });
    userRow.addEventListener("contextmenu", event => {
      const target = event.target;
      if (target instanceof Element && target.closest(".user-bubble")) event.preventDefault();
    });
  }

  if (!window.__truxUserActionDismissBound) {
    window.__truxUserActionDismissBound = true;
    document.addEventListener("pointerdown", event => {
      const target = event.target;
      if (target instanceof Element &&
          (target.closest(".user-message-actions") || target.closest(".user-row.user-actions-visible"))) return;
      document.querySelectorAll(".user-row.user-actions-visible").forEach(row => {
        row.classList.remove("user-actions-visible");
      });
    }, true);
  }
}

function appendMessageRow(label, text, rc, bc, imageUrl, animate, sources, videoUrl, messageMeta = null) {
  let chatContainer = getActiveChatContainer(), r = document.createElement("div");
  r.className = `row ${rc}` + (animate ? " appear" : "");
  let textContent = typeof text === "string" ? text : text?.text || "";

  if(rc.includes("user-row")) {
    // No stray newlines inside the bubble: it is white-space: pre-wrap,
    // so template indentation would render as blank lines.
    r.dataset.chatId = currentChatId || "";
    const userMessageIndex = Number.isInteger(messageMeta?.messageIndex)
      ? Number(messageMeta.messageIndex)
      : findStoppedMessageIndex(r, textContent);
    if (Number.isInteger(userMessageIndex) && userMessageIndex >= 0) r.dataset.messageIndex = String(userMessageIndex);
    r.innerHTML = `<div class="label">You</div><div class="bubble user-bubble">${escapeHtml(textContent).replace(/\n/g, "<br>")}</div>`;
    attachUserMessageActions(r, userMessageIndex, textContent);
  } else {
    r.innerHTML = `<div class="bubble ${bc}"></div><div class="actions"></div>`;
    let bubble = r.querySelector(".bubble");
    let actions = r.querySelector(".actions");

    bubble.innerHTML = renderFormattedText(textContent, false);
    renderTruxDiagrams(bubble);
    scheduleTruxMath(bubble);

    if(imageUrl) {
      let wrap = document.createElement("div"); wrap.className = "gen-image-wrap";
      let img = document.createElement("img"); img.src = imageUrl; img.alt = "Generated image";
      img.onload = () => img.classList.add("loaded");
      if(img.complete) img.classList.add("loaded");
      wrap.appendChild(img); bubble.appendChild(wrap);

      let dlBtn = document.createElement("button"); dlBtn.className = "act"; dlBtn.title = "Download image"; dlBtn.innerHTML = ICON.down + "Download";
      dlBtn.onclick = () => { let l = document.createElement("a"); l.href = imageUrl; l.download = `trux-omni-image-${Date.now()}.png`; l.click(); };
      actions.appendChild(dlBtn);
    }

    if(videoUrl) {
      let wrap = document.createElement("div");
      wrap.className = "gen-video-wrap";
      let video = document.createElement("video");
      video.src = videoUrl; video.controls = true; video.preload = "metadata"; video.playsInline = true;
      wrap.appendChild(video);
      bubble.appendChild(wrap);
      let openBtn = document.createElement("button");
      openBtn.className = "act"; openBtn.title = "Open video"; openBtn.textContent = "Open";
      openBtn.onclick = () => window.open(videoUrl, "_blank", "noopener");
      actions.appendChild(openBtn);
    }

    let readBtn = document.createElement("button"); readBtn.className = "act"; readBtn.title = "Read aloud"; readBtn.innerHTML = ICON.speak + "Read"; readBtn.onclick = () => speakText(textContent, readBtn);
    let copyBtn = document.createElement("button"); copyBtn.className = "act"; copyBtn.title = "Copy answer"; copyBtn.innerHTML = ICON.copy + "Copy"; copyBtn.onclick = () => copyTextMessage(textContent, copyBtn);
    let pinBtn = document.createElement("button"); pinBtn.className = "act"; pinBtn.title = "Pin to insights"; pinBtn.innerHTML = ICON.pin + "Pin"; pinBtn.onclick = () => pinInsight(textContent);
    let regenBtn = document.createElement("button"); regenBtn.className = "act"; regenBtn.title = "Regenerate this answer"; regenBtn.innerHTML = ICON.redo + "Retry"; regenBtn.onclick = () => regenerateLast();

    if (!messageMeta?.incomplete) actions.append(readBtn, copyBtn, pinBtn, regenBtn);
    attachSources(r, sources);
  }

  chatContainer.appendChild(r); chatContainer.scrollTop = chatContainer.scrollHeight;
  return r;
}

/* =====================================================================
   PROGRESSIVE LINE-BATCH STREAM RENDERER

   Reveal complete display lines in small animation-frame batches. Markdown
   blocks that are complete are committed once; only the active block is
   refreshed. Each new line gets a subtle fade, with no synthetic cursor.
   ===================================================================== */

function isNearBottom(el, slack) {
  return (el.scrollHeight - el.scrollTop - el.clientHeight) <= (slack || 120);
}

/* Split into top-level blocks on blank lines, but never inside a fence. */
function splitStreamBlocks(text) {
  let lines = text.split("\n");
  let blocks = [];
  let cur = [];
  let inFence = false;

  for (let line of lines) {
    if (/^\s*```/.test(line)) {
      cur.push(line);
      if (inFence) { blocks.push(cur.join("\n")); cur = []; inFence = false; }
      else inFence = true;
      continue;
    }
    if (!inFence && !line.trim()) {
      if (cur.length) { blocks.push(cur.join("\n")); cur = []; }
      continue;
    }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join("\n"));
  return blocks;
}

function createStreamRenderer(bubble) {
  /* Replace the existing renderer in place. No second layer or duplicate host. */
  bubble.innerHTML = '<div class="md-stream md-stream-fade-active"></div>';
  const host = bubble.firstElementChild;

  let target = "";
  let shown = 0;
  let settled = 0;
  let liveEl = null;
  let liveHtml = "";
  let finished = false;
  let stopped = false;
  let rafId = null;
  let doneCb = null;
  let lastRevealAt = -Infinity;

  const REVEAL_INTERVAL_MS = 44;     /* a new small group of words every ~44ms */
  const FADE_MS = 1300;              /* keep in step with .rv in chat.css */

  /* ---- line-by-line fade-in ----------------------------------------------
     The live block is re-rendered on every tick, so a plain CSS animation would
     restart each time. Instead we remember which text ranges (by character offset
     in the block's text) were revealed and when, and wrap those still fading in
     <span class="rv"> with a negative animation-delay. The animation therefore
     resumes where it was, and finished text stays unwrapped. */
  let marks = [];                    /* { s, e, t } revealed ranges of the live block */
  let markedLen = 0;
  let waitingFade = false;

  function revealTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        return parent && parent.closest("pre, .katex, .code-file, .trux-diagram, script, style")
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function applyReveal(el, now) {
    if (!el || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { marks = []; markedLen = 0; return; }
    const nodes = revealTextNodes(el);
    let total = 0;
    for (const n of nodes) total += n.nodeValue.length;
    if (total < markedLen) { marks = []; markedLen = 0; }          /* block was restructured */
    if (total > markedLen) { marks.push({ s: markedLen, e: total, t: now }); markedLen = total; }
    marks = marks.filter(m => now - m.t < FADE_MS);
    if (!marks.length) return;

    const pieces = [];
    let pos = 0;
    nodes.forEach((node, index) => {
      const a = pos, b = pos + node.nodeValue.length;
      pos = b;
      for (const m of marks) {
        const s = Math.max(m.s, a), e = Math.min(m.e, b);
        if (e > s) pieces.push({ node, index, s: s - a, e: e - a, t: m.t });
      }
    });
    /* Wrap from the end of each node backwards so earlier offsets stay valid. */
    pieces.sort((x, y) => x.index - y.index || y.s - x.s);
    for (const piece of pieces) {
      const range = document.createRange();
      range.setStart(piece.node, piece.s);
      range.setEnd(piece.node, piece.e);
      const span = document.createElement("span");
      span.className = "rv";
      span.style.animationDelay = -Math.round(now - piece.t) + "ms";
      range.surroundContents(span);
    }
  }

  function fadeRemaining(now) {
    let left = 0;
    for (const m of marks) left = Math.max(left, FADE_MS - (now - m.t));
    return left;
  }

  /* Reveal a few words at a time (more when the stream has run ahead), never a half-received word. */
  function nextRevealOffset() {
    const backlog = target.length - shown;
    if (backlog <= 0) return shown;
    const words = Math.min(14, 2 + Math.floor(backlog / 140));
    let cursor = shown;
    let count = 0;
    while (cursor < target.length && count < words) {
      let i = cursor;
      while (i < target.length && /\s/.test(target[i])) i++;
      while (i < target.length && !/\s/.test(target[i])) i++;
      if (i >= target.length && !finished) break;      /* the last word may still be arriving */
      while (i < target.length && /\s/.test(target[i])) i++;
      cursor = i;
      count++;
    }
    if (cursor <= shown && finished) return target.length;
    return cursor;
  }

  function commitBlock(html, isLive) {
    const el = document.createElement("div");
    el.className = "md-block" + (isLive ? " live" : "");
    el.innerHTML = html;
    host.appendChild(el);
    renderTruxDiagrams(el);
    return el;
  }

  function paint() {
    const visible = target.slice(0, shown);
    const blocks = splitStreamBlocks(visible);
    if (!blocks.length) return false;

    /* Commit completed Markdown blocks once; refresh only the active tail. */
    const now = performance.now();
    while (settled < blocks.length - 1) {
      if (liveEl) {
        if (liveEl.parentNode === host) host.removeChild(liveEl);
        liveEl = null;
        liveHtml = "";
      }
      const el = commitBlock(renderFormattedText(blocks[settled], false), false);
      applyReveal(el, now);                 /* carries the fade of the block that just finished */
      marks = []; markedLen = 0;            /* the next block starts fresh */
      setTimeout(() => el.classList.add("settled"), 400);
      settled++;
    }

    const tail = blocks[blocks.length - 1];
    const html = renderFormattedText(tail, !finished);
    if (html === liveHtml) return false;
    liveHtml = html;

    if (!liveEl) liveEl = commitBlock(html, true);
    else {
      const currentPending = liveEl.querySelector('.trux-diagram[data-trux-diagram-pending="true"]');
      if (currentPending) {
        const parsed = document.createElement("div"); parsed.innerHTML = html;
        const nextPending = parsed.querySelector('.trux-diagram[data-trux-diagram-pending="true"]');
        if (nextPending) {
          const oldSource = currentPending.querySelector(".trux-diagram-source");
          const newSource = nextPending.querySelector(".trux-diagram-source");
          if (oldSource && newSource) oldSource.textContent = newSource.textContent;
        } else liveEl.innerHTML = html;
      } else liveEl.innerHTML = html;
    }

    renderTruxDiagrams(liveEl);
    applyReveal(liveEl, now);
    liveEl.classList.toggle("single-line", liveEl.offsetHeight < 46);
    return true;
  }

  function tick(timestamp) {
    rafId = null;
    if (stopped) return;
    if (!bubble.isConnected) {
      stopped = true;
      return;
    }

    /* A real, visible cadence is intentional: don't dump the final payload. */
    if (timestamp - lastRevealAt < REVEAL_INTERVAL_MS) {
      rafId = requestAnimationFrame(tick);
      return;
    }

    const container = getActiveChatContainer();
    const stick = isNearBottom(container);
    const nextShown = nextRevealOffset();
    let advanced = false;

    if (nextShown > shown) {
      shown = nextShown;
      lastRevealAt = timestamp;
      advanced = paint();
      if (stick) container.scrollTop = container.scrollHeight;
    }

    if (finished && shown >= target.length) {
      /* Let the last lines finish fading in before the final clean re-render. */
      const left = fadeRemaining(performance.now());
      if (left > 0) {
        waitingFade = true;
        setTimeout(() => { waitingFade = false; start(); }, left + 30);
        return;
      }
      marks = []; markedLen = 0;
      host.innerHTML = renderFormattedText(target, false);
      renderTruxDiagrams(host);
      scheduleTruxMath(host);
      if (stick) container.scrollTop = container.scrollHeight;
      if (doneCb) {
        const callback = doneCb;
        doneCb = null;
        callback();
      }
      return;
    }

    /* Continue only while a full line is ready, or while draining a finished stream. */
    if (nextRevealOffset() > shown || finished) {
      rafId = requestAnimationFrame(tick);
    }
  }

  function start() {
    if (rafId === null && !stopped && !waitingFade) rafId = requestAnimationFrame(tick);
  }

  return {
    push(chunk) {
      target += chunk;
      start();
    },
    setText(text) {
      target = String(text || "");
      /* Never let an updated authoritative payload expose half a word. */
      shown = Math.min(shown, target.length);
      while (shown > 0 && shown < target.length && !/\s/.test(target.charAt(shown - 1))) {
        shown--;
      }
      start();
    },
    finish(cb) {
      finished = true;
      doneCb = cb || null;
      if (!bubble.isConnected) {
        stopped = true;
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = null;
        return;
      }
      stopped = false;
      start();
    },
    cancel() {
      stopped = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      host.classList.add("md-stream-fade-settling");
    },
    get received() { return target; }
  };
}
