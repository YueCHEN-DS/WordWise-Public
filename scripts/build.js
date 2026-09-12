import fs from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import crypto from 'node:crypto';
import { deriveBetaSuperVerifier } from '../license-core.js';

const packagePath = path.resolve('package.json');
const originalPackageData = fs.readFileSync(packagePath, 'utf8');
let packageRestored = false;

// 构建时把 license-core.js 的 BUILD_TS 占位符替换为当前时间戳，
// 作为"首次运行系统时钟错误"的下限兜底。构建后还原源文件。
const licenseCorePath = path.resolve('license-core.js');
const originalLicenseCoreData = fs.readFileSync(licenseCorePath, 'utf8');
let licenseCoreRestored = false;

// Beta builds may receive a one-time super-voucher verifier through the
// environment. The plaintext voucher is never written to the source tree or
// packaged app; stable builds keep the checked-in fail-closed config.
const betaSuperConfigPath = path.resolve('beta-super-config.js');
const originalBetaSuperConfigData = fs.readFileSync(betaSuperConfigPath, 'utf8');
let betaSuperConfigRestored = false;

const MAC_BUNDLED_MODELS = [
  {
    from: 'Qwen3-1.7B-Q5_K_M.gguf',
    to: 'models/Qwen3-1.7B-Q5_K_M.gguf',
  },
  {
    from: 'finetune-output/v1-archive/wsl-retrain-hf/export/Qwen3-1.7B-WordWise-Q5_K_M.gguf',
    to: 'models/Qwen3-1.7B-WordWise-Q5_K_M.gguf',
  },
  {
    from: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    to: 'models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
  },
];

function restorePackage() {
  if (packageRestored) return;
  fs.writeFileSync(packagePath, originalPackageData, 'utf8');
  packageRestored = true;
}
function restoreLicenseCore() {
  if (licenseCoreRestored) return;
  fs.writeFileSync(licenseCorePath, originalLicenseCoreData, 'utf8');
  licenseCoreRestored = true;
}
function restoreBetaSuperConfig() {
  if (betaSuperConfigRestored) return;
  fs.writeFileSync(betaSuperConfigPath, originalBetaSuperConfigData, 'utf8');
  betaSuperConfigRestored = true;
}

process.once('SIGINT', () => {
  restorePackage();
  restoreLicenseCore();
  restoreBetaSuperConfig();
  process.exit(130);
});

try {
  const json = JSON.parse(originalPackageData);
  json.version = '1.0.0';

  // 注入构建时间戳到 license-core.js（防首次运行时钟错误）
  const buildTs = Date.now();
  fs.writeFileSync(
    licenseCorePath,
    originalLicenseCoreData.replace('/*__BUILD_TS__*/ 0', `/*__BUILD_TS__*/ ${buildTs}`),
    'utf8',
  );
  console.log(`Injected BUILD_TS = ${buildTs} (${new Date(buildTs).toISOString()}) into license-core.js`);

  const betaSuperCode = process.env.WORDWISE_BETA_SUPER_CODE?.trim();
  if (betaSuperCode) {
    const saltB64 = crypto.randomBytes(16).toString('base64');
    const verifier = deriveBetaSuperVerifier(betaSuperCode, saltB64);
    if (!verifier) throw new Error('WORDWISE_BETA_SUPER_CODE 无效，无法生成校验器');
    const betaConfig = `// Generated only inside a beta build; restored after electron-builder exits.\nexport const BETA_SUPER_CONFIG = Object.freeze(${JSON.stringify({
      enabled: true,
      saltB64,
      verifierB64: verifier.toString('base64'),
    }, null, 2)});\n`;
    fs.writeFileSync(betaSuperConfigPath, betaConfig, 'utf8');
    console.log('Enabled beta super-license verifier for this build (plaintext voucher not embedded).');
  } else {
    console.log('Beta super-license verifier disabled for this build.');
  }

  // Keep only the native/runtime bundle for the requested target. The source
  // tree contains both Windows and macOS binaries so development can switch
  // platforms without changing the loader; an installer should ship one.
  const args = process.argv.slice(2);
  const target = args.includes('--mac') ? 'mac' : args.includes('--win') ? 'win' : null;
  if (target && Array.isArray(json.build?.files)) {
    const platformFilters = target === 'mac'
      ? [
          '!vocab-core/vocab_core.win32.node',
          '!node_modules/@node-llama-cpp/win-*/**',
          '!node_modules/@node-llama-cpp/linux-*/**',
        ]
      : [
          '!vocab-core/vocab_core.mac.node',
          '!node_modules/@node-llama-cpp/mac-*/**',
          '!node_modules/@node-llama-cpp/linux-*/**',
        ];
    json.build.files = [
      ...json.build.files.filter(pattern => !platformFilters.includes(pattern)),
      ...platformFilters,
    ];
  }

  // The macOS release is intentionally self-contained: all three built-in
  // profiles are copied to Resources/models outside app.asar only when the
  // caller explicitly opts in. Model files are local release inputs and are
  // intentionally absent from the public source snapshot.
  if (target === 'mac' && process.env.WORDWISE_BUNDLE_MODELS === '1') {
    const missing = MAC_BUNDLED_MODELS
      .map(model => model.from)
      .filter(relativePath => !fs.existsSync(path.resolve(relativePath)));
    if (missing.length > 0) {
      throw new Error(`Cannot build self-contained macOS package; missing model(s): ${missing.join(', ')}`);
    }
    const existingResources = Array.isArray(json.build?.extraResources)
      ? json.build.extraResources
      : [];
    const bundledDestinations = new Set(MAC_BUNDLED_MODELS.map(model => model.to));
    json.build.extraResources = [
      ...existingResources.filter(resource => {
        const destination = typeof resource === 'string' ? resource : resource?.to;
        return !bundledDestinations.has(destination);
      }),
      ...MAC_BUNDLED_MODELS,
    ];
    console.log(`Bundling ${MAC_BUNDLED_MODELS.length} verified GGUF models under Resources/models...`);
  }
  fs.writeFileSync(packagePath, JSON.stringify(json, null, 2) + '\n', 'utf8');

  console.log('Temporarily set version to 1.0.0 for electron-builder compatibility...');

  const builderCli = path.resolve('node_modules/electron-builder/cli.js');
  const result = spawnSync(process.execPath, [builderCli, ...args], { stdio: 'inherit' });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
} finally {
  console.log('Restoring package.json to original version v1.0...');
  restorePackage();
  restoreLicenseCore();
  restoreBetaSuperConfig();
}
