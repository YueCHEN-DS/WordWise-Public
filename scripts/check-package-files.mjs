#!/usr/bin/env node
// Inspect file selection; never run electron-builder or copy release assets.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { packageFilePatterns } from './package-file-rules.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { FileMatcher } = require('app-builder-lib/out/fileMatcher.js');
const { expandMacro } = require('app-builder-lib/out/util/macroExpander.js');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const runtime = [
  'package.json', 'main.js', 'preload.mjs', 'renderer.js', 'index.html', 'styles.css',
  'db-handlers.js', 'llm.js', 'compute-mode.js', 'evaluation-policy.js',
  'evaluation-protocol.js', 'scoring.js', 'license.js', 'license-core.js',
  'beta-super-config.js', 'demo-mode.js', 'icon.png',
  'vocab-core/index.js', 'vocab-core/package.json',
];
const forbidden = [
  '.env', '.env.production', 'nested/.env', 'nested/.env.local',
  'operator.pem', 'nested/operator.key', 'backup.dump.age',
  'online-trial/server/index.js', 'runtime/session.json', 'backups/main.dump',
  'private-assets/dictionaries/list.json', 'docs/WEB_BETA.md',
  'docs/assets/language-settings.png', 'public-files.json', '.git/config',
  'public-release/main.js', '.worktrees/private/main.js',
  'finetune/training.jsonl', 'finetune-output/checkpoint.json',
  'wordwise-gold/train.jsonl', 'wordwise-gold-archive/archive.jsonl',
  'research-paper-portfolio/figure.png', 'copyright_prep/source.txt',
  'evaluation/cases.jsonl', 'scripts/issue-code.mjs', 'test/scoring.test.js',
  'Qwen-example.gguf', 'models/Qwen-example.gguf',
];

export function inspectPackageFiles(target) {
  const patterns = packageFilePatterns(pkg.build.files, target);
  const matcher = new FileMatcher(root, path.join(root, 'dist', 'selection-only'),
    pattern => expandMacro(pattern, 'x64', {
      productName: pkg.build.productName, sanitizedProductName: pkg.build.productName,
    }, { '/*': '{,/**/*}' }), patterns);
  const filter = matcher.createFilter();
  const selected = name => filter(path.join(root, name), { isDirectory: () => false });
  for (const name of runtime) {
    assert.ok(fs.existsSync(path.join(root, name)), `Missing public runtime file: ${name}`);
    assert.ok(selected(name), `${target}: excluded runtime file: ${name}`);
  }
  for (const name of forbidden) assert.ok(!selected(name), `${target}: private/development file selected: ${name}`);
  const own = target === 'mac' ? 'mac' : 'win32';
  const other = target === 'mac' ? 'win32' : 'mac';
  assert.ok(selected(`vocab-core/vocab_core.${own}.node`), `${target}: own native module excluded`);
  assert.ok(!selected(`vocab-core/vocab_core.${other}.node`), `${target}: other native module selected`);
  const platform = target === 'mac' ? 'mac-arm64-metal' : 'win-x64';
  assert.ok(selected(`node_modules/@node-llama-cpp/${platform}/llama.node`), `${target}: inference runtime excluded`);
  for (const name of ['db/owned-list.txt', 'db/vocab_owned-list.db', 'audio.pack']) {
    assert.ok(selected(name), `${target}: optional user-supplied runtime asset excluded: ${name}`);
  }
  return { target, runtimeFiles: runtime.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    for (const target of ['mac', 'win']) {
      const result = inspectPackageFiles(target);
      console.log(`${target}: ${result.runtimeFiles} runtime files, native selection and private-file exclusions passed.`);
    }
    console.log('Read-only selection checks; no installer, native module, dictionary, audio or model was built or copied.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
