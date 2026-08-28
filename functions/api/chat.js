import { GoogleGenerativeAI } from '@google/generative-ai';

const BASE_PERSONA = `Never use latex for code generation. You can use unicode symbols and standard text. Your name is TruX, an AI created by TruX-Technologies. Keep answers concise, precise, and informative.`;

// Track image generation counts per IP/Session in memory (1 image limit per user)
const imageGenTracker = new Map();

function getGeminiModel(tier) {
  switch (tier) {
    case 'pro': return 'gemini-3.5-flash'; // TruX-Pro 3.5
    case 'base':
    default: return 'gemini-3.7-flash'; // TruX-Core 3.0
  }
}

// Nano Banana Pro / Fast Reliable Flux Engine with fallback
async function generateNanoBananaImage(prompt) {
  const seed = Math.floor(Math.random() * 1000000);
  const encodedPrompt = encodeURIComponent(prompt.trim() || "Abstract neon cyberpunk aesthetic art");
  
  // Using high-speed Nano-Banana Pro / Flux image endpoint
  const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&seed=${seed}&model=flux&nologo=true`;
  
  // Verify image generator health
  const checkRes = await fetch(imageUrl, { method: 'HEAD' });
  if (!checkRes.ok) {
    throw new Error('Image Generation Engine temporarily busy. Please try again.');
  }

  return imageUrl;
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    if (!env.GEMINI_API_KEY) {
      return Response.json({ error: 'GEMINI_API_KEY missing on server environment.' }, { status: 500 });
    }

    const clientIP = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'default-user';

    const { 
      message, 
      tier = 'base', 
      history = [], 
      image = null, 
      systemInstruction = '', 
      mode = 'chat', // 'chat' or 'image'
      thinkingLevel = 'medium' 
    } = await request.json();

    if (!message && !image) {
      return Response.json({ error: 'Message or image required.' }, { status: 400 });
    }

    // --- MODE 1: NANO BANANA PRO IMAGE GENERATION (1 Limit Enforcement) ---
    if (mode === 'image') {
      const userImageCount = imageGenTracker.get(clientIP) || 0;
      if (userImageCount >= 1) {
        return Response.json({ 
          error: 'Image generation limit reached! (1 free image allowed per user).' 
        }, { status: 429 });
      }

      try {
        const imageUrl = await generateNanoBananaImage(message);
        
        // Mark user as having generated 1 image
        imageGenTracker.set(clientIP, userImageCount + 1);

        return Response.json({ 
          reply: `Here is your generated image:\n\n![Generated Image](${imageUrl})` 
        });
      } catch (imgError) {
        console.error('Image Generation Error:', imgError);
        return Response.json({ error: `Image Generation failed: ${imgError.message}` }, { status: 500 });
      }
    }

    // --- MODE 2: CHAT WITH NATIVE SEARCH & THINKING BUDGET ---
    const combinedSystemInstruction = systemInstruction?.trim()
      ? `${BASE_PERSONA}\n\n[USER CUSTOM INSTRUCTIONS]:\n${systemInstruction}`
      : BASE_PERSONA;

    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    
    let thinkingBudget = 0;
    if (thinkingLevel === 'low') thinkingBudget = 1024;
    else if (thinkingLevel === 'medium') thinkingBudget = 2048;
    else if (thinkingLevel === 'high') thinkingBudget = 4096;

    const requestConfig = {
      model: getGeminiModel(tier),
      systemInstruction: combinedSystemInstruction,
      tools: [{ googleSearch: {} }]
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
    messageParts.push({ text: message || "Analyze attached image/content" });

    const contents = [...formattedHistory, { role: 'user', parts: messageParts }];
    const result = await model.generateContent({ contents });
    const response = result.response;

    let rawText = response.text() || 'No response generated.';
    
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
