import crypto from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createWcClient } from './wc.js';
import { resolveDateRange } from './dates.js';

const PORT = Number(process.env.PORT || 3000);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';
const STORE_TIMEZONE = process.env.STORE_TIMEZONE || 'UTC';
const STORE_NAME = process.env.STORE_NAME || 'store';

if (!AUTH_TOKEN && process.env.ALLOW_NO_AUTH !== 'true') {
  console.error('MCP_AUTH_TOKEN is not set. Refusing to start without auth (set ALLOW_NO_AUTH=true to override for local hacking).');
  process.exit(1);
}

const wc = createWcClient({
  baseUrl: process.env.WOO_BASE_URL,
  consumerKey: process.env.WOO_CONSUMER_KEY,
  consumerSecret: process.env.WOO_CONSUMER_SECRET,
  hostHeader: process.env.WOO_HOST_HEADER || undefined,
  timeoutMs: Number(process.env.WOO_TIMEOUT_MS || 15000),
});

const ORDER_STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'];

// ---- shaping helpers: keep tool output compact so it is cheap for an LLM to read ----
const slimProduct = (p) => ({
  id: p.id,
  name: p.name,
  sku: p.sku || undefined,
  status: p.status,
  price: p.price,
  regular_price: p.regular_price,
  sale_price: p.sale_price || undefined,
  stock_status: p.stock_status,
  stock_quantity: p.stock_quantity ?? undefined,
  permalink: p.permalink,
});

const slimOrder = (o) => ({
  id: o.id,
  number: o.number,
  status: o.status,
  total: o.total,
  currency: o.currency,
  date_created: o.date_created_gmt ? `${o.date_created_gmt}Z` : o.date_created,
  payment_method: o.payment_method_title || o.payment_method,
  customer: [o.billing?.first_name, o.billing?.last_name].filter(Boolean).join(' ') || undefined,
  email: o.billing?.email || undefined,
  items: (o.line_items || []).map((i) => ({ product_id: i.product_id, name: i.name, quantity: i.quantity, total: i.total })),
});

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });
const guard = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return fail(e?.message || String(e));
  }
};

function buildServer() {
  const server = new McpServer({ name: `woo-mcp (${STORE_NAME})`, version: '1.0.0' });

  server.registerTool(
    'list_products',
    {
      title: 'List products',
      description: 'List products in the WooCommerce store. Optionally search by text or filter by status.',
      inputSchema: {
        search: z.string().optional().describe('Free-text search on product name/description'),
        status: z.enum(['any', 'publish', 'draft', 'pending', 'private']).optional().describe('Product status, default any'),
        per_page: z.number().int().min(1).max(100).optional().describe('Page size, default 20'),
        page: z.number().int().min(1).optional().describe('Page number, default 1'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ search, status, per_page = 20, page = 1 }) => {
      const { data, headers } = await wc.get('/products', { search, status: status || 'any', per_page, page });
      return ok({ total: Number(headers['x-wp-total'] ?? data.length), page, products: data.map(slimProduct) });
    }),
  );

  server.registerTool(
    'create_product',
    {
      title: 'Create product',
      description: 'Create a simple product in the store. It is published (visible on the storefront) unless status says otherwise.',
      inputSchema: {
        name: z.string().min(1).describe('Product name'),
        regular_price: z.union([z.string(), z.number()]).describe('Regular price as a number, e.g. 19.99'),
        description: z.string().optional().describe('Long description'),
        short_description: z.string().optional(),
        sku: z.string().optional(),
        status: z.enum(['publish', 'draft', 'pending', 'private']).optional().describe('Default publish'),
        stock_quantity: z.number().int().min(0).optional().describe('If given, stock management is enabled with this quantity'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guard(async ({ name, regular_price, description, short_description, sku, status, stock_quantity }) => {
      const price = Number(regular_price);
      if (!Number.isFinite(price) || price < 0) return fail(`Invalid price: ${regular_price}`);
      const body = {
        name,
        type: 'simple',
        status: status || 'publish',
        regular_price: price.toFixed(2),
        description,
        short_description,
        sku,
      };
      if (stock_quantity !== undefined) {
        body.manage_stock = true;
        body.stock_quantity = stock_quantity;
      }
      const { data } = await wc.post('/products', body);
      return ok({ created: slimProduct(data) });
    }),
  );

  server.registerTool(
    'get_product',
    {
      title: 'Get product',
      description: 'Get one product by id.',
      inputSchema: { id: z.number().int().describe('Product id') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ id }) => {
      const { data } = await wc.get(`/products/${id}`);
      return ok(slimProduct(data));
    }),
  );

  server.registerTool(
    'list_orders',
    {
      title: 'List orders',
      description:
        'List orders, newest first. Use `date` ("today", "yesterday" or YYYY-MM-DD) for a single day in the store timezone, ' +
        'or created_after / created_before (ISO 8601) for a custom window.',
      inputSchema: {
        status: z.enum(['any', ...ORDER_STATUSES]).optional().describe('Order status, default any'),
        date: z.string().optional().describe('"today", "yesterday" or YYYY-MM-DD (store timezone)'),
        created_after: z.string().optional().describe('ISO 8601 timestamp'),
        created_before: z.string().optional().describe('ISO 8601 timestamp'),
        per_page: z.number().int().min(1).max(100).optional().describe('Page size, default 20'),
        page: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ status, date, created_after, created_before, per_page = 20, page = 1 }) => {
      let after = created_after;
      let before = created_before;
      if (date) {
        const range = resolveDateRange(date, STORE_TIMEZONE);
        if (!range) return fail(`Invalid date "${date}". Use "today", "yesterday" or YYYY-MM-DD.`);
        after = range.start;
        before = range.end;
      }
      for (const [label, v] of [['created_after', after], ['created_before', before]]) {
        if (v && Number.isNaN(Date.parse(v))) return fail(`${label} is not a valid ISO 8601 timestamp: ${v}`);
      }
      const { data, headers } = await wc.get('/orders', {
        status: status || 'any',
        after,
        before,
        per_page,
        page,
        orderby: 'date',
        order: 'desc',
      });
      // WooCommerce interprets bare timestamps in the site timezone; filter again on the GMT
      // date so the result is exact regardless of how the store's timezone is configured.
      const lo = after ? Date.parse(after) : -Infinity;
      const hi = before ? Date.parse(before) : Infinity;
      const orders = data.filter((o) => {
        const t = Date.parse(`${o.date_created_gmt}Z`);
        return Number.isNaN(t) || (t >= lo && t < hi);
      });
      return ok({ timezone: STORE_TIMEZONE, total: Number(headers['x-wp-total'] ?? orders.length), page, count: orders.length, orders: orders.map(slimOrder) });
    }),
  );

  server.registerTool(
    'get_order',
    {
      title: 'Get order',
      description: 'Get full details of one order by id, including line items and billing contact.',
      inputSchema: { id: z.number().int().describe('Order id') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ id }) => {
      const { data } = await wc.get(`/orders/${id}`);
      return ok({
        ...slimOrder(data),
        billing: data.billing,
        shipping_total: data.shipping_total,
        total_tax: data.total_tax,
        customer_note: data.customer_note || undefined,
        date_modified: data.date_modified_gmt ? `${data.date_modified_gmt}Z` : data.date_modified,
      });
    }),
  );

  server.registerTool(
    'update_order_status',
    {
      title: 'Update order status',
      description: 'Change the status of an order (e.g. processing -> completed). Customers may receive status emails.',
      inputSchema: {
        id: z.number().int().describe('Order id'),
        status: z.enum(ORDER_STATUSES).describe('New status'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guard(async ({ id, status }) => {
      const { data } = await wc.put(`/orders/${id}`, { status });
      return ok({ updated: slimOrder(data) });
    }),
  );

  return server;
}

// ---- HTTP wiring -------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const tokenBuf = Buffer.from(AUTH_TOKEN);
function authorized(req) {
  if (!AUTH_TOKEN) return true;
  const h = req.headers.authorization || '';
  const m = /^Bearer (.+)$/i.exec(h);
  if (!m) return false;
  const given = Buffer.from(m[1]);
  return given.length === tokenBuf.length && crypto.timingSafeEqual(given, tokenBuf);
}

// Stateless Streamable HTTP: a fresh server+transport per request. Any replica can serve any call.
app.post('/mcp', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
  const server = buildServer();
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
const methodNotAllowed = (_req, res) =>
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null });
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

const httpServer = app.listen(PORT, () => console.log(`woo-mcp listening on :${PORT} (store timezone ${STORE_TIMEZONE})`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => httpServer.close(() => process.exit(0)));
