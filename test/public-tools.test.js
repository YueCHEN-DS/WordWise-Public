import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkPublicFiles } from '../scripts/check-public-files.mjs';
import { inspectPackageFiles } from '../scripts/check-package-files.mjs';

function fixture(t, files = {}, extraAllowed = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wordwise-public-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--quiet']);
  const contents = { 'README.md': '# Fictional project\n', ...files };
  const allowed = [...new Set(['README.md', 'public-files.json', ...extraAllowed])].sort();
  contents['public-files.json'] = JSON.stringify({ version: 1, files: allowed });
  for (const [name, value] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), value);
  }
  git(['add', '--', ...Object.keys(contents)]);
  return { root, git };
}

test('publication guard accepts an exact, clean staged allowlist without modifying it', t => {
  const { root, git } = fixture(t);
  const before = git(['ls-files', '--stage', '-z']);
  assert.deepEqual(checkPublicFiles(root), { files: 2, problems: [] });
  assert.deepEqual(git(['ls-files', '--stage', '-z']), before);
});

test('publication guard rejects a staged file absent from the allowlist', t => {
  const { root } = fixture(t, { 'notes.md': 'A fictional note' });
  assert.ok(checkPublicFiles(root).problems.some(problem => problem.includes('notes.md: absent')));
});

test('allowlist cannot admit private keys, environments, dictionaries, backend or operator artifacts', async t => {
  for (const name of ['operator.pem', '.env.production', 'db/FR_example.json',
    'online-trial/server/index.js', 'backups/main.dump.age', 'models/example.gguf', 'scripts/issue-code.mjs']) {
    await t.test(name, t => {
      const { root } = fixture(t, { [name]: 'fictional content' }, [name]);
      assert.ok(checkPublicFiles(root).problems.some(problem => problem.startsWith(name + ':')));
    });
  }
});

test('publication guard rejects synthetic credentials and never includes their values in diagnostics', async t => {
  const cases = [
    ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
    ['gh', 'p_'].join('') + 'A'.repeat(36),
    ['github', '_pat_'].join('') + 'B'.repeat(50),
    'const apiKey = "' + 'C'.repeat(32) + '";',
    ['postgresql://', 'fictional:', 'D'.repeat(20), '@example.invalid/test'].join(''),
  ];
  for (let i = 0; i < cases.length; i++) {
    await t.test(`synthetic pattern ${i + 1}`, t => {
      const value = cases[i];
      const { root } = fixture(t, { 'helper.mjs': value }, ['helper.mjs']);
      const problems = checkPublicFiles(root).problems;
      assert.ok(problems.some(problem => /credential/.test(problem)));
      assert.ok(problems.every(problem => !problem.includes(value)));
    });
  }
});

test('publication guard checks staged bytes even when the working copy differs', t => {
  const value = ['gh', 'p_'].join('') + 'E'.repeat(36);
  const { root, git } = fixture(t, { 'helper.mjs': value }, ['helper.mjs']);
  fs.writeFileSync(path.join(root, 'helper.mjs'), '// clean working copy\n');
  assert.ok(checkPublicFiles(root).problems.some(problem => /credential/.test(problem)));
  git(['add', '--', 'helper.mjs']);
  fs.writeFileSync(path.join(root, 'helper.mjs'), value);
  assert.deepEqual(checkPublicFiles(root).problems, []);
});

test('publication guard rejects symlinks rather than following them', t => {
  const { root, git } = fixture(t, {}, ['link.md']);
  fs.symlinkSync('README.md', path.join(root, 'link.md'));
  git(['add', '--', 'link.md']);
  assert.ok(checkPublicFiles(root).problems.includes('link.md: symlink or submodule'));
});

test('publication guard rejects unexpected binaries and oversized source files', async t => {
  await t.test('binary', t => {
    const { root } = fixture(t, { 'helper.mjs': Buffer.from([0, 255, 0]) }, ['helper.mjs']);
    assert.ok(checkPublicFiles(root).problems.some(problem => /binary/.test(problem)));
  });
  await t.test('oversized', t => {
    const { root } = fixture(t, { 'helper.mjs': 'x'.repeat(2 * 1024 * 1024 + 1) }, ['helper.mjs']);
    assert.ok(checkPublicFiles(root).problems.some(problem => /2 MiB/.test(problem)));
  });
});

test('publication guard allows a public verification key but rejects an enabled operator verifier', t => {
  const { root, git } = fixture(t, {
    'beta-super-config.js': 'export const BETA_SUPER_CONFIG = { enabled: false };',
    'license.js': 'export const LICENSE_PUBLIC_KEY_B64 = "' + 'F'.repeat(44) + '";',
  }, ['beta-super-config.js', 'license.js']);
  assert.deepEqual(checkPublicFiles(root).problems, []);
  fs.writeFileSync(path.join(root, 'beta-super-config.js'), 'export const BETA_SUPER_CONFIG = { enabled: true };');
  git(['add', '--', 'beta-super-config.js']);
  assert.ok(checkPublicFiles(root).problems.some(problem => /operator-only/.test(problem)));
});

test('macOS package selection includes its own native runtime without private assets', () => {
  assert.equal(inspectPackageFiles('mac').target, 'mac');
});

test('Windows package selection includes its own native runtime without private assets', () => {
  assert.equal(inspectPackageFiles('win').target, 'win');
});
