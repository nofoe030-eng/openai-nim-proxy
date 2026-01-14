// server.js - Render/JanitorAI Optimized Proxy
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CRITICAL: CORS SETUP FOR JANITORAI/CHUB ---
app.use(cors({
  origin: '*', // Allow all origins (JanitorAI, Chub, Localhost)
  methods: ['GET', 'POST', 'OPTIONS'], // Allow these HTTP methods
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'], // Allow Auth headers
  credentials: true
}));

app.use(express.json());

// --- CONFIGURATION ---
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY; // Make sure this is set in Render Env Vars!

const SHOW_REASONING = true; 
const ENABLE_THINKING_MODE = true;

// --- MODEL MAPPINGS ---
const MODEL_MAPPING = {
  // Aliases for JanitorAI/Chub
  'gpt-3.5-turbo': 'z-ai/glm4.7',
  'gpt-4': 'deepseek-ai/deepseek-v3.2',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1-terminus', // Ensure this ID is valid on NVIDIA, or map to 'meta/llama-3.1-70b-instruct'
  
  // Direct access
  'z-ai/glm4.7': 'z-ai/glm4.7',
  'deepseek-v3.2': 'deepseek-ai/deepseek-v3.2',
  '3.1-terminus': 'deepseek-ai/deepseek-v3.1-terminus', // Placeholder ID
  
  // Fallbacks
  'claude-3-opus': 'meta/llama-3.1-405b-instruct',
  'claude-3-sonnet': 'meta/llama-3.1-70b-instruct'
};

// --- HEALTH CHECK ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Render Proxy Active', models_loaded: Object.keys(MODEL_MAPPING).length });
});

// --- LIST MODELS ---
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(id => ({
    id: id, object: 'model', created: Date.now(), owned_by: 'proxy'
  }));
  res.json({ object: 'list', data: models });
});

// --- CHAT GENERATION ---
app.post('/v1/chat/completions', async (req, res) => {
  // 1. Log Incoming Request (Check Render Logs if this doesn't appear)
  console.log(`[INCOMING] Model: ${req.body.model} | Stream: ${req.body.stream}`);

  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    // Model Selection Logic
    let nimModel = MODEL_MAPPING[model];
    if (!nimModel) {
      // Fallback heuristics
      const lower = model.toLowerCase();
      if (lower.includes('glm')) nimModel = 'z-ai/glm4.7';
      else if (lower.includes('deepseek')) nimModel = 'deepseek-ai/deepseek-v3.2';
      else nimModel = 'meta/llama-3.1-70b-instruct';
    }

    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.7,
      max_tokens: max_tokens || 4096,
      extra_body: ENABLE_THINKING_MODE ? { chat_template_kwargs: { thinking: true } } : undefined,
      stream: stream || false
    };

    // 2. Request to NVIDIA
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json',
      timeout: 120000 // 2 minute timeout
    });

    if (stream) {
      // --- CRITICAL FOR RENDER: DISABLE BUFFERING ---
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // <--- FIXES RENDER STREAMING ISSUES

      let buffer = '';
      let reasoningStarted = false;

      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        lines.forEach(line => {
          if (line.trim() === '') return;
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6);
            if (dataStr.trim() === '[DONE]') {
              if (SHOW_REASONING && reasoningStarted) {
                 res.write(`data: ${JSON.stringify({
                    choices: [{ delta: { content: "\n</think>\n\n" } }]
                 })}\n\n`);
              }
              res.write('data: [DONE]\n\n');
              return;
            }

            try {
              const data = JSON.parse(dataStr);
              if (data.choices?.[0]?.delta) {
                const delta = data.choices[0].delta;
                
                // Reasoning logic
                if (SHOW_REASONING) {
                  let contentPayload = "";
                  if (delta.reasoning_content) {
                    if (!reasoningStarted) { contentPayload += "<think>\n"; reasoningStarted = true; }
                    contentPayload += delta.reasoning_content;
                  }
                  if (delta.content) {
                    if (reasoningStarted) { contentPayload += "\n</think>\n\n"; reasoningStarted = false; }
                    contentPayload += delta.content;
                  }
                  
                  if (contentPayload) {
                    delta.content = contentPayload;
                    delete delta.reasoning_content;
                    res.write(`data: ${JSON.stringify(data)}\n\n`);
                  }
                } else {
                    // Standard pass-through
                    if(delta.content) res.write(`data: ${JSON.stringify(data)}\n\n`);
                }
              }
            } catch (e) {}
          }
        });
      });

      response.data.on('end', () => res.end());
      response.data.on('error', (err) => { console.error('Stream Error:', err); res.end(); });

    } else {
      res.json(response.data);
    }

  } catch (error) {
    // --- DETAILED ERROR LOGGING ---
    console.error('API Error:', error.message);
    if (error.response) {
        console.error('NVIDIA Response Status:', error.response.status);
        console.error('NVIDIA Response Data:', JSON.stringify(error.response.data, null, 2));
        
        return res.status(error.response.status).json(error.response.data);
    }
    res.status(500).json({ error: { message: "Proxy Connection Failed" } });
  }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
