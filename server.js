const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. NUCLEAR CORS + PREFLIGHT FIX
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: '*',
  exposedHeaders: '*',
  credentials: true
}));

app.use(express.json());

// --- CONFIGURATION ---
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// Updated mappings for February 2026 (Check underscores vs dots in NVIDIA dashboard)
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'zai-org/glm-5', 
  'gpt-4': 'deepseek-ai/deepseek-v3.2',
  'gpt-4o': 'deepseek-ai/deepseek-v3.2',
  'claude-3-opus': 'meta/llama-3.3-70b-instruct',
  'deepseek-v3.2': 'deepseek-ai/deepseek-v3.2'
};

// --- LOGGING MIDDLEWARE (See exactly what CHUB is sending in Render Logs) ---
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// --- PATH FIXER: Handles cases where CHUB adds extra segments ---
const handleChat = async (req, res) => {
  const requestedModel = req.body.model || 'gpt-3.5-turbo';
  
  try {
    const { model, messages, stream, ...rest } = req.body;
    const targetModel = MODEL_MAPPING[model] || model;

    console.log(`[PROXY] Mapping ${model} -> ${targetModel}`);

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
        ...rest,
        chat_template_kwargs: { thinking: true } // Standard for 2026 reasoning
      },
      responseType: stream ? 'stream' : 'json',
      timeout: 120000
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');

      response.data.on('data', (chunk) => {
        let payload = chunk.toString();
        // FORCE the model name in every chunk to match what CHUB requested
        // This prevents the "Unparseable" error
        const modifiedPayload = payload.replace(/"model":"[^"]+"/, `"model":"${requestedModel}"`);
        res.write(modifiedPayload);
      });

      response.data.on('end', () => res.end());
    } else {
      // Non-streaming: Mask model name
      response.data.model = requestedModel;
      res.json(response.data);
    }
  } catch (error) {
    console.error('[ERROR]', error.response?.data || error.message);
    res.status(error.response?.status || 500).json(error.response?.data || { error: "Proxy Error" });
  }
};

// Catch all variations of the completions path
app.post('/v1/chat/completions', handleChat);
app.post('/chat/completions', handleChat);

// --- MODELS LIST (Crucial for CHUB "Check" button) ---
const handleModels = (req, res) => {
  res.json({
    object: "list",
    data: Object.keys(MODEL_MAPPING).map(id => ({ id, object: "model", created: 1700000000, owned_by: "proxy" }))
  });
};
app.get('/v1/models', handleModels);
app.get('/models', handleModels);

// Root check
app.get('/', (req, res) => res.send('Proxy is Online. Use this URL in CHUB.'));

app.listen(PORT, () => console.log(`Proxy active on port ${PORT}`));
