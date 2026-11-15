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
    incognitoMode = false,
    generationEpoch = 0,
    activeTurnContext = null,
    generationStopRequested = false,
    truxLocationCache = null,
    truxAutoFollow = true;      /* the answer being written keeps the view pinned to its end until the user scrolls or touches */
try {
  const savedPlanTier = store.getItem("trux_plan_tier");
  currentPlanTier = ["base","plus","pro","edge"].includes(savedPlanTier) ? savedPlanTier : "base";
  store.setItem("trux_plan_tier", currentPlanTier);
} catch (_) {}
