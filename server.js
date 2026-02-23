// 1. IMPROVED CORS (More explicit for browser-based frontends)
app.use(cors({
  origin: true, // Reflects the request origin, better for some browsers than '*'
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'OpenAI-Organization'] 
}));

// Handle OPTIONS preflight explicitly
app.options('*', cors());

// 2. OPTIMIZED CHAT COMPLETIONS
app.post('/v1/chat/completions', async (req, res) => {
  console.log(`[REQUEST] Model: ${req.body.model} | Stream: ${req.body.stream}`);

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

    // Add thinking mode only if requested
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
            const delta = data.choices[0].delta;

            // Merge Reasoning into Content (Crucial for Chub to see DeepSeek "thoughts")
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
          } catch (e) {
            // Silently skip partial/malformed JSON chunks
          }
        }
      });

      response.data.on('end', () => res.end());
    } else {
      res.json(response.data);
    }

  } catch (error) {
    console.error('Proxy Error:', error.response?.data || error.message);
    // Ensure we ALWAYS return a JSON error so Chub doesn't see "Empty Response"
    res.status(error.response?.status || 500).json(
      error.response?.data || { error: { message: "Internal Proxy Error" } }
    );
  }
});
