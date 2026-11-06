/* AI activity panel, regenerate/edit, and the home screen. */
function appendToolStatusLine(toolId, tool, detail, phase = "complete", details = null) {
  const wrap = getEl(toolId);
  if (!wrap) return;
  const toolName = String(tool || "External tool").trim();
  const text = String(detail || "");
  const callId = String(details?.id || "");
  const serializedArgs = details?.args && typeof details.args === "object"
    ? JSON.stringify(details.args)
    : "";
  const signature = callId || (toolName + "||" + serializedArgs);

  let item = Array.from(wrap.querySelectorAll(".thinking-tool-item")).find(el => el.dataset.signature === signature);
  if (!item && phase === "start") {
    item = document.createElement("div");
    item.className = "thinking-tool-item active";
    item.dataset.signature = signature;
    wrap.appendChild(item);
  }
  if (!item) {
    item = wrap.querySelector(".thinking-tool-item.active:last-child") || wrap.lastElementChild;
    if (!item) {
      item = document.createElement("div");
      item.className = "thinking-tool-item";
      item.dataset.signature = signature;
      wrap.appendChild(item);
    }
  }

  const target = String(details?.target || toolName).trim() || toolName;
  const failureText = /failed|error|authorization required|configuration error/i.test(text);
  const succeeded = typeof details?.ok === "boolean" ? details.ok : !failureText;
  item.classList.toggle("active", phase === "start");
  item.classList.toggle("completed", phase !== "start" && succeeded);
  item.classList.toggle("failed", phase !== "start" && !succeeded);

  let head = item.querySelector(".thinking-tool-head");
  if (!head) { head = document.createElement("div"); head.className = "thinking-tool-head"; item.appendChild(head); }
  head.textContent = target;

  // Keep the thinking bar compact: never print raw tool arguments or large
  // provider responses here.
  item.querySelector(".thinking-tool-meta")?.remove();
  item.querySelector(".thinking-tool-result")?.remove();
  let status = item.querySelector(".thinking-tool-status");
  if (!status) {
    status = document.createElement("div");
    status.className = "thinking-tool-status";
    item.appendChild(status);
  }
  status.classList.toggle("failed", phase !== "start" && !succeeded);
  status.textContent = phase === "start" ? "(running…)" : (succeeded ? "(success)" : "(failed)");

  const panel = wrap.closest(".trux-thinking-panel");
  panel?.classList.add("has-tools");
  const toggle = panel?.querySelector(".trux-thinking-toggle");
  if (toggle) toggle.hidden = false;

  const container = getActiveChatContainer();
  if (phase === "start" && container && isNearBottom(container, 140)) {
    requestAnimationFrame(() => {
      if (container === getActiveChatContainer()) container.scrollTop = container.scrollHeight;
    });
  }
}

function settleThinkingDetails(toolId) {
  const wrap = getEl(toolId);
  if(!wrap) return;
  wrap.querySelectorAll(".thinking-tool-item.active").forEach(item => item.classList.remove("active"));
  if(!wrap.children.length) {
    wrap.hidden = true;
    wrap.style.display = "none";
  }
}

/* Re-runs the last user turn: drops the trailing assistant message from
   history and its row from the DOM, then re-sends. */
function regenerateLast() {
  if(isGenerating) return toast("Still generating - stop it first.");
  let msgs = chatSessions[currentChatId]?.messages;
  if(!msgs || !msgs.length) return;
  let lastUser = [...msgs].reverse().find(m => m.role === "user");
  if(!lastUser?.text) return toast("Nothing to regenerate.");
  while(msgs.length && msgs[msgs.length - 1].role !== "user") msgs.pop();
  msgs.pop();
  saveChatSessions();
  let rows = getActiveChatContainer().querySelectorAll(".row");
  for(let i = rows.length - 1; i >= 0; i--) {
    let isUser = rows[i].classList.contains("user-row");
    rows[i].remove();
    if(isUser) break;
  }
  getEl("promptInput").value = lastUser.text;
  handleInputChange();
  sendPrompt();
}

function normalizeAiActivity(text) {
  return String(text == null ? "" : text)
    .replace(/[\u0000-\u001F]/g," ")
    .replace(/\s+/g," ")
    .trim()
    .slice(0,300);
}

function compactAiActivity(text) {
  const clean = normalizeAiActivity(text);
  if (!clean) return "";
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length <= 4) return clean;
  return words.slice(0,4).join(" ").replace(/[,:;.!?…]+$/,"") + "…";
}

function appendThinkingHistory(panel, text) {
  const details = panel?.querySelector?.(".trux-thinking-details");
  if (!details || !text) return;
  if (Array.from(details.children).some(item => item.dataset?.activity === text)) return;
  const item = document.createElement("div");
  item.className = "thinking-status-step";
  item.dataset.activity = text;
  item.textContent = text;
  details.appendChild(item);
  const toggle = panel.querySelector(".trux-thinking-toggle");
  if (toggle) toggle.hidden = false;
}

function toggleThinkingDetails(panelId) {
  const panel = getEl(panelId);
  if (!panel) return;
  const details = panel.querySelector(".trux-thinking-details");
  const toggle = panel.querySelector(".trux-thinking-toggle");
  if (!details || !toggle) return;
  const expanded = !panel.classList.contains("expanded");
  panel.classList.toggle("expanded", expanded);
  details.hidden = !expanded;
  toggle.setAttribute("aria-expanded", String(expanded));
  const completed = panel.classList.contains("completed");
  const expandedLabel = completed ? "Hide executed steps" : "Minimize AI activity";
  const collapsedLabel = completed ? "Show executed steps" : "Expand AI activity";
  toggle.setAttribute("aria-label", expanded ? expandedLabel : collapsedLabel);
  toggle.title = expanded ? expandedLabel : collapsedLabel;
  if (expanded) requestAnimationFrame(() => { details.scrollTop = completed ? 0 : details.scrollHeight; });
}

function dismissThinkingPanel(row) {
  const panel = row?.querySelector?.(".trux-thinking-panel");
  if (!panel) return;
  panel.classList.add("thinking-dismissed");
  panel.setAttribute("aria-hidden", "true");
  setTimeout(() => panel.remove(), 140);
}

function getAssistantTurnUserRow(responseRow) {
  if (!responseRow) return null;
  let userRow = responseRow.previousElementSibling;
  if (userRow?.classList.contains("user-row")) return userRow;
  const rows = getActiveChatContainer()?.querySelectorAll(".row.user-row") || [];
  return rows[rows.length - 1] || null;
}

function editPromptFromAssistantRow(responseRow) {
  if (isGenerating) return toast("Stop the current generation first.", "err");
  const session = chatSessions[currentChatId];
  const userRow = getAssistantTurnUserRow(responseRow);
  if (!userRow || !session?.messages) return toast("The original prompt is unavailable.", "err");
  const index = findStoppedMessageIndex(userRow, userRow.querySelector(".user-bubble")?.textContent || "");
  if (index < 0) return toast("The original prompt is unavailable.", "err");
  const promptText = String(session.messages[index]?.text || "");
  session.messages.splice(index, 1);
  if (session.messages[index]?.role === "trux") session.messages.splice(index, 1);
  saveChatSessions();
  responseRow.remove();
  userRow.remove();
  const input = getEl("promptInput");
  input.value = promptText;
  input.focus();
  handleInputChange();
}

function setThinkingStatus(statusId, text) {
  const el = getEl(statusId);
  if (!el) return;
  const next = normalizeAiActivity(text);
  if (!next) return;
  const compact = compactAiActivity(next);
  const compactLine = el.querySelector(".thinking-status-line.compact");
  const fullLine = el.querySelector(".thinking-status-line.full");
  const currentLine = fullLine || compactLine;
  const previous = String(fullLine?.textContent || currentLine?.textContent || "").trim();
  const panel = el.closest(".trux-thinking-panel");
  if (panel?.classList.contains("completed")) return;
  const activityKey = value => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (panel && !(panel._seenThinkingActivities instanceof Set)) {
    panel._seenThinkingActivities = new Set();
  }
  const seenActivities = panel?._seenThinkingActivities;
  const isPlaceholderActivity = value => /^(?:thinking|working|processing)(?:[ .…]*)?$/i.test(String(value || "").trim());
  const previousKey = activityKey(previous);
  const nextKey = activityKey(next);
  if (seenActivities && previousKey) seenActivities.add(previousKey);
  if (previous === next || (seenActivities && nextKey && seenActivities.has(nextKey))) return;
  if (seenActivities && nextKey) seenActivities.add(nextKey);
  if (previous && !isPlaceholderActivity(previous)) appendThinkingHistory(panel, previous);
  if (compactLine) compactLine.textContent = compact;
  if (fullLine) { fullLine.textContent = next; fullLine.title = next; }
  else {
    currentLine.textContent = compact;
    currentLine.title = next;
  }
  if (panel) {
    panel.classList.add("has-activity");
    if (!isPlaceholderActivity(next)) appendThinkingHistory(panel, next);
    const details = panel.querySelector(".trux-thinking-details");
    if (details && panel.classList.contains("expanded")) {
      requestAnimationFrame(() => { details.scrollTop = details.scrollHeight; });
    }
  }
}

    let truxHomeGreetingTimers = [];
let truxHomeContentRequest = null;
let truxHomeGreetingQueue = [];
let truxHomeGreetingIndex = 0;
let truxHomePendingGreetings = [];
let truxHomeLastGreeting = "";
let truxHomeContentRetryCount = 0;
let truxHomeGreetingRunId = 0;

function clearHomeGreetingTimers() {
  truxHomeGreetingTimers.forEach(id => clearTimeout(id));
  truxHomeGreetingTimers = [];
}

function scheduleHomeGreeting(fn, delay) {
  const timer = setTimeout(() => {
    truxHomeGreetingTimers = truxHomeGreetingTimers.filter(id => id !== timer);
    fn();
  }, delay);
  truxHomeGreetingTimers.push(timer);
  return timer;
}

function cleanHomeGreeting(value) {
  const greeting = String(value || "").replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”]+$/g, "");
  const words = greeting ? greeting.split(/\s+/).length : 0;
  return greeting.length >= 16 && greeting.length <= 100 && words >= 4 && words <= 14 ? greeting : "";
}

function renderHomePrompts(prompts) {
  const panel = getEl("truxHomePrompts");
  if (!panel || !Array.isArray(prompts)) return false;
  const cleanPrompts = [...new Set(prompts
    .map(prompt => String(prompt || "").replace(/\s+/g, " ").trim())
    .filter(prompt => {
      const words = prompt ? prompt.split(/\s+/).length : 0;
      return prompt.length >= 8 && prompt.length <= 100 && words >= 3 && words <= 10;
    }))];
  if (cleanPrompts.length !== 3) return false;

  const buttons = cleanPrompts.map(cleanPrompt => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "trux-home-prompt";
    const mark = document.createElement("span");
    mark.className = "trux-home-prompt-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "↗";
    const label = document.createElement("span");
    label.className = "trux-home-prompt-label";
    label.textContent = cleanPrompt;
    button.append(mark, label);
    button.addEventListener("click", () => quickPrompt(cleanPrompt));
    return button;
  });
  panel.replaceChildren(...buttons);
  panel.hidden = false;
  return true;
}

async function loadHomeContent({ prefetch = false } = {}) {
  if (!document.body.classList.contains("home-active")) return false;
  if (truxHomeContentRequest) return truxHomeContentRequest;

  truxHomeContentRequest = (async () => {
    const prefetchedResponse = window.__truxHomeContentPrefetch;
    window.__truxHomeContentPrefetch = null;
    const response = await (prefetchedResponse || fetch("/api/home", { headers: { "Accept": "application/json" }, cache: "no-store" }));
    if (response?.__truxHomePrefetchError) throw response.__truxHomePrefetchError;
    if (!response || !response.ok) throw new Error("AI-generated home content is unavailable.");
    const payload = await response.json().catch(() => ({}));
    if (!document.body.classList.contains("home-active")) return false;

    const greetings = [...new Set((Array.isArray(payload.greetings) ? payload.greetings : [])
      .map(cleanHomeGreeting)
      .filter(Boolean))];
    if (greetings.length < 3 || !renderHomePrompts(payload.prompts)) {
      throw new Error("The AI returned incomplete home content.");
    }

    const uniqueGreetings = greetings.filter(greeting => greeting.toLocaleLowerCase() !== truxHomeLastGreeting.toLocaleLowerCase());
    if (prefetch && truxHomeGreetingIndex < truxHomeGreetingQueue.length) {
      truxHomePendingGreetings = uniqueGreetings;
    } else {
      truxHomeGreetingQueue = uniqueGreetings;
      truxHomeGreetingIndex = 0;
      truxHomePendingGreetings = [];
    }
    truxHomeContentRetryCount = 0;
    return true;
  })().catch(error => {
    console.debug("TruX AI-generated home content unavailable:", error?.message || error);
    if (document.body.classList.contains("home-active") && truxHomeContentRetryCount < 2) {
      truxHomeContentRetryCount += 1;
      const retryAsPrefetch = prefetch && truxHomeGreetingIndex < truxHomeGreetingQueue.length;
      const retryRunId = truxHomeGreetingRunId;
      scheduleHomeGreeting(() => {
        if (!document.body.classList.contains("home-active") || retryRunId !== truxHomeGreetingRunId) return;
        void loadHomeContent({ prefetch: retryAsPrefetch }).then(loaded => {
          if (loaded && !retryAsPrefetch && document.body.classList.contains("home-active") && retryRunId === truxHomeGreetingRunId) cycleHomeGreeting(retryRunId);
        });
      }, 1100 * truxHomeContentRetryCount);
    }
    return false;
  }).finally(() => {
    truxHomeContentRequest = null;
  });
  return truxHomeContentRequest;
}

function cycleHomeGreeting(runId = truxHomeGreetingRunId) {
  if (runId !== truxHomeGreetingRunId || !document.body.classList.contains("home-active")) return;
  const text = getEl("truxHomeSequenceText");
  if (!text) return;

  if (truxHomeGreetingIndex >= truxHomeGreetingQueue.length) {
    if (truxHomePendingGreetings.length) {
      truxHomeGreetingQueue = truxHomePendingGreetings;
      truxHomeGreetingIndex = 0;
      truxHomePendingGreetings = [];
    } else {
      text.classList.remove("is-visible", "is-replacing");
      text.textContent = "";
      text.hidden = true;
      void loadHomeContent({ prefetch: false }).then(loaded => {
        if (runId === truxHomeGreetingRunId && document.body.classList.contains("home-active") && (loaded || truxHomePendingGreetings.length)) cycleHomeGreeting(runId);
      });
      return;
    }
  }

  const greeting = truxHomeGreetingQueue[truxHomeGreetingIndex++];
  if (!greeting) return;
  text.hidden = false;
  text.classList.remove("is-visible");
  text.classList.add("is-replacing");
  scheduleHomeGreeting(() => {
    if (!document.body.classList.contains("home-active")) return;
    text.textContent = greeting;
    text.classList.remove("is-replacing");
    text.classList.add("is-visible");
    truxHomeLastGreeting = greeting;
  }, 180);

  if (truxHomeGreetingQueue.length - truxHomeGreetingIndex <= 2 && !truxHomePendingGreetings.length && !truxHomeContentRequest) {
    void loadHomeContent({ prefetch: true });
  }
  scheduleHomeGreeting(() => cycleHomeGreeting(runId), 4300);
}

function startHomeGreetingPulse() {
  clearHomeGreetingTimers();
  const runId = ++truxHomeGreetingRunId;
  truxHomeGreetingQueue = [];
  truxHomeGreetingIndex = 0;
  truxHomePendingGreetings = [];
  truxHomeLastGreeting = "";
  truxHomeContentRetryCount = 0;
  const text = getEl("truxHomeSequenceText");
  if (text) {
    text.textContent = "";
    text.hidden = true;
    text.classList.remove("is-visible", "is-replacing");
  }
  const prompts = getEl("truxHomePrompts");
  if (prompts) { prompts.replaceChildren(); prompts.hidden = true; }
  void loadHomeContent({ prefetch: false }).then(loaded => {
    if (loaded && runId === truxHomeGreetingRunId && document.body.classList.contains("home-active")) cycleHomeGreeting(runId);
  });
}

window.startHomeGreetingPulse = startHomeGreetingPulse;

function isNetworkFailure(error) {
  if (!error || error.name === "AbortError") return false;
  const msg = String(error.message || error || "").toLowerCase();
  return navigator.onLine === false ||
    /failed to fetch|networkerror|network error|load failed|err_internet_disconnected|err_network_changed|connection reset|connection closed|fetch failed/i.test(msg);
}

function waitForInternet(statusId) {
  return new Promise(resolve => {
    let pulse;
    const finish = (restored = true) => {
      cleanup();
      if (restored) setThinkingStatus(statusId, "Internet connection restored — continuing…");
      resolve();
    };
    const cleanup = () => {
      window.removeEventListener("online", finishOnline);
      if (pulse) clearInterval(pulse);
    };
    const finishOnline = () => finish(true);

    setThinkingStatus(statusId, "Waiting for internet connection…");
    window.addEventListener("online", finishOnline, { once: true });

    pulse = setInterval(() => {
      if (!isGenerating) {
        finish(false);
      } else if (navigator.onLine) {
        finish(true);
      } else {
        setThinkingStatus(statusId, "Still waiting for internet connection…");
      }
    }, 1500);
  });
}
