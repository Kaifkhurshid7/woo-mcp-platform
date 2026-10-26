import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDateRange } from '../src/dates.js';

test('today in UTC is a 24h window', () => {
  const r = resolveDateRange('today', 'UTC', new Date('2026-10-21T10:00:00Z'));
  assert.equal(r.start, '2026-10-21T00:00:00.000Z');
  assert.equal(r.end, '2026-10-22T00:00:00.000Z');
});

test('today in Asia/Calcutta starts at 18:30Z the previous day', () => {
  // 23:47 IST on 21 Oct is 18:17Z on 21 Oct
  const r = resolveDateRange('today', 'Asia/Calcutta', new Date('2026-10-21T18:17:00Z'));
  assert.equal(r.start, '2026-10-20T18:30:00.000Z');
  assert.equal(r.end, '2026-10-21T18:30:00.000Z');
});

test('yesterday and explicit dates', () => {
  const y = resolveDateRange('yesterday', 'UTC', new Date('2026-10-21T10:00:00Z'));
  assert.equal(y.start, '2026-10-20T00:00:00.000Z');
  const d = resolveDateRange('2026-02-28', 'UTC');
  assert.equal(d.end, '2026-03-01T00:00:00.000Z');
});

test('rejects garbage and impossible dates', () => {
  assert.equal(resolveDateRange('next tuesday', 'UTC'), null);
  assert.equal(resolveDateRange('2026-02-30', 'UTC'), null);
});
