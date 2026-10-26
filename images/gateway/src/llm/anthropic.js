import { postJson } from './http.js';

// Provider-neutral transcript -> Anthropic Messages API.
export function anthropicAdapter({ baseUrl, apiKey, model, timeoutMs }) {
  const base = baseUrl || 'https://api.anthropic.com';
  return {
    async complete({ system, transcript, tools }) {
      const messages = [];
      for (const m of transcript) {
        if (m.role === 'user') {
          messages.push({ role: 'user', content: [{ type: 'text', text: m.text }] });
        } else if (m.role === 'assistant') {
          const content = [];
          if (m.text) content.push({ type: 'text', text: m.text });
          for (const tc of m.toolCalls || []) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args || {} });
          if (content.length) messages.push({ role: 'assistant', content });
        } else if (m.role === 'tool') {
          const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.text || '(empty)', ...(m.isError ? { is_error: true } : {}) };
          const last = messages[messages.length - 1];
          if (last?.role === 'user' && last.content.every((c) => c.type === 'tool_result')) last.content.push(block);
          else messages.push({ role: 'user', content: [block] });
        }
      }
      const data = await postJson(`${base}/v1/messages`, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        timeoutMs,
        body: {
          model,
          max_tokens: 2048,
          system,
          messages,
          ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description || t.name, input_schema: t.inputSchema })) } : {}),
        },
      });
      const blocks = data.content || [];
      return {
        text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
        toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} })),
      };
    },
  };
}
