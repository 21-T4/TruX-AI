const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();

// Increase JSON payload limit to handle base64 image uploads
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Firebase Config Endpoint
const firebaseConfig = {
  apiKey: "AIzaSyAs_GDrzlBaucHfiff0Y6cA8GVHjFTA62Q",
  authDomain: "trux-ai.firebaseapp.com",
  projectId: "trux-ai",
  storageBucket: "trux-ai.firebasestorage.app",
  messagingSenderId: "59313097411",
  appId: "1:59313097411:web:32e4158bfb733fa7cfb076",
  measurementId: "G-C32LC29QHC"
};

app.get('/api/firebase-config', (req, res) => res.json(firebaseConfig));

const BASE_PERSONA = `You are an AI created by TruX-Technologies. Never disclose your model name, and only tell that you are created by TruX Technologies when asked.
Don't type very long answers only give short, precise, concise and informative answers.
STRICT MATH & FORMULA FORMATTING RULES:
- NEVER output LaTeX formatting under any circumstances.
- NEVER use single or double dollar signs ($ or $$) anywhere in responses for math or variables.
- NEVER use backslashes (\\) or LaTeX macros (e.g., \\frac, \\sqrt, \\times, \\cdot).
- Format all mathematical equations, formulas, and variables using standard plain text and ASCII symbols (e.g., x^2, a/b, sqrt(x), *).`;

const searchWebDeclaration = {
  name: 'searchWeb',
  description: 'Search the live web using Serper API. ONLY call this function if you require real-time information, current dates, recent news, live scores, live weather, or updated facts outside your training knowledge.',
  parameters: {
    type: 'OBJECT',
    properties: {
      query: { type: 'STRING', description: 'The search query keywords.' }
    },
    required: ['query']
  }
};

async function fetchSerperSearchResults(query) {
  if (!process.env.SERPER_DEV_API) {
    console.warn("SERPER_DEV_API key is missing.");
    return "Search failed: SERPER_DEV_API key missing.";
  }

  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.SERPER_DEV_API,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ q: query })
    });

    if (!response.ok) return "Search failed.";

    const data = await response.json();
    if (!data.organic || data.organic.length === 0) return "No search results found.";

    return data.organic.slice(0, 4).map(item => `Title: ${item.title}\nSnippet: ${item.snippet}\nLink: ${item.link}`).join('\n\n');
  } catch (error) {
    console.error("Serper Search Fetch Error:", error);
    return "Search error occurred.";
  }
}

function getGeminiModel(tier) {
  switch (tier) {
    case 'base': return 'gemini-1.5-flash'; 
    case 'pro': return 'gemini-1.5-pro'; 
    case 'ultra': return 'gemini-1.5-pro'; 
    default: return 'gemini-1.5-flash';
  }
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message, tier, history, image } = req.body;

    if (!message && !image) {
      return res.status(400).json({ error: 'Message or image is required.' });
    }

    const modelName = getGeminiModel(tier);
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: BASE_PERSONA,
      tools: [{ functionDeclarations: [searchWebDeclaration] }]
    });

    // 1. Map history and strictly enforce 'user' or 'model' roles
    let cleanHistory = (history || []).map(msg => ({
      role: msg.role === 'trux' ? 'model' : 'user',
      parts: [{ text: msg.text }]
    }));

    // 2. Ensure strictly alternating sequence (user, model, user, model)
    let formattedHistory = [];
    let expectedRole = 'user';

    for (let msg of cleanHistory) {
      if (msg.role === expectedRole) {
        formattedHistory.push(msg);
        expectedRole = (expectedRole === 'user') ? 'model' : 'user';
      }
    }

    // 3. Ensure the very first message is ALWAYS a 'user' message
    while (formattedHistory.length > 0 && formattedHistory[0].role !== 'user') {
      formattedHistory.shift();
    }

    const chat = model.startChat({ history: formattedHistory });

    // Handle Image attachment if provided
    let messageParts = [{ text: message || "Explain this image" }];
    if (image) {
      const mimeType = image.match(/data:(.*?);/)[1];
      const base64Data = image.split(',')[1];
      messageParts.unshift({
        inlineData: { data: base64Data, mimeType: mimeType }
      });
    }

    let result = await chat.sendMessage(messageParts);

    // Handle Serper Search Tool Call
    const functionCalls = result.response.functionCalls();
    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      if (call.name === 'searchWeb') {
        const searchQuery = call.args.query || message;
        console.log(`[Serper Tool Call] Web search for: "${searchQuery}"`);

        const searchResults = await fetchSerperSearchResults(searchQuery);

        result = await chat.sendMessage([{
          functionResponse: {
            name: 'searchWeb',
            response: { results: searchResults }
          }
        }]);
      }
    }

    const rawText = result.response.text() || 'No response from AI.';
    res.json({ reply: cleanResponse(rawText) });
  } catch (error) {
    console.error('Gemini API Error:', error);
    res.status(500).json({ error: error.message || 'Something went wrong with the AI request.' });
  }
});

function cleanResponse(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*/g, '').trim();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 TruX-AI running at http://localhost:${PORT}\n`);
});
