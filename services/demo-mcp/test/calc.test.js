import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../src/calc.js';

test('basic arithmetic and precedence', () => {
  assert.equal(calculate('1 + 2 * 3'), 7);
  assert.equal(calculate('(1 + 2) * 3'), 9);
  assert.equal(calculate('2 ^ 3 ^ 2'), 512);
  assert.equal(calculate('-4 + 10 % 4'), -2);
});

test('decimals and functions', () => {
  assert.equal(calculate('1299.50 * 1.18'), 1533.41);
  assert.equal(calculate('10 * 1.18'), 11.8);
  assert.equal(calculate('0.1 + 0.2'), 0.3);
  assert.equal(calculate('sqrt(144) + abs(-3)'), 15);
});

test('rejects code and bad input', () => {
  assert.throws(() => calculate('process.exit(1)'));
  assert.throws(() => calculate('1 / 0'));
  assert.throws(() => calculate('2 +'));
  assert.throws(() => calculate('foo(2)'));
});
