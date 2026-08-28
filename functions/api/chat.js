// functions/api/chat.js

const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

const BASE_PERSONA = `
Never use LaTeX for code generation.
You can use Unicode symbols and standard text.
Your name is TruX, an AI created by TruX-Technologies.
Keep answers concise, precise, useful, and informative.
Do not reveal hidden chain-of-thought or internal reasoning.
When current information is needed, use Google Search grounding.
`.trim();

const CHAT_MODELS = {
  base: "gemini-3.7-flash",
  pro: "gemini-3.5-flash",
};

const IMAGE_MODEL = "gemini-3-pro-image";

const VALID_THINKING_LEVELS = new Set([
  "low",
  "medium",
  "high",
]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function getModel(tier) {
  return CHAT_MODELS[tier] || CHAT_MODELS.base;
}

function normalizeThinkingLevel(level) {
  if (!level || level === "off") {
    return null;
  }

  return VALID_THINKING_LEVELS.has(level)
    ? level
    : "medium";
}

function cleanHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  const result = [];

  for (const msg of history.slice(-10)) {
    if (!msg || typeof msg !== "object") {
      continue;
    }

    const text = typeof msg.text === "string"
      ? msg.text.trim()
      : "";

    if (!text) {
      continue;
    }

    const role =
      msg.role === "trux" ||
      msg.role === "model" ||
      msg.role === "assistant"
        ? "model"
        : "user";

    // Gemini conversation history cannot have consecutive messages
    // with the same role in this format.
    const previous = result[result.length - 1];

    if (previous && previous.role === role) {
      previous.parts.push({ text });
    } else {
      result.push({
        role,
        parts: [{ text }],
      });
    }
  }

  // The first historical message must be user.
  while (result.length && result[0].role !== "user") {
    result.shift();
  }

  return result;
}

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") {
    return null;
  }

  const match = dataUrl.match(
    /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/s
  );

  if (!match) {
    return null;
  }

  return {
    mimeType: match[1],
    data: match[2],
  };
}

function extractText(response) {
  const parts =
    response?.candidates?.[0]?.content?.parts || [];

  return parts
    .filter((part) => typeof part?.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

function extractImage(response) {
  const parts =
    response?.candidates?.[0]?.content?.parts || [];

  for (const part of parts) {
    if (part?.inlineData?.data) {
      return {
        mimeType:
          part.inlineData.mimeType || "image/png",
        data: part.inlineData.data,
      };
    }
  }

  return null;
}

function extractGroundingSources(response) {
  const metadata =
    response?.candidates?.[0]?.groundingMetadata;

  if (!metadata) {
    return [];
  }

  const chunks = Array.isArray(metadata.groundingChunks)
    ? metadata.groundingChunks
    : [];

  const sources = [];

  for (const chunk of chunks) {
    const web = chunk?.web;

    if (
      web &&
      typeof web.uri === "string" &&
      typeof web.title === "string"
    ) {
      sources.push({
        title: web.title,
        uri: web.uri,
      });
    }
  }

  const unique = [];
  const seen = new Set();

  for (const source of sources) {
    if (seen.has(source.uri)) {
      continue;
    }

    seen.add(source.uri);
    unique.push(source);
  }

  return unique.slice(0, 10);
}

async function callGemini(
  apiKey,
  model,
  payload
) {
  const url =
    `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `Gemini returned invalid JSON (${response.status}).`
    );
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      `Gemini request failed with HTTP ${response.status}.`;

    const error = new Error(message);
    error.status = response.status;
    error.gemini = data;
    throw error;
  }

  return data;
}

async function generateTextResponse({
  apiKey,
  message,
  history,
  image,
  tier,
  systemInstruction,
  thinkingLevel,
}) {
  const model = getModel(tier);

  const cleanSystemInstruction = systemInstruction?.trim()
    ? `${BASE_PERSONA}\n\n[USER CUSTOM INSTRUCTIONS]\n${systemInstruction.trim()}`
    : BASE_PERSONA;

  const historicalContents = cleanHistory(history);

  const currentParts = [];

  // Optional uploaded image.
  if (image) {
    const parsedImage = parseDataUrl(image);

    if (parsedImage) {
      currentParts.push({
        inlineData: {
          mimeType: parsedImage.mimeType,
          data: parsedImage.data,
        },
      });
    }
  }

  currentParts.push({
    text: message?.trim() || "Analyze the attached image.",
  });

  historicalContents.push({
    role: "user",
    parts: currentParts,
  });

  const payload = {
    systemInstruction: {
      parts: [
        {
          text: cleanSystemInstruction,
        },
      ],
    },

    contents: historicalContents,

    tools: [
      {
        googleSearch: {},
      },
    ],

    generationConfig: {},
  };

  const normalizedThinking = normalizeThinkingLevel(
    thinkingLevel
  );

  if (normalizedThinking) {
    payload.generationConfig.thinkingConfig = {
      thinkingLevel: normalizedThinking,
    };
  }

  const response = await callGemini(
    apiKey,
    model,
    payload
  );

  return {
    reply:
      extractText(response) ||
      "I couldn't generate a text response.",

    image: null,

    sources: extractGroundingSources(response),
  };
}

async function generateImageResponse({
  apiKey,
  message,
  image,
}) {
  const contents = [];

  const parsedImage = image
    ? parseDataUrl(image)
    : null;

  if (parsedImage) {
    contents.push({
      inlineData: {
        mimeType: parsedImage.mimeType,
        data: parsedImage.data,
      },
    });
  }

  contents.push({
    text: message?.trim()
      ? message.trim()
      : "Create an original high-quality image.",
  });

  const payload = {
    contents,

    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],

      responseFormat: {
        image: {
          aspectRatio: "1:1",
          imageSize: "1K",
        },
      },
    },
  };

  const response = await callGemini(
    apiKey,
    IMAGE_MODEL,
    payload
  );

  const imageResult = extractImage(response);
  const textResult = extractText(response);

  if (!imageResult) {
    throw new Error(
      textResult ||
      "The image model returned no image data."
    );
  }

  return {
    reply:
      textResult ||
      "Image generated successfully.",

    image: imageResult,

    sources: extractGroundingSources(response),
  };
}

export async function onRequestPost(context) {
  try {
    const apiKey = context?.env?.GEMINI_API_KEY;

    if (!apiKey) {
      return json(
        {
          error:
            "GEMINI_API_KEY is not configured in Cloudflare Pages.",
        },
        500
      );
    }

    let body;

    try {
      body = await context.request.json();
    } catch {
      return json(
        {
          error: "Request body must be valid JSON.",
        },
        400
      );
    }

    const {
      message = "",
      history = [],
      image = null,
      tier = "base",
      systemInstruction = "",
      mode = "chat",
      thinkingLevel = "medium",
    } = body || {};

    const cleanMessage =
      typeof message === "string"
        ? message.trim()
        : "";

    if (!cleanMessage && !image) {
      return json(
        {
          error: "Message or image is required.",
        },
        400
      );
    }

    if (mode === "image") {
      const result = await generateImageResponse({
        apiKey,
        message: cleanMessage,
        image,
      });

      return json({
        ok: true,
        mode: "image",
        ...result,
      });
    }

    const result = await generateTextResponse({
      apiKey,
      message: cleanMessage,
      history,
      image,
      tier,
      systemInstruction,
      thinkingLevel,
    });

    return json({
      ok: true,
      mode: "chat",
      ...result,
    });
  } catch (error) {
    console.error("TruX API error:", error);

    const status = Number(error?.status) || 500;

    if (status === 401 || status === 403) {
      return json(
        {
          error:
            "Gemini API authentication failed. Check GEMINI_API_KEY.",
        },
        status
      );
    }

    if (status === 429) {
      return json(
        {
          error:
            "Gemini rate limit reached. Please try again shortly.",
        },
        429
      );
    }

    if (status === 400) {
      return json(
        {
          error:
            error?.message ||
            "Gemini rejected the request.",
        },
        400
      );
    }

    return json(
      {
        error:
          error?.message ||
          "Server connection error.",
      },
      500
    );
  }
}
