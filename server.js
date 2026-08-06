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
const BASE_PERSONA = `You are an AI created by TruX-Technologies. Never disclose your model name, and only tell that you are created by TruX Technologies when asked.
Don't type very long answers only give short, precise, concise and informative answers.
STRICT MATH & FORMULA FORMATTING RULES:
- NEVER output LaTeX formatting under any circumstances.
- NEVER use single or double dollar signs ($ or $$) anywhere in responses for math or variables.
- NEVER use backslashes (\\) or LaTeX macros (e.g., \\frac, \\sqrt, \\times, \\cdot).
- Format all mathematical equations, formulas, and variables using standard plain text and ASCII symbols (e.g., x^2, a/b, sqrt(x), *).`;

// Function declaration telling Gemini when it should request a web search
const searchWebDeclaration = {
  name: 'searchWeb',
  description: 'Search the live web using Google/Serper. ONLY call this function if you require real-time information, current dates, recent news, live scores, live weather, or updated facts outside your training knowledge. DO NOT call this for greetings, casual conversation, math, coding, or standard known facts.',
  parameters: {
    type: 'OBJECT',
    properties: {
      query: {
        type: 'STRING',
        description: 'The search query keywords.'
      }
    },
    required: ['query']
  }
};

/**
 * Fetches search results from Serper.dev API.
 */
async function fetchSerperSearchResults(query) {
  if (!process.env.SERPER_DEV_API) {
    console.warn("SERPER_DEV_API key is missing in environment variables.");
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

    if (!response.ok) {
      console.error(`Serper API HTTP Error: ${response.status} ${response.statusText}`);
      return "Search failed.";
    }

    const data = await response.json();
    if (!data.organic || data.organic.length === 0) {
      return "No search results found.";
    }

    return data.organic.slice(0, 4).map(item => {
      return `Title: ${item.title}\nSnippet: ${item.snippet}\nLink: ${item.link}`;
    }).join('\n\n');
  } catch (error) {
    console.error("Serper Search Fetch Error:", error);
    return "Search error occurred.";
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

    const modelName = getGeminiModel(tier);

    // Initialize Gemini with tool declaration
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: BASE_PERSONA,
      tools: [{ functionDeclarations: [searchWebDeclaration] }]
    });

    const chat = model.startChat();
    let result = await chat.sendMessage(message);

    // Check if Gemini requested to call searchWeb
    const functionCalls = result.response.functionCalls();

    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      if (call.name === 'searchWeb') {
        const searchQuery = call.args.query || message;
        console.log(`[Gemini Tool Call] Web search requested for: "${searchQuery}"`);

        // Execute Serper search
        const searchResults = await fetchSerperSearchResults(searchQuery);

        // Send search results back to Gemini to complete its answer
        result = await chat.sendMessage([
          {
            functionResponse: {
              name: 'searchWeb',
              response: { results: searchResults }
            }
          }
        ]);
      }
    } else {
      console.log(`[Gemini Direct Response] Bypassed web search.`);
    }

    const rawText = result.response.text() || 'No response from AI.';
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
