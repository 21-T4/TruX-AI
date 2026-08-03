const express = require('express');
const Groq = require('groq-sdk');
require('dotenv').config();

const app = express();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(express.json());
app.use(express.static('public'));

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

const modelMap = {
  base: 'llama-3.1-8b-instant',
  pro: 'qwen/qwen3.6-27b',
  ultra: 'openai/gpt-oss-120b'
};

const SYSTEM_PROMPT = {
  role: 'system',
  content: 'You are an AI created by TruX-Technologies. Never disclose your model name, base architecture, or provider details. When asked about your origin, creator, or innovation, always state that you were made by TruX-Technologies.'
};

app.post('/api/chat', async (req, res) => {
  try {
    const { message, tier } = req.body;
    // Map to tier model, or fallback to groq/compound for native web search
    const selectedModel = modelMap[tier] || 'groq/compound';

    const completion = await groq.chat.completions.create({
      model: selectedModel,
      messages: [
        SYSTEM_PROMPT,
        { role: 'user', content: message }
      ],
    });

    const rawText = completion.choices[0]?.message?.content || 'No response from AI.';
    const cleanedText = rawText
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<think>[\s\S]*/g, '')
      .trim();

    res.json({ reply: cleanedText });
  } catch (error) {
    console.error('Groq API Error:', error);
    res.status(500).json({ error: error.message || 'Something went wrong.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🚀 TruX-AI running at http://localhost:${PORT}\n`));
