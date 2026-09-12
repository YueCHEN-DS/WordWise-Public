import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const llm = fs.readFileSync(path.join(root, 'llm.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.mjs'), 'utf8');
const handlers = fs.readFileSync(path.join(root, 'db-handlers.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('all revision advancement is guarded and timer callbacks use the central request path', () => {
  assert.match(renderer, /async function requestNextQuestion\(source = 'manual'\)/);
  assert.match(renderer, /if \(advanceInFlight\) return/);
  assert.match(renderer, /setTimeout\(\(\) => requestNextQuestion\('timer'\), delay\)/);
  assert.doesNotMatch(renderer, /setTimeout\(pickNextWord/);
  assert.match(renderer, /questionGenerationToken\+\+/);
  assert.match(renderer, /evaluationToken !== questionGenerationToken/);
});

test('manual, timed, paused, and failure result contracts are distinct', () => {
  assert.match(renderer, /renderResultAdvanceControls\('manual'\)/);
  assert.match(renderer, /renderResultAdvanceControls\('timed', delay\)/);
  assert.match(renderer, /renderResultAdvanceControls\('paused'\)/);
  assert.match(renderer, /if \(!result \|\| result\.evaluation_status !== 'ok'\)/);
  assert.match(html, /id="autoAdvanceToggle"/);
  for (const delay of ['1500', '3000', '5000', '8000']) {
    assert.match(html, new RegExp(`value="${delay}"`));
  }
});

test('mistake queue and attempt context are wired end to end', () => {
  for (const channel of [
    'db-get-mistake-queue-status',
    'db-get-mistake-summary',
    'db-get-next-mistake',
  ]) {
    assert.match(preload, new RegExp(channel));
    assert.match(handlers, new RegExp(channel));
  }
  assert.match(renderer, /source: 'mistake_review', mistakeId: currentMistake\.mistakeId/);
  assert.match(llm, /attemptSource,/);
  assert.match(llm, /reviewMistakeId/);
});

test('storage failure and review rewards cannot update optimistic score UI', () => {
  assert.match(llm, /'storage_error'/);
  assert.match(llm, /判定已完成，但学习记录保存失败，本次不会计分/);
  assert.match(renderer, /result\.reward_eligible === true && isFirstAttempt/);
  assert.doesNotMatch(renderer, /if \(isFirstAttempt\) \{\s*currentScore \+= 10;/);
});
