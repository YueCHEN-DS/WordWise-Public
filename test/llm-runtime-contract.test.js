import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'llm.js'), 'utf8');

test('inference uses one reusable sequence and abortable generation', () => {
  assert.match(source, /sequences:\s*1/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /signal:\s*timeoutController\.signal/);
  assert.doesNotMatch(source, /Promise\.race|RESET_EVERY|maybeReset/);
});

test('model changes invalidate evaluation and hint caches', () => {
  const loadModel = source.slice(
    source.indexOf('export async function loadModelFromPath'),
    source.indexOf('export function disposeLlm')
  );
  assert.match(loadModel, /clearInferenceCache\(\)/);
  assert.match(source, /semanticCache\s*=\s*new Map/);
  assert.match(source, /hintCache\s*=\s*new Map/);
});

test('successful answer handling has one history-write call site', () => {
  const handler = source.slice(
    source.indexOf("ipcMain.handle('check-answer'"),
    source.indexOf("ipcMain.handle('cancel-hint'")
  );
  assert.equal(handler.match(/recordSemanticScore\(/g)?.length, 1);
  assert.match(handler, /missing_reference/);
});
