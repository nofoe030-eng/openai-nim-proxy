// server.js - Render/JanitorAI/Chub Optimized Proxy
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CRITICAL: AGGRESSIVE CORS SETUP FOR CHUB/JANITOR ---
// Using origin: true reflects the request origin, which is more reliable for browser-based tools.
app.use(cors({
  origin: true, 
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'OpenAI-Organization'] 
}));

// Explicitly handle OPTIONS preflight requests to prevent NetworkErrors in the browser.
app.options('*', cors());

app.use(express.json());

// --- CONFIGURATION ---
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const SHOW_REASONING = true;
const ENABLE_THINKING_MODE = true;

// --- MODEL MAPPINGS ---
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'z-ai/glm4.7',
  'gpt-4': 'deepseek-ai/deepseek-v3.2',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1-terminus', 
  'z-ai/glm4.7': 'z-ai/glm4.7',
  'deepseek-v3.2': 'deepseek-ai/deepseek-v3.2',
  '3.1-terminus': 'deepseek-ai/deepseek-v3.1-terminus',
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
  console.log(`[INCOMING] Model: ${req.body.model} | Stream: ${req.body.stream}`);

  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    let nimModel = MODEL_MAPPING[model];
    if (!nimModel) {
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
      res.setHeader('X-Accel-Buffering', 'no'); // Prevents Render from buffering the stream

      let reasoningStarted = false;

      response.data.on('data', (chunk) => {
        const payload = chunk.toString();
        const lines = payload.split('\n');

        for (let line of lines) {
          if (!line.trim() || !line.startsWith('data: ')) continue;
          
          const dataStr = line.replace('data: ', '').trim();
          if (dataStr === '[DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
          }

          try {
            const data = JSON.parse(dataStr);
            if (data.choices?.[0]?.delta) {
              const delta = data.choices[0].delta;
              
              if (SHOW_REASONING) {
                // Merge reasoning_content into content for Chub/Janitor compatibility
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
            }
          } catch (e) {
            // Ignore partial JSON chunks
          }
        }
      });

      response.data.on('end', () => res.end());
      response.data.on('error', (err) => { console.error('Stream Error:', err); res.end(); });

    } else {
      res.json(response.data);
    }

  } catch (error) {
    console.error('API Error:', error.message);
    const status = error.response?.status || 500;
    const errorData = error.response?.data || { error: { message: "Proxy Connection Failed" } };
    
    // Always return JSON error to prevent "Empty response" errors in Chub
    res.status(status).json(errorData); 
  }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
