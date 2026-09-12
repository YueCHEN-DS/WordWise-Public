import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GIB,
  MODEL_PROFILES,
  classifyHardware,
  classifyModelProfile,
  migrateModelConfig,
  profileDisplayLabel,
} from '../compute-mode.js';

test('hardware classifier includes every low-compute boundary', () => {
  assert.equal(classifyHardware({
    backend: 'cuda', vramTotalBytes: 4 * GIB, ramTotalBytes: 16 * GIB, logicalCores: 8,
  }).recommendLow, true);
  assert.equal(classifyHardware({
    backend: 'metal', vramTotalBytes: 8 * GIB, unifiedVramBytes: 8 * GIB,
    ramTotalBytes: 8 * GIB, logicalCores: 8,
  }).recommendLow, true);
  assert.equal(classifyHardware({
    backend: 'cuda', vramTotalBytes: 8 * GIB, ramTotalBytes: 8 * GIB, logicalCores: 8,
  }).recommendLow, true);
  assert.equal(classifyHardware({
    backend: 'cuda', vramTotalBytes: 8 * GIB, ramTotalBytes: 16 * GIB, logicalCores: 4,
  }).recommendLow, true);
  assert.equal(classifyHardware({
    backend: 'cpu', ramTotalBytes: 32 * GIB, logicalCores: 12,
  }).runtimeTier, 'cpu');
  assert.equal(classifyHardware({
    backend: 'unknown', detectionFailed: true, ramTotalBytes: 32 * GIB, logicalCores: 12,
  }).recommendLow, true);
  assert.equal(classifyHardware({
    backend: 'cuda', vramTotalBytes: 12 * GIB, ramTotalBytes: 32 * GIB, logicalCores: 12,
  }).runtimeTier, 'high');
  assert.equal(classifyHardware({
    backend: 'cuda', vramTotalBytes: 12 * GIB, ramTotalBytes: 32 * GIB,
    logicalCores: 12, lastModelLoadFailure: 'gpu_oom',
  }).recommendLow, true);
});

test('model profiles use GGUF metadata before filenames', () => {
  assert.equal(classifyModelProfile({ general: { size_label: '1.7B' } }, 'renamed.gguf'), 'low');
  assert.equal(classifyModelProfile({ general: { size_label: '4B' } }, 'small.gguf'), 'pro');
  assert.equal(classifyModelProfile({ general: { size_label: '7B' } }, 'other.gguf'), 'custom');
  assert.equal(classifyModelProfile(null, 'Qwen3-1.7B-Q5_K_M.gguf'), 'low');
  assert.equal(classifyModelProfile(
    { general: { size_label: '1.7B' } },
    'Qwen3-1.7B-WordWise-Q5_K_M.gguf'
  ), 'wordwise');
});

test('legacy model paths migrate without inventing a remembered preference', () => {
  const migrated = migrateModelConfig({
    modelPath: '/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    performanceTier: 'low',
  });
  assert.equal(migrated.modelPaths.pro, '/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf');
  assert.equal(migrated.activeModelProfile, 'pro');
  assert.equal(migrated.computeModePreference, undefined);
  assert.equal(migrated.performanceTier, undefined);
});

test('public labels distinguish product mode and runtime tier', () => {
  assert.equal(profileDisplayLabel('pro', 'low'), 'QWEN-Pro (Low)');
  assert.equal(profileDisplayLabel('pro', 'cpu'), 'QWEN-Pro (CPU)');
  assert.equal(profileDisplayLabel('wordwise', 'high'), 'QWEN-WordWise');
  assert.equal(profileDisplayLabel('low', 'high'), 'QWEN (Low)');
  assert.equal(profileDisplayLabel('custom', 'mid'), 'Custom (Mid)');
});

test('low profile pins the reduced runtime contract', () => {
  assert.deepEqual(MODEL_PROFILES.low.runtime, {
    contextSize: 512,
    batchSize: 128,
    sequences: 1,
    flashAttention: false,
    maxTokensEval: 40,
    cacheCap: 60,
  });
});

test('WordWise v1 is a distinct middle profile with the tested compact runtime', () => {
  assert.equal(MODEL_PROFILES.wordwise.displayName, 'QWEN-WordWise');
  assert.equal(MODEL_PROFILES.wordwise.expectedBytes, 1_257_879_232);
  assert.equal(
    MODEL_PROFILES.wordwise.sha256,
    '2f9c4af4716fb4a04999fbdfdf235201a7d28c392481267baf2d6b46dbfeb42f'
  );
  assert.equal(MODEL_PROFILES.wordwise.url, null);
  assert.match(MODEL_PROFILES.wordwise.localSource, /v1-archive[\s\S]*WordWise-Q5_K_M\.gguf$/);
  assert.equal(MODEL_PROFILES.wordwise.packagedSource, 'models/Qwen3-1.7B-WordWise-Q5_K_M.gguf');
  assert.deepEqual(MODEL_PROFILES.wordwise.runtime, MODEL_PROFILES.low.runtime);
});
