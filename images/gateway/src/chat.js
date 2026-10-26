const MAX_RESULT_CHARS = 12000;

const textOf = (result) =>
  (Array.isArray(result?.content) ? result.content : [])
    .map((c) => (c.type === 'text' ? c.text : `[${c.type} content]`))
    .join('\n')
    .slice(0, MAX_RESULT_CHARS);

function systemPrompt() {
  return [
    "You are the assistant inside a team's MCP gateway dashboard. You answer questions by calling the tools you are given.",
    `Today's date is ${new Date().toISOString().slice(0, 10)} (UTC).`,
    'Tool names look like <server>__<tool>; the prefix is the upstream server (for example woo = the WooCommerce store).',
    'Prefer calling a tool over guessing. Never invent products, orders, prices or notes. If a tool fails, say what failed and why.',
    'Keep answers short and concrete. Mention which tools you used when it helps.',
  ].join('\n');
}

/**
 * Chat agent loop. It talks to the *gateway's own* tool router, i.e. exactly the same exposure,
 * permission, rate-limit, timeout and audit path an external MCP client gets, and always as the
 * logged-in user, so every call lands in the audit log under that person with source "chat".
 */
export function createChat({ cfg, router, llm }) {
  return {
    async run(user, history, message) {
      if (!llm.configured) throw Object.assign(new Error(llm.reason), { status: 503 });

      const tools = router.exposedTools(user);
      const transcript = [
        ...history.map((h) => (h.role === 'assistant' ? { role: 'assistant', text: h.content, toolCalls: [] } : { role: 'user', text: h.content })),
        { role: 'user', text: message },
      ];
      const trace = [];
      let steps = 0;

      while (steps++ < cfg.llm.maxSteps) {
        const reply = await llm.complete({ system: systemPrompt(), transcript, tools });
        if (!reply.toolCalls.length) return { reply: reply.text || '(no answer)', toolCalls: trace, tools: tools.length };

        transcript.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls });
        for (const call of reply.toolCalls) {
          const result = await router.callTool(user, call.name, call.args, { source: 'chat' });
          const out = textOf(result);
          const [server, ...rest] = String(call.name).split('__');
          trace.push({ name: call.name, server, tool: rest.join('__') || call.name, args: call.args, isError: result.isError === true, output: out.slice(0, 4000) });
          transcript.push({ role: 'tool', toolCallId: call.id, name: call.name, text: out, isError: result.isError === true });
        }
      }
      return { reply: `I stopped after ${cfg.llm.maxSteps} tool-calling steps without reaching a final answer. The tools I called are listed below.`, toolCalls: trace, tools: tools.length };
    },
  };
}
