import { GoogleGenerativeAI } from '@google/generative-ai';

const BASE_PERSONA = `Never use latex for code generation. You can use unicode symbols and standard text. Your name is TruX, an AI created by TruX-Technologies (dont tag ur name an creator with every message unless aske you eg- who are you etc). Keep answers concise, precise, and informative.`;

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

    const combinedSystemInstruction = systemInstruction?.trim()
      ? `${BASE_PERSONA}\n\n[USER INSTRUCTIONS]:\n${systemInstruction}`
      : BASE_PERSONA;

    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: getGeminiModel(tier),
      systemInstruction: combinedSystemInstruction,
      tools: [{ functionDeclarations: [searchWebDeclaration] }]
    });

    // Format up to 5 pairs (10 messages) of alternating user/model history
    let formattedHistory = [];
    if (Array.isArray(history)) {
      const recentHistory = history.slice(-10); // 5 pairs
      let lastRole = null;
      for (const msg of recentHistory) {
        const role = msg.role === 'trux' || msg.role === 'model' ? 'model' : 'user';
        if (role !== lastRole && msg.text) {
          formattedHistory.push({ role, parts: [{ text: String(msg.text) }] });
          lastRole = role;
        }
      }
    }

    // Trim history if it starts with model to maintain strict user-first turn
    if (formattedHistory.length > 0 && formattedHistory[0].role === 'model') {
      formattedHistory.shift();
    }
    // Trim end if duplicate user turn exists
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
    messageParts.push({ text: message || "Analyze image" });

    const contents = [...formattedHistory, { role: 'user', parts: messageParts }];
    let result = await model.generateContent({ contents });
    let response = result.response;

    const functionCalls = response.functionCalls();
    if (functionCalls?.length > 0 && functionCalls[0].name === 'searchWeb') {
      const searchResults = await fetchSerperSearchResults(
        functionCalls[0].args.query || message,
        env.SERPER_DEV_API
      );

      contents.push({ role: 'model', parts: response.candidates[0].content.parts });
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'searchWeb',
            response: { result: searchResults }
          }
        }]
      });

      result = await model.generateContent({ contents });
      response = result.response;
    }

    let rawText = response.text() || 'No response generated.';
    return Response.json({ reply: rawText.replace(/<think>[\s\S]*?<\/think>/g, '').trim() });

  } catch (error) {
    console.error('API Error:', error);
    return Response.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
