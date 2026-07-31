const express = require('express');
const Groq = require('groq-sdk');
require('dotenv').config();

const app = express();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(express.json());
// Serves your public/index.html automatically
app.use(express.static('public'));

// ==========================================
// 1. FIREBASE CONFIG ENDPOINT
// ==========================================
// The frontend fetches this to safely get the API key
const firebaseConfig = {
  apiKey: "AIzaSyAs_GDrzlBaucHfiff0Y6cA8GVHjFTA62Q",
  authDomain: "trux-ai.firebaseapp.com",
  projectId: "trux-ai",
  storageBucket: "trux-ai.firebasestorage.app",
  messagingSenderId: "59313097411",
  appId: "1:59313097411:web:32e4158bfb733fa7cfb076",
  measurementId: "G-C32LC29QHC",
  // ... other config fields
};
// Endpoint so your frontend can safely fetch the config
app.get('/api/config', (req, res) => {
  res.json(firebaseConfig);
});

// ==========================================
// 2. GROQ AI CHAT ENDPOINT
// ==========================================
// Tier to Groq Model Mapping
const modelMap = {
  base: 'llama-3.1-8b-instant',
  pro: 'qwen/qwen3.6-27b',
  ultra: 'openai/gpt-oss-120b'
};

app.post('/api/chat', async (req, res) => {
  try {
    const { message, tier } = req.body;
    const selectedModel = modelMap[tier] || modelMap.base;

    const completion = await groq.chat.completions.create({
      model: selectedModel,
      messages: [{ role: 'user', content: message }],
    });

    const reply = completion.choices[0]?.message?.content || 'No response from AI.';
    res.json({ reply });
  } catch (error) {
    console.error('Groq API Error:', error);
    res.status(500).json({ error: error.message || 'Something went wrong.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 TruX-AI running at http://localhost:${PORT}\n`);
});
