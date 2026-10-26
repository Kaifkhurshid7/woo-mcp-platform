import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const INSTRUCTIONS =
  'This gateway aggregates several MCP servers. Every tool is named <server>__<tool>, so the prefix tells you ' +
  'which server a tool belongs to. Tools of unreachable or disabled servers are not listed.';

/**
 * The gateway's own MCP endpoint (Streamable HTTP, stateless).
 *
 * Stateless means: no session is kept between requests, so any gateway replica can serve any
 * request and nothing is lost when a pod restarts. A fresh MCP Server is built per request and
 * closed afterwards; the authenticated user is captured in the closure.
 */
export function mountMcp(app, { auth, router }) {
  app.post('/mcp', auth.apiKeyAuth, async (req, res) => {
    const user = req.user;
    const server = new Server({ name: 'mcp-gateway', version: '1.0.0' }, { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: router.exposedTools(user).map(router.toWire) }));
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      router.callTool(user, request.params.name, request.params.arguments ?? {}, { source: 'mcp' }),
    );

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
  });

  const notAllowed = (_req, res) =>
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this endpoint is stateless, use POST.' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
