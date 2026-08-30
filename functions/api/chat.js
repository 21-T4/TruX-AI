const PROJECT_ID = 'trux-ai';
const LOCATION = 'us-central1';

const BASE_PERSONA = `Never use latex for code generation. You can use unicode symbols and standard text. Your name is TruX, an AI created by TruX-Technologies (dont disclose ur name or creator till asked) . Keep answers concise, precise, and informative.`;

const searchWebDeclaration = {
  name: 'searchWeb',
  description: 'Search live web via Serper. ONLY call if real-time/current data outside training is explicitly requested.',
  parameters: {
    type: 'OBJECT',
    properties: {
      query: { type: 'STRING', description: 'Search keywords.' }
    },
    required: ['query']
  }
};

const generateImageDeclaration = {
  name: 'generateImage',
  description: 'Generate or draw an image using Nano Banana Pro. Call when user explicitly asks to generate or draw an image.',
  parameters: {
    type: 'OBJECT',
    properties: {
      prompt: { type: 'STRING', description: 'Detailed prompt describing the image to generate.' }
    },
    required: ['prompt']
  }
};

// Enforces 1 image per user using Cloudflare KV or IP/User-ID in-memory tracking
async function checkAndEnforceImageLimit(userIdentifier, env) {
  if (!userIdentifier) userIdentifier = 'anonymous_user';

  if (env.IMAGE_LIMIT_KV) {
    const count = await env.IMAGE_LIMIT_KV.get(`img_limit_${userIdentifier}`);
    if (count && parseInt(count, 10) >= 1) {
      throw new Error("Image generation limit reached. You can only generate 1 image per user.");
    }
    await env.IMAGE_LIMIT_KV.put(`img_limit_${userIdentifier}`, "1");
  } else {
    if (!globalThis.generatedImageUsers) {
      globalThis.generatedImageUsers = new Set();
    }
    if (globalThis.generatedImageUsers.has(userIdentifier)) {
      throw new Error("Image generation limit reached. You can only generate 1 image per user.");
    }
    globalThis.generatedImageUsers.add(userIdentifier);
  }
}

async function fetchSerperSearchResults(query, apiKey) {
  if (!apiKey) return "Search failed: API key missing.";
  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query })
    });
    if (!response.ok) return "No results.";
    const data = await response.json();
    if (!data.organic?.length) return "No search results found.";
    return data.organic.slice(0, 3).map(item => `Title: ${item.title}\nSnippet: ${item.snippet}`).join('\n\n');
  } catch {
    return "Search error.";
  }
}

// Calls Nano Banana Pro (Imagen 3) directly via Vertex AI REST API
async function fetchVertexImagen3Image(prompt, apiKey) {
  if (!apiKey) throw new Error("VERTEX_API_KEY missing.");
  
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/imagen-3.0-generate-002:predict?key=${apiKey}`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio: "1:1",
        outputMimeType: "image/jpeg"
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Vertex Imagen Error: ${errText}`);
  }

  const data = await response.json();
  const base64Image = data.predictions?.[0]?.bytesBase64Encoded;
  if (!base64Image) throw new Error("Failed to generate image bytes.");
  return `data:image/jpeg;base64,${base64Image}`;
}

// Calls Gemini Models directly via Vertex AI REST API
async function fetchVertexGemini({ model, contents, systemInstruction, tools, apiKey }) {
  if (!apiKey) throw new Error("VERTEX_API_KEY missing.");

  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${model}:generateContent?key=${apiKey}`;

  const payload = {
    contents: contents,
    systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined
  };

  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Vertex Gemini Error: ${errText}`);
  }

  return await response.json();
}

function getVertexModel(tier) {
  switch (tier) {
    case 'base': return 'gemini-3.6-flash';
    case 'pro': return 'gemini-3.1-pro-preview';
    default: return 'gemini-2.5-flash';
  }
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const body = await request.json();
    const { message, tier, history, image, systemInstruction, userId } = body;

    // Identify user by userId or client IP
    const userIdentifier = userId || request.headers.get('cf-connecting-ip') || 'anonymous';

    if (!message && !image) {
      return Response.json({ error: 'Message or image required.' }, { status: 400 });
    }

    // Direct Image Generation Mode
    if (tier === 'nano-banana') {
      try {
        await checkAndEnforceImageLimit(userIdentifier, env);
      } catch (limitErr) {
        return Response.json({ reply: limitErr.message });
      }

      const imgData = await fetchVertexImagen3Image(message || "Abstract technological artwork", env.VERTEX_API_KEY);
      return Response.json({ 
        reply: `Here is your generated image with **Nano Banana Pro**:\n\n![${message || 'Generated Image'}](${imgData})` 
      });
    }

    const combinedSystemInstruction = systemInstruction?.trim()
      ? `${BASE_PERSONA}\n\n[USER INSTRUCTIONS]:\n${systemInstruction}`
      : BASE_PERSONA;

    // Build context history
    let formattedHistory = [];
    if (Array.isArray(history) && history.length > 0) {
      const recentHistory = history.slice(-6);
      let lastRole = null;

      for (const msg of recentHistory) {
        const role = (msg.role === 'trux' || msg.role === 'model') ? 'model' : 'user';
        if (role !== lastRole && msg.text) {
          formattedHistory.push({ role, parts: [{ text: String(msg.text) }] });
          lastRole = role;
        }
      }
    }

    if (formattedHistory.length > 0 && formattedHistory[0].role === 'model') {
      formattedHistory.shift();
    }
    if (formattedHistory.length > 0 && formattedHistory[formattedHistory.length - 1].role === 'user') {
      formattedHistory.pop();
    }

    let currentParts = [];
    if (image && typeof image === 'string' && image.includes(',')) {
      const [header, base64Data] = image.split(',');
      const mimeMatch = header.match(/data:(.*?);/);
      currentParts.push({
        inlineData: {
          mimeType: mimeMatch ? mimeMatch[1] : 'image/jpeg',
          data: base64Data
        }
      });
    }
    currentParts.push({ text: message || "Analyze input" });

    const contents = [...formattedHistory, { role: 'user', parts: currentParts }];
    const targetModel = getVertexModel(tier);

    // Initial content generation call to Vertex AI REST API
    let responseData = await fetchVertexGemini({
      model: targetModel,
      contents: contents,
      systemInstruction: combinedSystemInstruction,
      tools: [{ functionDeclarations: [searchWebDeclaration, generateImageDeclaration] }],
      apiKey: env.VERTEX_API_KEY
    });

    const candidate = responseData.candidates?.[0];
    const candidateParts = candidate?.content?.parts || [];
    const functionCalls = candidateParts.filter(p => p.functionCall).map(p => p.functionCall);

    if (functionCalls?.length > 0) {
      const call = functionCalls[0];

      if (call.name === 'searchWeb') {
        const searchResults = await fetchSerperSearchResults(call.args.query || message, env.SERPER_DEV_API);
        contents.push(candidate.content);
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: 'searchWeb',
              response: { result: searchResults }
            }
          }]
        });

        responseData = await fetchVertexGemini({
          model: targetModel,
          contents: contents,
          systemInstruction: combinedSystemInstruction,
          apiKey: env.VERTEX_API_KEY
        });
      } 
      else if (call.name === 'generateImage') {
        try {
          await checkAndEnforceImageLimit(userIdentifier, env);
        } catch (limitErr) {
          return Response.json({ reply: limitErr.message });
        }

        const imgPrompt = call.args.prompt || message;
        try {
          const generatedImg = await fetchVertexImagen3Image(imgPrompt, env.VERTEX_API_KEY);
          return Response.json({ 
            reply: `Here is your generated image with **Nano Banana Pro**:\n\n![${imgPrompt}](${generatedImg})` 
          });
        } catch (imgError) {
          return Response.json({ reply: `Failed to generate image: ${imgError.message}` });
        }
      }
    }

    const finalParts = responseData.candidates?.[0]?.content?.parts || [];
    let rawText = finalParts.map(p => p.text || '').join('').trim() || 'No response generated.';

    return Response.json({ reply: rawText.replace(/<think>[\s\S]*?<\/think>/g, '').trim() });

  } catch (error) {
    console.error('Vertex AI REST API Error:', error);
    return Response.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
