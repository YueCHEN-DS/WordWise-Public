// ---------------------------------------------------------------------------
// license.js — Electron 胶水层
//
// 把 license-core.js 的纯逻辑接到主进程：设备指纹采集、三点冗余存储、
// 交叉校验、时间锚持久化与定时复查、激活码后端抽象、IPC、强制执行。
//
// 强制执行点：本模块导出 assertLearningAllowed()，由 db-handlers.js / llm.js
// 的学习类 IPC 在入口处调用。UI 锁屏只是表象，真正的闸门在主进程。
//
// 后端抽象：LICENSE_BACKEND 现为 'local-key'（离线验签）。
// 将来接入服务器：新建 license-backend-http.js 实现同接口，服务端签发的令牌
// 仍是同一 82 字节格式，复用 license-core.verifyActivationPayload()，把这里
// 的常量改成 'http' 并在 license.json 增加 lastRevalidateMs / 离线宽限即可。
// ---------------------------------------------------------------------------
import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  computeFingerprint,
  deviceCodeFromFingerprint,
  decodeActivationCode,
  licenseExpiredAt,
  isLifetimeLicense,
  newTrialState,
  serializeTrialRecord,
  parseTrialRecord,
  reduceTimeAnchor,
  getTrialStatus,
  TRIAL_MS,
  BETA_SUPER_LICENSE_DAYS,
  verifyBetaSuperCode,
  BUILD_TS,
  TIERS,
} from './license-core.js';
import { BETA_SUPER_CONFIG } from './beta-super-config.js';

const execFileAsync = promisify(execFile);

// 后端选择：优先读 config.json 的 licenseBackend，默认 'local-key'（离线验签）。
// 切服务器验证：在 config.json 写 {"licenseBackend":"http","licenseServerUrl":"https://..."}
// 即可，无需改代码。HttpBackend 见下方实现（服务端签发同格式 82B 令牌，复用验签）。
function readLicenseConfig() {
  try {
    const cfgPath = path.join(app.getPath('userData'), 'config.json');
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch { return {}; }
}
const _licenseCfg = readLicenseConfig();
const LICENSE_BACKEND = _licenseCfg.licenseBackend || 'local-key';
const LICENSE_SERVER_URL = _licenseCfg.licenseServerUrl || process.env.LICENSE_SERVER_URL || '';
const HTTP_REVALIDATE_INTERVAL_MS = 24 * 86_400_000; // 在线时每天向服务器复核一次
const HTTP_OFFLINE_GRACE_MS = 7 * 86_400_000;        // 离线宽限 7 天
const ANCHOR_INTERVAL_MS = 60_000;
const PERSIST_MIN_DELTA_MS = 60_000;

let mainWindow = null;
let currentFingerprint = null;
let currentDeviceCode = null;
let trialState = null;            // {v, installId, firstRunMs, maxSeenMs}
let activatedLicense = null;      // {payload, code, activatedAt}
let currentStatus = 'expired';    // 'trial' | 'active' | 'expired'
let currentReason = null;
let anchorTimer = null;
let lastPersistedMs = 0;
let persistPending = false;

export function setMainWindow(win) { mainWindow = win; }

// ===========================================================================
// 1. 设备指纹
// ===========================================================================
async function getMachineId() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('reg', [
        'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid',
      ]);
      const m = stdout.match(/MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]+)/);
      return m ? m[1] : '';
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
      const m = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      return m ? m[1] : '';
    }
  } catch (e) {
    console.warn('[License] machineId 采集失败:', e.message);
  }
  return '';
}

function getCpu() {
  try { return os.cpus()[0]?.model || ''; } catch { return ''; }
}

async function collectFingerprint() {
  const machineId = await getMachineId();
  const cpu = getCpu();
  // 故意不纳入 MAC（网卡增减/虚拟网卡会导致指纹漂移，破坏试用连续性）
  const fp = computeFingerprint({ machineId, mac: '', cpu });
  return { fp, deviceCode: deviceCodeFromFingerprint(fp) };
}

function fpPrefixHex() {
  return currentFingerprint.slice(0, 16); // 指纹前 8 字节的十六进制
}

// ===========================================================================
// 2. 三点冗余存储
// ===========================================================================
function licenseDir() { return path.join(app.getPath('userData'), 'license'); }
function trialFilePath() { return path.join(licenseDir(), 'trial.dat'); }
function licenseFilePath() { return path.join(licenseDir(), 'license.json'); }
function betaRedemptionFilePath() { return path.join(licenseDir(), 'beta-super-redemption.json'); }

const BETA_SUPER_LICENSE_KIND = 'beta-super-v1';

// --- 存储 1：userData 文件 ---
function readFileStore() {
  try { return fs.readFileSync(trialFilePath(), 'utf8'); } catch { return null; }
}
function writeFileStore(raw) {
  fs.mkdirSync(licenseDir(), { recursive: true });
  const tmp = trialFilePath() + '.tmp';
  fs.writeFileSync(tmp, raw, 'utf8');
  fs.renameSync(tmp, trialFilePath());
}

// --- 存储 2：注册表 (Win) / plist (mac) ---
async function readSystemStore() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('reg', [
        'query', 'HKCU\\Software\\WordWise', '/v', 'TrialState',
      ]);
      const m = stdout.match(/TrialState\s+REG_SZ\s+(.+)/);
      return m ? Buffer.from(m[1].trim(), 'base64').toString('utf8') : null;
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('defaults', [
        'read', 'com.wordwise.vocab-tester', 'TrialState',
      ]);
      return Buffer.from(stdout.trim(), 'base64').toString('utf8');
    }
  } catch { /* 首次运行或被删除 */ }
  return null;
}
async function writeSystemStore(raw) {
  const b64 = Buffer.from(raw, 'utf8').toString('base64');
  try {
    if (process.platform === 'win32') {
      await execFileAsync('reg', [
        'add', 'HKCU\\Software\\WordWise', '/v', 'TrialState', '/t', 'REG_SZ', '/d', b64, '/f',
      ]);
    } else if (process.platform === 'darwin') {
      await execFileAsync('defaults', [
        'write', 'com.wordwise.vocab-tester', 'TrialState', b64,
      ]);
    }
  } catch (e) {
    console.warn('[License] 系统存储写入失败（将仅靠文件+DB 冗余）:', e.message);
  }
}

// --- 存储 3：SQLite 文件头隐藏标记 ---
// user_version @ offset 60-63, application_id @ offset 68-71（SQLite 不主动改写）
function listVocabDbFiles() {
  const dir = app.getPath('userData');
  try {
    return fs.readdirSync(dir)
      .filter(f => /^vocab.*\.db$/.test(f))
      .map(f => path.join(dir, f));
  } catch { return []; }
}
function readDbMarker(dbPath) {
  try {
    const fd = fs.openSync(dbPath, 'r');
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 4, 60);
    fs.readSync(fd, buf, 4, 4, 68);
    fs.closeSync(fd);
    return buf;
  } catch { return null; }
}
function writeDbMarker(dbPath, tag8) {
  try {
    const fd = fs.openSync(dbPath, 'r+');
    fs.writeSync(fd, tag8.subarray(0, 4), 0, 4, 60);
    fs.writeSync(fd, tag8.subarray(4, 8), 0, 4, 68);
    fs.closeSync(fd);
  } catch (e) {
    // DB 被 native 模块占用时可能写入失败 —— 非致命，文件+系统存储已足够
    console.warn('[License] DB 标记写入失败:', path.basename(dbPath), e.message);
  }
}
function readAllDbMarkers() {
  const results = [];
  for (const dbPath of listVocabDbFiles()) {
    const m = readDbMarker(dbPath);
    if (m) results.push(m.toString('hex'));
  }
  return results;
}
function writeAllDbMarkers(tagHex) {
  const tag8 = Buffer.from(tagHex, 'hex').subarray(0, 8);
  for (const dbPath of listVocabDbFiles()) writeDbMarker(dbPath, tag8);
}
// db-handlers 切换词库后调用，给新建的 DB 文件补标记
export function notifyDbSwitched(dbPath) {
  if (!trialState || !currentFingerprint) return;
  const raw = serializeTrialRecord(trialState, currentFingerprint);
  const tag = JSON.parse(raw).tag;
  writeDbMarker(dbPath, Buffer.from(tag, 'hex').subarray(0, 8));
}

// ===========================================================================
// 3. 激活态存储（license.json）
// ===========================================================================
function loadActivatedLicense() {
  try {
    const obj = JSON.parse(fs.readFileSync(licenseFilePath(), 'utf8'));
    if (obj?.kind === BETA_SUPER_LICENSE_KIND) {
      if (!BETA_SUPER_CONFIG.enabled) return null;
      if (obj.codeHashB64 !== BETA_SUPER_CONFIG.verifierB64) return null;
      if (obj.fpPrefixHex !== fpPrefixHex()) {
        console.warn('[License] beta super voucher is bound to another device');
        return null;
      }
      if (!Number.isInteger(obj.expSec) || obj.expSec <= 0) return null;
      return {
        payload: {
          version: 1,
          tier: 'beta',
          expSec: obj.expSec,
          fpPrefixHex: obj.fpPrefixHex,
          nonce: 0,
        },
        code: null,
        activatedAt: obj.activatedAt || Date.now(),
        betaSuper: true,
      };
    }
    if (!obj?.code) return null;
    // 每次都用嵌入公钥重新验签 —— 防止有人手搓假 license.json
    const payload = decodeActivationCode(obj.code);
    if (!payload) { console.warn('[License] license.json 验签失败'); return null; }
    if (payload.fpPrefixHex !== fpPrefixHex()) {
      console.warn('[License] 激活码设备不匹配');
      return null;
    }
    return {
      payload, code: obj.code,
      activatedAt: obj.activatedAt || Date.now(),
      lastRevalidateMs: obj.lastRevalidateMs || null,
      betaSuper: false,
    };
  } catch { return null; }
}
function saveActivatedLicense(storedCode, payload, extra = {}) {
  fs.mkdirSync(licenseDir(), { recursive: true });
  fs.writeFileSync(licenseFilePath(), JSON.stringify({
    code: storedCode,
    activatedAt: Date.now(),
    tier: payload.tier,
    expSec: payload.expSec,
    ...extra,
  }, null, 2), 'utf8');
}

function readBetaRedemption() {
  try {
    const obj = JSON.parse(fs.readFileSync(betaRedemptionFilePath(), 'utf8'));
    if (obj?.kind !== BETA_SUPER_LICENSE_KIND) return null;
    if (typeof obj.codeHashB64 !== 'string' || typeof obj.fpPrefixHex !== 'string') return null;
    return obj;
  } catch { return null; }
}

function writeBetaRedemption(record) {
  fs.mkdirSync(licenseDir(), { recursive: true });
  const tmp = betaRedemptionFilePath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tmp, betaRedemptionFilePath());
}

function saveBetaActivatedLicense(record) {
  fs.mkdirSync(licenseDir(), { recursive: true });
  const tmp = licenseFilePath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({
    kind: BETA_SUPER_LICENSE_KIND,
    codeHashB64: record.codeHashB64,
    fpPrefixHex: record.fpPrefixHex,
    activatedAt: record.activatedAt,
    tier: 'beta',
    expSec: record.expSec,
  }, null, 2), 'utf8');
  fs.renameSync(tmp, licenseFilePath());
}

// ===========================================================================
// 4. 后端抽象
// ===========================================================================
class LocalKeyBackend {
  constructor() { this.name = 'local-key'; }
  async activate(input) {
    const payload = decodeActivationCode(input);
    if (!payload) return { ok: false, reason: 'invalid' };
    return { ok: true, payload, storedCode: input };
  }
  async refresh() { return null; } // 离线模式无需刷新
}

// 服务器后端：服务端签发与离线激活码同格式的 82B 令牌（复用 verifyActivationPayload）。
// 客户端只负责把码/设备码发给服务端、缓存返回的令牌、定时复核、离线宽限。
// 接入步骤：config.json 写 {"licenseBackend":"http","licenseServerUrl":"https://你的域名"}。
class HttpBackend {
  constructor() {
    this.name = 'http';
    if (!LICENSE_SERVER_URL) {
      console.warn('[License] HttpBackend 启用但未配置 licenseServerUrl');
    }
  }
  async _post(path, body) {
    if (!LICENSE_SERVER_URL) throw new Error('未配置 licenseServerUrl');
    const res = await fetch(`${LICENSE_SERVER_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, reason: `server_${res.status}` };
    return { ok: true, data: await res.json() };
  }
  async activate(input) {
    let r;
    try { r = await this._post('/activate', { code: input, deviceCode: currentDeviceCode }); }
    catch (e) { return { ok: false, reason: 'network' }; }
    if (!r.ok) return r;
    const payload = decodeActivationCode(r.data.token);
    if (!payload) return { ok: false, reason: 'invalid_token' };
    return { ok: true, payload, storedCode: r.data.token, lastRevalidateMs: Date.now() };
  }
  // 定时复核：成功返回新 token；离线在宽限内返回 null（保持现状）；超宽限返回 {expired}
  async refresh(license) {
    if (!license?.lastRevalidateMs) return null;
    const since = Date.now() - license.lastRevalidateMs;
    if (since < HTTP_REVALIDATE_INTERVAL_MS) return null; // 未到复核时间
    let r;
    try { r = await this._post('/revalidate', { token: license.code, deviceCode: currentDeviceCode }); }
    catch (e) {
      // 网络失败：在离线宽限内继续，否则判失效
      return since > HTTP_OFFLINE_GRACE_MS ? { expired: true, reason: 'offline_grace_expired' } : null;
    }
    if (!r.ok) return { expired: true, reason: r.reason };
    const payload = decodeActivationCode(r.data.token);
    if (!payload) return { expired: true, reason: 'invalid_token' };
    return { payload, storedCode: r.data.token, lastRevalidateMs: Date.now() };
  }
}

function createBackend(name) {
  if (name === 'http') return new HttpBackend();
  return new LocalKeyBackend();
}
const backend = createBackend(LICENSE_BACKEND);

// ===========================================================================
// 5. 状态计算与交叉校验
// ===========================================================================
async function readAllTrialRecords() {
  const fp = currentFingerprint;
  const raws = [];
  const fileRaw = readFileStore();
  if (fileRaw != null) raws.push(fileRaw);
  const sysRaw = await readSystemStore();
  if (sysRaw != null) raws.push(sysRaw);
  for (const hex of readAllDbMarkers()) {
    // DB 标记只存了 tag 前 8 字节，无法还原完整记录，单独作为"存在性 + tag 前缀"证据
    raws.push('__dbmarker:' + hex);
  }
  // 解析完整记录（文件 + 系统存储）
  const parsed = [];
  for (const raw of raws) {
    if (typeof raw === 'string' && raw.startsWith('__dbmarker:')) {
      parsed.push({ kind: 'dbmarker', tagPrefix: raw.slice(11) });
    } else {
      parsed.push({ kind: 'full', state: parseTrialRecord(raw, fp, null), raw });
    }
  }
  return parsed;
}

function buildStateObject() {
  const now = Date.now();
  if (currentStatus === 'active' && activatedLicense) {
    const p = activatedLicense.payload;
    let daysLeft = null;
    if (!isLifetimeLicense(p)) {
      daysLeft = Math.max(0, Math.ceil((p.expSec * 1000 - now) / 86_400_000));
    }
    return {
      status: 'active', daysLeft, tier: p.tier,
      expiresAt: isLifetimeLicense(p) ? null : p.expSec,
      betaSuper: Boolean(activatedLicense.betaSuper),
      deviceCode: currentDeviceCode, reason: null,
    };
  }
  if (currentStatus === 'trial' && trialState) {
    const t = getTrialStatus(trialState);
    return {
      status: 'trial', daysLeft: t.daysLeft, tier: null,
      expiresAt: null, deviceCode: currentDeviceCode, reason: null,
    };
  }
  return {
    status: 'expired', daysLeft: 0, tier: null,
    expiresAt: null, deviceCode: currentDeviceCode, reason: currentReason || 'expired',
  };
}

async function evaluateStatus() {
  const now = Date.now();

  // 1) 已激活且有效 → active
  if (activatedLicense && !licenseExpiredAt(activatedLicense.payload, now)) {
    setStatus('active', null);
    return;
  }

  // 2) 读取三点记录
  const records = await readAllTrialRecords();
  const fullValid = records.filter(r => r.kind === 'full' && r.state);
  const fullCorrupt = records.filter(r => r.kind === 'full' && !r.state);
  const dbMarkers = records.filter(r => r.kind === 'dbmarker');

  // 2a) 有损坏的完整记录（标签对不上 / 字段错乱）→ 篡改
  if (fullCorrupt.length > 0) { setStatus('expired', 'tamper'); return; }

  // 2b) 全部缺失 → 全新试用
  if (fullValid.length === 0) {
    if (dbMarkers.length > 0) {
      // 文件/系统存储都没了但 DB 标记还在 → 用户删了 license 目录想重置 → 判篡改
      setStatus('expired', 'tamper'); return;
    }
    const installId = crypto.randomUUID();
    trialState = newTrialState(Math.max(now, BUILD_TS || 0), installId, BUILD_TS);
    await persistTrialState();
    setStatus('trial', null);
    return;
  }

  // 2c) 多份完整记录之间 installId / firstRunMs 不一致 → 冲突
  const installIds = new Set(fullValid.map(r => r.state.installId));
  const firstRuns = new Set(fullValid.map(r => r.state.firstRunMs));
  if (installIds.size > 1 || firstRuns.size > 1) { setStatus('expired', 'conflict'); return; }

  // 2d) 合并：取最大 maxSeenMs
  const base = fullValid[0].state;
  const maxSeen = fullValid.reduce((m, r) => Math.max(m, r.state.maxSeenMs), base.maxSeenMs);
  trialState = { ...base, maxSeenMs: maxSeen };

  // 2e) DB 标记若存在，需与当前 trial 的 tag 前缀一致（不一致 → 篡改）
  if (dbMarkers.length > 0) {
    const expectedPrefix = JSON.parse(serializeTrialRecord(trialState, currentFingerprint)).tag.slice(0, 16);
    const mismatch = dbMarkers.some(m => m.tagPrefix !== expectedPrefix);
    if (mismatch) { setStatus('expired', 'tamper'); return; }
  }

  // 3) 时间锚
  const r = reduceTimeAnchor(trialState, now);
  if (r.rollback) { setStatus('expired', 'rollback'); return; }
  if (r.changed) {
    trialState = r.state;
    if (now - lastPersistedMs > PERSIST_MIN_DELTA_MS) await persistTrialState();
  }

  // 4) 试用是否到期
  setStatus(getTrialStatus(trialState).expired ? 'expired' : 'trial',
            getTrialStatus(trialState).expired ? 'trial_expired' : null);
}

function setStatus(status, reason) {
  const changed = currentStatus !== status || currentReason !== reason;
  currentStatus = status;
  currentReason = reason;
  if (changed) broadcastState();
}

function broadcastState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('license-state', buildStateObject());
  }
}

async function persistTrialState() {
  if (!trialState || !currentFingerprint) return;
  const raw = serializeTrialRecord(trialState, currentFingerprint);
  try { writeFileStore(raw); } catch (e) { console.warn('[License] 文件存储失败:', e.message); }
  await writeSystemStore(raw);
  const tagHex = JSON.parse(raw).tag;
  writeAllDbMarkers(tagHex);
  lastPersistedMs = Date.now();
  persistPending = false;
}

// ===========================================================================
// 6. 强制执行
// ===========================================================================
// 学习类 IPC 入口调用。同步推进时间锚（防会话内改时钟），返回拦截结果。
export function assertLearningAllowed() {
  if (currentStatus === 'active') return { blocked: false };
  if (currentStatus === 'trial' && trialState) {
    const now = Date.now();
    const r = reduceTimeAnchor(trialState, now);
    if (r.rollback) { setStatus('expired', 'rollback'); return { blocked: true, reason: 'rollback' }; }
    if (r.changed) {
      trialState = r.state;
      if (now - lastPersistedMs > PERSIST_MIN_DELTA_MS) persistTrialState(); // fire-and-forget
    }
    if (getTrialStatus(trialState).expired) { setStatus('expired', 'trial_expired'); return { blocked: true, reason: 'trial_expired' }; }
    return { blocked: false };
  }
  return { blocked: true, reason: currentReason || 'expired' };
}

export function getLicenseState() { return buildStateObject(); }

// ===========================================================================
// 7. 激活流程
// ===========================================================================
async function activate(code) {
  const betaResult = await activateBetaSuper(code);
  if (betaResult) return betaResult;

  const result = await backend.activate(code);
  if (!result.ok) return { ok: false, reason: result.reason || 'invalid' };
  const payload = result.payload;
  if (payload.fpPrefixHex !== fpPrefixHex()) return { ok: false, reason: 'device' };
  if (licenseExpiredAt(payload, Date.now())) return { ok: false, reason: 'expired' };
  const storedCode = result.storedCode || code;
  const extra = result.lastRevalidateMs ? { lastRevalidateMs: result.lastRevalidateMs } : {};
  saveActivatedLicense(storedCode, payload, extra);
  activatedLicense = {
    payload, code: storedCode, activatedAt: Date.now(),
    lastRevalidateMs: result.lastRevalidateMs || null,
    betaSuper: false,
  };
  setStatus('active', null);
  return { ok: true, state: buildStateObject() };
}

// Temporary beta-only path. The beta build contains only a salted verifier
// hash. The first local redemption binds the voucher to this device and
// grants one year. Global one-use enforcement still requires a server.
async function activateBetaSuper(code) {
  if (!BETA_SUPER_CONFIG.enabled || !verifyBetaSuperCode(code, BETA_SUPER_CONFIG)) return null;

  const codeHashB64 = BETA_SUPER_CONFIG.verifierB64;
  const previous = readBetaRedemption();
  if (previous?.codeHashB64 === codeHashB64 || activatedLicense?.betaSuper) {
    return { ok: false, reason: 'beta_used' };
  }
  if (activatedLicense && currentStatus === 'active') {
    return { ok: false, reason: 'already_active' };
  }

  const now = Date.now();
  const record = {
    kind: BETA_SUPER_LICENSE_KIND,
    codeHashB64,
    fpPrefixHex: fpPrefixHex(),
    activatedAt: now,
    expSec: Math.floor(now / 1000) + BETA_SUPER_LICENSE_DAYS * 86_400,
  };

  // Consume the local voucher marker before saving the license so a retry
  // after a partial write cannot silently issue another local redemption.
  writeBetaRedemption(record);
  saveBetaActivatedLicense(record);
  activatedLicense = {
    payload: {
      version: 1,
      tier: 'beta',
      expSec: record.expSec,
      fpPrefixHex: record.fpPrefixHex,
      nonce: 0,
    },
    code: null,
    activatedAt: now,
    betaSuper: true,
  };
  setStatus('active', null);
  return { ok: true, state: buildStateObject() };
}

// ===========================================================================
// 8. IPC
// ===========================================================================
export function registerLicenseHandlers() {
  ipcMain.handle('license-get-state', async () => buildStateObject());
  ipcMain.handle('license-get-device-code', async () => currentDeviceCode);
  ipcMain.handle('license-activate', async (_e, code) => activate(code));
}

// ===========================================================================
// 9. 生命周期
// ===========================================================================
export async function initLicense() {
  const { fp, deviceCode } = await collectFingerprint();
  currentFingerprint = fp;
  currentDeviceCode = deviceCode;
  console.log('[License] deviceCode =', deviceCode);

  activatedLicense = loadActivatedLicense();
  await evaluateStatus();

  anchorTimer = setInterval(async () => {
    try {
      if (currentStatus === 'active') {
        // 已激活：检查是否到期
        if (activatedLicense && licenseExpiredAt(activatedLicense.payload, Date.now())) {
          activatedLicense = null;
          await evaluateStatus();
          return;
        }
        // http 后端：定时向服务器复核令牌，离线宽限内放行
        if (backend.name === 'http' && activatedLicense && !activatedLicense.betaSuper) {
          const r = await backend.refresh(activatedLicense);
          if (r?.expired) {
            console.warn('[License] 服务器复核失败，令牌失效:', r.reason);
            activatedLicense = null;
            await evaluateStatus();
          } else if (r?.payload) {
            saveActivatedLicense(r.storedCode, r.payload, { lastRevalidateMs: r.lastRevalidateMs });
            activatedLicense = { payload: r.payload, code: r.storedCode,
              activatedAt: activatedLicense.activatedAt, lastRevalidateMs: r.lastRevalidateMs,
              betaSuper: false };
          }
        }
        return;
      }
      await evaluateStatus();
    } catch (e) { console.warn('[License] 定时复查出错:', e.message); }
  }, ANCHOR_INTERVAL_MS);
  // 确保进程退出时不会卡住定时器
  if (anchorTimer.unref) anchorTimer.unref();

  return buildStateObject();
}

export function disposeLicense() {
  if (anchorTimer) { clearInterval(anchorTimer); anchorTimer = null; }
}
