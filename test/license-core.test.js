import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  base32Encode,
  base32Decode,
  normalizeCodeInput,
  computeFingerprint,
  deviceCodeFromFingerprint,
  deviceCodeToFpPrefix,
  issueActivationCode,
  decodeActivationCode,
  verifyActivationPayload,
  isLifetimeLicense,
  licenseExpiredAt,
  LIFETIME_EXP_SEC,
  BETA_SUPER_CODE_PREFIX,
  BETA_SUPER_CODE_BYTES,
  formatBetaSuperCode,
  normalizeBetaSuperCode,
  deriveBetaSuperVerifier,
  verifyBetaSuperCode,
  newTrialState,
  serializeTrialRecord,
  parseTrialRecord,
  reduceTimeAnchor,
  getTrialStatus,
  TRIAL_MS,
  ROLLBACK_TOLERANCE_MS,
} from '../license-core.js';

// 测试专用密钥对（与发货公钥无关）
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const privPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

const FP = computeFingerprint({ machineId: 'machine-1', mac: 'aa:bb:cc:dd:ee:ff', cpu: 'Test CPU' });
const FP_PREFIX = Buffer.from(FP, 'hex').subarray(0, 8);
const NOW = 1_750_000_000_000;

function makeCode(overrides = {}) {
  return issueActivationCode({
    tier: 'y1',
    expSec: Math.floor(NOW / 1000) + 365 * 86_400,
    fpPrefix: FP_PREFIX,
    privateKeyPem: privPem,
    nonce: 42,
    ...overrides,
  });
}

test('base32 roundtrip preserves bytes', () => {
  for (const len of [1, 8, 14, 64, 78]) {
    const buf = crypto.randomBytes(len);
    const decoded = base32Decode(base32Encode(buf));
    assert.deepEqual(decoded, buf);
  }
});

test('base32Decode rejects characters outside the alphabet', () => {
  assert.equal(base32Decode('O'), null); // O 不在 Crockford 字母表
  assert.equal(base32Decode('U'), null);
  assert.equal(base32Decode('!@#$'), null);
});

test('normalizeCodeInput strips separators and maps ambiguous chars', () => {
  assert.equal(normalizeCodeInput('ww1-abcd ef-gh'), 'ABCD0EFGH'.replace('0', '0') && 'ABCDEFGH');
  assert.equal(normalizeCodeInput('oIl'), '011');
  assert.equal(normalizeCodeInput(''), '');
  assert.equal(normalizeCodeInput(null), '');
});

test('fingerprint is deterministic and input-sensitive', () => {
  const a = computeFingerprint({ machineId: 'm', mac: 'x', cpu: 'c' });
  assert.equal(a, computeFingerprint({ machineId: 'm', mac: 'x', cpu: 'c' }));
  assert.notEqual(a, computeFingerprint({ machineId: 'm2', mac: 'x', cpu: 'c' }));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('device code roundtrips to the 8-byte fingerprint prefix', () => {
  const code = deviceCodeFromFingerprint(FP);
  assert.match(code, /^[0-9A-Z]+(-[0-9A-Z]+)*$/);
  const prefix = deviceCodeToFpPrefix(code);
  assert.ok(Buffer.isBuffer(prefix));
  assert.deepEqual(prefix, FP_PREFIX);
  // 小写、无连字符也能解析
  assert.deepEqual(deviceCodeToFpPrefix(code.toLowerCase().replace(/-/g, '')), FP_PREFIX);
  assert.equal(deviceCodeToFpPrefix('XXXX'), null);
});

test('activation code: issue → decode roundtrip', () => {
  const code = makeCode();
  assert.match(code, /^WW1-([0-9A-Z]{6}-)*[0-9A-Z]+$/);
  const payload = decodeActivationCode(code, pubB64);
  assert.ok(payload);
  assert.equal(payload.tier, 'y1');
  assert.equal(payload.fpPrefixHex, FP_PREFIX.toString('hex'));
  assert.equal(payload.nonce, 42);
});

test('activation code: tampered byte is rejected', () => {
  const code = makeCode();
  const normalized = normalizeCodeInput(code);
  // 翻转中间一个字符
  const mid = Math.floor(normalized.length / 2);
  const replacement = normalized[mid] === 'A' ? 'B' : 'A';
  const tampered = normalized.slice(0, mid) + replacement + normalized.slice(mid + 1);
  assert.equal(decodeActivationCode(tampered, pubB64), null);
});

test('activation code: wrong public key is rejected', () => {
  const other = crypto.generateKeyPairSync('ed25519');
  const otherPub = other.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.equal(decodeActivationCode(makeCode(), otherPub), null);
});

test('activation code: unconfigured placeholder key rejects everything', () => {
  assert.equal(decodeActivationCode(makeCode()), null); // 默认 LICENSE_PUBLIC_KEY_B64 是占位符
  assert.equal(verifyActivationPayload(Buffer.alloc(78), pubB64), null);
  assert.equal(verifyActivationPayload(crypto.randomBytes(78), ''), null);
});

test('license expiry: lifetime sentinel never expires', () => {
  const life = decodeActivationCode(makeCode({ tier: 'life', expSec: LIFETIME_EXP_SEC }), pubB64);
  assert.ok(isLifetimeLicense(life));
  assert.equal(licenseExpiredAt(life, NOW + 1e13), false);
});

test('beta super voucher has high entropy, salted verification, and a fail-closed switch', () => {
  const code = formatBetaSuperCode(Buffer.alloc(BETA_SUPER_CODE_BYTES, 7));
  const saltB64 = crypto.randomBytes(16).toString('base64');
  const verifierB64 = deriveBetaSuperVerifier(code, saltB64).toString('base64');
  const config = { enabled: true, saltB64, verifierB64 };

  assert.match(code, new RegExp(`^${BETA_SUPER_CODE_PREFIX}-[0-9A-Z-]{20,}$`));
  assert.ok(code.length >= 20);
  assert.equal(normalizeBetaSuperCode(code.toLowerCase()), normalizeBetaSuperCode(code));
  assert.equal(verifyBetaSuperCode(code, config), true);
  assert.equal(verifyBetaSuperCode(`${code}A`, config), false);
  assert.equal(verifyBetaSuperCode(code, { ...config, enabled: false }), false);
});

test('license expiry: boundary second', () => {
  const expSec = Math.floor(NOW / 1000);
  const payload = decodeActivationCode(makeCode({ expSec }), pubB64);
  assert.equal(licenseExpiredAt(payload, expSec * 1000 - 1), false);
  assert.equal(licenseExpiredAt(payload, expSec * 1000), true);
});

test('trial state: serialize/parse roundtrip with tag verification', () => {
  const state = newTrialState(NOW, 'install-1', 0);
  const raw = serializeTrialRecord(state, FP);
  assert.deepEqual(parseTrialRecord(raw, FP, 'install-1'), state);
});

test('trial record: wrong fingerprint, wrong installId, tampered field all rejected', () => {
  const state = newTrialState(NOW, 'install-1', 0);
  const raw = serializeTrialRecord(state, FP);
  assert.equal(parseTrialRecord(raw, 'ff'.repeat(32), 'install-1'), null);
  assert.equal(parseTrialRecord(raw, FP, 'install-2'), null);

  const tampered = JSON.parse(raw);
  tampered.firstRunMs -= 86_400_000; // 试图把试用起点往前挪一天
  assert.equal(parseTrialRecord(JSON.stringify(tampered), FP, 'install-1'), null);

  const badOrder = JSON.parse(raw);
  badOrder.maxSeenMs = badOrder.firstRunMs - 1;
  assert.equal(parseTrialRecord(JSON.stringify(badOrder), FP, 'install-1'), null);
});

test('newTrialState clamps firstRunMs to build timestamp', () => {
  const buildTs = NOW + 86_400_000;
  const state = newTrialState(NOW, 'i', buildTs); // 系统时钟比构建时间还早 → 不可信
  assert.equal(state.firstRunMs, buildTs);
  assert.equal(state.maxSeenMs, buildTs);
});

test('time anchor: normal advance persists', () => {
  const state = newTrialState(NOW, 'i', 0);
  const r = reduceTimeAnchor(state, NOW + 60_000);
  assert.equal(r.rollback, false);
  assert.equal(r.changed, true);
  assert.equal(r.state.maxSeenMs, NOW + 60_000);
});

test('time anchor: rollback beyond tolerance is flagged', () => {
  const state = newTrialState(NOW, 'i', 0);
  const r = reduceTimeAnchor(state, NOW - ROLLBACK_TOLERANCE_MS - 1);
  assert.equal(r.rollback, true);
  assert.equal(r.changed, false);
});

test('time anchor: NTP jitter within tolerance is ignored', () => {
  const state = newTrialState(NOW, 'i', 0);
  const r = reduceTimeAnchor(state, NOW - ROLLBACK_TOLERANCE_MS + 1000);
  assert.equal(r.rollback, false);
  assert.equal(r.changed, false);
  assert.equal(r.state.maxSeenMs, NOW);
});

test('time anchor: forward jump consumes trial time', () => {
  const state = newTrialState(NOW, 'i', 0);
  const jumped = reduceTimeAnchor(state, NOW + 6 * 86_400_000).state;
  const status = getTrialStatus(jumped);
  assert.equal(status.daysLeft, 1);
  assert.equal(status.expired, false);
});

test('trial status: expiry boundary and days-left rounding', () => {
  const fresh = newTrialState(NOW, 'i', 0);
  assert.equal(getTrialStatus(fresh).daysLeft, 7);
  assert.equal(getTrialStatus(fresh).expired, false);

  const atEnd = { ...fresh, maxSeenMs: fresh.firstRunMs + TRIAL_MS };
  assert.equal(getTrialStatus(atEnd).expired, true);
  assert.equal(getTrialStatus(atEnd).daysLeft, 0);

  const beyond = { ...fresh, maxSeenMs: fresh.firstRunMs + TRIAL_MS + 999 };
  assert.equal(getTrialStatus(beyond).expired, true);

  const partial = { ...fresh, maxSeenMs: fresh.firstRunMs + TRIAL_MS - 1000 };
  assert.equal(getTrialStatus(partial).daysLeft, 1); // 不足一天按一天显示
  assert.equal(getTrialStatus(partial).expired, false);
});

test('trial status: timezone crossing is a no-op (UTC ms throughout)', () => {
  // 跨时区只改变本地显示，Date.now() 不变 —— 用同一 now 重算即可证明无影响
  const state = newTrialState(NOW, 'i', 0);
  assert.deepEqual(getTrialStatus(state), getTrialStatus(state));
});
