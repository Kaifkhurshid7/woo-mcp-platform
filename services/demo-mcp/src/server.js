/**
 * Demo MCP server with two personalities selected by KIND: "notes" (shared scratch-pad) and "utils" (calculator, clock).
 * Both expose `ping` on purpose, to show how the gateway keeps same-named tools apart.
 */
import crypto from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { calculate } from './calc.js';

// One image, two personalities selected with KIND:
//   notes - a shared scratch-pad (in memory) the team can write to
//   utils - calculator and clock
// Both also expose a tool called `ping`, which is deliberate: it lets the gateway demonstrate
// how it disambiguates identical tool names coming from different servers.
const KIND = process.env.KIND || 'utils';
const PORT = Number(process.env.PORT || 3000);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';

if (!['notes', 'utils'].includes(KIND)) {
  console.error(`Unknown KIND "${KIND}" (expected notes or utils)`);
  process.exit(1);
}
if (!AUTH_TOKEN && process.env.ALLOW_NO_AUTH !== 'true') {
  console.error('MCP_AUTH_TOKEN is not set. Refusing to start without auth (set ALLOW_NO_AUTH=true to override).');
  process.exit(1);
}

const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });

const notes = []; // { id, title, body, created_at }
let nextId = 1;

function addPing(server) {
  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description: `Health check for the "${KIND}" server. Returns "pong from ${KIND}".`,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ok(`pong from ${KIND}`),
  );
}

function buildNotes() {
  const server = new McpServer({ name: 'notes', version: '1.0.0' });
  addPing(server);
  server.registerTool(
    'add_note',
    {
      title: 'Add note',
      description: 'Save a note to the shared team scratch-pad.',
      inputSchema: { title: z.string().min(1).max(200), body: z.string().max(5000).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ title, body }) => {
      if (notes.length >= 1000) notes.shift();
      const note = { id: nextId++, title, body: body || '', created_at: new Date().toISOString() };
      notes.push(note);
      return ok({ saved: note });
    },
  );
  server.registerTool(
    'list_notes',
    {
      title: 'List notes',
      description: 'List the most recent notes, newest first.',
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ limit = 20 }) => ok({ total: notes.length, notes: [...notes].reverse().slice(0, limit) }),
  );
  server.registerTool(
    'search_notes',
    {
      title: 'Search notes',
      description: 'Case-insensitive search over note titles and bodies.',
      inputSchema: { query: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      const q = query.toLowerCase();
      return ok({ matches: notes.filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)).reverse() });
    },
  );
  return server;
}

function buildUtils() {
  const server = new McpServer({ name: 'utils', version: '1.0.0' });
  addPing(server);
  server.registerTool(
    'calculate',
    {
      title: 'Calculate',
      description:
        'Evaluate an arithmetic expression exactly, e.g. "1299.50 * 1.18" or "(12 + 8) / 4". Supports + - * / % ^, parentheses, sqrt, abs, round, floor, ceil, pi, e.',
      inputSchema: { expression: z.string().min(1).max(200) },
      annotations: { readOnlyHint: true },
    },
    async ({ expression }) => {
      try {
        return ok({ expression, result: calculate(expression) });
      } catch (e) {
        return fail(`Could not evaluate "${expression}": ${e.message}`);
      }
    },
  );
  server.registerTool(
    'current_time',
    {
      title: 'Current time',
      description: 'Current date and time in an IANA timezone (default UTC), e.g. "Asia/Kolkata".',
      inputSchema: { timezone: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ timezone = 'UTC' }) => {
      try {
        const now = new Date();
        const local = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'full', timeStyle: 'long' }).format(now);
        return ok({ timezone, local, iso_utc: now.toISOString() });
      } catch {
        return fail(`Unknown timezone "${timezone}"`);
      }
    },
  );
  return server;
}

const build = KIND === 'notes' ? buildNotes : buildUtils;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.get('/healthz', (_req, res) => res.json({ ok: true, kind: KIND }));

const tokenBuf = Buffer.from(AUTH_TOKEN);
function authorized(req) {
  if (!AUTH_TOKEN) return true;
  const m = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const given = Buffer.from(m[1]);
  return given.length === tokenBuf.length && crypto.timingSafeEqual(given, tokenBuf);
}

app.post('/mcp', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
  const server = build();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('mcp request failed', e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
});
const notAllowed = (_req, res) =>
  res
    .status(405)
    .set('Allow', 'POST')
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null });
app.get('/mcp', notAllowed);
app.delete('/mcp', notAllowed);

const httpServer = app.listen(PORT, () => console.log(`demo-mcp (${KIND}) listening on :${PORT}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => httpServer.close(() => process.exit(0)));
