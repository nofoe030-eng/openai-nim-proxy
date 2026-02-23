const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. NUCLEAR CORS (Maximum Permissiveness for Chub)
app.use(cors({
  origin: '*', // Absolute wildcard is required for some Chub browser configurations
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: '*', // Allows all headers Chub might send (like x-requested-with)
  exposedHeaders: '*',
  credentials: true
}));

app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  res.sendStatus(204);
});

app.use(express.json());

// --- CONFIGURATION ---
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const SHOW_REASONING = true; 
const ENABLE_THINKING_MODE = true;

// --- MODEL MAPPINGS ---
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'z-ai/glm4.7',
  'gpt-4': 'z-ai/glm5',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1-terminus',
  'z-ai/glm4.7': 'z-ai/glm4.7',
  'deepseek-v3.2': 'deepseek-ai/deepseek-v3.2',
  '3.1-terminus': 'deepseek-ai/deepseek-v3.1-terminus',
  'claude-3-opus': 'meta/llama-3.1-405b-instruct',
  'claude-3-sonnet': 'meta/llama-3.1-70b-instruct'
};

// --- HEALTH CHECK ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', proxy: 'Chub-Optimized' });
});

// --- LIST MODELS (Required for Chub "Check Proxy" button) ---
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(id => ({
    id: id, object: 'model', created: 1677610602, owned_by: 'openai'
  }));
  res.json({ object: 'list', data: models });
});

// --- CHAT GENERATION ---
app.post('/v1/chat/completions', async (req, res) => {
  const requestedModel = req.body.model; // Store what Chub wants to see
  console.log(`[REQUEST] Chub requested: ${requestedModel}`);

  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    let nimModel = MODEL_MAPPING[model] || 'meta/llama-3.1-70b-instruct';

    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.7,
      max_tokens: max_tokens || 4096,
      stream: stream || false
    };

    if (ENABLE_THINKING_MODE) {
      nimRequest.extra_body = { chat_template_kwargs: { thinking: true } };
    }

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json',
      timeout: 120000 
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); 

      let reasoningStarted = false;

      response.data.on('data', (chunk) => {
        const payload = chunk.toString();
        const lines = payload.split('\n');

        for (let line of lines) {
          if (!line.startsWith('data: ')) continue;
          if (line.includes('[DONE]')) {
            res.write('data: [DONE]\n\n');
            continue;
          }

          try {
            const data = JSON.parse(line.replace('data: ', ''));
            
            // 2. MODEL MASKING: Overwrite NVIDIA name with the one Chub requested
            data.model = requestedModel;

            const delta = data.choices[0].delta;
            if (SHOW_REASONING) {
              if (delta.reasoning_content) {
                if (!reasoningStarted) {
                  delta.content = "<think>\n" + delta.reasoning_content;
                  reasoningStarted = true;
                } else {
                  delta.content = delta.reasoning_content;
                }
                delete delta.reasoning_content;
              } else if (delta.content && reasoningStarted) {
                delta.content = "\n</think>\n\n" + delta.content;
                reasoningStarted = false;
              }
            }

            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } catch (e) {}
        }
      });

      response.data.on('end', () => res.end());
    } else {
      // Non-streaming: also mask the model name
      response.data.model = requestedModel;
      res.json(response.data);
    }

  } catch (error) {
    console.error('Proxy Error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json(
      error.response?.data || { error: { message: "Internal Proxy Error" } }
    );
  }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
