// server.js - OpenAI to NVIDIA NIM API Proxy
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 🔥 REASONING DISPLAY TOGGLE - Shows/hides reasoning in output
const SHOW_REASONING = true; // Set to true to show reasoning with <think> tags

// 🔥 THINKING MODE TOGGLE - Enables thinking for specific models that support it
const ENABLE_THINKING_MODE = true; // Set to true to enable chat_template_kwargs thinking parameter

// Model mapping configuration
// Maps incoming "model" names to the actual NVIDIA NIM model IDs
const MODEL_MAPPING = {
  // --- User Requested Mappings ---
  'gpt-3.5-turbo': 'z-ai/glm4.7',
  'gpt-4': 'deepseek-ai/deepseek-v3.2',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1-terminus', // Assuming '3.1-terminus' maps here, or use '3.1-terminus' directly
  
  // --- Direct Access keys (Allowing explicit request of these models) ---
  'z-ai/glm4.7': 'z-ai/glm4.7',
  'glm4.7': 'z-ai/glm4.7',
  
  'deepseek-v3.2': 'deepseek-ai/deepseek-v3.2',
  'deepseek-ai/deepseek-v3.2': 'deepseek-ai/deepseek-v3.2',
  
  '3.1-terminus': '3.1-terminus', // Ensure this ID exists in your API provider, or map to 'deepseek-ai/deepseek-v3.1'
  
  // --- Standard Fallbacks / Other Models ---
  'claude-3-opus': 'meta/llama-3.1-405b-instruct',
  'claude-3-sonnet': 'meta/llama-3.1-70b-instruct',
  'deepseek-r1': 'deepseek-ai/deepseek-r1'
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'OpenAI to NVIDIA NIM Proxy', 
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });
});

// List models endpoint (OpenAI compatible)
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  
  res.json({
    object: 'list',
    data: models
  });
});

// Chat completions endpoint (main proxy)
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    // 1. Smart model selection
    let nimModel = MODEL_MAPPING[model];
    
    // If no direct map found, check logic or passthrough
    if (!nimModel) {
      // If the model name is already a valid NIM ID (like "deepseek-ai/..."), use it directly
      if (model.includes('/') || model.includes('terminus')) {
        nimModel = model;
      } else {
        // Fallback logic for unmapped aliases
        const modelLower = model.toLowerCase();
        if (modelLower.includes('gpt-4') || modelLower.includes('opus')) {
          nimModel = 'deepseek-ai/deepseek-v3.2';
        } else if (modelLower.includes('terminus')) {
          nimModel = '3.1-terminus';
        } else if (modelLower.includes('glm')) {
          nimModel = 'z-ai/glm4.7';
        } else {
          nimModel = 'z-ai/glm4.7'; // Default fallback
        }
      }
    }
    
    console.log(`Proxying ${model} -> ${nimModel} (Stream: ${stream})`);

    // 2. Transform OpenAI request to NIM format
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 4096,
      extra_body: ENABLE_THINKING_MODE ? { chat_template_kwargs: { thinking: true } } : undefined,
      stream: stream || false
    };
    
    // 3. Make request to NVIDIA NIM API
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });
    
    if (stream) {
      // --- STREAMING HANDLER ---
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
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
                 const closingChunk = {
                    id: "closing-think",
                    object: "chat.completion.chunk",
                    created: Date.now(),
                    model: model,
                    choices: [{ index: 0, delta: { content: "\n</think>\n\n" }, finish_reason: null }]
                 };
                 res.write(`data: ${JSON.stringify(closingChunk)}\n\n`);
              }
              res.write('data: [DONE]\n\n');
              return;
            }
            
            try {
              const data = JSON.parse(dataStr);
              if (data.choices && data.choices[0].delta) {
                const delta = data.choices[0].delta;
                const reasoning = delta.reasoning_content;
                const content = delta.content;
                
                if (SHOW_REASONING) {
                  let newContent = '';
                  
                  if (reasoning && !reasoningStarted) {
                    newContent += '<think>\n' + reasoning;
                    reasoningStarted = true;
                  } else if (reasoning) {
                    newContent += reasoning;
                  }
                  
                  if (content && reasoningStarted) {
                    newContent += '\n</think>\n\n' + content;
                    reasoningStarted = false;
                  } else if (content) {
                    newContent += content;
                  }
                  
                  if (newContent) {
                    delta.content = newContent;
                    delete delta.reasoning_content;
                    res.write(`data: ${JSON.stringify(data)}\n\n`);
                  }
                } else {
                  if (reasoning) delete delta.reasoning_content;
                  if (content) res.write(`data: ${JSON.stringify(data)}\n\n`);
                }
              }
            } catch (e) { }
          }
        });
      });
      
      response.data.on('end', () => res.end());
      response.data.on('error', (err) => {
        console.error('Stream error:', err.message);
        res.end();
      });

    } else {
      // --- NON-STREAMING HANDLER ---
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => {
          let fullContent = choice.message?.content || '';
          if (SHOW_REASONING && choice.message?.reasoning_content) {
            fullContent = `<think>\n${choice.message.reasoning_content}\n</think>\n\n${fullContent}`;
          }
          return {
            index: choice.index,
            message: { role: choice.message.role, content: fullContent },
            finish_reason: choice.finish_reason
          };
        }),
        usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };
      res.json(openaiResponse);
    }
    
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

app.all('*', (req, res) => res.status(404).json({ error: { message: `Endpoint ${req.path} not found` } }));

app.listen(PORT, () => {
  console.log(`OpenAI to NVIDIA NIM Proxy running on port ${PORT}`);
  console.log(`Supported custom models: z-ai/glm4.7, deepseek-v3.2, 3.1-terminus`);
});
