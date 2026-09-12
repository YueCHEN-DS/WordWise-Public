import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  selectModelFile: () => ipcRenderer.invoke('select-model-file'),
  downloadDefaultModel: () => ipcRenderer.invoke('download-default-model'),
  checkDefaultModel: () => ipcRenderer.invoke('check-default-model'),
  initializeAi: () => ipcRenderer.invoke('initialize-ai'),
  getModelProfiles: () => ipcRenderer.invoke('get-model-profiles'),
  activateComputeMode: profile => ipcRenderer.invoke('activate-compute-mode', profile),
  downloadModel: profile => ipcRenderer.invoke('download-model', profile),
  unloadModel: () => ipcRenderer.invoke('unload-model'),
  detectGpu: () => ipcRenderer.invoke('detect-gpu'),
  updateConfig: config => ipcRenderer.invoke('update-config', config),
  checkAnswer: (word, answer, responseTimeMs, attemptContext = { source: 'practice' }) =>
    ipcRenderer.invoke('check-answer', word, answer, responseTimeMs, attemptContext),
  getHint: (word, level) => ipcRenderer.invoke('get-hint', word, level),
  cancelHint: () => ipcRenderer.invoke('cancel-hint'),
  openExternal: url => ipcRenderer.invoke('open-external', url),
  getConfig: () => ipcRenderer.invoke('get-config'),
  getAudioPath: word => ipcRenderer.invoke('get-audio-path', word),
  getPerfInfo: () => ipcRenderer.invoke('get-perf-info'),

  db: {
    getAvailableLists: () => ipcRenderer.invoke('db-get-lists'),
    switchList: listName => ipcRenderer.invoke('db-switch-list', listName),
    getAllWords: () => ipcRenderer.invoke('db-get-all-words'),
    addWord: (term, meaning) => ipcRenderer.invoke('db-add-word', term, meaning),
    deleteWord: id => ipcRenderer.invoke('db-delete-word', id),
    importDialog: () => ipcRenderer.invoke('db-import-dialog'),
    getBatch: (limit, mode, offset) => ipcRenderer.invoke('db-get-batch', limit, mode, offset),
    updateScore: (id, isCorrect) => ipcRenderer.invoke('db-update-score', id, isCorrect),
    saveSession: (wordsTested, correct, score) =>
      ipcRenderer.invoke('db-save-session', wordsTested, correct, score),
    wordCount: () => ipcRenderer.invoke('db-word-count'),
    exportJson: () => ipcRenderer.invoke('db-export-json'),
    refreshList: listName => ipcRenderer.invoke('db-refresh-list', listName),
    getNextAdaptive: (difficulty, excludeWordId) =>
      ipcRenderer.invoke('db-get-next-adaptive', difficulty, excludeWordId),
    getMastery: wordId => ipcRenderer.invoke('db-get-mastery', wordId),
    getProgress: () => ipcRenderer.invoke('db-get-progress-summary'),
    updateDifficulty: (wordId, level) => ipcRenderer.invoke('db-update-difficulty', wordId, level),
    getWordProfile: wordId => ipcRenderer.invoke('db-get-word-profile', wordId),
    getConfusionMap: limit => ipcRenderer.invoke('db-get-confusion-map', limit),
    getConfusionDetail: (sourceWordId, fingerprint) =>
      ipcRenderer.invoke('db-get-confusion-detail', sourceWordId, fingerprint),
    getMistakeQueueStatus: () => ipcRenderer.invoke('db-get-mistake-queue-status'),
    getMistakeSummary: options => ipcRenderer.invoke('db-get-mistake-summary', options),
    getNextMistake: options => ipcRenderer.invoke('db-get-next-mistake', options),
  },

  license: {
    getState: () => ipcRenderer.invoke('license-get-state'),
    getDeviceCode: () => ipcRenderer.invoke('license-get-device-code'),
    activate: code => ipcRenderer.invoke('license-activate', code),
    onStateChange: callback => {
      ipcRenderer.on('license-state', (_event, data) => callback(data));
    },
  },

  onModelStatus: callback => {
    ipcRenderer.on('model-status', (_event, data) => callback(data));
  },
  onDownloadProgress: callback => {
    ipcRenderer.on('download-progress', (_event, data) => callback(data));
  },
  onGpuBackend: callback => {
    ipcRenderer.on('gpu-backend', (_event, data) => callback(data));
  },
  onInferencePerf: callback => {
    ipcRenderer.on('inference-perf', (_event, data) => callback(data));
  },
  onLowModeRecommendation: callback => {
    ipcRenderer.on('low-mode-recommendation', (_event, data) => callback(data));
  },
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('model-status');
    ipcRenderer.removeAllListeners('download-progress');
    ipcRenderer.removeAllListeners('gpu-backend');
    ipcRenderer.removeAllListeners('inference-perf');
    ipcRenderer.removeAllListeners('low-mode-recommendation');
    ipcRenderer.removeAllListeners('license-state');
  },
});
