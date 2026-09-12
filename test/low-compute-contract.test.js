import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_PROFILES } from '../compute-mode.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const llm = read('llm.js');
const preload = read('preload.mjs');
const renderer = read('renderer.js');
const html = read('index.html');
const main = read('main.js');
const pkg = JSON.parse(read('package.json'));

test('startup selection is renderer-ready and blocks legacy eager model loading', () => {
  assert.match(preload, /initializeAi:[\s\S]*?initialize-ai/);
  assert.match(llm, /ipcMain\.handle\('initialize-ai'/);
  assert.match(renderer, /await window\.electronAPI\.initializeAi\(\)/);
  assert.doesNotMatch(main, /loadModelFromPath|Auto-load model/);
});

test('compute mode IPC and required UI controls are wired end to end', () => {
  for (const [method, channel] of [
    ['getModelProfiles', 'get-model-profiles'],
    ['activateComputeMode', 'activate-compute-mode'],
    ['downloadModel', 'download-model'],
  ]) {
    assert.match(preload, new RegExp(`${method}:[\\s\\S]*?${channel}`));
    assert.match(llm, new RegExp(`ipcMain\\.handle\\('${channel}'`));
    assert.match(renderer, new RegExp(`electronAPI\\.${method}\\(`));
  }
  for (const id of [
    'modelModeBadge', 'computeModeCurrent', 'hardwareCapabilitySummary',
    'proModeBtn', 'wordwiseModeBtn', 'lowModeBtn', 'lowModeReminderOverlay', 'lowModeReasonList',
    'acceptLowModeBtn', 'keepProModeBtn',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test('low profile download identity and atomic integrity contract are fixed', () => {
  assert.equal(MODEL_PROFILES.low.expectedBytes, 1_257_880_128);
  assert.equal(
    MODEL_PROFILES.low.sha256,
    'b0949de5b2e06cbed6aa96517f9bd8afb334584b6f95ee83479292ff4bdd8ed3'
  );
  assert.match(MODEL_PROFILES.low.url, /modelscope\.cn[\s\S]*\/resolve\/master\//);
  assert.match(llm, /\.part/);
  assert.match(llm, /statfsSync/);
  assert.match(llm, /sha256File|createHash\('sha256'\)/);
  assert.match(llm, /renameSync\(partialPath, destination\)/);
  assert.ok(pkg.build.files.includes('!**/*.gguf'));
  assert.ok(pkg.build.files.includes('!node_modules/node-llama-cpp/llama/localBuilds/**'));
});

test('low quality rejection occurs before the sole learning-history write', () => {
  const handler = llm.slice(
    llm.indexOf("ipcMain.handle('check-answer'"),
    llm.indexOf("ipcMain.handle('cancel-hint'")
  );
  assert.ok(handler.indexOf('evaluated.qualityRejected') < handler.indexOf('recordSemanticScore('));
  assert.equal(handler.match(/recordSemanticScore\(/g)?.length, 1);
  assert.match(handler, /rejected\.evaluation_path\s*=\s*evaluated\.path/);
  assert.match(handler, /rejected\.low_verification\s*=\s*evaluated\.lowVerification/);
  assert.match(llm, /COMPACT_MODEL_PROFILES\.has\(activeModelProfile\)[\s\S]*?gateLowModelDecision/);
  assert.match(llm, /COMPACT_MODEL_PROFILES\.has\(activeModelProfile\)[\s\S]*?仅支持本地 L1 提示/);
  assert.match(renderer, /compactModelProfiles\.has\(currentModelProfile\) && level > 1/);
});

test('WordWise v1 profile is wired as the verified middle application model', () => {
  const wordwise = MODEL_PROFILES.wordwise;
  assert.equal(wordwise.expectedBytes, 1_257_879_232);
  assert.equal(wordwise.sha256, '2f9c4af4716fb4a04999fbdfdf235201a7d28c392481267baf2d6b46dbfeb42f');
  assert.equal(wordwise.url, null);
  assert.match(llm, /localProfileSourcePath/);
  assert.match(llm, /model_source_unavailable/);
  assert.match(llm, /\['pro', 'wordwise', 'low'\]/);
  assert.match(html, /startComputeMode\('wordwise'\)/);
});
