const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

const BASE_PERSONA = `Never use latex for code generation u can use symbols text and small nos for squares. You are an AI created by TruX-Technologies. Never disclose your model name, and only tell that you are created by TruX Technologies when asked.
Don't type very long answers only give short, precise, concise and informative answers.`;

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
  if (!process.env.SERPER_DEV_API) return "Search failed: SERPER_DEV_API key missing.";
  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_DEV_API, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query })
    });
    if (!response.ok) return "Search failed.";
    const data = await response.json();
    if (!data.organic || data.organic.length === 0) return "No search results found.";
    return data.organic.slice(0, 4).map(item => `Title: ${item.title}\nSnippet: ${item.snippet}\nLink: ${item.link}`).join('\n\n');
  } catch (error) {
    return "Search error occurred.";
  }
}

// Updated Models
function getGeminiModel(tier) {
  switch (tier) {
    case 'base': return 'gemini-3.1-flash-lite'; 
    case 'pro': return 'gemini-3.5-flash-lite'; 
    case 'ultra': return 'gemini-3.6-flash'; 
    default: return 'gemini-3.1-flash-lite';
  }
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message, tier, history, image } = req.body;
    if (!message && !image) return res.status(400).json({ error: 'Message or image is required.' });

    const modelName = getGeminiModel(tier);
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: BASE_PERSONA,
      tools: [{ functionDeclarations: [searchWebDeclaration] }]
    });

    let cleanHistory = (history || []).map(msg => ({
      role: msg.role === 'trux' ? 'model' : 'user',
      parts: [{ text: msg.text }]
    }));

    let formattedHistory = [];
    let expectedRole = 'user';
    for (let msg of cleanHistory) {
      if (msg.role === expectedRole) {
        formattedHistory.push(msg);
        expectedRole = (expectedRole === 'user') ? 'model' : 'user';
      }
    }
    while (formattedHistory.length > 0 && formattedHistory[0].role !== 'user') formattedHistory.shift();

    const chat = model.startChat({ history: formattedHistory });

    let messageParts = [{ text: message || "Explain this image" }];
    if (image) {
      const mimeType = image.match(/data:(.*?);/)[1];
      const base64Data = image.split(',')[1];
      messageParts.unshift({ inlineData: { data: base64Data, mimeType: mimeType } });
    }

    let result = await chat.sendMessage(messageParts);

    const functionCalls = result.response.functionCalls();
    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      if (call.name === 'searchWeb') {
        const searchResults = await fetchSerperSearchResults(call.args.query || message);
        result = await chat.sendMessage([{ functionResponse: { name: 'searchWeb', response: { results: searchResults } } }]);
      }
    }

    const rawText = result.response.text() || 'No response from AI.';
    res.json({ reply: rawText.replace(/<think>[\s\S]*?<\/think>/g, '').trim() });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error processing request.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
