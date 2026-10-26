import test from 'node:test';
import assert from 'node:assert/strict';
import { createVault, generateApiKey, hashPassword, sha256, verifyPassword } from '../src/crypto.js';
import { exposedName, matchesAny } from '../src/router.js';

test('vault round-trips and rejects tampering', () => {
  const v = createVault('a-long-test-secret-value');
  const blob = v.encrypt('{"type":"bearer","token":"abc"}');
  assert.ok(!blob.includes('abc'));
  assert.equal(v.decrypt(blob), '{"type":"bearer","token":"abc"}');
  const parts = blob.split(':');
  parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => v.decrypt(parts.join(':')));
  assert.throws(() => createVault('short'));
});

test('passwords hash with salt and verify', () => {
  const h = hashPassword('correct horse battery');
  assert.ok(verifyPassword('correct horse battery', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.notEqual(hashPassword('x'), hashPassword('x'));
});

test('api keys are stored as hashes only', () => {
  const { key, hash, prefix } = generateApiKey();
  assert.match(key, /^gw_/);
  assert.equal(hash, sha256(key));
  assert.ok(key.startsWith(prefix));
  assert.notEqual(hash, key);
});

test('tool naming: prefixes never collide and long names are shortened deterministically', () => {
  assert.equal(exposedName('notes', 'ping'), 'notes__ping');
  assert.notEqual(exposedName('notes', 'ping'), exposedName('utils', 'ping'));
  assert.equal(exposedName('woo', 'weird.name!'), 'woo__weird_name_');
  const long = exposedName('woo', 'x'.repeat(100));
  assert.equal(long.length, 64);
  assert.equal(long, exposedName('woo', 'x'.repeat(100)));
  assert.notEqual(long, exposedName('woo', 'x'.repeat(99) + 'y'));
});

test('admin-only patterns', () => {
  assert.ok(matchesAny('create_*, update_order_status', 'create_product'));
  assert.ok(matchesAny('create_*, update_order_status', 'update_order_status'));
  assert.ok(!matchesAny('create_*', 'list_orders'));
  assert.ok(!matchesAny('', 'anything'));
});
