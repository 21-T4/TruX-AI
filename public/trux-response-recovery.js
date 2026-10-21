/* Durable TruX-Code response recovery. The provider owns generation; this file only bridges stream events to the existing browser chat cache. */
(() => {
  "use strict";
  if (window.__truxResponseRecoveryInstalled) return;
  window.__truxResponseRecoveryInstalled = true;

  const PREFIX = "trux_chat_sessions_local_v1:";
  const polling = new Set();
  const activeRequests = new Map();
  const rawSet = Storage.prototype.setItem;
  const rawGet = Storage.prototype.getItem;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const cacheKey = uid => PREFIX + encodeURIComponent(String(uid || ""));

  function readCache(key) {
    try { return JSON.parse(rawGet.call(localStorage, key) || "{}") || {}; }
    catch { return {}; }
  }
  function writeCache(key, data) {
    try { rawSet.call(localStorage, key, JSON.stringify(data)); return true; }
    catch (error) { console.warn("[trux-response-recovery] browser cache write failed", error?.message || error); return false; }
  }
  function isJobId(value) { return /^[A-Za-z0-9_-]{12,128}$/.test(String(value || "")); }
  function messageText(message) { return String(message?.text || ""); }

  // Preserve completed provider answers if the legacy app later saves its older in-memory snapshot.
  function mergeRecovered(existing, next) {
    if (!existing || !next || typeof existing !== "object" || typeof next !== "object") return next;
    for (const [chatId, oldSession] of Object.entries(existing)) {
      const session = next[chatId];
      if (!oldSession?.messages || !session || !Array.isArray(session.messages)) continue;
      const oldMessages = oldSession.messages, messages = session.messages;
      for (let oi = 0; oi < oldMessages.length; oi++) {
        const oldUser = oldMessages[oi];
        if (oldUser?.role !== "user") continue;
        const oldAssistant = oldMessages[oi + 1];
        const pendingId = oldUser.responseJobId;
        const completed = oldAssistant?.role === "trux" &&
          oldAssistant.recoveredByClient === true &&
          oldAssistant.incomplete !== true &&
          isJobId(oldAssistant.responseJobId);
        if (!pendingId && !completed) continue;
        const prompt = completed ? String(oldAssistant.recoveryPrompt || messageText(oldUser)) : messageText(oldUser);
        let ni = -1;
        const matches = (m) => m?.role === "user" && messageText(m) === prompt &&
          (pendingId ? (!m.responseJobId || m.responseJobId === pendingId) : true);
        if (matches(messages[oi])) ni = oi;
        if (ni < 0) {
          let nearestDistance = Infinity;
          for (let index = 0; index < messages.length; index++) {
            if (!matches(messages[index])) continue;
            const distance = Math.abs(index - oi);
            if (distance < nearestDistance) { nearestDistance = distance; ni = index; }
          }
        }
        if (ni < 0) continue;
        if (pendingId && !messages[ni].responseJobId) messages[ni].responseJobId = pendingId;
        const jobId = pendingId || oldAssistant.responseJobId;
        const oldReply = oldMessages.slice(oi + 1).find(m => m?.role === "trux" && m.responseJobId === jobId);
        if (!oldReply) continue;
        const current = messages[ni + 1];
        if (oldReply.incomplete !== true) {
          if (current?.role === "trux") messages[ni + 1] = { ...oldReply };
          else messages.splice(ni + 1, 0, { ...oldReply });
          delete messages[ni].responseJobId;
        } else if (current?.role === "trux") {
          current.responseJobId = jobId;
          if (String(oldReply.text || "").length > String(current.text || "").length) current.text = oldReply.text;
          if (Array.isArray(oldReply.toolEvents) && oldReply.toolEvents.length > (current.toolEvents || []).length) current.toolEvents = oldReply.toolEvents;
        } else messages.splice(ni + 1, 0, { ...oldReply });
      }
    }
    return next;
  }

  try {
    Storage.prototype.setItem = function(key, value) {
      const k = String(key);
      if (k.startsWith(PREFIX)) {
        try {
          const incoming = JSON.parse(String(value));
          const previous = JSON.parse(rawGet.call(this, k) || "{}");
          const merged = mergeRecovered(previous, incoming);
          return rawSet.call(this, k, JSON.stringify(merged));
        } catch {}
      }
      return rawSet.call(this, key, value);
    };
  } catch (error) {
    console.warn("[trux-response-recovery] could not install cache merge", error?.message || error);
  }

  function findJob(jobId) {
    for (let n = 0; n < localStorage.length; n++) {
      const key = localStorage.key(n);
      if (!key?.startsWith(PREFIX)) continue;
      const sessions = readCache(key);
      for (const [chatId, session] of Object.entries(sessions)) {
        if (session?.incognito || !Array.isArray(session?.messages)) continue;
        const index = session.messages.findIndex(m => m?.role === "user" && m.responseJobId === jobId);
        if (index >= 0) return { key, sessions, chatId, session, userIndex: index, prompt: messageText(session.messages[index]) };
      }
    }
    return null;
  }

  function findVisiblePromptUser(uid, prompt) {
    const key = cacheKey(uid), sessions = readCache(key);
    const rows = Array.from(document.querySelectorAll(".row.user-row")).reverse();
    for (const row of rows) {
      if (!row.dataset.chatId || !Number.isInteger(Number(row.dataset.messageIndex))) continue;
      if (row.getClientRects().length === 0) continue;
      const shown = String(row.querySelector(".user-bubble")?.textContent || "").trim();
      if (shown !== String(prompt || "").trim() && !shown.startsWith(String(prompt || "").trim())) continue;
      const chatId = String(row.dataset.chatId), userIndex = Number(row.dataset.messageIndex);
      const session = sessions[chatId], message = session?.messages?.[userIndex];
      if (session?.incognito || session?.mode !== "coding" || message?.role !== "user" || messageText(message) !== String(prompt || "")) continue;
      return {
        key, sessions, chatId, session, userIndex, prompt: messageText(message),
        ...(isJobId(message.responseJobId) ? { jobId: message.responseJobId } : {})
      };
    }
    return null;
  }


  function bindJobToPrompt(uid, prompt, requestedId = "") {
    const key = cacheKey(uid), sessions = readCache(key);
    let best = null;
    const entries = Object.entries(sessions).sort((a, b) => {
      const ta = Number(String(a[0]).replace(/^chat_/, "")) || 0;
      const tb = Number(String(b[0]).replace(/^chat_/, "")) || 0;
      return tb - ta;
    });
    for (const [chatId, session] of entries) {
      if (session?.incognito || session?.mode !== "coding" || !Array.isArray(session?.messages)) continue;
      for (let i = session.messages.length - 1; i >= 0; i--) {
        const m = session.messages[i];
        if (m?.role !== "user" || m.responseJobId || m.responseRecoveryComplete) continue;
        if (messageText(m) !== String(prompt || "")) continue;
        const next = session.messages[i + 1];
        if (next?.role === "trux" && next.incomplete !== true) continue;
        best = { key, sessions, chatId, session, userIndex: i, prompt: messageText(m) };
        break;
      }
      if (best) break;
    }
    if (!best) return null;
    const id = isJobId(requestedId) ? requestedId : "truxjob_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
    best.session.messages[best.userIndex].responseJobId = id;
    writeCache(best.key, best.sessions);
    const row = locateUserRow(best.chatId, best.userIndex);
    const replyRow = row?.nextElementSibling;
    if (replyRow?.classList.contains("trux-row")) replyRow.dataset.responseJobId = id;
    return { ...best, jobId: id };
  }

  function locateUserRow(chatId, index) {
    return Array.from(document.querySelectorAll(".row.user-row")).find(row =>
      row.dataset.chatId === String(chatId) && Number(row.dataset.messageIndex) === Number(index)
    ) || null;
  }

  function storeSnapshot(jobId, text, complete, toolEvents = [], errorText = "") {
    const location = findJob(jobId);
    if (!location) return;
    const { key, sessions, chatId, session, userIndex, prompt } = location;
    const userMessage = session.messages[userIndex];
    let index = session.messages.findIndex((m, i) => i > userIndex && m?.role === "trux" && m.responseJobId === jobId);
    if (index < 0) {
      const newMessage = { role: "trux", text: String(text || ""), incomplete: !complete, responseJobId: jobId, recoveredByClient: true, recoveryPrompt: prompt };
      if (toolEvents.length) newMessage.toolEvents = toolEvents.slice(-180);
      if (errorText) newMessage.recoveryError = errorText;
      session.messages.splice(userIndex + 1, 0, newMessage);
      index = userIndex + 1;
    } else {
      const item = session.messages[index];
      item.text = String(text || item.text || "");
      item.incomplete = !complete;
      item.recoveredByClient = true;
      item.recoveryPrompt = prompt;
      if (toolEvents.length) item.toolEvents = toolEvents.slice(-180);
      if (errorText) item.recoveryError = errorText;
      else delete item.recoveryError;
    }
    if (complete) {
      delete userMessage.responseJobId;
      userMessage.responseRecoveryComplete = true;
    }
    writeCache(key, sessions);
    if (complete) paintRecoveredReply(chatId, userIndex, jobId, String(text || ""));
  }

  function paintRecoveredReply(chatId, userIndex, jobId, text) {
    const userRow = locateUserRow(chatId, userIndex);
    if (!userRow) return;
    let row = Array.from(document.querySelectorAll(".row.trux-row")).find(item => item.dataset.responseJobId === jobId);
    if (!row) {
      const candidate = userRow.nextElementSibling;
      if (candidate?.classList.contains("trux-row") && !candidate.querySelector(".user-bubble")) row = candidate;
    }
    if (!row) {
      row = document.createElement("div");
      row.className = "row trux-row";
      row.innerHTML = '<div class="bubble trux-bubble"></div><div class="actions"></div>';
      userRow.after(row);
    }
    row.dataset.responseJobId = jobId;
    const bubble = row.querySelector(".bubble:not(.user-bubble)");
    if (bubble) {
      bubble.classList.remove("thinking");
      bubble.textContent = text;
    }
    const panel = row.querySelector(".trux-thinking-panel");
    if (panel) {
      panel.classList.add("completed");
      panel.removeAttribute("data-thinking-visible");
      panel.querySelectorAll(".thinking-status-line").forEach(line => { line.textContent = "Response recovered"; });
    }
    const actions = row.querySelector(".actions");
    if (actions && !actions.children.length) {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "act";
      copy.textContent = "Copy";
      copy.onclick = () => navigator.clipboard?.writeText(text);
      actions.appendChild(copy);
    }
  }

  async function recoverJob(jobId, user) {
    if (!isJobId(jobId) || polling.has(jobId)) return;
    polling.add(jobId);
    let wait = 2500, missingSince = 0;
    const deadline = Date.now() + 6 * 60 * 60 * 1000;
    const toolEvents = [];
    try {
      while (Date.now() < deadline) {
        if (!navigator.onLine) { await sleep(3000); continue; }
        try {
          const token = await user.getIdToken();
          const response = await window.__truxRecoveryNativeFetch(
            "/api/chat?responseJobId=" + encodeURIComponent(jobId),
            { method: "GET", cache: "no-store", headers: { "Authorization": "Bearer " + token, "Accept": "application/json" } }
          );
          if (response.status === 404) {
            if (!missingSince) missingSince = Date.now();
            if (Date.now() - missingSince > 90000) return;
            await sleep(wait); wait = Math.min(12000, Math.round(wait * 1.3)); continue;
          }
          missingSince = 0;
          if (response.status === 202 || response.status === 429 || response.status >= 500) {
            await sleep(wait); wait = Math.min(12000, Math.round(wait * 1.3)); continue;
          }
          if (response.status === 401 || response.status === 403) return;
          if (!response.ok) { await sleep(wait); wait = Math.min(12000, Math.round(wait * 1.3)); continue; }
          const data = await response.json();
          if (data.status === "completed" && String(data.text || "").trim()) {
            storeSnapshot(jobId, String(data.text), true, toolEvents);
            return;
          }
          if (["failed", "cancelled", "incomplete"].includes(String(data.status || ""))) {
            const current = findJob(jobId);
            if (current) {
              const old = current.session.messages[current.userIndex + 1];
              storeSnapshot(jobId, old?.text || "", false, toolEvents, String(data.error || "Response recovery ended before completion."));
              const refreshed = findJob(jobId);
              if (refreshed) {
                delete refreshed.session.messages[refreshed.userIndex].responseJobId;
                writeCache(refreshed.key, refreshed.sessions);
              }
            }
            return;
          }
        } catch {}
        await sleep(wait);
        wait = Math.min(12000, Math.round(wait * 1.3));
      }
    } finally {
      polling.delete(jobId);
    }
  }

  function startPendingRecovery(user) {
    if (!user) return;
    setTimeout(() => {
      const sessions = readCache(cacheKey(user.uid));
      const ids = [];
      for (const session of Object.values(sessions)) {
        if (session?.incognito || !Array.isArray(session?.messages)) continue;
        for (const message of session.messages) {
          if (message?.role === "user" && isJobId(message.responseJobId)) ids.push(message.responseJobId);
        }
      }
      for (const id of new Set(ids)) void recoverJob(id, user);
    }, 500);
  }

  function parseFrame(frame, job) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    let packet;
    try { packet = JSON.parse(data); } catch { return; }
    if (packet.type === "response_job" && isJobId(packet.responseJobId)) {
      if (packet.responseJobId !== job.id) job.id = packet.responseJobId;
      if (!job.location) job.location = findJob(job.id) || bindJobToPrompt(job.uid, job.prompt, job.id);
    } else if (packet.type === "chunk") {
      job.full += String(packet.text || "");
      if (Date.now() - job.lastSaveAt > 500) {
        job.lastSaveAt = Date.now();
        storeSnapshot(job.id, job.full, false, job.toolEvents);
      }
    } else if (packet.type === "ai_step" || packet.type === "status" || packet.type === "tool_status") {
      job.toolEvents.push({
        type: packet.type,
        status: String(packet.status || "").slice(0, 240),
        tool: String(packet.tool || "").slice(0, 120),
        phase: String(packet.phase || "complete").slice(0, 24)
      });
      storeSnapshot(job.id, job.full, false, job.toolEvents);
    } else if (packet.type === "final") {
      job.finalText = String(packet.text || "").trim();
      if (job.finalText) storeSnapshot(job.id, job.finalText, true, job.toolEvents);
    } else if (packet.type === "done" && !job.finalText) {
      void recoverJob(job.id, job.user);
    } else if (packet.type === "error") {
      void recoverJob(job.id, job.user);
    }
  }

  window.__truxRecoveryNativeFetch = window.fetch.bind(window);
  const nativeFetch = window.__truxRecoveryNativeFetch;
  window.fetch = async function(input, init) {
    let options = init;
    let job = null;
    try {
      const url = typeof input === "string" ? input : input?.url || "";
      const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (url.includes("/api/chat") && method === "POST" && typeof init?.body === "string") {
        const body = JSON.parse(init.body);
        if (body?.mode === "coding" && !body.incognito) {
          const user = window.firebase?.auth?.()?.currentUser;
          if (user) {
            const prompt = String(body.message || "");
            const pendingAuthRetry = Array.from(activeRequests.values()).find(item =>
              item.uid === String(user.uid) && item.prompt === prompt && item.authFailures === 1
            );
            const location = (isJobId(body.responseJobId) ? findJob(body.responseJobId) : null)
              || findVisiblePromptUser(user.uid, prompt)
              || (pendingAuthRetry ? findJob(pendingAuthRetry.id) || pendingAuthRetry.location : null)
              || bindJobToPrompt(user.uid, prompt, body.responseJobId || "");
            const id = isJobId(body.responseJobId) ? body.responseJobId
              : location?.jobId || ("truxjob_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10));
            body.responseJobId = id;
            if (location && location.session.messages[location.userIndex]?.responseJobId !== id) {
              location.session.messages[location.userIndex].responseJobId = id;
              writeCache(location.key, location.sessions);
            }
            const stateKey = String(user.uid) + "|" + (location?.chatId || "") + "|" + prompt;
            const previousJob = activeRequests.get(stateKey);
            job = previousJob?.id === id ? previousJob : {
              id, uid: user.uid, prompt, user, location, stateKey,
              full: "", finalText: "", lastSaveAt: 0, authFailures: 0, toolEvents: []
            };
            if (!job.location && location) job.location = location;
            activeRequests.set(stateKey, job);
            options = { ...init, body: JSON.stringify(body) };
          }
        }
      }
    } catch {}
    const response = await nativeFetch(input, options);
    if (!job) return response;
    if (!response.ok || !response.body || !String(response.headers.get("content-type") || "").includes("text/event-stream")) {
      if (response.status !== 401 || job.authFailures > 0) {
        const location = findJob(job.id);
        if (location) {
          delete location.session.messages[location.userIndex].responseJobId;
          writeCache(location.key, location.sessions);
        }
        activeRequests.delete(job.stateKey);
      } else job.authFailures += 1;
      return response;
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = "";
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const part = await reader.read();
          if (part.done) {
            pending += decoder.decode();
            if (pending.trim()) parseFrame(pending, job);
            if (!job.finalText) void recoverJob(job.id, job.user);
            controller.close();
            activeRequests.delete(job.stateKey);
            return;
          }
          pending += decoder.decode(part.value, { stream: true });
          const frames = pending.split(/\r?\n\r?\n/);
          pending = frames.pop() || "";
          for (const frame of frames) parseFrame(frame, job);
          controller.enqueue(part.value);
        } catch (error) {
          void recoverJob(job.id, job.user);
          controller.error(error);
        }
      },
      cancel(reason) {
        // The browser may stop reading on navigation/final UI render; provider generation is a background interaction.
        void reader.cancel(reason).catch(() => {});
        if (!job.finalText) void recoverJob(job.id, job.user);
        activeRequests.delete(job.stateKey);
      }
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  };

  try {
    const auth = window.firebase?.auth?.();
    if (auth?.onAuthStateChanged) auth.onAuthStateChanged(user => startPendingRecovery(user));
  } catch {}
  window.addEventListener("online", () => {
    try { startPendingRecovery(window.firebase?.auth?.()?.currentUser); } catch {}
  });
})();