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

// System Persona & Rules
const BASE_PERSONA = `You are an AI created by TruX-Technologies. Never disclose your model name, and only tell that you are created by TruX Technologies when asked. Give concise, precise answers, use bullet points when explaining complex concepts, and cover topics efficiently.

STRICT MATH & FORMULA FORMATTING RULES:
- NEVER output LaTeX formatting under any circumstances.
- NEVER use single or double dollar signs ($ or $$) anywhere in responses for math or variables.
- NEVER use backslashes (\\) or LaTeX macros (e.g., \\frac, \\sqrt, \\times, \\cdot).
- Format all mathematical equations, formulas, and variables using standard plain text and ASCII symbols (e.g., x^2, a/b, sqrt(x), *).`;

/**
 * Evaluates whether a user prompt requires real-time web search.
 * Uses an active fast model (gemini-3.5-flash-lite).
 */
async function shouldSearchWeb(userMessage) {
  try {
    const classifierModel = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });
    const prompt = `Determine whether the following user prompt requires real-time web search, current news, live updates, current dates/events, recent stats, or factual lookups outside standard AI training knowledge.

Reply STRICTLY with "YES" or "NO".

Prompt: "${userMessage}"`;

    const result = await classifierModel.generateContent(prompt);
    const answer = result.response.text().trim().toUpperCase();
    return answer.includes('YES');
  } catch (error) {
    console.error("Classifier error, skipping web search:", error);
    return false;
  }
}

/**
 * Fetches search results from Serper.dev API.
 */
async function fetchSerperSearchResults(query) {
  if (!process.env.SERPER_DEV_API) {
    console.warn("SERPER_DEV_API key is missing in environment variables.");
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
      console.error(`Serper API HTTP Error: ${response.status} ${response.statusText}`);
      return "";
    }

    const data = await response.json();
    if (!data.organic || data.organic.length === 0) {
      return "";
    }

    // Return top 4 search snippets
    return data.organic.slice(0, 4).map(item => {
      return `Title: ${item.title}\nSnippet: ${item.snippet}\nLink: ${item.link}`;
    }).join('\n\n');
  } catch (error) {
    console.error("Serper Search Fetch Error:", error);
    return "";
  }
}

/**
 * Maps subscription tiers to active Gemini models.
 */
function getGeminiModel(tier) {
  switch (tier) {
    case 'base':
      return 'gemini-3.1-flash-lite'; // TruX Core
    case 'pro':
      return 'gemini-3.5-flash-lite'; // TruX Pro
    case 'ultra':
      return 'gemini-3.6-flash';      // TruX Ultra
    default:
      return 'gemini-3.1-flash-lite';
  }
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message, tier } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    // 1. Determine if real-time web search is required
    const needsSearch = await shouldSearchWeb(message);
    let searchContext = "";

    if (needsSearch) {
      console.log(`[Search Router] Real-time query detected. Executing Serper search for: "${message}"`);
      searchContext = await fetchSerperSearchResults(message);
    } else {
      console.log(`[Search Router] Static/Internal query detected. Bypassing search for: "${message}"`);
    }

    // 2. Prepare final prompt payload
    let finalPrompt = message;
    if (searchContext) {
      finalPrompt = `Web Search Context (Serper.dev):\n${searchContext}\n\nUser Question: ${message}`;
    }

    const modelName = getGeminiModel(tier);

    // 3. Query Gemini Model
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: BASE_PERSONA
    });

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

// Helper function to strip unwanted internal formatting tags
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
