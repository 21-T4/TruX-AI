import { GoogleGenAI } from '@google-genai';

const BASE_PERSONA = `Never use latex for code generation. You can use unicode symbols and standard text. Your name is TruX, an AI created by TruX-Technologies. Keep answers concise, precise, and informative.`;

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

async function fetchImagen3Image(prompt, apiKey) {
  if (!apiKey) throw new Error("API Key or Token missing.");
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { sampleCount: 1, aspectRatio: "1:1", outputMimeType: "image/jpeg" }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Imagen Error: ${errText}`);
  }

  const data = await response.json();
  const base64Image = data.predictions?.[0]?.bytesBase64Encoded;
  if (!base64Image) throw new Error("Failed to generate image bytes.");
  return `data:image/jpeg;base64,${base64Image}`;
}

function getVertexModel(tier) {
  switch (tier) {
    case 'base': return 'gemini-3.1-flash';
    case 'pro': return 'gemini-3.1-pro-preview';
    default: return 'gemini-3.1-flash';
  }
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    
    // Initialize Google Gen AI SDK in Vertex AI Mode
    const ai = new GoogleGenAI({
      vertexAI: true,
      project: env.GCP_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || 'trux-ai-project',
      location: env.GCP_LOCATION || 'us-central1',
      apiKey: env.GEMINI_API_KEY || env.GCP_API_KEY
    });

    const { message, tier, history, image, systemInstruction } = await request.json();

    if (!message && !image) {
      return Response.json({ error: 'Message or image required.' }, { status: 400 });
    }

    // Direct Image Generation Mode
    if (tier === 'nano-banana') {
      const imgData = await fetchImagen3Image(message || "Abstract technological artwork", env.GEMINI_API_KEY);
      return Response.json({ 
        reply: `Here is your generated image with **Nano Banana Pro**:\n\n![${message || 'Generated Image'}](${imgData})` 
      });
    }

    const combinedSystemInstruction = systemInstruction?.trim()
      ? `${BASE_PERSONA}\n\n[USER INSTRUCTIONS]:\n${systemInstruction}`
      : BASE_PERSONA;

    // Build context history: Exactly 3 turns (3 User + 3 AI = max 6 items) for optimal automated prefix caching
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

    // Ensure valid alternation structure starting with user and ending with model
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

    // Initial content generation call
    let response = await ai.models.generateContent({
      model: targetModel,
      contents: contents,
      config: {
        systemInstruction: combinedSystemInstruction,
        tools: [{ functionDeclarations: [searchWebDeclaration, generateImageDeclaration] }]
      }
    });

    const candidate = response.candidates?.[0];
    const functionCalls = candidate?.content?.parts?.filter(p => p.functionCall).map(p => p.functionCall);

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

        response = await ai.models.generateContent({
          model: targetModel,
          contents: contents,
          config: { systemInstruction: combinedSystemInstruction }
        });
      } 
      else if (call.name === 'generateImage') {
        const imgPrompt = call.args.prompt || message;
        try {
          const generatedImg = await fetchImagen3Image(imgPrompt, env.GEMINI_API_KEY);
          return Response.json({ 
            reply: `Here is your generated image with **Nano Banana Pro**:\n\n![${imgPrompt}](${generatedImg})` 
          });
        } catch (imgError) {
          return Response.json({ reply: `Failed to generate image: ${imgError.message}` });
        }
      }
    }

    let rawText = response.text || 'No response generated.';
    return Response.json({ reply: rawText.replace(/<think>[\s\S]*?<\/think>/g, '').trim() });

  } catch (error) {
    console.error('Vertex AI API Error:', error);
    return Response.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
