import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'demo-mode.js'), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'demo-mode.js' });
const demo = sandbox.WordWiseDemo;

test('demo catalog exposes every visible vocabulary list', () => {
  assert.ok(demo);
  assert.equal(demo.defaultList, 'CET4_edited.txt');
  assert.deepEqual(
    Array.from(demo.getLists(), item => item.file),
    [
      'Custom / My Words',
      'Highschool_edited.txt',
      'CET4_edited.txt',
      'CET6_edited.txt',
      'TOEFL.txt',
      'GRE_8000_Words.txt',
    ]
  );
});

test('vocabulary tiers reveal the required progressive hint depth', () => {
  const expectedDepth = new Map([
    ['CET4_edited.txt', 0],
    ['CET6_edited.txt', 1],
    ['TOEFL.txt', 2],
    ['GRE_8000_Words.txt', 3],
  ]);

  for (const [listFile, depth] of expectedDepth) {
    const scenario = demo.getScenario(listFile);
    assert.equal(scenario.hintDepth, depth, listFile);
    assert.equal(scenario.hints.length, 3, listFile);
    assert.ok(scenario.totalWords > 0, listFile);
    assert.ok(scenario.position > 0 && scenario.position <= scenario.totalWords, listFile);
    assert.ok(scenario.words.some(word => word.term === scenario.current.term), listFile);
  }
});

test('scenario and confusion fixtures are defensive copies', () => {
  const first = demo.getScenario('CET6_edited.txt');
  first.current.term = 'changed';
  first.hints[0] = 'changed';
  const second = demo.getScenario('CET6_edited.txt');
  assert.equal(second.current.term, 'abrupt');
  assert.equal(second.hints[0], 'a_____ (adj.) 突…');

  const map = demo.getConfusionMap();
  assert.equal(map.length, 3);
  assert.ok(map.some(edge => edge.isConfirmed));
  assert.ok(map.some(edge => !edge.isConfirmed));
  map[0].riskScore = 0;
  assert.equal(demo.getConfusionMap()[0].riskScore, 92);
});

test('fixed interface content does not expose a demo watermark', () => {
  for (const list of demo.getLists()) {
    const visibleContent = JSON.stringify(demo.getScenario(list.file));
    assert.doesNotMatch(visibleContent, /演示模式|演示数据|demo mode|demo data/i);
  }
});
