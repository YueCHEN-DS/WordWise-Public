#!/usr/bin/env node
/**
 * pack_audio_db.mjs — Packs all audio/*.mp3 files into a single binary archive.
 *
 * Zero dependencies — uses only Node.js built-in modules.
 *
 * Usage:
 *   node scripts/pack_audio_db.mjs [--audio-dir <dir>] [--output <path>]
 *
 * Defaults:
 *   --audio-dir  ./audio
 *   --output     ./audio.pack
 *
 * File format:
 *   [4 bytes LE: index JSON byte length N]
 *   [N bytes: JSON index mapping word → {offset, size}]
 *   [... concatenated MP3 binary data ...]
 *
 * Offsets in the index are relative to the start of the data section
 * (i.e., file position = 4 + N + offset).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// --- CLI args ---
const args = process.argv.slice(2);
function getArg(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

const audioDir = path.resolve(getArg('--audio-dir', path.join(projectRoot, 'audio')));
const outputPath = path.resolve(getArg('--output', path.join(projectRoot, 'audio.pack')));

// --- Main ---
console.log(`[pack-audio] Scanning: ${audioDir}`);
console.log(`[pack-audio] Output:   ${outputPath}`);

if (!fs.existsSync(audioDir)) {
  console.error(`[pack-audio] ERROR: audio directory not found: ${audioDir}`);
  process.exit(1);
}

const mp3Files = fs.readdirSync(audioDir)
  .filter(f => f.toLowerCase().endsWith('.mp3'))
  .sort();

console.log(`[pack-audio] Found ${mp3Files.length} MP3 files`);

if (mp3Files.length === 0) {
  console.error('[pack-audio] ERROR: no MP3 files found');
  process.exit(1);
}

const t0 = Date.now();

// Build index and collect data buffers
const index = {};
const dataBuffers = [];
let currentOffset = 0;

for (let i = 0; i < mp3Files.length; i++) {
  const file = mp3Files[i];
  const stem = path.parse(file).name.toLowerCase();
  const filePath = path.join(audioDir, file);
  const data = fs.readFileSync(filePath);

  index[stem] = { offset: currentOffset, size: data.length };
  dataBuffers.push(data);
  currentOffset += data.length;

  if ((i + 1) % 2000 === 0) {
    console.log(`[pack-audio]   ... read ${i + 1}/${mp3Files.length}`);
  }
}

// Serialize index to JSON
const indexJson = JSON.stringify(index);
const indexBuf = Buffer.from(indexJson, 'utf8');

// Write output file: [4-byte index length] [index JSON] [audio data...]
const headerBuf = Buffer.alloc(4);
headerBuf.writeUInt32LE(indexBuf.length, 0);

const fd = fs.openSync(outputPath, 'w');
fs.writeSync(fd, headerBuf);
fs.writeSync(fd, indexBuf);
for (const buf of dataBuffers) {
  fs.writeSync(fd, buf);
}
fs.closeSync(fd);

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const packSize = fs.statSync(outputPath).size;
console.log(`[pack-audio] Done! Packed ${mp3Files.length} files in ${elapsed}s`);
console.log(`[pack-audio] Pack size: ${(packSize / 1048576).toFixed(1)} MB`);
console.log(`[pack-audio] Index size: ${(indexBuf.length / 1024).toFixed(1)} KB (${Object.keys(index).length} entries)`);
