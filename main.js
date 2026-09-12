import { app, BrowserWindow, ipcMain, shell, protocol } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { initLlmHandlers, disposeLlm, getCachedConfig, setMainWindow as setLlmWin } from './llm.js';
import { registerDbHandlers, initVocabDb, getVocabCore, setMainWindow as setDbWin } from './db-handlers.js';
import { initLicense, registerLicenseHandlers, disposeLicense, setMainWindow as setLicenseWin } from './license.js';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;

// ---------------------------------------------------------------------------
// Audio binary pack — replaces 12,858 loose MP3 files
// Format: [4-byte LE index length] [JSON index] [concatenated MP3 data]
// Zero external dependencies.
// ---------------------------------------------------------------------------
let audioFd = null;          // file descriptor for audio.pack
let audioIndex = null;       // { word: { offset, size } }
let audioDataOffset = 0;     // byte offset where audio data section starts

function audioPackPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'audio.pack');
  }
  return path.join(__dirname, 'audio.pack');
}

function initAudioPack() {
  const packPath = audioPackPath();
  if (!fs.existsSync(packPath)) {
    console.warn('[Audio] audio.pack not found at', packPath);
    return;
  }
  try {
    audioFd = fs.openSync(packPath, 'r');

    // Read 4-byte header: index JSON length
    const headerBuf = Buffer.alloc(4);
    fs.readSync(audioFd, headerBuf, 0, 4, 0);
    const indexLen = headerBuf.readUInt32LE(0);

    // Read index JSON
    const indexBuf = Buffer.alloc(indexLen);
    fs.readSync(audioFd, indexBuf, 0, indexLen, 4);
    audioIndex = JSON.parse(indexBuf.toString('utf8'));

    // Data section starts after header + index
    audioDataOffset = 4 + indexLen;

    console.log(`[Audio] opened audio.pack: ${Object.keys(audioIndex).length} entries`);
  } catch (err) {
    console.error('[Audio] failed to open audio.pack:', err.message);
    audioFd = null;
    audioIndex = null;
  }
}

// In-memory LRU cache for recently read blobs (each ≈ 10 KB, cap at 200 ≈ 2 MB)
const AUDIO_LRU_MAX = 200;
const audioLruCache = new Map();

function getAudioBlob(word) {
  if (!audioIndex || audioFd === null) return null;

  // LRU cache check
  if (audioLruCache.has(word)) {
    const val = audioLruCache.get(word);
    audioLruCache.delete(word);
    audioLruCache.set(word, val);
    return val;
  }

  if (!Object.prototype.hasOwnProperty.call(audioIndex, word)) return null;
  const entry = audioIndex[word];

  // Read from the pack file at the exact offset
  const buf = Buffer.alloc(entry.size);
  fs.readSync(audioFd, buf, 0, entry.size, audioDataOffset + entry.offset);

  // Evict oldest if at capacity
  if (audioLruCache.size >= AUDIO_LRU_MAX) {
    const oldest = audioLruCache.keys().next().value;
    audioLruCache.delete(oldest);
  }
  audioLruCache.set(word, buf);
  return buf;
}

// ---------------------------------------------------------------------------
// Register custom `media:` protocol for serving audio blobs
// Must be called BEFORE app.whenReady()
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([{
  scheme: 'media',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
  },
}]);

function registerMediaProtocol() {
  protocol.handle('media', (request) => {
    // Expected URL: media://audio/<word>
    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\/+/, '').split('/');
    if (parts[0] !== 'audio' && url.hostname !== 'audio') {
      return new Response('Not Found', { status: 404 });
    }
    // The word is either in pathname (media://audio/abandon) or hostname=audio + path
    const word = (url.hostname === 'audio' ? parts[0] : parts[1]) || '';
    if (!word) {
      return new Response('Not Found', { status: 404 });
    }

    const blob = getAudioBlob(word);
    if (!blob) {
      return new Response('Not Found', { status: 404 });
    }

    return new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(blob.length),
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  });
  console.log('[Audio] media: protocol registered');
}

// ---------------------------------------------------------------------------
// IPC: check whether audio exists for a word (returns boolean)
// ---------------------------------------------------------------------------
ipcMain.handle('has-audio', async (_e, word) => {
  if (typeof word !== 'string' || !word) return false;
  const safeName = word.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  return audioIndex ? Object.prototype.hasOwnProperty.call(audioIndex, safeName) : false;
});

// Returns a media:// URL string or null
ipcMain.handle('get-audio-path', async (_e, word) => {
  if (typeof word !== 'string' || !word) return null;
  const safeName = word.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  if (audioIndex && Object.prototype.hasOwnProperty.call(audioIndex, safeName)) {
    return `media://audio/${safeName}`;
  }
  return null;
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, 'icon.png'));
  }

  mainWindow = new BrowserWindow({
    icon: path.join(__dirname, 'icon.png'),
    width: 1100,
    height: 850,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: true
    },
    titleBarStyle: 'hiddenInset',
    show: false
  });

  setLlmWin(mainWindow);
  setDbWin(mainWindow);
  setLicenseWin(mainWindow);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // 安全：只允许停留在本地 file:// 内容，阻止主窗口导航到远程页面。
  // 否则远程页面会在导航后重新注入 preload，从而拿到完整 electronAPI（IPC）。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      console.warn(`[Security] blocked main-frame navigation to: ${url}`);
      event.preventDefault();
    }
  });
  // 安全：本应用不应存在子 frame，拒绝一切子 frame 导航（纵深防御）。
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) {
      console.warn('[Security] blocked subframe navigation');
      event.preventDefault();
    }
  });

  mainWindow.loadFile('index.html').catch(err => console.error('Failed to load UI:', err));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.once('closed', () => { mainWindow = null; });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

// 外部链接只允许 http/https
ipcMain.handle('open-external', async (_e, url) => {
  if (typeof url !== 'string' || !(url.startsWith('https://') || url.startsWith('http://'))) {
    console.warn(`[Security] blocked: ${url}`);
    return { success: false, error: 'Only http:// and https:// URLs are allowed.' };
  }
  await shell.openExternal(url);
});

ipcMain.handle('get-config', async () => getCachedConfig());

app.whenReady().then(async () => {
  // Boost main process priority to ensure inference gets CPU time
  if (process.platform === 'win32') {
    try {
      app.setAppUserModelId('com.wordwise.vocab-tester');
      const priority = os.cpus().length >= 8 ? 'high' : 'normal';
      process.setPriority?.(priority);
      console.log(`[Main] process priority: ${priority}`);
    } catch (e) {
      console.warn('[Main] priority set failed:', e.message);
    }
  }

  // Initialize audio pack and protocol
  initAudioPack();
  registerMediaProtocol();

  initVocabDb();
  await initLicense();
  createWindow();

  initLlmHandlers(getVocabCore);
  registerDbHandlers();
  registerLicenseHandlers();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  disposeLlm();
  disposeLicense();
  if (audioFd !== null) { try { fs.closeSync(audioFd); } catch (_) {} }
  if (process.platform !== 'darwin') app.quit();
});

