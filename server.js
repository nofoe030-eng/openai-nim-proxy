// server.js - Optimized for Chub.ai & NVIDIA NIM
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['*'] }));
app.use(express.json());

const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// --- CRITICAL FOR CHUB: MODEL MAPPING ---
// Chub.ai typically only lets you select "gpt-4" or "gpt-3.5-turbo" 
// in its UI. We map those names to NVIDIA's specific model IDs here.
const MODEL_MAPPING = {
  'gpt-4': 'z-ai/glm4.7', // DeepSeek V3 is best for RP
  'gpt-4o': 'meta/llama-3.1-405b-instruct',
  'gpt-3.5-turbo': 'meta/llama-3.1-8b-instruct',
  'deepseek-r1': 'deepseek-ai/deepseek-r1'
};

// --- CHUB HEALTH CHECK ENDPOINT ---
app.get('/v1/models', (req, res) => {
  res.json({
    object: "list",
    data: Object.keys(MODEL_MAPPING).map(id => ({
      id: id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "nvidia"
    }))
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, stream, ...rest } = req.body;
    
    // Map the model name or default to a safe one
    const targetModel = MODEL_MAPPING[model] || model || 'deepseek-ai/deepseek-v3';

    const nimRequest = {
      model: targetModel,
      messages,
      stream: stream || false,
      ...rest
    };

    const response = await axios({
      method: 'post',
      url: `${NIM_API_BASE}/chat/completions`,
      data: nimRequest,
      headers: { 
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json' 
      },
      responseType: stream ? 'stream' : 'json'
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let reasoningStarted = false;
      let reasoningEnded = false;

      response.data.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        for (let line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const data = JSON.parse(line.slice(6));
              const delta = data.choices[0].delta;
              let contentToSend = "";

              // --- FIXED REASONING LOGIC FOR CHUB ---
              // We convert reasoning_content into a <think> block inside the main content
              if (delta.reasoning_content) {
                if (!reasoningStarted) {
                  contentToSend = "<think>\n" + delta.reasoning_content;
                  reasoningStarted = true;
                } else {
                  contentToSend = delta.reasoning_content;
                }
              } else if (delta.content) {
                if (reasoningStarted && !reasoningEnded) {
                  contentToSend = "\n</think>\n\n" + delta.content;
                  reasoningEnded = true;
                } else {
                  contentToSend = delta.content;
                }
              }

              if (contentToSend) {
                // IMPORTANT: We modify the delta to look exactly like standard OpenAI
                data.choices[0].delta = { content: contentToSend };
                res.write(`data: ${JSON.stringify(data)}\n\n`);
              }
            } catch (e) { /* Ignore partial chunks */ }
          } else if (line === 'data: [DONE]') {
            res.write('data: [DONE]\n\n');
          }
        }
      });

      response.data.on('end', () => res.end());
    } else {
      // Non-streaming fix: Ensure the reasoning is wrapped in the final JSON
      if (response.data.choices[0].message.reasoning_content) {
        const r = response.data.choices[0].message;
        r.content = `<think>\n${r.reasoning_content}\n</think>\n\n${r.content || ""}`;
        delete r.reasoning_content;
      }
      res.json(response.data);
    }

  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json(error.response?.data || { error: "Proxy Error" });
  }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
