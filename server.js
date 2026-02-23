const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());

const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'zai-org/glm-5',
  'gpt-4': 'zai-org/glm-4.7',
  'gpt-4o': 'deepseek-ai/deepseek-v3.2',
  'gpt-4-turbo': 'meta/llama-3.3-70b-instruct'
};

// 1. Health Check
app.get('/', (req, res) => res.send('Proxy is Live. Use this URL in CHUB with /v1 at the end.'));

// 2. Models Endpoint (Crucial for CHUB/Janitor)
app.get('/v1/models', (req, res) => {
  res.json({
    object: "list",
    data: Object.keys(MODEL_MAPPING).map(id => ({ id, object: "model", created: 1700000000, owned_by: "proxy" }))
  });
});

// 3. Chat Completions
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, stream, ...rest } = req.body;
    const targetModel = MODEL_MAPPING[model] || model;

    const payload = {
      model: targetModel,
      messages,
      stream: stream || false,
      ...rest,
      // 2026 NVIDIA Thinking Mode parameter
      chat_template_kwargs: { "enable_thinking": true }
    };

    const response = await axios({
      method: 'post',
      url: `${NIM_API_BASE}/chat/completions`,
      headers: { 'Authorization': `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
      data: payload,
      responseType: stream ? 'stream' : 'json'
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      response.data.pipe(res);
    } else {
      res.json(response.data);
    }
  } catch (error) {
    console.error('Proxy Error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json(error.response?.data || { error: "Internal Proxy Error" });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
