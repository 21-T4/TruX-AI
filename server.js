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

app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;

    // Fetch live context from Serper
    const searchContext = await fetchWebSearch(message);

    // Append search results to persona prompt if available
    let systemPromptContent = BASE_PERSONA;
    if (searchContext) {
      systemPromptContent += `\n\nUse the following real-time web search context to accurately answer the user request:\n\n--- SEARCH CONTEXT ---\n${searchContext}\n----------------------`;
    }

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPromptContent },
        { role: 'user', content: message }
      ],
    });

    const rawText = completion.choices[0]?.message?.content || 'No response from AI.';
    const cleanedText = cleanResponse(rawText);

    res.json({ reply: cleanedText });
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
