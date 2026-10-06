#!/usr/bin/env node
// Inspect Git's index, not unstaged working-tree copies. Output paths, never values.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const manifestName = 'public-files.json';
const maxBytes = 2 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const forbiddenDirectories = /(?:^|\/)(?:online-trial|server|deployment|backups|runtime|private-assets|models|finetune(?:-output)?|wordwise-gold(?:-archive)?|research-paper-portfolio|copyright_prep[^/]*|evaluation|paid|commercial|release-private|\.worktrees|\.codex)(?:\/|$)/i;
const forbiddenFiles = /(?:^|\/)(?:\.env(?:\.[^/]*)?|audio\.pack|issue(?:-beta-super)?-code\.mjs|gen-keypair\.mjs)$|\.(?:pem|key|crt|age|gguf|safetensors|bin|node|db|sqlite3?|dump|jsonl|mp3|mp4|mov|dmg|exe|zip|pyc)$/i;
const forbiddenDictionaries = /(?:^|\/)db\/.*\.(?:json|txt|csv)$/i;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /postgres(?:ql)?:\/\/[^\s/:]+:[^\s/@]+@/i,
];

export function forbiddenPublicPath(name) {
  return !name || name.startsWith('/') || name.split('/').includes('..') || name.includes('\\') ||
    forbiddenDirectories.test(name) || forbiddenFiles.test(name) || forbiddenDictionaries.test(name);
}

export function contentProblems(name, bytes) {
  if (name.endsWith('.png')) {
    return bytes.subarray(0, 8).equals(pngSignature) ? [] : ['invalid PNG'];
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return ['unapproved binary content']; }
  const problems = [];
  if (text.includes('\0')) problems.push('unapproved binary content');
  if (secretPatterns.some(pattern => pattern.test(text))) problems.push('credential signature');
  const assignments = text.matchAll(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|cookie[_-]?secret|encryption[_-]?key)\s*[:=]\s*["']([A-Za-z0-9_+/=.-]{16,})["']/gi);
  for (const match of assignments) {
    if (!/^(?:example|dummy|fake|placeholder|replace|change|your[-_])/i.test(match[1])) {
      problems.push('literal credential assignment');
      break;
    }
  }
  if (name === 'beta-super-config.js' && /\benabled\s*:\s*true\b/.test(text)) {
    problems.push('enabled operator-only beta verifier');
  }
  if (/(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+\/(?:Desktop|Documents|\.ssh|\.aws|\.codex)\//.test(text)) {
    problems.push('private machine path');
  }
  return [...new Set(problems)];
}

export function checkPublicFiles(root) {
  const git = args => execFileSync('git', args, {
    cwd: root, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const entries = git(['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean).map(line => {
    const match = line.match(/^(\d+) ([a-f0-9]+) (\d+)\t([\s\S]+)$/);
    if (!match) throw new Error('Cannot inspect staged file metadata');
    return { mode: match[1], sha: match[2], stage: match[3], name: match[4] };
  });
  const readBlob = entry => git(['cat-file', 'blob', entry.sha]);
  const manifestEntry = entries.find(entry => entry.name === manifestName && entry.stage === '0');
  if (!manifestEntry || !['100644', '100755'].includes(manifestEntry.mode)) {
    throw new Error('Stage a regular public-files.json allowlist before checking');
  }
  const manifest = JSON.parse(readBlob(manifestEntry).toString('utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) ||
      !manifest.files.every(name => typeof name === 'string') ||
      new Set(manifest.files).size !== manifest.files.length || !manifest.files.includes(manifestName)) {
    throw new Error('Invalid public-files.json allowlist');
  }
  const allowed = new Set(manifest.files);
  const problems = [];
  for (const name of allowed) if (forbiddenPublicPath(name)) problems.push(`${name}: forbidden allowlist path`);
  const indexed = new Set(entries.map(entry => entry.name));
  for (const name of allowed) if (!indexed.has(name)) problems.push(`${name}: allowlisted file missing from index`);
  for (const entry of entries) {
    const { name, mode, stage } = entry;
    if (stage !== '0') { problems.push(`${name}: unresolved merge`); continue; }
    if (!allowed.has(name)) { problems.push(`${name}: absent from public allowlist`); continue; }
    if (forbiddenPublicPath(name)) { problems.push(`${name}: private artifact`); continue; }
    if (!['100644', '100755'].includes(mode)) { problems.push(`${name}: symlink or submodule`); continue; }
    const size = Number(git(['cat-file', '-s', entry.sha]).toString('utf8'));
    if (size > maxBytes) { problems.push(`${name}: exceeds 2 MiB source limit`); continue; }
    for (const reason of contentProblems(name, readBlob(entry))) problems.push(`${name}: ${reason}`);
  }
  return { files: entries.length, problems: [...new Set(problems)] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const result = checkPublicFiles(root);
    if (result.problems.length) {
      console.error(result.problems.join('\n'));
      process.exitCode = 1;
    } else console.log(`Public Git index passed: ${result.files} allowlisted files; no checked credential signatures or private artifacts.`);
  } catch {
    console.error('Public index check failed. Verify the staged allowlist and Git index; no file contents were printed.');
    process.exitCode = 1;
  }
}
