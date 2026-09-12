import path from 'node:path';

export const GIB = 1024 ** 3;

export const MODEL_PROFILES = Object.freeze({
  pro: Object.freeze({
    id: 'pro',
    displayName: 'QWEN-Pro',
    filename: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    packagedSource: 'models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    url: 'https://hf-mirror.com/lmstudio-community/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    expectedBytes: 2_497_280_448,
    sha256: '8cdb57cbb880d313736a9bc4e3d3d2485f145b5e19cf33783746e753e82641fc',
    runtime: Object.freeze({
      contextSize: 1024,
      sequences: 1,
      adaptiveBatch: true,
      flashAttention: true,
    }),
  }),
  wordwise: Object.freeze({
    id: 'wordwise',
    displayName: 'QWEN-WordWise',
    filename: 'Qwen3-1.7B-WordWise-Q5_K_M.gguf',
    packagedSource: 'models/Qwen3-1.7B-WordWise-Q5_K_M.gguf',
    url: null,
    localSource: 'finetune-output/v1-archive/wsl-retrain-hf/export/Qwen3-1.7B-WordWise-Q5_K_M.gguf',
    expectedBytes: 1_257_879_232,
    sha256: '2f9c4af4716fb4a04999fbdfdf235201a7d28c392481267baf2d6b46dbfeb42f',
    runtime: Object.freeze({
      contextSize: 512,
      batchSize: 128,
      sequences: 1,
      flashAttention: false,
      maxTokensEval: 40,
      cacheCap: 60,
    }),
  }),
  low: Object.freeze({
    id: 'low',
    displayName: 'QWEN',
    filename: 'Qwen3-1.7B-Q5_K_M.gguf',
    packagedSource: 'models/Qwen3-1.7B-Q5_K_M.gguf',
    url: 'https://modelscope.cn/models/unsloth/Qwen3-1.7B-GGUF/resolve/master/Qwen3-1.7B-Q5_K_M.gguf',
    expectedBytes: 1_257_880_128,
    sha256: 'b0949de5b2e06cbed6aa96517f9bd8afb334584b6f95ee83479292ff4bdd8ed3',
    runtime: Object.freeze({
      contextSize: 512,
      batchSize: 128,
      sequences: 1,
      flashAttention: false,
      maxTokensEval: 40,
      cacheCap: 60,
    }),
  }),
});

export function classifyHardware(input = {}) {
  const ramTotalBytes = finiteNumber(input.ramTotalBytes);
  const logicalCores = finiteNumber(input.logicalCores);
  const vramTotalBytes = finiteNumber(input.vramTotalBytes);
  const unifiedVramBytes = finiteNumber(input.unifiedVramBytes);
  const dedicatedVramBytes = Math.max(0, vramTotalBytes - unifiedVramBytes);
  const backend = String(input.backend || 'unknown').toLowerCase();
  const reasons = [];

  if (backend === 'cpu' || backend === 'false') {
    reasons.push({ code: 'cpu_only', label: '仅检测到 CPU 推理后端' });
  } else if (input.detectionFailed === true) {
    reasons.push({ code: 'detection_failed', label: '无法确认可用的 GPU 加速能力' });
  }
  if (unifiedVramBytes > 0 && ramTotalBytes > 0 && ramTotalBytes <= 8 * GIB) {
    reasons.push({ code: 'unified_memory', label: `统一内存仅 ${formatGiB(ramTotalBytes)}` });
  } else if (dedicatedVramBytes > 0 && dedicatedVramBytes <= 4 * GIB) {
    reasons.push({ code: 'vram', label: `独立显存仅 ${formatGiB(dedicatedVramBytes)}` });
  }
  if (ramTotalBytes > 0 && ramTotalBytes <= 8 * GIB) {
    reasons.push({ code: 'ram', label: `系统内存仅 ${formatGiB(ramTotalBytes)}` });
  }
  if (logicalCores > 0 && logicalCores <= 4) {
    reasons.push({ code: 'cpu_cores', label: `仅 ${logicalCores} 个逻辑 CPU 核心` });
  }
  if (['gpu_oom', 'memory_allocation'].includes(input.lastModelLoadFailure)) {
    reasons.push({ code: 'previous_oom', label: 'QWEN-Pro 曾因显存或内存不足降级' });
  }

  const recommendLow = reasons.length > 0;
  let runtimeTier = 'mid';
  if (backend === 'cpu' || backend === 'false') runtimeTier = 'cpu';
  else if (recommendLow) runtimeTier = 'low';
  else if (ramTotalBytes >= 16 * GIB && logicalCores >= 8) runtimeTier = 'high';

  return {
    recommendLow,
    runtimeTier,
    reasons,
    backend,
    gpuNames: Array.isArray(input.gpuNames) ? input.gpuNames : [],
    vramTotalBytes,
    unifiedVramBytes,
    dedicatedVramBytes,
    ramTotalBytes,
    logicalCores,
    detectionFailed: input.detectionFailed === true,
  };
}

export function classifyModelProfile(metadata, filename = '') {
  const general = metadata?.general || metadata || {};
  const sizeLabel = String(general.size_label || '').trim().toLowerCase();
  const identity = `${general.name || ''} ${general.basename || ''} ${filename}`.toLowerCase();
  if (/wordwise/i.test(identity)) return 'wordwise';
  if (sizeLabel === '1.7b' || /(?:^|[^\d])1[._-]?7b(?:[^\d]|$)/i.test(identity)) return 'low';
  if (sizeLabel === '4b' || /(?:^|[^\d])4b(?:[^\d]|$)/i.test(identity)) return 'pro';
  return 'custom';
}

export function migrateModelConfig(rawConfig = {}) {
  const config = { ...rawConfig, modelPaths: { ...(rawConfig.modelPaths || {}) } };
  if (typeof config.autoAdvanceEnabled !== 'boolean') config.autoAdvanceEnabled = true;
  if (![1500, 3000, 5000, 8000].includes(config.autoAdvanceDelayMs)) {
    config.autoAdvanceDelayMs = 1500;
  }
  if (config.modelPath && !Object.values(config.modelPaths).includes(config.modelPath)) {
    const legacyProfile = classifyModelProfile(null, path.basename(config.modelPath));
    config.modelPaths[legacyProfile] = config.modelPath;
    config.activeModelProfile ||= legacyProfile;
  }
  // Earlier builds persisted an automatically detected value as though it were
  // a user override. Runtime capability is now recomputed on every launch.
  delete config.performanceTier;
  return config;
}

export function profileDisplayLabel(profile, runtimeTier = 'mid') {
  if (profile === 'low') return 'QWEN (Low)';
  if (profile === 'wordwise') return 'QWEN-WordWise';
  const suffix = titleCase(runtimeTier || 'mid');
  if (profile === 'pro') return `QWEN-Pro (${suffix})`;
  return `Custom (${suffix})`;
}

export function builtInModelPath(profile, userDataPath, config = {}) {
  const configured = config.modelPaths?.[profile];
  if (configured) return configured;
  const definition = MODEL_PROFILES[profile];
  return definition ? path.join(userDataPath, definition.filename) : '';
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function formatGiB(bytes) {
  const value = bytes / GIB;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} GiB`;
}

function titleCase(value) {
  const normalized = String(value).toLowerCase();
  if (normalized === 'cpu') return 'CPU';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
