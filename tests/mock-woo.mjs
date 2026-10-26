// A small fake of the WooCommerce REST API (wc/v3) so the whole platform can be tested without
// WordPress. It enforces the same preconditions the real store does: Basic auth with a consumer
// key/secret, and "HTTPS" signalled via X-Forwarded-Proto.
import http from 'node:http';

const PORT = Number(process.env.PORT || 19001);
const KEY = process.env.WOO_CONSUMER_KEY;
const SECRET = process.env.WOO_CONSUMER_SECRET;

const products = [];
const orders = [];
let pid = 100;
let oid = 5000;

const nowGmt = () => new Date().toISOString().replace(/\.\d+Z$/, '');
const mkOrder = ({ product, qty = 1, first = 'Test', last = 'Buyer', status = 'processing', date }) => {
  const total = (Number(product.regular_price) * qty).toFixed(2);
  return {
    id: ++oid, number: String(oid), status, currency: 'INR', total,
    date_created: date || nowGmt(), date_created_gmt: date || nowGmt(), date_modified_gmt: nowGmt(),
    payment_method: 'cod', payment_method_title: 'Cash on delivery',
    billing: { first_name: first, last_name: last, email: `${first.toLowerCase()}@example.com` },
    line_items: [{ product_id: product.id, name: product.name, quantity: qty, total }],
  };
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};

      // test hook (not part of WooCommerce): place an order as a shopper would
      if (url.pathname === '/__test/order' && req.method === 'POST') {
        const p = products.find((x) => x.id === json.product_id) || products[products.length - 1];
        const o = mkOrder({ product: p, ...json });
        orders.unshift(o);
        return send(201, o);
      }

      if (!url.pathname.startsWith('/wp-json/wc/v3/')) return send(404, { code: 'rest_no_route', message: 'No route' });
      const auth = Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString();
      if (req.headers['x-forwarded-proto'] !== 'https') return send(401, { code: 'woocommerce_rest_cannot_view', message: 'Basic auth needs SSL (mock)' });
      if (auth !== `${KEY}:${SECRET}`) return send(401, { code: 'woocommerce_rest_authentication_error', message: 'Invalid consumer key or secret' });

      const route = url.pathname.replace('/wp-json/wc/v3', '');
      const q = url.searchParams;

      if (route === '/products' && req.method === 'GET') {
        let list = products.filter((p) => !q.get('search') || p.name.toLowerCase().includes(q.get('search').toLowerCase()));
        const status = q.get('status');
        if (status && status !== 'any') list = list.filter((p) => p.status === status);
        const per = Number(q.get('per_page') || 10);
        return send(200, list.slice(0, per), { 'x-wp-total': String(list.length) });
      }
      if (route === '/products' && req.method === 'POST') {
        if (!json.name) return send(400, { code: 'rest_missing_callback_param', message: 'Missing parameter(s): name' });
        const p = { id: ++pid, name: json.name, status: json.status || 'publish', price: json.regular_price, regular_price: json.regular_price, sale_price: '', stock_status: 'instock', permalink: `http://store.test/product/${pid}`, sku: json.sku || '' };
        products.push(p);
        return send(201, p);
      }
      let m;
      if ((m = /^\/products\/(\d+)$/.exec(route)) && req.method === 'GET') {
        const p = products.find((x) => x.id === Number(m[1]));
        return p ? send(200, p) : send(404, { code: 'woocommerce_rest_product_invalid_id', message: 'Invalid ID.' });
      }
      if (route === '/orders' && req.method === 'GET') {
        let list = orders;
        const status = q.get('status');
        if (status && status !== 'any') list = list.filter((o) => o.status === status);
        // like WooCommerce, the mock treats bare/Z timestamps as UTC
        if (q.get('after')) list = list.filter((o) => Date.parse(o.date_created_gmt + 'Z') > Date.parse(q.get('after')));
        if (q.get('before')) list = list.filter((o) => Date.parse(o.date_created_gmt + 'Z') < Date.parse(q.get('before')));
        return send(200, list, { 'x-wp-total': String(list.length) });
      }
      if ((m = /^\/orders\/(\d+)$/.exec(route))) {
        const o = orders.find((x) => x.id === Number(m[1]));
        if (!o) return send(404, { code: 'woocommerce_rest_shop_order_invalid_id', message: 'Invalid ID.' });
        if (req.method === 'PUT') Object.assign(o, json);
        return send(200, o);
      }
      send(404, { code: 'rest_no_route', message: 'No route was found matching the URL and request method.' });
    });
  })
  .listen(PORT, () => console.log(`mock-woo on :${PORT}`));
