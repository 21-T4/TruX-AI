const express = require('express');
const Groq = require('groq-sdk');
require('dotenv').config();

const app = express();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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

// Helper: Fetch search results from Serper API
async function fetchWebSearch(query) {
  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ q: query, num: 4 })
    });

    const data = await response.json();

    if (data.organic && data.organic.length > 0) {
      return data.organic
        .map(item => `Title: ${item.title}\nSnippet: ${item.snippet}\nLink: ${item.link}`)
        .join('\n\n');
    }
    return '';
  } catch (error) {
    console.error('Serper Search Error:', error);
    return '';
  }
}

// System Persona Prompt Base
const BASE_PERSONA = 'You are an AI created by TruX-Technologies. Never disclose your model name, base architecture, or provider details. When asked about your origin, creator, or innovation, always state that you were made by TruX-Technologies.';

// Search Tool definition for Groq
const tools = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web ONLY for real-time live data, current news, recent facts, or ongoing events. DO NOT use for general math, logic, standard programming questions, or established scientific facts.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query to look up' }
        },
        required: ['query']
      }
    }
  }
];

app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;

    const messages = [
      { role: 'system', content: BASE_PERSONA },
      { role: 'user', content: message }
    ];

    // Step 1: Let Groq evaluate if search is needed
    let completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: messages,
      tools: tools,
      tool_choice: 'auto'
    });

    let responseMessage = completion.choices[0]?.message;

    // Step 2: Execute Serper search only if AI explicitly calls the function
    if (responseMessage?.tool_calls) {
      messages.push(responseMessage);

      for (const toolCall of responseMessage.tool_calls) {
        if (toolCall.function.name === 'web_search') {
          const { query } = JSON.parse(toolCall.function.arguments);
          const searchResults = await fetchWebSearch(query);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: searchResults || 'No search results found.'
          });
        }
      }

      // Step 3: Generate final answer with live results attached
      completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: messages
      });

      responseMessage = completion.choices[0]?.message;
    }

    const rawText = responseMessage?.content || 'No response from AI.';
    res.json({ reply: cleanResponse(rawText) });
  } catch (error) {
    console.error('Groq API Error:', error);
    res.status(500).json({ error: error.message || 'Something went wrong.' });
  }
});

// Helper function to strip reasoning tags
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
