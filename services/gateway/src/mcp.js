/**
 * The gateway's own MCP endpoints (Streamable HTTP, stateless).
 *
 *   POST /mcp          every tool of every enabled server, named <server>__<tool>
 *   POST /mcp/search   three meta-tools (search_tools, describe_tool, call_tool) for catalogues too large to
 *                      hand to a model in one piece
 *
 * Stateless means no session is kept between requests, so any gateway replica can serve any request and
 * nothing is lost when a pod restarts. A fresh MCP Server is built per request and closed afterwards; the
 * authenticated user is captured in the closure.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const INSTRUCTIONS =
  'This gateway aggregates several MCP servers. Every tool is named <server>__<tool>, so the prefix tells you ' +
  'which server a tool belongs to. Tools of unreachable or disabled servers are not listed.';

const SEARCH_INSTRUCTIONS =
  'This gateway has too many tools to list. Call search_tools with a short description of what you want to do, ' +
  'then describe_tool for the input schema, then call_tool with the exact tool name and its arguments.';

/**
 * @param {import('express').Express} app
 * @param {{auth: object, router: object, upstreams: object}} deps
 */
export function mountMcp(app, { auth, router, upstreams }) {
  /** Build the request handler for one endpoint flavour. */
  const handler = (mode) => async (req, res) => {
    const user = req.user;
    await upstreams.ensureFresh();
    const server = new Server(
      { name: 'mcp-gateway', version: '2.0.0' },
      { capabilities: { tools: { listChanged: false } }, instructions: mode === 'search' ? SEARCH_INSTRUCTIONS : INSTRUCTIONS },
    );

    if (mode === 'search') {
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: router.META_TOOLS }));
      server.setRequestHandler(CallToolRequestSchema, async (request) =>
        router.callMetaTool(user, request.params.name, request.params.arguments ?? {}, { source: 'mcp' }),
      );
    } else {
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: router.exposedTools(user).map(router.toWire) }));
      server.setRequestHandler(CallToolRequestSchema, async (request) =>
        router.callTool(user, request.params.name, request.params.arguments ?? {}, { source: 'mcp' }),
      );
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp] request failed', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  };

  const notAllowed = (_req, res) =>
    res
      .status(405)
      .set('Allow', 'POST')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this endpoint is stateless, use POST.' }, id: null });

  for (const [path, mode] of [
    ['/mcp', 'full'],
    ['/mcp/search', 'search'],
  ]) {
    app.post(path, auth.mcpAuth, auth.safe(handler(mode)));
    app.get(path, notAllowed);
    app.delete(path, notAllowed);
  }
}
