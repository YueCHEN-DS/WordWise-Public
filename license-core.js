// ---------------------------------------------------------------------------
// license-core.js — 纯逻辑授权核心（不依赖 Electron，可用 node:test 直接测试）
//
// 职责：
//   1. 设备指纹哈希 + 设备码（用户报给开发者的短码）
//   2. 离线激活码编解码（Ed25519 签名，Crockford base32，人工可转抄）
//   3. 试用状态的时间锚 reducer（防改系统时间）
//   4. 试用期 / 会员到期计算
//
// 安全说明：本模块只做"验签"，私钥永不进入仓库与安装包。
// 后续接入服务器时，服务端签发的令牌复用本模块同一 78 字节格式与
// verifyActivationPayload()，客户端校验路径不变。
// ---------------------------------------------------------------------------
import crypto from 'node:crypto';

// 构建脚本（scripts/build.js）会在打包时把 0 替换为构建时间戳（毫秒）。
// 用于"首次运行时系统时钟就是错的"场景的兜底下限。开发环境下为 0（不生效）。
export const BUILD_TS = /*__BUILD_TS__*/ 1787930522844;

// ---------------------------------------------------------------------------
// 套餐定义
// ---------------------------------------------------------------------------
export const TIERS = {
  m6:   { id: 0, label: '半年会员', price: 19.9,  days: 180 },
  y1:   { id: 1, label: '一年会员', price: 29.9,  days: 365 },
  y2:   { id: 2, label: '两年会员', price: 49.9,  days: 730 },
  life: { id: 3, label: '终身会员', price: 199.9, days: null },
};
export const TIER_BY_ID = { 0: 'm6', 1: 'y1', 2: 'y2', 3: 'life' };
export const LIFETIME_EXP_SEC = 0xffffffff;

export const TRIAL_DAYS = 7;
export const TRIAL_MS = TRIAL_DAYS * 86_400_000;
export const BETA_SUPER_LICENSE_DAYS = 365;
export const BETA_SUPER_CODE_PREFIX = 'WWS';
export const BETA_SUPER_CODE_BYTES = 24;
// 系统时钟回拨容忍窗口（NTP 校时抖动）。超过即判定为时间篡改。
export const ROLLBACK_TOLERANCE_MS = 120_000;

// ---------------------------------------------------------------------------
// 激活码公钥（SPKI DER 的 base64）。由 scripts/gen-keypair.mjs 生成后粘贴于此。
// 为空时所有激活码都会被拒绝（安全默认值）。
// ---------------------------------------------------------------------------
export const LICENSE_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAxNEQuSSqC2NlTzPsxXYnT7pF8GkcHsGiLVIMKF8TOdU=';

// ---------------------------------------------------------------------------
// Crockford base32（去掉易混淆的 I/L/O/U）
// ---------------------------------------------------------------------------
const B32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of str) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// 把用户手输的码规范化：去空格/连字符、大写、O→0、I/L→1
export function normalizeCodeInput(input) {
  if (typeof input !== 'string') return '';
  let s = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.startsWith('WW1')) s = s.slice(3);
  return s;
}

function group(str, size) {
  const parts = [];
  for (let i = 0; i < str.length; i += size) parts.push(str.slice(i, i + size));
  return parts.join('-');
}

// Beta super codes are high-entropy bearer vouchers. The plaintext is kept
// outside the repository; beta builds contain only a salted scrypt verifier.
// This is intentionally a temporary beta mechanism, not a replacement for
// server-side redemption or the normal device-bound signed token.
export function formatBetaSuperCode(entropy = crypto.randomBytes(BETA_SUPER_CODE_BYTES)) {
  if (!Buffer.isBuffer(entropy) || entropy.length !== BETA_SUPER_CODE_BYTES) {
    throw new Error(`beta super code entropy must be ${BETA_SUPER_CODE_BYTES} bytes`);
  }
  return `${BETA_SUPER_CODE_PREFIX}-${group(base32Encode(entropy), 6)}`;
}

export function normalizeBetaSuperCode(input) {
  if (typeof input !== 'string') return '';
  let value = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (value.startsWith(BETA_SUPER_CODE_PREFIX)) value = value.slice(BETA_SUPER_CODE_PREFIX.length);
  return value;
}

export function deriveBetaSuperVerifier(input, saltB64) {
  const normalized = normalizeBetaSuperCode(input);
  if (!normalized || typeof saltB64 !== 'string') return null;
  const salt = Buffer.from(saltB64, 'base64');
  if (salt.length < 16) return null;
  return crypto.scryptSync(normalized, salt, 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

export function verifyBetaSuperCode(input, config) {
  if (!config?.enabled || typeof config.verifierB64 !== 'string') return false;
  const actual = deriveBetaSuperVerifier(input, config.saltB64);
  const expected = Buffer.from(config.verifierB64, 'base64');
  if (!actual || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// 设备指纹
// ---------------------------------------------------------------------------
export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// machineId: Windows MachineGuid / macOS IOPlatformUUID；mac: 网卡 MAC；cpu: CPU 型号
export function computeFingerprint({ machineId, mac, cpu }) {
  return sha256Hex(`wordwise-v1|${machineId || ''}|${mac || ''}|${cpu || ''}`);
}

// 设备码 = 指纹前 8 字节的 base32（13 字符），分组展示，用户报给开发者用于发卡
export function deviceCodeFromFingerprint(fpHex) {
  const prefix = Buffer.from(fpHex, 'hex').subarray(0, 8);
  return group(base32Encode(prefix), 4);
}

export function deviceCodeToFpPrefix(deviceCode) {
  const normalized = normalizeCodeInput(deviceCode);
  const buf = base32Decode(normalized);
  if (!buf || buf.length !== 8) return null;
  return buf;
}

// ---------------------------------------------------------------------------
// 激活码：18 字节 payload + 64 字节 Ed25519 签名 = 82 字节
//   [ver:1][tier:1][exp:4 LE unix秒][fpPrefix:8][nonce:4]
//   偏移：ver@0 tier@1 exp@2-5 fpPrefix@6-13 nonce@14-17
// ---------------------------------------------------------------------------
const PAYLOAD_LEN = 18;
const SIG_LEN = 64;
export const ACTIVATION_BUF_LEN = PAYLOAD_LEN + SIG_LEN;
const NONCE_OFFSET = 14;

export function buildActivationPayload({ tierId, expSec, fpPrefix, nonce }) {
  const buf = Buffer.alloc(PAYLOAD_LEN);
  buf.writeUInt8(1, 0);
  buf.writeUInt8(tierId & 0xff, 1);
  buf.writeUInt32LE(expSec >>> 0, 2);
  Buffer.from(fpPrefix).copy(buf, 6, 0, 8);
  buf.writeUInt32LE((nonce ?? crypto.randomBytes(4).readUInt32LE(0)) >>> 0, NONCE_OFFSET);
  return buf;
}

export function signActivationPayload(payload, privateKeyPem) {
  return crypto.sign(null, payload, privateKeyPem);
}

// 完整签发：payload + 签名 → "WW1-XXXXXX-…" 激活码
export function issueActivationCode({ tier, expSec, fpPrefix, privateKeyPem, nonce }) {
  const tierDef = TIERS[tier];
  if (!tierDef) throw new Error(`未知套餐: ${tier}`);
  if (!Buffer.isBuffer(fpPrefix) || fpPrefix.length !== 8) {
    throw new Error('fpPrefix 必须是 8 字节 Buffer');
  }
  const payload = buildActivationPayload({ tierId: tierDef.id, expSec, fpPrefix, nonce });
  const sig = signActivationPayload(payload, privateKeyPem);
  return 'WW1-' + group(base32Encode(Buffer.concat([payload, sig])), 6);
}

// 校验签名并解出 payload（不检查设备匹配与到期，那是 license.js 的职责）
export function verifyActivationPayload(buf, publicKeyB64 = LICENSE_PUBLIC_KEY_B64) {
  if (!Buffer.isBuffer(buf) || buf.length !== ACTIVATION_BUF_LEN) return null;
  if (!publicKeyB64 || publicKeyB64.startsWith('__')) return null;
  const payload = buf.subarray(0, PAYLOAD_LEN);
  const sig = buf.subarray(PAYLOAD_LEN);
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, payload, key, sig)) return null;
  } catch {
    return null;
  }
  if (payload.readUInt8(0) !== 1) return null;
  const tierId = payload.readUInt8(1);
  if (!(tierId in TIER_BY_ID)) return null;
  return {
    version: 1,
    tier: TIER_BY_ID[tierId],
    expSec: payload.readUInt32LE(2),
    fpPrefixHex: payload.subarray(6, 14).toString('hex'),
    nonce: payload.readUInt32LE(NONCE_OFFSET),
  };
}

// 解析用户输入的激活码字符串 → 验签后的 payload 或 null
export function decodeActivationCode(input, publicKeyB64 = LICENSE_PUBLIC_KEY_B64) {
  const normalized = normalizeCodeInput(input);
  if (!normalized) return null;
  const buf = base32Decode(normalized);
  return verifyActivationPayload(buf, publicKeyB64);
}

export function isLifetimeLicense(payload) {
  return payload?.expSec === LIFETIME_EXP_SEC;
}

export function licenseExpiredAt(payload, nowMs) {
  if (!payload) return true;
  if (isLifetimeLicense(payload)) return false;
  return payload.expSec * 1000 <= nowMs;
}

// ---------------------------------------------------------------------------
// 试用状态：{v, installId, firstRunMs, maxSeenMs} + HMAC 完整性标签
// 标签密钥派生自设备指纹 —— 只是防普通用户手改，不是真正的安全边界。
// ---------------------------------------------------------------------------
export function newTrialState(nowMs, installId, buildTs = BUILD_TS) {
  const firstRunMs = Math.max(nowMs, buildTs || 0);
  return { v: 1, installId, firstRunMs, maxSeenMs: firstRunMs };
}

export function canonicalTrialState(state) {
  return JSON.stringify({
    v: state.v,
    installId: state.installId,
    firstRunMs: state.firstRunMs,
    maxSeenMs: state.maxSeenMs,
  });
}

export function trialTag(state, fpHex) {
  const key = sha256Hex(`ww-trial|${fpHex}`);
  return crypto.createHmac('sha256', key).update(canonicalTrialState(state)).digest('hex');
}

export function serializeTrialRecord(state, fpHex) {
  return JSON.stringify({ ...state, tag: trialTag(state, fpHex) });
}

// 校验并解析试用记录；任何不一致（标签错、字段缺、installId 不符）都返回 null
export function parseTrialRecord(raw, fpHex, expectedInstallId) {
  try {
    const obj = JSON.parse(raw);
    if (obj?.v !== 1 || typeof obj.installId !== 'string') return null;
    if (typeof obj.firstRunMs !== 'number' || typeof obj.maxSeenMs !== 'number') return null;
    if (expectedInstallId && obj.installId !== expectedInstallId) return null;
    const state = { v: 1, installId: obj.installId, firstRunMs: obj.firstRunMs, maxSeenMs: obj.maxSeenMs };
    if (obj.tag !== trialTag(state, fpHex)) return null;
    if (state.maxSeenMs < state.firstRunMs) return null;
    return state;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 时间锚 reducer：单调递增的 maxSeenMs
//   - 回拨超过容忍窗口 → rollback=true（调用方判定试用到期）
//   - 回拨在窗口内（NTP 抖动）→ 忽略，不落盘
//   - 前进（含大幅跳到未来）→ 推进 maxSeenMs，消耗试用时长（安全方向）
// 全部使用 UTC 毫秒，时区切换无影响。
// ---------------------------------------------------------------------------
export function reduceTimeAnchor(state, nowMs, toleranceMs = ROLLBACK_TOLERANCE_MS) {
  if (nowMs < state.maxSeenMs - toleranceMs) {
    return { state, rollback: true, changed: false };
  }
  if (nowMs <= state.maxSeenMs) {
    return { state, rollback: false, changed: false };
  }
  return { state: { ...state, maxSeenMs: nowMs }, rollback: false, changed: true };
}

// ---------------------------------------------------------------------------
// 试用状态计算：已用时长 = maxSeenMs - firstRunMs
// ---------------------------------------------------------------------------
export function getTrialStatus(state, trialMs = TRIAL_MS) {
  const elapsedMs = Math.max(0, state.maxSeenMs - state.firstRunMs);
  const remainingMs = trialMs - elapsedMs;
  return {
    elapsedMs,
    remainingMs: Math.max(0, remainingMs),
    daysLeft: Math.max(0, Math.ceil(remainingMs / 86_400_000)),
    expired: remainingMs <= 0,
  };
}
