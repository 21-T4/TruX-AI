/* Subscription page. */
let truxSubscriptionReturnState = null;
function refreshSubscriptionPage() {
  const supportedTiers = ["base", "plus", "pro", "edge"];
  const activePlan = supportedTiers.includes(currentPlanTier) ? currentPlanTier : "base";
  document.querySelectorAll("[data-subscription-plan]").forEach(card => {
    const tier = card.getAttribute("data-subscription-plan");
    const isCurrent = tier === activePlan;
    card.classList.toggle("current", isCurrent);
    const button = card.querySelector(".subscription-plan-action");
    if (!button) return;
    if (tier === "base") button.textContent = isCurrent ? "Current plan" : "Choose Free";
    else if (tier === "pro" && isCurrent) button.textContent = "Current plan";
    else button.textContent = "Coming Dec 1, 2026";
  });
}
function openSubscriptionPage() {
  // Capture the active workspace once, so repeated taps cannot overwrite
  // the destination used by the page's Back action.
  if (!document.body.classList.contains("subscription-page-active")) {
    truxSubscriptionReturnState = { mode: workspaceMode, chatId: currentChatId };
  }

  closeAttachmentMenu(); closeModelDropdown(); closeChatContextMenu();

  // Plans is a standalone screen, not an overlay on top of Chat/Code.
  // Clear mode-specific visibility flags while keeping workspaceMode and
  // currentChatId untouched; closeSubscriptionPage restores them via
  // setWorkspaceMode() using the saved state above.
  document.body.classList.remove(
    "home-active",
    "chat-session-active",
    "plugins-page-active",
    "notebook-open",
    "scrolled"
  );
  document.body.removeAttribute("data-media-mode");
  document.body.classList.add("subscription-page-active");

  getEl("subscriptionWorkspace")?.scrollTo({ top: 0, behavior: "instant" });
  refreshSubscriptionPage();
}
function closeSubscriptionPage() {
  const state = truxSubscriptionReturnState || { mode: "chat", chatId: currentChatId };
  document.body.classList.remove("subscription-page-active");
  truxSubscriptionReturnState = null;
  const sessionId = state.chatId || currentChatId;
  if (sessionId && chatSessions[sessionId]) {
    void loadChatSession(sessionId);
    return;
  }
  currentChatId = null;
  setWorkspaceMode(state.mode || "chat", { reload: false, preserveSession: false, forceReset: true });
}
function selectSubscriptionPlan(plan) {
  const planNames = { base: "Free", plus: "Plus", pro: "Pro", edge: "TruX AI Edge" };
  if (!Object.prototype.hasOwnProperty.call(planNames, plan)) {
    return toast("That plan is not available.");
  }
  if (plan === currentPlanTier) {
    return toast("You already have " + planNames[plan] + " access. Updated pricing and limits take effect December 1, 2026.");
  }
  if (plan !== "base") {
    return toast(planNames[plan] + " pricing and updated limits are scheduled for December 1, 2026. Plan changes are not active yet.");
  }
  toast("Plan selection is managed through your TruX account.");
}
function openSubscriptionSupport() {
  toast("Subscription support is being prepared. Please use Help & feedback to contact the TruX team.");
}
