// Deterministic, rule-based "model" for automated tests and offline demos (LLM_PROVIDER=mock).
// It is NOT an LLM: it pattern-matches the last user message and emits tool calls so the
// tool loop, audit attribution and gateway routing can be exercised without any API key.
export function mockAdapter() {
  const find = (tools, suffix) => tools.find((t) => t.name.endsWith(`__${suffix}`));
  return {
    async complete({ transcript, tools }) {
      const last = transcript[transcript.length - 1];
      if (last?.role === 'tool') {
        const results = transcript.slice(transcript.map((m) => m.role).lastIndexOf('assistant') + 1).filter((m) => m.role === 'tool');
        return { text: `Done. ${results.map((r) => `${r.name}: ${r.text.slice(0, 400)}`).join('\n')}`, toolCalls: [] };
      }
      const text = last?.text || '';
      const calls = [];
      const create = /create (?:a )?product (?:named |called )?["']?(.+?)["']? (?:priced|at|for|with price)\s*\$?(\d+(?:\.\d+)?)/i.exec(text);
      if (create && find(tools, 'create_product')) {
        calls.push({ name: find(tools, 'create_product').name, args: { name: create[1], regular_price: create[2] } });
      } else if (/orders?/i.test(text) && find(tools, 'list_orders')) {
        calls.push({ name: find(tools, 'list_orders').name, args: { date: 'today' } });
      } else if (/products?/i.test(text) && find(tools, 'list_products')) {
        calls.push({ name: find(tools, 'list_products').name, args: {} });
      }
      if (/ping/i.test(text)) for (const t of tools.filter((x) => x.name.endsWith('__ping'))) calls.push({ name: t.name, args: {} });
      if (!calls.length) return { text: 'Mock model: I only understand "create product X priced N", "orders", "products" and "ping".', toolCalls: [] };
      return { text: '', toolCalls: calls.map((c, i) => ({ id: `mock_${Date.now()}_${i}`, ...c })) };
    },
  };
}
