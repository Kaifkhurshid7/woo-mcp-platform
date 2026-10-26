import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeUpstreamUrl } from '../src/ssrf.js';

const rejects = (u, opts) => assert.rejects(() => assertSafeUpstreamUrl(u, opts));

test('blocks metadata, loopback, link-local and bad schemes', async () => {
  await rejects('http://169.254.169.254/latest/meta-data/');
  await rejects('http://metadata.google.internal/computeMetadata/v1/');
  await rejects('http://127.0.0.1:8080/mcp');
  await rejects('http://[::1]/mcp');
  await rejects('http://[::ffff:127.0.0.1]/mcp');
  await rejects('http://[fe80::1]/mcp');
  await rejects('http://[fd00:ec2::254]/');
  await rejects('file:///etc/passwd');
  await rejects('ftp://example.com/');
  await rejects('http://user:pw@example.com/mcp');
  await rejects('not a url');
});

test('allows cluster-internal addresses by default, not when private is disallowed', async () => {
  await assert.doesNotReject(() => assertSafeUpstreamUrl('http://10.96.0.12:3000/mcp'));
  await assert.doesNotReject(() => assertSafeUpstreamUrl('http://192.168.1.10/mcp'));
  await rejects('http://10.96.0.12:3000/mcp', { allowPrivate: false });
  await rejects('http://192.168.1.10/mcp', { allowPrivate: false });
});

test('loopback can be allowed explicitly for development, metadata never', async () => {
  await assert.doesNotReject(() => assertSafeUpstreamUrl('http://127.0.0.1:9000/mcp', { allowLoopback: true }));
  await rejects('http://169.254.169.254/', { allowLoopback: true, allowPrivate: true });
});
