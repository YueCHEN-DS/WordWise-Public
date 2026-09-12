import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMeaning } from '../scoring.js';

test('normalization removes presentation noise only', () => {
  assert.equal(normalizeMeaning('  v. 放 弃；抛弃 '), '放弃抛弃');
  assert.equal(normalizeMeaning('Happy-Day'), 'happyday');
});
