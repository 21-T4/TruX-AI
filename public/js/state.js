/* Shared UI state. */
let currentPlanTier = "base",
    workspaceMode = "chat",
    chatSessions = {},
    pinnedInsights = store.json("trux_pinned", []),
    feedbackCount = Number(store.getItem("trux_feedback_count")) || 0,
    currentChatId = null,
    isGenerating = false,
    sendPromptInFlight = false,
    activeAbortController = null,
    selectedImageBase64 = null,
    pastedTextBlocks = [],
    fileAttachments = [],
    wasInputByVoice = false,
    contextMenuTargetId = null,
    notebookMoveTargetId = null,
    codeBlockCounter = 0,
    recognition = null,
    isRecording = false,
    isScrolledUp = false,
    activeStreamer = null,
    advancedThinkingEnabled = false,
    advancedThinkingLevel = "low",
    incognitoMode = false,
    generationEpoch = 0,
    activeTurnContext = null,
    generationStopRequested = false,
    truxLocationCache = null,
    currentProfileOption = null;
try {
  const savedPlanTier = store.getItem("trux_plan_tier");
  currentPlanTier = ["base","pro"].includes(savedPlanTier) ? savedPlanTier : "base";
  store.setItem("trux_plan_tier", currentPlanTier);
  advancedThinkingLevel = ["low","medium","extended"].includes(store.getItem("trux_thinking_level")) ? store.getItem("trux_thinking_level") : "low";
  advancedThinkingEnabled = advancedThinkingLevel === "extended";
} catch (_) {}
