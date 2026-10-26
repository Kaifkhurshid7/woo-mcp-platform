// Renders the BUILT dashboard (services/dashboard/dist) in jsdom against a running gateway and clicks through
// the main screens. Not a replacement for a real browser, but it catches runtime errors in the React code.
//   GATEWAY_URL=http://127.0.0.1:9500 ADMIN_EMAIL=... ADMIN_PASSWORD=... node tests/ui-smoke.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const base = process.env.GATEWAY_URL.replace(/\/$/, '');
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../services/dashboard/dist');
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(dist, html.match(/src="\/(assets\/[^"]+\.js)"/)[1]), 'utf8');

let cookie = '';
const errors = [];
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: `${base}/`,
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
window.fetch = async (url, opts = {}) => {
  const res = await fetch(new URL(url, base), { ...opts, headers: { ...(opts.headers || {}), ...(cookie ? { cookie } : {}) } });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
  return res;
};
window.Element.prototype.scrollIntoView = () => {};
window.confirm = () => true;
window.addEventListener('error', (e) => errors.push(e.error?.stack || e.message));
const origErr = window.console.error;
window.console.error = (...a) => (errors.push(a.join(' ')), origErr(...a));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}\n--- page text ---\n${window.document.body.textContent.slice(0, 600)}`);
};
const $ = (sel) => window.document.querySelector(sel);
const text = () => window.document.body.textContent;
function setValue(el, v) {
  const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const nav = (route) => {
  window.location.hash = route;
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
};

window.eval(js);

await until(() => $('input[type=email]'), 'login form');
console.log('ok  login screen rendered');
setValue($('input[type=email]'), process.env.ADMIN_EMAIL);
setValue($('input[type=password]'), process.env.ADMIN_PASSWORD);
$('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

await until(() => /MCP servers/.test(text()) && /WooCommerce store/.test(text()), 'servers page');
assert.ok(/Connected/.test(text()), 'servers show Connected');
assert.ok([...window.document.querySelectorAll('.server')].length >= 3, 'three server cards');
console.log('ok  servers page: %d servers, statuses shown', window.document.querySelectorAll('.server').length);
click([...window.document.querySelectorAll('.server button')].find((b) => b.textContent === 'Tools'));
await until(() => /woo__create_product/.test(text()), 'tool list expands');
console.log('ok  tool list shows prefixed names');

nav('/keys');
await until(() => /Gateway endpoint/.test(text()) && /Sign in with your browser/.test(text()), 'keys page');
setValue($('input[placeholder^="e.g."]'), 'ui-smoke');
$('form.inline').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await until(() => /Your new API key/.test(text()), 'new key modal');
assert.ok(/claude mcp add --transport http/.test(text()) && /gw_/.test(text()));
console.log('ok  key creation shows the key once with client snippets');
click([...window.document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Done'));

nav('/chat');
await until(() => /Try one of these/.test(text()), 'chat page');
click([...window.document.querySelectorAll('.suggest')].find((b) => /orders/.test(b.textContent)));
await until(() => /Tools called/.test(text()), 'chat tool trace', 15000);
assert.ok(/woo__list_orders/.test(text()));
console.log('ok  chat answered and displayed the tool trace');

nav('/audit');
await until(() => /list_orders/.test(text()) && /chat/.test(text()), 'audit entries');
console.log('ok  audit log lists the call');

nav('/stores');
await until(() => /New store/.test(text()), 'stores page');
console.log('ok  stores page rendered');

nav('/metrics');
await until(() => /Error rate/.test(text()), 'metrics page');
console.log('ok  metrics page rendered');

nav('/team');
await until(() => /Invite a team member/.test(text()), 'team page');
console.log('ok  team page rendered');

const real = errors.filter((e) => !/Not implemented|act\(/.test(e));
assert.equal(real.length, 0, `console/runtime errors:\n${real.join('\n')}`);
console.log('UI SMOKE PASSED');
process.exit(0);
