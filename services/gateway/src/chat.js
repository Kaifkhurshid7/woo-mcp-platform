/**
 * Chat agent loop.
 *
 * It talks to the gateway's own tool router, i.e. exactly the same exposure, permission, rate-limit,
 * timeout and audit path an external MCP client gets, and always as the logged-in user, so every call
 * lands in the audit log under that person with source "chat".
 *
 * With many tools (above `chatMaxDirectTools`) handing every schema to the model would waste its context,
 * so the agent switches to the search/describe/call meta-tools and discovers tools on demand.
 */
const MAX_RESULT_CHARS = 12000;

const textOf = (result) =>
  (Array.isArray(result?.content) ? result.content : [])
    .map((c) => (c.type === 'text' ? c.text : `[${c.type} content]`))
    .join('\n')
    .slice(0, MAX_RESULT_CHARS);

function systemPrompt(searchMode) {
  return [
    "You are the assistant inside a team's MCP gateway dashboard. You answer questions by calling the tools you are given.",
    `Today's date is ${new Date().toISOString().slice(0, 10)} (UTC).`,
    'Tool names look like <server>__<tool>; the prefix is the upstream server (for example woo = the WooCommerce store).',
    searchMode
      ? 'There are many tools, so you only see three: search_tools, describe_tool and call_tool. Search first, check the schema with describe_tool if unsure, then run the tool with call_tool.'
      : 'Prefer calling a tool over guessing.',
    'Never invent products, orders, prices or notes. If a tool fails, say what failed and why.',
    'Keep answers short and concrete. Mention which tools you used when it helps.',
  ].join('\n');
}

/** Unwrap call_tool so the trace shows the real tool that ran. */
function describeCall(call) {
  const name = call.name === 'call_tool' && call.args?.name ? String(call.args.name) : call.name;
  const args = call.name === 'call_tool' ? (call.args?.arguments ?? {}) : call.args;
  const [server, ...rest] = String(name).split('__');
  return { name, server: rest.length ? server : 'gateway', tool: rest.join('__') || name, args, viaSearch: call.name === 'call_tool' };
}

export function createChat({ cfg, router, llm }) {
  return {
    /**
     * @param {{id: string, email: string, role: string}} user the signed-in user the agent acts as
     * @param {Array<{role: string, content: string}>} history earlier turns
     * @param {string} message the new user message
     */
    async run(user, history, message) {
      if (!llm.configured) throw Object.assign(new Error(llm.reason), { status: 503 });

      const visible = router.exposedTools(user);
      const searchMode = visible.length > cfg.chatMaxDirectTools;
      const tools = searchMode ? router.META_TOOLS : visible;
      const transcript = [
        ...history.map((h) =>
          h.role === 'assistant' ? { role: 'assistant', text: h.content, toolCalls: [] } : { role: 'user', text: h.content },
        ),
        { role: 'user', text: message },
      ];
      const trace = [];
      let steps = 0;

      while (steps++ < cfg.llm.maxSteps) {
        const reply = await llm.complete({ system: systemPrompt(searchMode), transcript, tools });
        if (!reply.toolCalls.length) return { reply: reply.text || '(no answer)', toolCalls: trace, tools: visible.length, searchMode };

        transcript.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls });
        for (const call of reply.toolCalls) {
          const result = searchMode
            ? await router.callMetaTool(user, call.name, call.args, { source: 'chat' })
            : await router.callTool(user, call.name, call.args, { source: 'chat' });
          const out = textOf(result);
          const shown = describeCall(call);
          trace.push({ ...shown, isError: result.isError === true, output: out.slice(0, 4000) });
          transcript.push({ role: 'tool', toolCallId: call.id, name: call.name, text: out, isError: result.isError === true });
        }
      }
      return {
        reply: `I stopped after ${cfg.llm.maxSteps} tool-calling steps without reaching a final answer. The tools I called are listed below.`,
        toolCalls: trace,
        tools: visible.length,
        searchMode,
      };
    },
  };
}
