#!/usr/bin/env node
/**
 * prebuild_vocab_dbs.mjs — Pre-builds SQLite databases for all built-in word lists.
 *
 * Zero external dependencies — uses only vocab-core (Rust/SQLite native module).
 *
 * This eliminates the first-launch import delay (~2-5s per list) on low-performance
 * devices by shipping pre-populated databases alongside the app.
 *
 * Usage:
 *   node scripts/prebuild_vocab_dbs.mjs
 *
 * Output:
 *   db/vocab_<ListName>.db for each built-in word list
 *
 * These .db files are then auto-detected by db-handlers.js at runtime. If a
 * pre-built DB exists and already has words, the import step is skipped entirely.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Load the vocab-core native module
let vc;
try {
  vc = require(path.join(projectRoot, 'vocab-core'));
} catch (err) {
  console.error('[prebuild] Failed to load vocab-core:', err.message);
  process.exit(1);
}

const BUILT_IN_LISTS = {
  'Highschool_edited.txt': { difficulty: 2 },
  'CET4_edited.txt':       { difficulty: 3 },
  'CET6_edited.txt':       { difficulty: 5 },
  'TOEFL.txt':             { difficulty: 7 },
  'GRE_8000_Words.txt':    { difficulty: 9 },
};

const dbDir = path.join(projectRoot, 'db');

const builtPaths = [];
let totalBuilt = 0;
let totalSkipped = 0;

for (const [listFile, config] of Object.entries(BUILT_IN_LISTS)) {
  const seedPath = path.join(dbDir, listFile);
  if (!fs.existsSync(seedPath)) {
    console.warn(`[prebuild] SKIP: seed file not found: ${seedPath}`);
    totalSkipped++;
    continue;
  }

  const baseName = path.parse(listFile).name;
  const dbPath = path.join(dbDir, `vocab_${baseName}.db`);

  // Remove existing pre-built DB and any WAL/SHM files
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  console.log(`[prebuild] Building vocab_${baseName}.db from ${listFile}...`);
  const t0 = Date.now();

  try {
    const setupResult = vc.setupDb(dbPath);
    console.log(`[prebuild]   setup: ${setupResult.message}`);

    const importResult = await vc.importWordsFromFile(seedPath);
    console.log(`[prebuild]   imported: ${importResult.imported}, skipped: ${importResult.skipped}`);

    if (config.difficulty && config.difficulty > 1) {
      try {
        vc.setDefaultDifficulty(config.difficulty);
        console.log(`[prebuild]   difficulty: ${config.difficulty}`);
      } catch (e) {
        console.warn(`[prebuild]   setDefaultDifficulty failed: ${e.message}`);
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[prebuild]   import completed in ${elapsed}s`);
    builtPaths.push(dbPath);
    totalBuilt++;
  } catch (err) {
    console.error(`[prebuild] ERROR building ${listFile}:`, err.message);
    totalSkipped++;
  }
}

// Switch the Rust module to a throwaway DB so it releases all built DBs.
// When the Rust SQLite connection closes, it performs a passive WAL checkpoint
// automatically, flushing data from WAL into the main DB file.
const dummyPath = path.join(dbDir, '__prebuild_dummy.db');
try { vc.setupDb(dummyPath); } catch (_) {}

// Report final sizes and verify word counts
console.log(`\n[prebuild] Verifying ${builtPaths.length} databases...`);
for (const dbPath of builtPaths) {
  const name = path.basename(dbPath);
  try {
    // Re-open each DB to check word count and trigger any remaining checkpoint
    vc.setupDb(dbPath);
    const count = vc.getWordCount();

    // Switch away so the connection closes cleanly
    vc.setupDb(dummyPath);

    // Clean up any lingering WAL/SHM files after close
    for (const ext of ['-wal', '-shm']) {
      const f = dbPath + ext;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    const dbSize = fs.statSync(dbPath).size;
    console.log(`[prebuild]   ${name}: ${count} words, ${(dbSize / 1024).toFixed(0)} KB`);
  } catch (e) {
    console.warn(`[prebuild]   ${name}: verify failed: ${e.message}`);
  }
}

// Clean up dummy DB
for (const f of [dummyPath, dummyPath + '-wal', dummyPath + '-shm']) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

console.log(`\n[prebuild] Complete: ${totalBuilt} built, ${totalSkipped} skipped`);
