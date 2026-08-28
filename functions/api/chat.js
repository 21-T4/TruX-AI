const BASE_PERSONA = `
You are TruX, an AI created by TruX-Technologies.
Keep answers concise, precise and informative.
Never expose hidden reasoning or chain-of-thought.
Never use LaTeX for code generation.
Use Unicode symbols and standard text where appropriate.
`;

const MODELS = {
  base: "gemini-3.7-flash",
  pro: "gemini-3.7-flash"
};

const IMAGE_MODEL = "gemini-3.1-flash-image";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .slice(-10)
    .filter(m => m && m.text)
    .map(m => ({
      role: m.role === "trux" || m.role === "model"
        ? "model"
        : "user",
      parts: [
        {
          text: String(m.text)
        }
      ]
    }));
}

function extractText(data) {
  const parts =
    data?.candidates?.[0]?.content?.parts || [];

  return parts
    .filter(p => p.text)
    .map(p => p.text)
    .join("\n")
    .trim();
}

function extractImage(data) {
  const parts =
    data?.candidates?.[0]?.content?.parts || [];

  for (const part of parts) {
    if (part.inlineData?.data) {
      return {
        mimeType: part.inlineData.mimeType || "image/png",
        data: part.inlineData.data
      };
    }
  }

  return null;
}

async function callGemini({
  apiKey,
  model,
  contents,
  config
}) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents,
      generationConfig: config
    })
  });

  const data = await response.json();

  if (!response.ok) {
    const message =
      data?.error?.message ||
      `Gemini API returned HTTP ${response.status}`;

    throw new Error(message);
  }

  return data;
}

function thinkingConfig(level) {
  switch (level) {
    case "low":
      return {
        thinkingLevel: "LOW"
      };

    case "medium":
      return {
        thinkingLevel: "MEDIUM"
      };

    case "high":
      return {
        thinkingLevel: "HIGH"
      };

    default:
      return {
        thinkingLevel: "MINIMAL"
      };
  }
}

export async function onRequestPost(context) {
  try {
    const apiKey = context.env.GEMINI_API_KEY;

    if (!apiKey) {
      return json({
        error: "GEMINI_API_KEY is not configured in Cloudflare Pages."
      }, 500);
    }

    let body;

    try {
      body = await context.request.json();
    } catch {
      return json({
        error: "Invalid JSON request."
      }, 400);
    }

    const {
      message = "",
      history = [],
      image = null,
      tier = "base",
      systemInstruction = "",
      thinkingLevel = "medium",
      mode = "chat"
    } = body;

    const prompt = String(message || "").trim();

    if (!prompt && !image) {
      return json({
        error: "Message cannot be empty."
      }, 400);
    }

    /*
     * IMAGE GENERATION
     */
    if (mode === "image") {
      const imagePrompt =
        `${prompt || "Create an abstract futuristic artwork"}.
         Create a high-quality original image.
         Do not describe the image instead of generating it.`;

      const imageResponse = await callGemini({
        apiKey,
        model: IMAGE_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              {
                text: imagePrompt
              }
            ]
          }
        ],
        config: {
          responseModalities: ["IMAGE"]
        }
      });

      const generatedImage = extractImage(imageResponse);

      if (!generatedImage) {
        const text = extractText(imageResponse);

        return json({
          error: text || "The image model did not return an image."
        }, 500);
      }

      return json({
        success: true,
        mode: "image",
        image: generatedImage,
        reply: "Image generated successfully."
      });
    }

    /*
     * NORMAL CHAT
     */

    const contents = cleanHistory(history);

    const parts = [];

    if (image && typeof image === "string") {
      const match =
        image.match(/^data:([^;]+);base64,(.+)$/);

      if (match) {
        parts.push({
          inlineData: {
            mimeType: match[1],
            data: match[2]
          }
        });
      }
    }

    parts.push({
      text: prompt || "Analyze the attached image."
    });

    contents.push({
      role: "user",
      parts
    });

    const custom =
      String(systemInstruction || "").trim();

    const systemText =
      custom
        ? `${BASE_PERSONA}\n\nUser custom instructions:\n${custom}`
        : BASE_PERSONA;

    const config = {
      systemInstruction: {
        parts: [
          {
            text: systemText
          }
        ]
      },
      thinkingConfig: thinkingConfig(thinkingLevel),
      temperature: 0.7,
      maxOutputTokens: 4096
    };

    /*
     * Google Search is enabled for normal chat.
     */
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELS[tier] || MODELS.base}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents,
        systemInstruction: config.systemInstruction,
        generationConfig: {
          thinkingConfig: config.thinkingConfig,
          temperature: config.temperature,
          maxOutputTokens: config.maxOutputTokens
        },
        tools: [
          {
            googleSearch: {}
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const error =
        data?.error?.message ||
        `Gemini API error ${response.status}`;

      return json({
        error
      }, response.status);
    }

    const reply = extractText(data);

    if (!reply) {
      return json({
        error: "Gemini returned an empty response.",
        raw: data
      }, 500);
    }

    /*
     * Extract Google Search sources.
     */
    const chunks =
      data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];

    const sources = [];

    for (const chunk of chunks) {
      if (chunk?.web?.uri) {
        sources.push({
          title: chunk.web.title || chunk.web.uri,
          url: chunk.web.uri
        });
      }
    }

    return json({
      success: true,
      mode: "chat",
      reply,
      sources
    });

  } catch (error) {
    console.error("TruX API error:", error);

    return json({
      error: error?.message || "Internal server error."
    }, 500);
  }
}

export async function onRequestGet() {
  return json({
    ok: true,
    service: "TruX AI API",
    endpoint: "/api/chat"
  });
}
