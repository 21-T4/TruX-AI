import { GoogleGenerativeAI } from '@google/generative-ai';

const BASE_PERSONA = `Never use latex for code generation. You can use unicode symbols and standard text. Your name is TruX, an AI created by TruX-Technologies ( dont tag ur name with every message just disclose it when asked about ur name or creator ). Keep answers concise, precise, and informative.`;

function getGeminiModel(tier) {
  switch (tier) {
    case 'pro': return 'gemini-3.7-flash';
    case 'base':
    default: return 'gemini-3.5-flash';
  }
}

// Dedicated helper for Imagen 3 generation
async function generateImagen3(prompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:generateImages?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: prompt,
      config: {
        numberOfImages: 1,
        outputMimeType: 'image/jpeg',
        aspectRatio: '1:1'
      }
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Image API Error ${response.status}`);
  }

  const data = await response.json();
  const base64Bytes = data.generatedImages?.[0]?.image?.imageBytes;
  if (!base64Bytes) throw new Error('No image bytes returned from Imagen.');

  return `data:image/jpeg;base64,${base64Bytes}`;
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    if (!env.GEMINI_API_KEY) {
      return Response.json({ error: 'GEMINI_API_KEY missing on server environment.' }, { status: 500 });
    }

    const { 
      message, 
      tier = 'base', 
      history = [], 
      image = null, 
      systemInstruction = '', 
      mode = 'chat', // 'chat' or 'image'
      thinkingLevel = 'medium' // 'off', 'low', 'medium', 'high'
    } = await request.json();

    if (!message && !image) {
      return Response.json({ error: 'Message or image required.' }, { status: 400 });
    }

    // --- MODE 1: IMAGE GENERATION ---
    if (mode === 'image') {
      try {
        const imageUrl = await generateImagen3(message || "Abstract creative AI art", env.GEMINI_API_KEY);
        return Response.json({ 
          reply: `Here is your generated image:\n\n![Generated Image](${imageUrl})` 
        });
      } catch (imgError) {
        console.error('Image Generation Error:', imgError);
        return Response.json({ error: `Image Generation failed: ${imgError.message}` }, { status: 500 });
      }
    }

    // --- MODE 2: CHAT WITH NATIVE GOOGLE SEARCH & THINKING BUDGET ---
    const combinedSystemInstruction = systemInstruction?.trim()
      ? `${BASE_PERSONA}\n\n[USER CUSTOM INSTRUCTIONS]:\n${systemInstruction}`
      : BASE_PERSONA;

    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    
    // Configure Thinking Budget mapping
    let thinkingBudget = 0;
    if (thinkingLevel === 'low') thinkingBudget = 1024;
    else if (thinkingLevel === 'medium') thinkingBudget = 2048;
    else if (thinkingLevel === 'high') thinkingBudget = 4096;

    const requestConfig = {
      model: getGeminiModel(tier),
      systemInstruction: combinedSystemInstruction,
      tools: [{ googleSearch: {} }] // Native Google Search Grounding
    };

    if (thinkingBudget > 0) {
      requestConfig.thinkingConfig = { thinkingBudget };
    }

    const model = genAI.getGenerativeModel(requestConfig);

    // Format chat history
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

    if (formattedHistory.length > 0 && formattedHistory[0].role === 'model') {
      formattedHistory.shift();
    }
    if (formattedHistory.length > 0 && formattedHistory[formattedHistory.length - 1].role === 'user') {
      formattedHistory.pop();
    }

    let messageParts = [];
    if (image && typeof image === 'string') {
      const mimeMatch = image.match(/data:(.*?);/);
      if (mimeMatch && image.includes(',')) {
        messageParts.push({
          inlineData: {
            mimeType: mimeMatch[1],
            data: image.split(',')[1]
          }
        });
      }
    }
    messageParts.push({ text: message || "Analyze attached content" });

    const contents = [...formattedHistory, { role: 'user', parts: messageParts }];
    const result = await model.generateContent({ contents });
    const response = result.response;

    let rawText = response.text() || 'No response generated.';
    
    // Parse Google Search Grounding metadata if available
    const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
    let searchSourcesText = '';
    if (groundingMetadata?.groundingChunks?.length) {
      const sources = groundingMetadata.groundingChunks
        .filter(chunk => chunk.web?.uri && chunk.web?.title)
        .map(chunk => `[${chunk.web.title}](${chunk.web.uri})`);
      if (sources.length > 0) {
        searchSourcesText = `\n\n**Sources:**\n` + Array.from(new Set(sources)).map(s => `• ${s}`).join('\n');
      }
    }

    const finalResponse = (rawText + searchSourcesText).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return Response.json({ reply: finalResponse });

  } catch (error) {
    console.error('API Error:', error);
    return Response.json({ error: error.message || 'Server connection error' }, { status: 500 });
  }
}
