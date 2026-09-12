import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.mjs'), 'utf8');
const handlers = fs.readFileSync(path.join(root, 'db-handlers.js'), 'utf8');
const licenseMod = fs.readFileSync(path.join(root, 'license.js'), 'utf8');
const betaConfig = fs.readFileSync(path.join(root, 'beta-super-config.js'), 'utf8');
const buildScript = fs.readFileSync(path.join(root, 'scripts/build.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const demo = fs.readFileSync(path.join(root, 'demo-mode.js'), 'utf8');

test('HTML ids are unique', () => {
  const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map(match => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
});

test('inline UI handlers are implemented by the renderer', () => {
  const handlers = [...html.matchAll(/\son(?:click|change)=["']([A-Za-z_$][\w$]*)\(/g)]
    .map(match => match[1]);
  const missing = [...new Set(handlers)].filter(name => {
    const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
    return !declaration.test(renderer);
  });
  assert.deepEqual(missing, []);
});

test('confusion map controls required by the renderer exist', () => {
  for (const id of [
    'confusionMapModalOverlay',
    'confusionRiskFilter',
    'confusionMapStatus',
    'confusionMapGraph',
    'confusionMapDetail',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test('confusion and adaptive IPC methods are wired end to end', () => {
  for (const [method, channel] of [
    ['getNextAdaptive', 'db-get-next-adaptive'],
    ['getConfusionMap', 'db-get-confusion-map'],
    ['getConfusionDetail', 'db-get-confusion-detail'],
  ]) {
    assert.match(preload, new RegExp(`${method}:[\\s\\S]*?${channel}`));
    assert.match(handlers, new RegExp(`ipcMain\\.handle\\('${channel}'`));
    assert.match(renderer, new RegExp(`electronAPI\\.db\\.${method}\\(`));
  }
});

test('license IPC channels are wired preload ↔ main process', () => {
  for (const [method, channel] of [
    ['getState', 'license-get-state'],
    ['getDeviceCode', 'license-get-device-code'],
    ['activate', 'license-activate'],
  ]) {
    assert.match(preload, new RegExp(`license:[\\s\\S]*?${method}:[\\s\\S]*?${channel}`));
    assert.match(licenseMod, new RegExp(`ipcMain\\.handle\\('${channel}'`));
  }
  // 状态变更事件通道
  assert.match(preload, /license-state/);
  assert.match(licenseMod, /webContents\.send\(['"]license-state['"]/);
  assert.match(preload, /removeAllListeners\(['"]license-state['"]\)/);
});

test('expired-license overlay is visible and activation restores settings access', () => {
  assert.match(renderer, /function showLicenseLock\s*\(\)[\s\S]*?overlay\.classList\.add\(['"]active['"]\)/);
  assert.match(renderer, /overlay\.classList\.toggle\(['"]active['"], expired\)/);
  assert.match(renderer, /settings\.style\.display = ['"]none['"]/);
  assert.match(renderer, /else \{[\s\S]*?settings\.style\.display = ['"]['"];/);
});

test('beta super voucher is opt-in, hash-only, and locally single-use', () => {
  assert.match(betaConfig, /enabled:\s*false/);
  assert.doesNotMatch(betaConfig, /WWS-[0-9A-Z]/);
  assert.match(buildScript, /WORDWISE_BETA_SUPER_CODE/);
  assert.match(buildScript, /restoreBetaSuperConfig/);
  assert.match(licenseMod, /activateBetaSuper\(/);
  assert.match(licenseMod, /beta-super-redemption\.json/);
  assert.match(licenseMod, /reason: 'beta_used'/);
  assert.match(renderer, /state\.betaSuper/);
});

test('stylesheet braces are balanced', () => {
  const source = styles
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '');
  let depth = 0;
  for (const character of source) {
    if (character === '{') depth += 1;
    if (character === '}') depth -= 1;
    assert.ok(depth >= 0, 'stylesheet has an unexpected closing brace');
  }
  assert.equal(depth, 0);
});

test('optimized evaluation status and path are handled by the renderer', () => {
  assert.match(renderer, /evaluation_status\s*!==\s*['"]ok['"]/);
  assert.match(renderer, /literal_fast_path:[\s\S]*?本地快速判定/);
  assert.match(renderer, /boundary_semantic_review:[\s\S]*?边界语义复核/);
  assert.match(preload, /cancelHint:[\s\S]*?cancel-hint/);
});

test('demo mode controls and fixtures are wired before the renderer', () => {
  assert.match(html, /id=["']demoModeToggleBtn["']/);
  assert.match(html, /onclick=["']toggleDemoMode\(\)["']/);
  assert.ok(
    html.indexOf('<script src="demo-mode.js"></script>') <
      html.indexOf('<script src="renderer.js"></script>')
  );
  assert.match(renderer, /async function toggleDemoMode\s*\(/);
  assert.match(renderer, /updateConfig\(\{ demoMode: nextValue \}\)/);
  assert.match(renderer, /if \(isDemoMode\) \{[\s\S]*?WordWiseDemo\.getLists\(\)/);
  assert.match(demo, /hintDepth:\s*0/);
  assert.match(demo, /hintDepth:\s*1/);
  assert.match(demo, /hintDepth:\s*2/);
  assert.match(demo, /hintDepth:\s*3/);
});

test('demo interactions bypass persistent learning paths', () => {
  assert.match(renderer, /if \(isDemoMode\) \{\s*evaluateDemoAnswer\(answer\);\s*return;/);
  assert.match(renderer, /if \(isDemoMode\) \{\s*requestDemoHint\(level, cost\);\s*return;/);
  assert.match(renderer, /if \(isElectron && !isDemoMode\) \{[\s\S]*?electronAPI\.db\.deleteWord/);
  assert.match(renderer, /if \(!isDemoMode\) localStorage\.setItem\(SCORE_KEY/);
});
