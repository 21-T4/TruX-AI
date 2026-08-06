const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();

// Initialize Gemini API using GEMINI_API_KEY from environment variables
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.use(express.json());
app.use(express.static('public'));

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

// System Persona
const BASE_PERSONA = `You are an AI created by TruX-Technologies. Never disclose your model name, and only tell that you are created by TruX Technologies when asked, give very short and precise answers, use bullet points (only when explaining something or when needed), cover vast topic with less words.

STRICT MATH & FORMULA FORMATTING RULES:
- NEVER output LaTeX formatting under any circumstances.
- NEVER use single or double dollar signs ($ or $$) anywhere in responses for math or variables.
- NEVER use backslashes (\\) or LaTeX macros (e.g., \\frac, \\sqrt, \\times, \\cdot).
- Format all mathematical equations, formulas, and variables using standard plain text and ASCII symbols (e.g., x^2, a/b, sqrt(x), *).`;

// Helper function to search web using Serper.dev API
async function fetchSerperSearchResults(query) {
  if (!process.env.SERPER_DEV_API) {
    console.warn("SERPER_DEV_API key is not set in environment variables.");
    return "";
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

    if (!response.ok) {
      console.error(`Serper API error: ${response.statusText}`);
      return "";
    }

    const data = await response.json();
    if (!data.organic || data.organic.length === 0) {
      return "";
    }

    // Extract top 4 search results
    const results = data.organic.slice(0, 4).map(item => {
      return `Title: ${item.title}\nSnippet: ${item.snippet}\nLink: ${item.link}`;
    }).join('\n\n');

    return results;
  } catch (error) {
    console.error("Serper Search Fetch Error:", error);
    return "";
  }
}

// Model selection helper based on tiers
function getGeminiModel(tier) {
  switch (tier) {
    case 'base':
      return 'gemini-2.0-flash'; // TruX Core
    case 'pro':
      return 'gemini-2.0-flash'; // TruX Pro
    case 'ultra':
      return 'gemini-1.5-pro';   // TruX Ultra
    default:
      return 'gemini-2.0-flash';
  }
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message, tier } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    // Fetch search results from Serper.dev
    const searchContext = await fetchSerperSearchResults(message);

    // Combine web context with the user query if available
    let finalPrompt = message;
    if (searchContext) {
      finalPrompt = `Web Search Context (Real-time data from Serper.dev):\n${searchContext}\n\nUser Question: ${message}`;
    }

    const modelName = getGeminiModel(tier);

    // Initialize Gemini model (Google Search grounding removed)
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: BASE_PERSONA
    });

    // Generate completion
    const result = await model.generateContent(finalPrompt);
    const response = await result.response;
    const rawText = response.text() || 'No response from AI.';

    const cleanedText = cleanResponse(rawText);

    res.json({ reply: cleanedText });
  } catch (error) {
    console.error('Gemini API Error:', error);
    res.status(500).json({ error: error.message || 'Something went wrong with the AI request.' });
  }
});

// Helper function to clean text
function cleanResponse(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*/g, '')
    .trim();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 TruX-AI running at http://localhost:${PORT}\n`);
});
