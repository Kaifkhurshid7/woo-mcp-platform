import { postJson } from './http.js';

// Provider-neutral transcript -> OpenAI-compatible Chat Completions.
// Works with OpenAI, Groq, OpenRouter, Google's Gemini OpenAI endpoint, and local servers such as
// Ollama (http://ollama:11434/v1) or vLLM, which makes free tiers and local models easy.
export function openaiAdapter({ baseUrl, apiKey, model, timeoutMs }) {
  const base = baseUrl || 'https://api.openai.com/v1';
  return {
    async complete({ system, transcript, tools }) {
      const messages = [{ role: 'system', content: system }];
      for (const m of transcript) {
        if (m.role === 'user') messages.push({ role: 'user', content: m.text });
        else if (m.role === 'assistant') {
          const msg = { role: 'assistant', content: m.text || null };
          if (m.toolCalls?.length) {
            msg.tool_calls = m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) } }));
          }
          messages.push(msg);
        } else if (m.role === 'tool') {
          messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.text || '(empty)' });
        }
      }
      const data = await postJson(`${base}/chat/completions`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        timeoutMs,
        body: {
          model,
          messages,
          ...(tools.length
            ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || t.name, parameters: t.inputSchema } })), tool_choice: 'auto' }
            : {}),
        },
      });
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error('Language model returned no message');
      return {
        text: (msg.content || '').trim(),
        toolCalls: (msg.tool_calls || []).map((tc, i) => {
          let args = {};
          try {
            args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            args = {};
          }
          return { id: tc.id || `call_${i}`, name: tc.function?.name, args };
        }),
      };
    },
  };
}
