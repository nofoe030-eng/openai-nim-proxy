const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Permissive CORS for CHUB/Janitor
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: '*',
  credentials: true
}));

app.use(express.json());

// --- CONFIGURATION ---
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'z-ai/glm4.7',
  'gpt-4': 'z-ai/glm5',
  'gpt-4o': 'deepseek-ai/deepseek-v3.2',
  'claude-3-opus': 'meta/llama-3.1-405b-instruct',
  'deepseek-v3.2': 'deepseek-ai/deepseek-v3.2'
};

// --- LOGGING MIDDLEWARE (Check Render Logs to see what CHUB hits) ---
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// --- CORE HANDLER ---
const handleChatRequest = async (req, res) => {
  const requestedModel = req.body.model || 'gpt-3.5-turbo';
  const targetModel = MODEL_MAPPING[requestedModel] || requestedModel;

  try {
    const { messages, stream, temperature, max_tokens } = req.body;

    const response = await axios({
      method: 'post',
      url: `${NIM_API_BASE}/chat/completions`,
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      data: {
        model: targetModel,
        messages,
        stream: stream || false,
        temperature: temperature || 0.7,
        max_tokens: max_tokens || 4096,
        chat_template_kwargs: { "enable_thinking": true } // 2026 NIM standard
      },
      responseType: stream ? 'stream' : 'json',
      timeout: 120000
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      response.data.on('data', (chunk) => {
        let payload = chunk.toString();
        // FORCE the model name to match what CHUB expects
        const masked = payload.replace(/"model":"[^"]+"/, `"model":"${requestedModel}"`);
        res.write(masked);
      });
      response.data.on('end', () => res.end());
    } else {
      // Mask model name in JSON response
      response.data.model = requestedModel;
      res.json(response.data);
    }
  } catch (error) {
    // CRITICAL: Always return JSON error to prevent CHUB TypeError
    console.error('API Error:', error.response?.data || error.message);
    const status = error.response?.status || 500;
    const errorBody = typeof error.response?.data === 'object' 
      ? error.response.data 
      : { error: { message: error.message, details: error.response?.data } };
    
    res.status(status).json(errorBody);
  }
};

// --- ROUTES (Covers all common CHUB misconfigurations) ---
app.post(['/v1/chat/completions', '/chat/completions', '/v1/v1/chat/completions'], handleChatRequest);

app.get(['/v1/models', '/models'], (req, res) => {
  res.json({
    object: "list",
    data: Object.keys(MODEL_MAPPING).map(id => ({ id, object: "model", created: 1700000000, owned_by: "proxy" }))
  });
});

app.get('/', (req, res) => res.json({ status: "online", proxy: "NVIDIA-NIM-CHUB" }));

// --- CATCH-ALL 404 (Ensures JSON instead of HTML) ---
app.use((req, res) => {
  res.status(404).json({ error: { message: `Route ${req.url} not found. Check your URL in CHUB settings.` } });
});

app.listen(PORT, () => console.log(`Proxy active on port ${PORT}`));
