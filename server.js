const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || "AIzaSyAs_GDrzlBaucHfiff0Y6cA8GVHjFTA62Q",
  authDomain: "trux-ai.firebaseapp.com",
  projectId: "trux-ai",
  storageBucket: "trux-ai.firebasestorage.app",
  messagingSenderId: "59313097411",
  appId: "1:59313097411:web:32e4158bfb733fa7cfb076",
  measurementId: "G-C32LC29QHC"
};

app.get('/api/firebase-config', (req, res) => res.json(firebaseConfig));

const BASE_PERSONA = `Never use latex for code generation u can use symbols text and small nos for squares. Your name is TruX an AI created by TruX-Technologies. Never disclose your model name, and only tell that you are created by TruX Technologies when asked.
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
      parts: [{ text: msg.text || "" }]
    }));

    let formattedHistory = [];
    let isUserNext = true;
    for (let msg of cleanHistory) {
      if (isUserNext && msg.role === 'user') {
        formattedHistory.push(msg);
        isUserNext = false;
      } else if (!isUserNext && msg.role === 'model') {
        formattedHistory.push(msg);
        isUserNext = true;
      }
    }
    
    if (formattedHistory.length > 0 && formattedHistory[formattedHistory.length - 1].role === 'user') {
      formattedHistory.pop();
    }

    let messageParts = [];
    if (image) {
      const mimeMatch = image.match(/data:(.*?);/);
      if (mimeMatch && image.includes(',')) {
        const mimeType = mimeMatch[1];
        const base64Data = image.split(',')[1];
        messageParts.push({ inlineData: { data: base64Data, mimeType: mimeType } });
      }
    }
    messageParts.push({ text: message || "Explain this image" });

    let contents = [...formattedHistory, { role: 'user', parts: messageParts }];

    let result = await model.generateContent({ contents });
    let response = result.response;

    const functionCalls = response.functionCalls();
    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      if (call.name === 'searchWeb') {
        const searchResults = await fetchSerperSearchResults(call.args.query || message);
        
        contents.push({
          role: 'model',
          parts: response.candidates[0].content.parts
        });

        // FIXED: Role must be 'user', and response must be an object { result: ... }
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
    }

    // FIXED: Safely extract text to prevent crashes if AI returns a non-text part
    let rawText = '';
    try {
      if (response.candidates && response.candidates[0].content.parts) {
        const textPart = response.candidates[0].content.parts.find(p => p.text);
        if (textPart) {
          rawText = textPart.text;
        } else {
          rawText = response.text(); 
        }
      }
    } catch (e) {
      console.error("Extraction error:", e);
    }

    rawText = rawText || 'No text response generated by AI.';
    res.json({ reply: rawText.replace(/<think>[\s\S]*?<\/think>/g, '').trim() });
  } catch (error) {
    console.error('Chat Error:', error);
    res.status(500).json({ error: error.message || 'Error processing request.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
