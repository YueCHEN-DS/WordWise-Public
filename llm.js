import { app, ipcMain, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  evaluationPaths,
  firstEvaluationPath,
  gateLowModelDecision,
  isExactMeaning,
  isLookAlikeWord,
  makeLevelOneHint,
  needsBoundaryReview,
} from './evaluation-policy.js';
import {
  buildEvaluationPrompt,
  buildLowVerificationPrompt,
  buildReviewPrompt,
  evaluationSystemPrompt,
  hintSchema,
  localExplanation,
  lowEvaluationSystemPrompt,
  lowVerificationSchema,
  parseHint,
  parseLowVerification,
  parseSemanticDecision,
  reviewSchema,
  semanticSchema,
} from './evaluation-protocol.js';
import { normalizeMeaning } from './scoring.js';
import {
  MODEL_PROFILES,
  builtInModelPath,
  classifyHardware,
  classifyModelProfile,
  migrateModelConfig,
  profileDisplayLabel,
} from './compute-mode.js';
import { assertLearningAllowed } from './license.js';

let mainWindow = null;
export function setMainWindow(win) { mainWindow = win; }

const userDataPath = app.getPath('userData');
const configPath = path.join(userDataPath, 'config.json');
let cachedConfig = null;

export function getCachedConfig() {
  if (!cachedConfig) cachedConfig = loadConfig();
  return cachedConfig;
}

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      return migrateModelConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    }
  } catch (err) {
    console.error('config load failed:', err);
  }
  return {};
}

function saveConfig(cfg) {
  try {
    cachedConfig = migrateModelConfig(cfg);
    if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(cachedConfig, null, 2), 'utf8');
  } catch (err) {
    console.error('config save failed:', err);
  }
}

let llama = null;
let model = null;
let context = null;
let session = null;
let currentLlamaGpuSetting = null;
let currentBackend = null;
let semanticGrammar = null;
let reviewGrammar = null;
let hintGrammar = null;
let lowVerificationGrammar = null;
let activeInference = null;
let inferenceTail = Promise.resolve();
let hintGeneration = 0;
let detectedGpuTier = null;
let gpuOomFallback = false;
let activeModelProfile = 'custom';
let deviceCapability = null;
let startupInitialized = false;
const COMPACT_MODEL_PROFILES = new Set(['low', 'wordwise']);

const os = await import('os');

let perfTier = 'mid';
let perfConfig = null;

const TIER_DEFAULTS = {
  high:   { contextSize: 1024, batchSize: 512, timeout: 45_000, threads: 0,          gpuLayerMode: 'auto', flashAttention: true,  maxTokensEval: 48,  maxTokensReview: 96,  cacheCap: 150, cacheTtl: 15 * 60_000 },
  mid:    { contextSize: 1024, batchSize: 256, timeout: 40_000, threads: 0,          gpuLayerMode: 'auto', flashAttention: true,  maxTokensEval: 48,  maxTokensReview: 96,  cacheCap: 100, cacheTtl: 10 * 60_000 },
  low:    { contextSize: 512,  batchSize: 128, timeout: 60_000, threads: 0,          gpuLayerMode: 'auto', flashAttention: false, maxTokensEval: 40,  maxTokensReview: 80,  cacheCap: 60,  cacheTtl: 8 * 60_000 },
  cpu:    { contextSize: 512,  batchSize: 64,  timeout: 90_000, threads: 0,          gpuLayerMode: 0,      flashAttention: false, maxTokensEval: 40,  maxTokensReview: 80,  cacheCap: 50,  cacheTtl: 5 * 60_000 },
};

function detectHardwareTier() {
  const totalMemMB = os.totalmem() / (1024 * 1024);
  const cpus = os.cpus();
  const cpuCount = cpus.length;
  const cfg = getCachedConfig();

  if (currentBackend === 'cpu' || cfg.useGpu === false || gpuOomFallback) {
    perfTier = 'cpu';
  } else if (COMPACT_MODEL_PROFILES.has(activeModelProfile)) {
    perfTier = 'low';
  } else if (deviceCapability?.runtimeTier && TIER_DEFAULTS[deviceCapability.runtimeTier]) {
    perfTier = deviceCapability.runtimeTier;
  } else if (totalMemMB <= 8192 || cpuCount <= 4) {
    perfTier = 'low';
  } else if (cpuCount >= 8 && totalMemMB >= 16384) {
    perfTier = 'high';
  } else {
    perfTier = 'mid';
  }

  if (detectedGpuTier === 'low' && (perfTier === 'high' || perfTier === 'mid')) {
    perfTier = 'low';
  }
  // If GPU detection forced CPU mode but saved config still says GPU tier, downgrade
  if ((detectedGpuTier === null || gpuOomFallback) && perfTier !== 'cpu') {
    const cfg2 = getCachedConfig();
    if (cfg2.useGpu === false || gpuOomFallback) {
      perfTier = 'cpu';
    }
  }

  // The selected model profile and the detected hardware tier are deliberately
  // independent. QWEN Low keeps its fixed 512/128 runtime even on a CPU-only
  // backend, while the tier still reports CPU to the renderer.
  const profileRuntime = COMPACT_MODEL_PROFILES.has(activeModelProfile)
    ? MODEL_PROFILES[activeModelProfile].runtime
    : null;
  const base = { ...TIER_DEFAULTS[perfTier], ...(profileRuntime || {}) };
  base.threads = (perfTier === 'cpu' || currentBackend === 'cpu')
    ? Math.max(1, Math.min(cpuCount - 1, Math.floor(cpuCount * 0.75)))
    : 0;
  perfConfig = base;

  console.log(`[Perf] tier=${perfTier} gpu=${detectedGpuTier || 'undetected'} mem=${Math.round(totalMemMB)}MB cpus=${cpuCount} threads=${base.threads}`);
  return perfConfig;
}

function getPerfConfig() {
  return perfConfig || detectHardwareTier();
}

const TIER_RANK = { high: 3, mid: 2, low: 1, cpu: 0 };
function adjustTierForBackend(backend) {
  if (!backend || backend === 'cpu') {
    if (perfTier !== 'cpu') {
      console.log(`[Perf] backend=cpu, downgrading tier ${perfTier} -> cpu`);
      perfTier = 'cpu';
      perfConfig = null;
    }
    return getPerfConfig();
  }
  if (detectedGpuTier && TIER_RANK[detectedGpuTier] < TIER_RANK[perfTier]) {
    console.log(`[Perf] GPU tier ${detectedGpuTier} < system tier ${perfTier}, downgrading`);
    perfTier = detectedGpuTier;
    perfConfig = null;
  }
  return getPerfConfig();
}

function cacheKey(word, meaning, answer) {
  return `${String(word).trim().toLowerCase()}\u241f${normalizeMeaning(meaning)}\u241f${normalizeMeaning(answer)}`;
}

function cacheGet(store, key) {
  if (!store.has(key)) return null;
  const entry = store.get(key);
  const ttl = perfConfig?.cacheTtl ?? 10 * 60_000;
  if (Date.now() - entry.ts > ttl) {
    store.delete(key);
    return null;
  }
  store.delete(key);
  store.set(key, entry);
  return entry.val;
}

function cacheSet(store, key, val) {
  const cap = perfConfig?.cacheCap ?? 100;
  if (store.size >= cap) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
  store.set(key, { val, ts: Date.now() });
}

const semanticCache = new Map();
const hintCache = new Map();

function clearInferenceCache() {
  semanticCache.clear();
  hintCache.clear();
}

function stopHint() {
  hintGeneration++;
  if (activeInference?.kind === 'hint') {
    activeInference.controller.abort(new Error('hint cancelled'));
    inferenceTail = Promise.resolve();
  }
}

function queueInference(kind, work) {
  const run = async () => {
    const controller = new AbortController();
    activeInference = { kind, controller };
    try {
      return await work(controller.signal);
    } finally {
      if (activeInference?.controller === controller) activeInference = null;
    }
  };
  const job = inferenceTail.then(run, run);
  inferenceTail = job.catch(() => undefined);
  return job;
}

async function askModel(prompt, options, signal) {
  if (!session) throw new Error('model not loaded');
  const pc = getPerfConfig();
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const timeoutMs = attempt > 1 ? Math.floor(pc.timeout * 1.5) : pc.timeout;
    const timeoutController = new AbortController();
    const abort = () => timeoutController.abort(signal?.reason || new Error('inference cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(
      () => timeoutController.abort(new Error('inference timeout')),
      timeoutMs
    );

    try {
      const result = await session.prompt(prompt, {
        ...options,
        signal: timeoutController.signal,
      });
      return result;
    } catch (err) {
      const isTimeout = String(err?.message || '').toLowerCase().includes('timeout');
      if (isTimeout && attempt < MAX_ATTEMPTS) {
        console.warn(`[LLM] timeout on attempt ${attempt}, retrying with extended timeout...`);
        mainWindow?.webContents.send('inference-perf', {
          event: 'timeout_retry', attempt, nextTimeoutMs: Math.floor(pc.timeout * 1.5),
        });
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      session?.resetChatHistory();
    }
  }
}

let llamaCppModule = null;
async function getLlamaCpp() {
  if (!llamaCppModule) llamaCppModule = await import('node-llama-cpp');
  return llamaCppModule;
}

async function ensureLlamaBackend(useGpu) {
  const desiredGpu = useGpu ? 'yes' : 'no';
  // Capability refreshes must never dispose a backend that owns a live model.
  if (llama && model) return llama;
  if (llama && currentLlamaGpuSetting === desiredGpu) return llama;

  if (llama) {
    try { await llama.dispose(); } catch (error) {
      console.warn('[LLM] backend dispose failed:', error.message);
    }
    llama = null;
    currentBackend = null;
  }

  const llamaCpp = await getLlamaCpp();
  if (!useGpu) {
    const pc = getPerfConfig();
    llama = await llamaCpp.getLlama({ gpu: false, threads: pc.threads || undefined });
    currentBackend = 'cpu';
    currentLlamaGpuSetting = desiredGpu;
    return llama;
  }

  const isAppleSilicon = process.platform === 'darwin' && process.arch === 'arm64';
  const backends = isAppleSilicon ? ['metal', false] : ['cuda', 'vulkan', 'metal', false];
  let lastError = null;
  for (const backend of backends) {
    try {
      llama = await llamaCpp.getLlama({ gpu: backend === false ? false : backend });
      currentBackend = backend || 'cpu';
      currentLlamaGpuSetting = desiredGpu;
      mainWindow?.webContents.send('gpu-backend', { backend: currentBackend });
      console.log(`[LLM] backend: ${currentBackend.toUpperCase()}`);
      return llama;
    } catch (error) {
      lastError = error;
      console.warn(`[LLM] ${backend || 'cpu'} not available: ${error.message}`);
    }
  }
  throw lastError || new Error('No inference backend is available');
}

export async function assessDeviceCapability(force = false) {
  if (deviceCapability && !force) return deviceCapability;
  const cfg = getCachedConfig();
  const base = {
    ramTotalBytes: os.totalmem(),
    logicalCores: os.cpus().length,
    lastModelLoadFailure: cfg.lastModelLoadFailure,
  };
  try {
    await ensureLlamaBackend(cfg.useGpu !== false);
    let vram = { total: 0, free: 0, unifiedSize: 0 };
    let gpuNames = [];
    if (currentBackend !== 'cpu') {
      [vram, gpuNames] = await Promise.all([
        llama.getVramState(),
        llama.getGpuDeviceNames(),
      ]);
    }
    deviceCapability = classifyHardware({
      ...base,
      backend: currentBackend,
      gpuNames,
      vramTotalBytes: vram.total,
      unifiedVramBytes: vram.unifiedSize,
    });
  } catch (error) {
    console.warn('[Hardware] capability detection failed:', error.message);
    deviceCapability = classifyHardware({ ...base, backend: 'unknown', detectionFailed: true });
  }
  detectedGpuTier = deviceCapability.runtimeTier;
  perfConfig = null;
  return deviceCapability;
}

async function profileForModelPath(modelPath, preferredProfile = null) {
  if (['pro', 'wordwise', 'low', 'custom'].includes(preferredProfile)) return preferredProfile;
  try {
    const { readGgufFileInfo } = await getLlamaCpp();
    const info = await readGgufFileInfo(modelPath, { readTensorInfo: false });
    return classifyModelProfile(info.metadata, path.basename(modelPath));
  } catch (error) {
    console.warn('[Model] metadata classification failed:', error.message);
    return classifyModelProfile(null, path.basename(modelPath));
  }
}

function modelStatusPayload(status, extra = {}) {
  const profile = extra.profile || activeModelProfile || 'custom';
  const runtimeTier = extra.runtimeTier || perfTier || 'mid';
  return {
    status,
    profile,
    displayName: profile === 'custom' ? 'Custom' : MODEL_PROFILES[profile].displayName,
    runtimeTier,
    displayLabel: profileDisplayLabel(profile, runtimeTier),
    ...extra,
  };
}

export async function loadModelFromPath(modelPath, options = {}) {
  const requestedProfile = await profileForModelPath(modelPath, options.profile);
  activeModelProfile = requestedProfile;
  perfConfig = null;
  mainWindow?.webContents.send('model-status', modelStatusPayload('loading', {
    profile: requestedProfile,
    message: `正在加载 ${profileDisplayLabel(requestedProfile, perfTier)}…`,
  }));

  try {
    gpuOomFallback = false;
    activeInference?.controller.abort(new Error('model changed'));
    stopHint();
    await inferenceTail.catch(() => undefined);
    if (session) session = null;
    if (context) { await context.dispose(); context = null; }
    if (model) { await model.dispose(); model = null; }
    semanticGrammar = null;
    reviewGrammar = null;
    hintGrammar = null;
    lowVerificationGrammar = null;
    clearInferenceCache();

    const cfg = getCachedConfig();
    const useGpu = cfg.useGpu !== false;
    await ensureLlamaBackend(useGpu);

    adjustTierForBackend(currentBackend);
    const pc = getPerfConfig();
    const canFlashAttention = pc.flashAttention && ['metal', 'cuda', 'vulkan'].includes(currentBackend);

    try {
      model = await llama.loadModel({
        modelPath,
        gpuLayers: currentBackend === 'cpu' ? 0 : pc.gpuLayerMode,
        defaultContextFlashAttention: canFlashAttention,
      });
      context = await model.createContext({
        contextSize: pc.contextSize,
        batchSize: pc.batchSize,
        sequences: 1,
        flashAttention: canFlashAttention && model.flashAttentionSupported,
      });
    } catch (gpuErr) {
      const errMsg = String(gpuErr?.message || '').toLowerCase();
      const isGpuLoadError = currentBackend !== 'cpu' && (
        errMsg.includes('memory') || errMsg.includes('vram') ||
        errMsg.includes('oom') || errMsg.includes('alloc') ||
        errMsg.includes('cuda') || errMsg.includes('vulkan')
      );
      if (!isGpuLoadError) throw gpuErr;

      console.warn(`[LLM] GPU load failed: ${gpuErr.message}, falling back to CPU...`);
      mainWindow?.webContents.send('model-status', modelStatusPayload('loading', {
        profile: requestedProfile,
        errorCode: 'gpu_oom',
        message: 'GPU 加载失败，正在使用 CPU 重试…',
      }));
      try { await llama.dispose(); } catch (e) { }
      const pcFallback = getPerfConfig();
      llama = await (await getLlamaCpp()).getLlama({ gpu: false, threads: pcFallback.threads || undefined });
      currentBackend = 'cpu';
      currentLlamaGpuSetting = 'no';
      gpuOomFallback = true;
      const failedConfig = getCachedConfig();
      failedConfig.lastModelLoadFailure = 'gpu_oom';
      failedConfig.oomRecommendationAcknowledged = false;
      saveConfig(failedConfig);
      deviceCapability = null;
      mainWindow?.webContents.send('gpu-backend', { backend: 'cpu' });
      adjustTierForBackend('cpu');
      const pc2 = getPerfConfig();
      model = await llama.loadModel({ modelPath, gpuLayers: 0, defaultContextFlashAttention: false });
      context = await model.createContext({
        contextSize: pc2.contextSize, batchSize: pc2.batchSize, sequences: 1, flashAttention: false,
      });
    }
    const llamaCpp = await getLlamaCpp();
    session = new llamaCpp.LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt: COMPACT_MODEL_PROFILES.has(requestedProfile)
        ? lowEvaluationSystemPrompt
        : evaluationSystemPrompt,
    });
    semanticGrammar = await llama.createGrammarForJsonSchema(semanticSchema);
    reviewGrammar = await llama.createGrammarForJsonSchema(reviewSchema);
    hintGrammar = await llama.createGrammarForJsonSchema(hintSchema);
    lowVerificationGrammar = await llama.createGrammarForJsonSchema(lowVerificationSchema);
    await session.preloadPrompt('Evaluate this record.\nWORD=');
    session.resetChatHistory();

    activeModelProfile = classifyModelProfile(model.fileInfo?.metadata, path.basename(modelPath));
    const updated = getCachedConfig();
    updated.modelPath = modelPath;
    updated.modelPaths ||= {};
    updated.modelPaths[activeModelProfile] = modelPath;
    updated.activeModelProfile = activeModelProfile;
    if (options.persistPreference === true) {
      updated.computeModePreference = activeModelProfile;
    }
    if (activeModelProfile === 'pro' && !gpuOomFallback) {
      updated.lastModelLoadFailure = null;
      updated.oomRecommendationAcknowledged = false;
    }
    saveConfig(updated);
    if (activeModelProfile === 'pro' && !gpuOomFallback) {
      deviceCapability = null;
      await assessDeviceCapability(true);
      perfConfig = null;
      detectHardwareTier();
    }

    const readyPayload = modelStatusPayload('ready', {
      profile: activeModelProfile,
      runtimeTier: perfTier,
      message: `${profileDisplayLabel(activeModelProfile, perfTier)} 已加载`,
      modelName: path.basename(modelPath),
      backend: currentBackend,
      perfTier,
    });
    mainWindow?.webContents.send('model-status', readyPayload);

    if (activeModelProfile === 'pro' && gpuOomFallback && options.suppressRecommendation !== true) {
      const capability = await assessDeviceCapability(true);
      mainWindow?.webContents.send('low-mode-recommendation', { capability, source: 'gpu_oom' });
    }

    return {
      success: true,
      profile: activeModelProfile,
      displayName: readyPayload.displayName,
      displayLabel: readyPayload.displayLabel,
      modelName: path.basename(modelPath),
      backend: currentBackend,
      contextSize: context.contextSize,
      batchSize: context.batchSize,
      flashAttention: context.flashAttention,
      gpuLayers: model.gpuLayers,
      perfTier,
      timeout: pc.timeout,
      threads: pc.threads,
    };
  } catch (err) {
    console.error('model load failed:', err);
    if (session) session = null;
    if (context) { try { await context.dispose(); } catch (e) { } context = null; }
    if (model) { try { await model.dispose(); } catch (e) { } model = null; }
    const errorMessage = String(err?.message || err);
    const memoryFailure = /memory|vram|oom|alloc/i.test(errorMessage);
    const errorCode = memoryFailure ? 'memory_allocation' : 'model_load_failed';
    if (requestedProfile === 'pro' && memoryFailure) {
      const failedConfig = getCachedConfig();
      failedConfig.lastModelLoadFailure = errorCode;
      failedConfig.oomRecommendationAcknowledged = false;
      saveConfig(failedConfig);
      deviceCapability = null;
    }
    mainWindow?.webContents.send('model-status', modelStatusPayload('error', {
      profile: requestedProfile,
      errorCode,
      message: `模型加载失败：${errorMessage}`,
    }));
    if (requestedProfile === 'pro' && memoryFailure && options.suppressRecommendation !== true) {
      const capability = await assessDeviceCapability(true);
      mainWindow?.webContents.send('low-mode-recommendation', { capability, source: errorCode });
    }
    return { success: false, error: errorMessage, errorCode };
  }
}

export function disposeLlm() {
  activeInference?.controller.abort(new Error('model disposed'));
  stopHint();
  clearInferenceCache();
  if (session) session = null;
  if (context) { context?.dispose().catch(() => { }); context = null; }
  if (model) { model?.dispose().catch(() => { }); model = null; }
  semanticGrammar = null;
  reviewGrammar = null;
  hintGrammar = null;
  lowVerificationGrammar = null;
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyBuiltInModel(profile, modelPath) {
  const definition = MODEL_PROFILES[profile];
  if (!definition || !fs.existsSync(modelPath)) {
    return { valid: false, errorCode: 'model_missing' };
  }
  const stats = fs.statSync(modelPath);
  const size = stats.size;
  const resolvedModelPath = path.resolve(modelPath);
  if (size !== definition.expectedBytes) {
    return { valid: false, errorCode: 'model_size_mismatch', size };
  }
  const cfg = getCachedConfig();
  const verified = cfg.verifiedModels?.[profile];
  if (verified?.sha256 === definition.sha256 &&
      verified?.size === size && verified?.mtimeMs === stats.mtimeMs &&
      verified?.path === resolvedModelPath) {
    return { valid: true, size, sha256: definition.sha256 };
  }
  const digest = await sha256File(modelPath);
  if (digest !== definition.sha256) {
    return { valid: false, errorCode: 'model_hash_mismatch', size, sha256: digest };
  }
  cfg.verifiedModels ||= {};
  cfg.verifiedModels[profile] = {
    path: resolvedModelPath,
    sha256: digest,
    size,
    mtimeMs: stats.mtimeMs,
  };
  saveConfig(cfg);
  return { valid: true, size, sha256: digest };
}

function localProfileSourcePath(definition) {
  if (!definition) return '';

  // Packaged builds carry verified built-in models outside app.asar so the
  // native GGUF reader can open them directly. Prefer that immutable copy
  // over a development-machine path persisted in config.json.
  if (app.isPackaged && definition.packagedSource) {
    const packagedPath = path.join(process.resourcesPath, definition.packagedSource);
    if (fs.existsSync(packagedPath)) return packagedPath;
  }

  if (!definition.localSource) return '';
  return path.resolve(app.getAppPath(), definition.localSource);
}

function assertDownloadSpace(definition) {
  fs.mkdirSync(userDataPath, { recursive: true });
  if (typeof fs.statfsSync !== 'function') return;
  const stats = fs.statfsSync(userDataPath);
  const available = Number(stats.bavail) * Number(stats.bsize);
  const required = definition.expectedBytes + 512 * 1024 ** 2;
  if (Number.isFinite(available) && available < required) {
    const error = new Error('磁盘可用空间不足，请至少保留模型大小外加 512 MB。');
    error.code = 'insufficient_disk_space';
    throw error;
  }
}

async function openDownloadResponse(requestUrl, redirectsLeft = 6) {
  const protocol = requestUrl.startsWith('https:') ? 'https' : 'http';
  const module = await import(protocol);
  const requester = module.default || module;
  return new Promise((resolve, reject) => {
    const request = requester.get(requestUrl, {
      headers: { 'User-Agent': 'WordWise/1.0.0', Accept: 'application/octet-stream' },
    }, async response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) return reject(new Error('Too many download redirects'));
        try {
          resolve(await openDownloadResponse(new URL(response.headers.location, requestUrl).toString(), redirectsLeft - 1));
        } catch (error) {
          reject(error);
        }
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      resolve(response);
    });
    request.on('error', reject);
  });
}

async function downloadProfile(profile) {
  const definition = MODEL_PROFILES[profile];
  if (!definition) throw new Error(`Unknown model profile: ${profile}`);
  const cfg = getCachedConfig();
  const configuredPath = builtInModelPath(profile, userDataPath, cfg);

  // An installer-owned model is the canonical source for a packaged build.
  // This also repairs a config.json that still points at the developer's
  // checkout or at a stale downloaded copy.
  const localSource = localProfileSourcePath(definition);
  if (app.isPackaged && localSource) {
    const packagedExisting = await verifyBuiltInModel(profile, localSource);
    if (packagedExisting.valid) {
      cfg.modelPaths ||= {};
      cfg.modelPaths[profile] = localSource;
      saveConfig(cfg);
      return localSource;
    }
  }

  const existing = await verifyBuiltInModel(profile, configuredPath);
  if (existing.valid) return configuredPath;
  // A stale legacy path must not redirect a fresh download into a removed or
  // read-only development directory.
  const destination = path.join(userDataPath, definition.filename);
  if (destination !== configuredPath) {
    const defaultExisting = await verifyBuiltInModel(profile, destination);
    if (defaultExisting.valid) {
      cfg.modelPaths ||= {};
      cfg.modelPaths[profile] = destination;
      saveConfig(cfg);
      return destination;
    }
  }
  if (localSource && fs.existsSync(localSource)) {
    const localExisting = await verifyBuiltInModel(profile, localSource);
    if (localExisting.valid) {
      cfg.modelPaths ||= {};
      cfg.modelPaths[profile] = localSource;
      saveConfig(cfg);
      return localSource;
    }
  }
  if (!definition.url) {
    const error = new Error('QWEN-WordWise v1 本地模型源不存在或校验失败；当前版本未配置远程下载地址。');
    error.code = 'model_source_unavailable';
    throw error;
  }
  // Disk space matters only when bytes will actually be downloaded. A valid
  // installed model must remain usable even when free space is currently low.
  assertDownloadSpace(definition);
  const partialPath = `${destination}.part`;

  try { if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath); } catch { }
  mainWindow?.webContents.send('download-progress', {
    profile,
    displayName: definition.displayName,
    percent: 0,
    receivedMB: '0',
    totalMB: (definition.expectedBytes / 1024 ** 2).toFixed(0),
    message: `开始下载 ${definition.displayName}…`,
  });

  let received = 0;
  let lastTick = 0;
  const hash = crypto.createHash('sha256');
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      hash.update(chunk);
      const now = Date.now();
      if (now - lastTick >= 400) {
        lastTick = now;
        const percent = Math.min(99.9, received / definition.expectedBytes * 100);
        mainWindow?.webContents.send('download-progress', {
          profile,
          displayName: definition.displayName,
          percent: Number(percent.toFixed(1)),
          receivedMB: (received / 1024 ** 2).toFixed(1),
          totalMB: (definition.expectedBytes / 1024 ** 2).toFixed(0),
          message: `正在下载 ${definition.displayName}…`,
        });
      }
      callback(null, chunk);
    },
  });

  try {
    const response = await openDownloadResponse(definition.url);
    await pipeline(response, progress, fs.createWriteStream(partialPath));
    const digest = hash.digest('hex');
    if (received !== definition.expectedBytes) {
      const error = new Error(`模型大小校验失败：${received} / ${definition.expectedBytes}`);
      error.code = 'model_size_mismatch';
      throw error;
    }
    if (digest !== definition.sha256) {
      const error = new Error('模型 SHA-256 校验失败。');
      error.code = 'model_hash_mismatch';
      throw error;
    }
    if (fs.existsSync(destination)) fs.unlinkSync(destination);
    fs.renameSync(partialPath, destination);
    cfg.modelPaths ||= {};
    cfg.modelPaths[profile] = destination;
    const installedStats = fs.statSync(destination);
    cfg.verifiedModels ||= {};
    cfg.verifiedModels[profile] = {
      path: path.resolve(destination),
      sha256: digest,
      size: installedStats.size,
      mtimeMs: installedStats.mtimeMs,
    };
    saveConfig(cfg);
    mainWindow?.webContents.send('download-progress', {
      profile,
      displayName: definition.displayName,
      percent: 100,
      receivedMB: (received / 1024 ** 2).toFixed(1),
      totalMB: (definition.expectedBytes / 1024 ** 2).toFixed(0),
      message: `${definition.displayName} 下载并校验完成`,
    });
    return destination;
  } catch (error) {
    try { if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath); } catch { }
    mainWindow?.webContents.send('download-progress', {
      profile,
      displayName: definition.displayName,
      percent: -1,
      errorCode: error.code || 'download_failed',
      message: `下载失败：${error.message}`,
    });
    throw error;
  }
}

function modelProfilesState() {
  const cfg = getCachedConfig();
  return Object.fromEntries(Object.keys(MODEL_PROFILES).map(profile => {
    const definition = MODEL_PROFILES[profile];
    const configuredPath = builtInModelPath(profile, userDataPath, cfg);
    const defaultPath = path.join(userDataPath, definition.filename);
    const localSource = localProfileSourcePath(definition);
    const candidates = app.isPackaged
      ? [...new Set([localSource, configuredPath, defaultPath].filter(Boolean))]
      : [...new Set([configuredPath, defaultPath, localSource].filter(Boolean))];
    const modelPath = candidates.find(candidate =>
      fs.existsSync(candidate) && fs.statSync(candidate).size === definition.expectedBytes
    ) || configuredPath || defaultPath;
    const installed = fs.existsSync(modelPath) && fs.statSync(modelPath).size === definition.expectedBytes;
    return [profile, {
      id: profile,
      displayName: definition.displayName,
      filename: definition.filename,
      expectedBytes: definition.expectedBytes,
      path: modelPath,
      installed,
      active: activeModelProfile === profile && Boolean(model),
    }];
  }));
}

function emptyLearningState() {
  return {
    mastery_score: null,
    difficulty_delta: 0,
    sm2_next_review: null,
    is_stubborn: false,
    confusion_hint: '',
    confusion_update: null,
  };
}

function failedEvaluation(status, explanation, startedAt) {
  return {
    evaluation_status: status,
    evaluation_path: null,
    reason_code: null,
    confidence: null,
    explanation_source: null,
    latency_ms: Math.round(performance.now() - startedAt),
    perf_tier: perfTier,
    model_profile: activeModelProfile,
    low_verification: null,
    is_correct: null,
    score: null,
    reward_eligible: false,
    mistake_id: null,
    reviewed_mistake_id: null,
    mistake_resolved: false,
    explanation,
    ...emptyLearningState(),
  };
}

function classifyFailure(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (message.includes('timeout')) {
    return ['timeout', '评估超时，本次不会计分，请重试。'];
  }
  if (message.includes('cancel') || message.includes('model changed') || message.includes('disposed')) {
    return ['cancelled', '评估已取消，本次不会计分。'];
  }
  return ['invalid_output', '模型返回的数据无法验证，本次不会计分，请重试。'];
}

function readConfusionSignal(vc, wordId, answer) {
  if (!vc?.getConfusionSignal || wordId == null) return null;
  try {
    return vc.getConfusionSignal(Math.floor(Number(wordId)), answer || '');
  } catch (error) {
    console.warn('[Confusion] signal lookup failed:', error.message);
    return null;
  }
}

function readAnswerCandidate(vc, wordId, answer) {
  if (!vc?.getAnswerCandidate || wordId == null) return null;
  try {
    return vc.getAnswerCandidate(Math.floor(Number(wordId)), answer || '');
  } catch (error) {
    console.warn('[Evaluation] candidate lookup failed:', error.message);
    return null;
  }
}

function updatedSignal(previous, update) {
  if (!update) return previous;
  return {
    occurrenceCount: update.occurrenceCount,
    riskScore: update.riskScore,
    candidateTerm: update.candidateTerm,
    candidateConfidence: update.candidateConfidence,
    isConfirmed: update.occurrenceCount >= 2 && !!update.candidateTerm,
  };
}

async function evaluateAnswer(word, meaning, answer, answerCandidate, confusionSignal, signal) {
  const key = cacheKey(word, meaning, answer);
  const cached = cacheGet(semanticCache, key);
  let path = firstEvaluationPath(answer, meaning, cached);
  let decision;
  let explanation = '';
  let explanationSource = 'local_template';
  let lowVerification = null;

  if (path === evaluationPaths.literal) {
    decision = { score: 100, reasonCode: 'exact', confidence: 100 };
  } else if (answerCandidate && isLookAlikeWord(word, answerCandidate.term)) {
    decision = { score: 15, reasonCode: 'wrong_sense', confidence: 100 };
    path = evaluationPaths.literal;
    explanation = `你的回答更接近“${answerCandidate.term}”。标准释义：${meaning}`;
    explanationSource = 'local_confusion_match';
  } else if (path === evaluationPaths.cached) {
    decision = cached;
  } else {
    const raw = await askModel(buildEvaluationPrompt(word, meaning, answer), {
      grammar: semanticGrammar,
      maxTokens: (getPerfConfig().maxTokensEval ?? 48),
      temperature: 0,
    }, signal);
    decision = parseSemanticDecision(semanticGrammar.parse(raw));

    if (COMPACT_MODEL_PROFILES.has(activeModelProfile)) {
      let gate = gateLowModelDecision(decision);
      if (gate.needsVerification) {
        const verificationRaw = await askModel(buildLowVerificationPrompt(word, meaning, answer), {
          grammar: lowVerificationGrammar,
          maxTokens: 24,
          temperature: 0,
        }, signal);
        const verification = parseLowVerification(lowVerificationGrammar.parse(verificationRaw));
        gate = gateLowModelDecision(decision, verification);
        lowVerification = {
          accepted: gate.accepted,
          reason: gate.reason,
          relation: verification.relation,
          confidence: verification.confidence,
        };
        path = evaluationPaths.lowVerify;
      }
      if (!gate.accepted) {
        return {
          qualityRejected: true,
          qualityGateReason: gate.reason,
          path: evaluationPaths.lowVerify,
          lowVerification: lowVerification || {
            accepted: false,
            reason: gate.reason,
            relation: null,
            confidence: null,
          },
        };
      }
      lowVerification ||= {
        accepted: true,
        reason: gate.reason,
        relation: null,
        confidence: null,
      };
    } else if (needsBoundaryReview(decision, confusionSignal)) {
      const reviewed = await askModel(
        buildReviewPrompt(word, meaning, answer, decision, confusionSignal),
        { grammar: reviewGrammar, maxTokens: (getPerfConfig().maxTokensReview ?? 96), temperature: 0 },
        signal
      );
      decision = parseSemanticDecision(reviewGrammar.parse(reviewed), true);
      explanation = decision.explanation;
      explanationSource = 'model';
      path = evaluationPaths.review;
    }
    cacheSet(semanticCache, key, {
      score: decision.score,
      reasonCode: decision.reasonCode,
      confidence: decision.confidence,
    });
  }

  return { decision, path, explanation, explanationSource, lowVerification };
}

export function initLlmHandlers(getVocabCore) {
  ipcMain.handle('detect-gpu', async () => {
    try {
      const capability = await assessDeviceCapability(true);
      return {
        success: true,
        hasGoodGpu: capability.backend !== 'cpu' && !capability.detectionFailed,
        backend: capability.backend,
        gpuTier: capability.runtimeTier,
        gpuName: capability.gpuNames.join(', '),
        capability,
      };
    } catch (err) {
      console.error('GPU detect failed:', err);
      return { hasGoodGpu: false, error: err.message };
    }
  });

  // 只允许 renderer 通过 IPC 修改这些白名单配置项，防止被 XSS 利用写入
  // modelPaths.*、activeModelProfile、licenseBackend 等任意键。
  const ALLOWED_CONFIG_KEYS = new Set([
    'useGpu',
    'demoMode',
    'autoReadWord',
    'autoAdvanceEnabled',
    'autoAdvanceDelayMs',
  ]);

  ipcMain.handle('update-config', async (_e, kv) => {
    if (!kv || typeof kv !== 'object' || Array.isArray(kv)) {
      return { success: false, error: 'invalid config payload' };
    }
    const cfg = getCachedConfig();
    for (const [k, v] of Object.entries(kv)) {
      if (!ALLOWED_CONFIG_KEYS.has(k)) {
        console.warn(`[Security] update-config blocked unknown key: ${k}`);
        continue;
      }
      cfg[k] = v;
    }
    saveConfig(cfg);
    if (Object.prototype.hasOwnProperty.call(kv, 'useGpu')) {
      deviceCapability = null;
      perfConfig = null;
    }
    return { success: true };
  });

  ipcMain.handle('get-model-profiles', async () => modelProfilesState());

  ipcMain.handle('initialize-ai', async () => {
    const capability = await assessDeviceCapability();
    const cfg = getCachedConfig();
    const preference = cfg.computeModePreference;
    const previousOom = capability.reasons.some(reason => reason.code === 'previous_oom') &&
      cfg.oomRecommendationAcknowledged !== true;
    const requiresChoice = capability.recommendLow && (
      !['pro', 'wordwise', 'low', 'custom'].includes(preference) ||
      (preference === 'pro' && previousOom)
    );
    const result = {
      capability,
      preference: preference || null,
      activeProfile: cfg.activeModelProfile || null,
      profiles: modelProfilesState(),
      requiresChoice,
    };

    if (!startupInitialized) {
      startupInitialized = true;
      if (!requiresChoice) {
        const selected = ['wordwise', 'pro', 'low', 'custom'].includes(preference)
          ? preference
          : (cfg.activeModelProfile || 'wordwise');
        const selectedPath = selected === 'custom'
          ? cfg.modelPaths?.custom
          : modelProfilesState()[selected]?.path;
        if (selectedPath && fs.existsSync(selectedPath)) {
          setTimeout(() => {
            loadModelFromPath(selectedPath, { profile: selected, persistPreference: false })
              .catch(error => console.error('[Startup] model load failed:', error));
          }, capability.recommendLow ? 300 : 700);
        }
      }
    }
    return result;
  });

  ipcMain.handle('activate-compute-mode', async (_event, profile) => {
    if (!['pro', 'wordwise', 'low'].includes(profile)) {
      return { success: false, errorCode: 'invalid_profile', error: '不支持的算力模式。' };
    }
    const cfg = getCachedConfig();
    const modelPath = modelProfilesState()[profile].path;
    if (!fs.existsSync(modelPath)) {
      return { success: false, needsDownload: true, errorCode: 'model_missing', profile };
    }
    const verified = await verifyBuiltInModel(profile, modelPath);
    if (!verified.valid) {
      return {
        success: false,
        needsDownload: true,
        errorCode: verified.errorCode,
        error: '本地模型文件不完整或校验失败，需要重新下载。',
        profile,
      };
    }
    const firstLowActivation = profile === 'low' && cfg.lowModeActivated !== true;
    const loaded = await loadModelFromPath(modelPath, {
      profile,
      persistPreference: true,
      suppressRecommendation: profile === 'pro',
    });
    if (loaded.success && profile === 'pro' && gpuOomFallback) {
      const updated = getCachedConfig();
      updated.oomRecommendationAcknowledged = true;
      saveConfig(updated);
    }
    if (loaded.success && profile === 'low') {
      const updated = getCachedConfig();
      updated.lowModeActivated = true;
      saveConfig(updated);
    }
    return { ...loaded, firstLowActivation };
  });

  ipcMain.handle('download-model', async (_event, profile) => {
    if (!['pro', 'wordwise', 'low'].includes(profile)) {
      return { success: false, errorCode: 'invalid_profile', error: '不支持的模型下载。' };
    }
    const cfg = getCachedConfig();
    const firstLowActivation = profile === 'low' && cfg.lowModeActivated !== true;
    try {
      const modelPath = await downloadProfile(profile);
      const loaded = await loadModelFromPath(modelPath, {
        profile,
        persistPreference: true,
        suppressRecommendation: profile === 'pro',
      });
      if (loaded.success && profile === 'pro' && gpuOomFallback) {
        const updated = getCachedConfig();
        updated.oomRecommendationAcknowledged = true;
        saveConfig(updated);
      }
      if (loaded.success && profile === 'low') {
        const updated = getCachedConfig();
        updated.lowModeActivated = true;
        saveConfig(updated);
      }
      return { ...loaded, firstLowActivation };
    } catch (error) {
      return {
        success: false,
        profile,
        errorCode: error.code || 'download_failed',
        error: error.message,
      };
    }
  });

  ipcMain.handle('unload-model', async () => {
    activeInference?.controller.abort(new Error('model disposed'));
    stopHint();
    await inferenceTail.catch(() => undefined);
    disposeLlm();
    if (llama) {
      try { await llama.dispose(); } catch (e) { }
      llama = null;
      currentLlamaGpuSetting = null;
      currentBackend = null;
    }
    mainWindow?.webContents.send('model-status', modelStatusPayload('error', {
      message: '模型已卸载',
      unloaded: true
    }));
    return { success: true };
  });

  ipcMain.handle('select-model-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select GGUF Model File',
      filters: [
        { name: 'GGUF Models', extensions: ['gguf'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    return await loadModelFromPath(result.filePaths[0], { persistPreference: true });
  });

  // 'load-model' 已移除：原实现接受 renderer 传入的任意路径读 GGUF 文件。
  // 模型加载统一走 select-model-file（对话框授权）或 download-model / activate-compute-mode。

  ipcMain.handle('check-answer', async (_e, word, answer, responseTimeMs, attemptContext = { source: 'practice' }) => {
    const lic = assertLearningAllowed();
    if (lic.blocked) {
      return { status: 'license_blocked', evaluation_status: 'license_blocked', error: '会员已到期', licenseBlocked: true };
    }
    const startedAt = performance.now();
    if (!session) {
      return failedEvaluation('invalid_output', '模型尚未加载。', startedAt);
    }
    stopHint();
    const vc = getVocabCore();
    try {
      const dbWord = vc?.getWordByTerm(word);
      const meaning = dbWord?.meaning?.trim() || '';
      if (!meaning || meaning.includes('(释义待补充)')) {
        return failedEvaluation(
          'missing_reference',
          '这个单词缺少可信释义，本次不会计分。请先补充词义。',
          startedAt
        );
      }

      const wordId = dbWord?.id ?? null;
      const attemptSource = attemptContext?.source === 'mistake_review'
        ? 'mistake_review'
        : 'practice';
      const requestedMistakeId = Number(attemptContext?.mistakeId);
      const reviewMistakeId = attemptSource === 'mistake_review'
        && Number.isSafeInteger(requestedMistakeId) && requestedMistakeId > 0
        ? requestedMistakeId
        : null;
      if (attemptSource === 'mistake_review' && reviewMistakeId === null) {
        return failedEvaluation(
          'invalid_context',
          '错题复习状态已变化，本次不会计分。请重新进入错题复习。',
          startedAt
        );
      }
      const confusionSignal = readConfusionSignal(vc, wordId, answer);
      const answerCandidate = isExactMeaning(answer, meaning)
        ? null
        : readAnswerCandidate(vc, wordId, answer);
      const evaluated = await queueInference('answer', signal =>
        evaluateAnswer(word, meaning, answer, answerCandidate, confusionSignal, signal)
      );
      if (evaluated.qualityRejected) {
        const rejected = failedEvaluation(
          'uncertain',
          `${MODEL_PROFILES[activeModelProfile]?.displayName || 'QWEN'} 质量复核未通过，本次不会计分。请重试或切换至 QWEN-Pro。`,
          startedAt
        );
        rejected.evaluation_path = evaluated.path;
        rejected.low_verification = evaluated.lowVerification;
        return rejected;
      }
      const { decision, path, explanationSource, lowVerification } = evaluated;
      const isCorrect = decision.score >= 60;
      let scoreResult = null;
      const rtMs = typeof responseTimeMs === 'number' ? responseTimeMs : 0;
      if (!vc || wordId == null || !Number.isFinite(Number(wordId))) {
        return failedEvaluation(
          'storage_error',
          '判定已完成，但学习记录保存失败，本次不会计分。',
          startedAt
        );
      }
      try {
        scoreResult = vc.recordSemanticScore(
          Math.floor(Number(wordId)),
          decision.score,
          rtMs,
          answer || '',
          attemptSource,
          reviewMistakeId
        );
        console.log(
          `[Adaptive] "${word}" score=${decision.score} mastery=${scoreResult.masteryScore?.toFixed(1)}` +
          ` delta=${scoreResult.difficultyDelta}` +
          (scoreResult.isStubborn ? ' [STUBBORN]' : '') +
          (scoreResult.confusionHint ? ` confusion="${scoreResult.confusionHint.slice(0, 40)}..."` : '')
        );
      } catch (e) {
        console.error('[Adaptive] atomic recordScore:', e.message);
        const failed = failedEvaluation(
          'storage_error',
          '判定已完成，但学习记录保存失败，本次不会计分。',
          startedAt
        );
        failed.evaluation_path = path;
        return failed;
      }

      const currentSignal = updatedSignal(confusionSignal, scoreResult?.confusionUpdate);
      const explanation = evaluated.explanation || localExplanation(decision, meaning, currentSignal);

      return {
        evaluation_status: 'ok',
        evaluation_path: path,
        reason_code: decision.reasonCode,
        confidence: decision.confidence,
        explanation_source: explanationSource,
        latency_ms: Math.round(performance.now() - startedAt),
        perf_tier: perfTier,
        model_profile: activeModelProfile,
        low_verification: lowVerification,
        is_correct: isCorrect,
        score: decision.score,
        reward_eligible: scoreResult.rewardEligible === true,
        mistake_id: scoreResult.mistakeId ?? null,
        reviewed_mistake_id: scoreResult.reviewedMistakeId ?? null,
        mistake_resolved: scoreResult.mistakeResolved === true,
        explanation,
        mastery_score: scoreResult?.masteryScore ?? null,
        difficulty_delta: scoreResult?.difficultyDelta ?? 0,
        sm2_next_review: scoreResult?.sm2NextReview ?? null,
        is_stubborn: scoreResult?.isStubborn ?? false,
        confusion_hint: scoreResult?.confusionHint ?? '',
        confusion_update: scoreResult?.confusionUpdate ?? null,
      };
    } catch (err) {
      console.error('[LLM] answer evaluation failed:', err.message);
      const [status, message] = classifyFailure(err);
      return failedEvaluation(status, message, startedAt);
    }
  });

  ipcMain.handle('cancel-hint', () => {
    stopHint();
    return { success: true };
  });

  ipcMain.handle('get-hint', async (_e, word, level) => {
    const lic = assertLearningAllowed();
    if (lic.blocked) {
      return { status: 'license_blocked', hint: '', error: '会员已到期', licenseBlocked: true };
    }
    if (!session) return { status: 'invalid_output', hint: '', error: '模型尚未加载。' };
    const vc = getVocabCore();
    let meaning = '';
    try {
      meaning = vc?.getWordByTerm(word)?.meaning?.trim() || '';
    } catch (error) {
      console.warn('[Hint] meaning lookup failed:', error.message);
    }

    const localHint = level === 1 ? makeLevelOneHint(word, meaning) : null;
    if (localHint) {
      return { status: 'ok', hint: localHint, source: 'local' };
    }
    if (COMPACT_MODEL_PROFILES.has(activeModelProfile)) {
      return {
        status: 'unsupported',
        hint: '',
        error: level === 1
          ? '当前词条无法生成本地 L1 提示。'
          : `${MODEL_PROFILES[activeModelProfile]?.displayName || 'QWEN'} 仅支持本地 L1 提示，请切换至 QWEN-Pro 使用深度提示。`,
      };
    }
    if (![1, 2, 3].includes(level)) {
      return { status: 'invalid_output', hint: '', error: '提示级别无效。' };
    }
    if (!meaning || meaning.includes('(释义待补充)')) {
      return { status: 'missing_reference', hint: '', error: '缺少可信释义，无法生成提示。' };
    }

    const key = `hint:${level}:${word}:${meaning}`;
    const cached = cacheGet(hintCache, key);
    if (cached) return { status: 'ok', hint: cached, source: 'cache' };

    let prompt;
    if (level === 1) {
      prompt = `Return JSON with one hint. Show the first letter and underscores, the part of speech, and one Chinese meaning character.
WORD=${JSON.stringify(word)}
MEANING=${JSON.stringify(meaning)}`;
    } else if (level === 2) {
      prompt = `Return JSON with one hint: a simple English definition of at most 10 words. Do not reveal the Chinese meaning.
WORD=${JSON.stringify(word)}
MEANING=${JSON.stringify(meaning)}`;
    } else if (level === 3) {
      prompt = `Return JSON with one hint containing two common synonyms and one short example. Replace the tested word with ___.
WORD=${JSON.stringify(word)}
MEANING=${JSON.stringify(meaning)}`;
    }

    const generation = ++hintGeneration;
    try {
      const hint = await queueInference('hint', async signal => {
        if (generation !== hintGeneration) throw new Error('hint cancelled');
        const pc = getPerfConfig();
        const hintMaxTokens = level === 3 ? Math.min(80, pc.maxTokensReview) : pc.maxTokensEval;
        const response = await askModel(prompt, {
          grammar: hintGrammar,
          maxTokens: hintMaxTokens,
          temperature: 0,
        }, signal);
        if (generation !== hintGeneration) throw new Error('hint cancelled');
        return parseHint(hintGrammar.parse(response));
      });
      cacheSet(hintCache, key, hint);
      return { status: 'ok', hint, source: 'model' };
    } catch (err) {
      const [status, message] = classifyFailure(err);
      if (status !== 'cancelled') console.error('[Hint] generation failed:', err.message);
      return { status, hint: '', error: message };
    }
  });

  ipcMain.handle('get-perf-info', async () => {
    const pc = getPerfConfig();
    return {
      tier: perfTier,
      profile: activeModelProfile,
      displayLabel: profileDisplayLabel(activeModelProfile, perfTier),
      backend: currentBackend,
      contextSize: pc.contextSize,
      batchSize: pc.batchSize,
      timeout: pc.timeout,
      threads: pc.threads,
      flashAttention: pc.flashAttention,
      cacheCap: pc.cacheCap,
      cacheTtl: pc.cacheTtl,
      semanticCacheSize: semanticCache.size,
      hintCacheSize: hintCache.size,
    };
  });

  ipcMain.handle('download-default-model', async () => {
    try {
      const modelPath = await downloadProfile('pro');
      return await loadModelFromPath(modelPath, { profile: 'pro', persistPreference: true });
    } catch (err) {
      console.error('download failed:', err);
      return { success: false, errorCode: err.code || 'download_failed', error: err.message };
    }
  });

  ipcMain.handle('check-default-model', async () => {
    const state = modelProfilesState().pro;
    return { exists: state.installed, path: state.path, filename: state.filename };
  });
}
