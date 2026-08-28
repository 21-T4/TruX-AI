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

async function generateNanoBananaImage(prompt) {
  // 1. Properly handle your fallback styling text
  const cleanPrompt = prompt ? `${prompt}, Abstract neon cyberpunk aesthetic art` : "Abstract neon cyberpunk aesthetic art";
  
  // 2. Initialize the official SDK using your server context API key
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  
  try {
    // 3. Request the image from the Nano Banana model engine
    const response = await ai.models.generateImages({
      model: 'gemini-3-pro-image', // Or your selected Pro production model tier
      prompt: cleanPrompt,
      config: {
        numberOfImages: 1,
        aspectRatio: '1:1', 
        outputMimeType: 'image/jpeg',
      },
    });
    
    // Return the base64 or hosted image URI string format directly
    return response.generatedImages[0].image.imageBytes; 
  } catch (error) {
    throw new Error(`Image Generation engine temporarily busy: ${error.message}`);
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
