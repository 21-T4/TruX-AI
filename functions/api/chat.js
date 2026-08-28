import { GoogleGenerativeAI } from '@google/generative-ai';

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
  description: 'Generate or draw an image using Nano Banana Pro (Imagen 3). Call when the user requests generating, creating, or drawing an image.',
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

// Nano Banana Pro (Imagen 3 REST API Integration)
async function fetchImagen3Image(prompt, apiKey) {
  if (!apiKey) throw new Error("GEMINI_API_KEY missing.");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${apiKey}`;
  
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
    throw new Error(`Imagen Generation Error: ${errText}`);
  }

  const data = await response.json();
  const base64Image = data.predictions?.[0]?.bytesBase64Encoded;
  if (!base64Image) throw new Error("Failed to generate image.");
  return `data:image/jpeg;base64,${base64Image}`;
}

function getGeminiModel(tier) {
  switch (tier) {
    case 'base': return 'gemini-3.1-flash-lite';
    case 'pro': return 'gemini-3.5-flash-lite';
    case 'ultra': return 'gemini-3.6-flash';
    default: return 'gemini-3.1-flash-lite';
  }
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    if (!env.GEMINI_API_KEY) {
      return Response.json({ error: 'GEMINI_API_KEY missing.' }, { status: 500 });
    }

    const { message, tier, history, image, systemInstruction } = await request.json();

    if (!message && !image) {
      return Response.json({ error: 'Message or image required.' }, { status: 400 });
    }

    // Direct Nano Banana Pro Image Generation Mode
    if (tier === 'nano-banana') {
      const imgData = await fetchImagen3Image(message || "Abstract technological artwork", env.GEMINI_API_KEY);
      return Response.json({ 
        reply: `Here is your generated image with **Nano Banana Pro**:\n\n![${message || 'Generated Image'}](${imgData})` 
      });
    }

    const combinedSystemInstruction = systemInstruction?.trim()
      ? `${BASE_PERSONA}\n\n[USER INSTRUCTIONS]:\n${systemInstruction}`
      : BASE_PERSONA;

    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: getGeminiModel(tier),
      systemInstruction: combinedSystemInstruction,
      tools: [{ functionDeclarations: [searchWebDeclaration, generateImageDeclaration] }]
    });

    let formattedHistory = [];
    if (Array.isArray(history)) {
      const recentHistory = history.slice(-10);
      let lastRole = null;
      for (const msg of recentHistory) {
        const role = msg.role === 'trux' || msg.role === 'model' ? 'model' : 'user';
        if (role !== lastRole && msg.text) {
          formattedHistory.push({ role, parts: [{ text: String(msg.text) }] });
          lastRole = role;
        }
      }
    }

    if (formattedHistory.length > 0 && formattedHistory[0].role === 'model') formattedHistory.shift();
    if (formattedHistory.length > 0 && formattedHistory[formattedHistory.length - 1].role === 'user') formattedHistory.pop();

    let messageParts = [];
    if (image && typeof image === 'string') {
      const mimeMatch = image.match(/data:(.*?);/);
      if (mimeMatch && image.includes(',')) {
        messageParts.push({
          inlineData: { mimeType: mimeMatch[1], data: image.split(',')[1] }
        });
      }
    }
    messageParts.push({ text: message || "Analyze image" });

    const contents = [...formattedHistory, { role: 'user', parts: messageParts }];
    let result = await model.generateContent({ contents });
    let response = result.response;

    const functionCalls = response.functionCalls();
    if (functionCalls?.length > 0) {
      const call = functionCalls[0];
      
      if (call.name === 'searchWeb') {
        const searchResults = await fetchSerperSearchResults(call.args.query || message, env.SERPER_DEV_API);
        contents.push({ role: 'model', parts: response.candidates[0].content.parts });
        contents.push({ role: 'user', parts: [{ functionResponse: { name: 'searchWeb', response: { result: searchResults } } }] });
        result = await model.generateContent({ contents });
        response = result.response;
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

    let rawText = response.text() || 'No response generated.';
    return Response.json({ reply: rawText.replace(/<think>[\s\S]*?<\/think>/g, '').trim() });

  } catch (error) {
    console.error('API Error:', error);
    return Response.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
