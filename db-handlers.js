import { ipcMain, dialog, app } from 'electron';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { assertLearningAllowed, notifyDbSwitched } from './license.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const userDataPath = app.getPath('userData');
let mainWindow = null;
export function setMainWindow(win) { mainWindow = win; }

let vc = null;

export function getVocabCore() {
  if (!vc) {
    try {
      const plat = process.platform;
      const nodeFile = plat === 'win32' ? 'vocab_core.win32.node' : 'vocab_core.mac.node';
      vc = require(path.join(__dirname, 'vocab-core', nodeFile));
    } catch (err) {
      console.error('[vocab-core] native module load failed:', err.message);
    }
  }
  return vc;
}

export function initVocabDb() {
  const c = getVocabCore();
  if (!c) return;
  try {
    c.setupDb(path.join(userDataPath, 'vocab.db'));
  } catch (err) {
    console.error('[db] init failed:', err.message);
  }
}

const LIST_DIFFICULTY = {
  'Highschool_edited.txt': 2,
  'CET4_edited.txt': 3,
  'CET6_edited.txt': 5,
  'TOEFL.txt': 7,
  'GRE_8000_Words.txt': 9,
};

function dbDir() {
  if (app.isPackaged) {
    // 打包后 db 文件通过 asarUnpack 解包到 app.asar.unpacked/db/
    // Rust 原生模块使用自己的文件 I/O，必须读取真实路径（不能在 asar 内）
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'db');
  }
  return path.join(__dirname, 'db');
}

function seedPathFor(listName) {
  if (typeof listName !== 'string' || path.basename(listName) !== listName) return null;
  if (!['.txt', '.json', '.csv'].includes(path.extname(listName).toLowerCase())) return null;
  return path.join(dbDir(), listName);
}

export function registerDbHandlers() {
  const licenseGuard = () => {
    const r = assertLearningAllowed();
    return r.blocked ? { licenseBlocked: true, reason: r.reason } : null;
  };
  ipcMain.handle('db-get-lists', async () => {
    const lists = [{ name: 'Custom / My Words', file: 'Custom / My Words' }];
    const dir = dbDir();
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(f =>
        f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.json') || f.toLowerCase().endsWith('.csv')
      ).sort((left, right) => left.localeCompare(right, 'en'));
      const pretty = {
        'Highschool_edited.txt': 'Highschool',
        'CET4_edited.txt': 'CET4',
        'CET6_edited.txt': 'CET6',
        'TOEFL.txt': 'TOEFL',
        'GRE_8000_Words.txt': 'GRE'
      };
      lists.push(...files.map(f => ({
        file: f,
        name: pretty[f] || f.replace(/_edited\.txt$/i, '').replace(/\.txt$/i, '')
      })));
    }
    return lists;
  });

  ipcMain.handle('db-switch-list', async (_e, listName) => {
    const c = getVocabCore();
    if (!c) return false;

    let dbName = 'vocab.db';
    let seedFile = null;

    if (listName !== 'Custom / My Words') {
      seedFile = seedPathFor(listName);
      if (!seedFile || !fs.existsSync(seedFile)) return false;
      const base = path.parse(listName).name;
      dbName = `vocab_${base}.db`;
    }

    try {
      const dbPath = path.join(userDataPath, dbName);

      // --- Pre-built DB: if user data doesn't have this DB yet, copy from app bundle ---
      const isBuiltIn = Object.prototype.hasOwnProperty.call(LIST_DIFFICULTY, listName);
      if (isBuiltIn && !fs.existsSync(dbPath)) {
        const prebuiltPath = path.join(dbDir(), dbName);
        if (fs.existsSync(prebuiltPath)) {
          console.log(`[db] copying pre-built ${dbName} to user data...`);
          const t0 = Date.now();
          fs.copyFileSync(prebuiltPath, dbPath);
          console.log(`[db] copied in ${Date.now() - t0}ms`);
        }
      }

      const result = c.setupDb(dbPath);
      console.log(`[db] switched to ${dbName}:`, result.message);
      notifyDbSwitched(dbPath);

      if (seedFile && fs.existsSync(seedFile)) {
        const count = Number(c.getWordCount());
        // 内置词库且词数太少，可能是上次导入被中断了
        if (count === 0 || (isBuiltIn && count < 10)) {
          console.log(`[db] seeding ${listName} (count=${count})...`);
          const res = await c.importWordsFromFile(seedFile);
          console.log(`[db] seeded: +${res.imported} (skipped: ${res.skipped})`);
          if (res.imported === 0 && res.total === 0) {
            console.error(`[db] seed file empty or unreadable: ${seedFile}`);
          }
          const diff = LIST_DIFFICULTY[listName];
          if (diff && diff > 1) {
            try {
              c.setDefaultDifficulty(diff);
              console.log(`[Adaptive] default difficulty ${diff} for ${listName}`);
            } catch (e) {
              console.warn('[Adaptive] setDefaultDifficulty:', e.message);
            }
          }
        } else {
          const diff = LIST_DIFFICULTY[listName];
          if (diff && diff > 1) {
            try {
              c.setDefaultDifficulty(diff);
            } catch (e) {
              console.warn('[Adaptive] setDefaultDifficulty (existing):', e.message);
            }
          }
        }
      }
      return true;
    } catch (err) {
      console.error('[db] switch list failed:', err.message);
      return false;
    }
  });

  ipcMain.handle('db-refresh-list', async (_e, listName) => {
    const g = licenseGuard(); if (g) return g;
    const c = getVocabCore();
    if (!c) return { success: false };
    const seedFile = seedPathFor(listName);
    if (!seedFile || !fs.existsSync(seedFile)) {
      return { success: false, error: 'Source file not found' };
    }
    try {
      const res = await c.importWordsFromFile(seedFile);
      return { success: true, ...res };
    } catch (e) {
      console.error('[db] refresh:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('db-get-word', async (_e, term) => {
    const c = getVocabCore();
    if (!c) return null;
    try { return c.getWordByTerm(term); } catch (e) { console.error('[db] getWord:', e.message); return null; }
  });

  ipcMain.handle('db-get-all-words', async () => {
    const c = getVocabCore();
    if (!c) { console.warn('[db] getAllWords called but native not ready'); return []; }
    try { return c.getAllWords(); } catch (e) { console.error('[db] getAllWords:', e.message); return []; }
  });

  ipcMain.handle('db-add-word', async (_e, term, meaning) => {
    const g = licenseGuard(); if (g) return g;
    const c = getVocabCore();
    if (!c) return { success: false, message: '词汇引擎未就绪' };
    try { return c.addWord(term, meaning); } catch (e) { return { success: false, message: e.message }; }
  });

  ipcMain.handle('db-delete-word', async (_e, id) => {
    const g = licenseGuard(); if (g) return g;
    const c = getVocabCore();
    if (!c) return { success: false, message: 'native 模块加载失败' };
    try { return c.deleteWord(id); } catch (e) { return { success: false, message: e.message }; }
  });

  // 'db-import-file' 已移除：原实现接受 renderer 传入的任意路径并交给 native
  // 模块读文件，与 db-get-all-words 组合可形成任意文件读取链。导入统一走
  // db-import-dialog（由系统文件对话框授权选择）。

  ipcMain.handle('db-get-batch', async (_e, limit, mode, offset) => {
    const g = licenseGuard(); if (g) return g;
    const c = getVocabCore();
    if (!c) return [];
    try { return c.getPracticeBatch(Number(limit), mode || 'random', Number(offset || 0)); } catch (e) { console.error('[db] getBatch:', e.message); return []; }
  });

  ipcMain.handle('db-update-score', async (_e, id, isCorrect) => {
    const g = licenseGuard(); if (g) return g;
    const c = getVocabCore();
    if (!c) return { success: false, message: 'vocabCore 为空' };
    try { return c.updateWordScore(Number(id), isCorrect); } catch (e) { return { success: false, message: e.message }; }
  });

  ipcMain.handle('db-save-session', async (_e, tested, correct, score) => {
    const g = licenseGuard(); if (g) return g;
    const c = getVocabCore();
    if (!c) return { success: false, message: '引擎未加载' };
    try { return c.saveSession(Number(tested), Number(correct), Number(score)); } catch (e) { return { success: false, message: e.message }; }
  });

  ipcMain.handle('db-word-count', async () => {
    const c = getVocabCore();
    if (!c) return 0;
    try { return Number(c.getWordCount()); } catch (e) { console.error(e); return 0; }
  });

  ipcMain.handle('db-export-json', async () => {
    const c = getVocabCore();
    if (!c) return '[]';
    try { return c.exportWordsJson(); } catch (e) { console.error(e); return '[]'; }
  });

  ipcMain.handle('db-import-dialog', async () => {
    const g = licenseGuard(); if (g) return g;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Vocabulary File',
      filters: [
        { name: 'Vocab Files', extensions: ['txt', 'csv', 'json'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    const c = getVocabCore();
    if (!c) return { canceled: false, imported: 0, skipped: 0, total: 0 };
    try {
      const res = await c.importWordsFromFile(result.filePaths[0]);
      return { canceled: false, ...res };
    } catch (e) {
      return { canceled: false, error: e.message };
    }
  });


  ipcMain.handle('db-get-next-adaptive', async (_e, curDiff, excludeId) => {
    const g = licenseGuard(); if (g) return g;
    const c = getVocabCore();
    if (!c) return null;
    try {
      const excl = excludeId ? Number(excludeId) : null;
      return c.getNextAdaptiveWord(Number(curDiff || 3), excl);
    } catch (e) {
      console.error('[Adaptive] pickNext:', e.message);
      return null;
    }
  });

  ipcMain.handle('db-get-mastery', async (_e, wordId) => {
    const c = getVocabCore();
    if (!c) return 0;
    try { return c.getMasteryScore(Number(wordId)); } catch (e) { console.error('[Adaptive] mastery:', e.message); return 0; }
  });

  ipcMain.handle('db-get-progress-summary', async () => {
    const c = getVocabCore();
    if (!c) return [];
    try { return c.getUserProgressSummary(); } catch (e) { console.error('[Adaptive] progress:', e.message); return []; }
  });

  ipcMain.handle('db-update-difficulty', async (_e, wordId, level) => {
    const g = licenseGuard(); if (g) return g;
    const c = getVocabCore();
    if (!c) return { success: false, message: '引擎未就绪' };
    try { return c.updateWordDifficulty(Number(wordId), Number(level)); } catch (e) { return { success: false, message: e.message }; }
  });

  ipcMain.handle('db-get-word-profile', async (_e, wordId) => {
    const c = getVocabCore();
    if (!c || typeof c.getWordProfile !== 'function') return null;
    try {
      return c.getWordProfile(Number(wordId));
    } catch (e) {
      console.error('[Adaptive] wordProfile:', e.message);
      return null;
    }
  });

  ipcMain.handle('db-get-confusion-map', async (_e, limit) => {
    const c = getVocabCore();
    if (!c || typeof c.getConfusionMap !== 'function') return [];
    try {
      return c.getConfusionMap(Number(limit || 20));
    } catch (e) {
      console.error('[ConfusionMap] load failed:', e.message);
      return [];
    }
  });

  ipcMain.handle('db-get-confusion-detail', async (_e, sourceWordId, fingerprint) => {
    const c = getVocabCore();
    if (!c || typeof c.getConfusionDetail !== 'function') return null;
    try {
      return c.getConfusionDetail(Number(sourceWordId), String(fingerprint || ''));
    } catch (e) {
      console.error('[ConfusionMap] detail failed:', e.message);
      return null;
    }
  });

  ipcMain.handle('db-get-mistake-queue-status', async () => {
    const c = getVocabCore();
    if (!c || typeof c.getMistakeQueueStatus !== 'function') return { dueCount: 0, unresolvedCount: 0, nextEligibleAt: null };
    try {
      return c.getMistakeQueueStatus();
    } catch (e) {
      console.error('[MistakeQueue] status failed:', e.message);
      return { dueCount: 0, unresolvedCount: 0, nextEligibleAt: null, error: e.message };
    }
  });

  ipcMain.handle('db-get-next-mistake', async (_e, options = {}) => {
    const g = licenseGuard(); if (g) return g;
    const c = getVocabCore();
    if (!c || typeof c.getNextMistake !== 'function') return null;
    try {
      const id = Number(options?.excludeMistakeId);
      return c.getNextMistake(Number.isSafeInteger(id) && id > 0 ? id : null);
    } catch (e) {
      console.error('[MistakeQueue] next failed:', e.message);
      return null;
    }
  });

  ipcMain.handle('db-get-mistake-summary', async (_e, options = {}) => {
    const g = licenseGuard(); if (g) return g;
    const c = getVocabCore();
    if (!c || typeof c.getMistakeSummary !== 'function') return [];
    try {
      const status = ['due', 'waiting', 'resolved', 'unresolved'].includes(options?.status)
        ? options.status
        : 'unresolved';
      const limit = Math.max(1, Math.min(200, Number(options?.limit) || 50));
      const cursor = Number(options?.cursor);
      return c.getMistakeSummary(
        status,
        limit,
        Number.isSafeInteger(cursor) && cursor > 0 ? cursor : null
      );
    } catch (e) {
      console.error('[MistakeQueue] summary failed:', e.message);
      return [];
    }
  });
}
