const path = require('path');

const platform = process.platform;
const nodeFileName = platform === 'win32' ? 'vocab_core.win32.node' : 'vocab_core.mac.node';

let native;
try {
  native = require(path.join(__dirname, nodeFileName));
} catch (err) {
  console.error('[vocab-core] Failed to load native module:', err.message);
  // graceful fallback so the app doesn't crash if not built yet
  native = {
    setupDb: () => ({ success: false, message: 'Native module not available' }),
    importWordsFromFile: () => ({ imported: 0, skipped: 0, total: 0 }),
    addWord: () => ({ success: false, message: 'Native module not available' }),
    deleteWord: () => ({ success: false, message: 'Native module not available' }),
    getAllWords: () => [],
    getWordByTerm: () => null,
    getPracticeBatch: () => [],
    updateWordScore: () => ({ success: false, message: 'Native module not available' }),
    saveSession: () => ({ success: false, message: 'Native module not available' }),
    getWordCount: () => 0,
    exportWordsJson: () => '[]',
    recordSemanticScore: () => ({
      success: false,
      masteryScore: 0,
      difficultyDelta: 0,
      sm2Interval: 0,
      sm2NextReview: '',
      isStubborn: false,
      confusionHint: '',
      confusionUpdate: null,
      rewardEligible: false,
      mistakeId: null,
      reviewedMistakeId: null,
      mistakeResolved: false,
    }),
    getMasteryScore: () => 0,
    getNextAdaptiveWord: () => null,
    getUserProgressSummary: () => [],
    updateWordDifficulty: () => ({ success: false, message: 'Native module not available' }),
    setDefaultDifficulty: () => ({ success: false, message: 'Native module not available' }),
    getWordProfile: () => null,
    getConfusionMap: () => [],
    getConfusionDetail: () => null,
    getConfusionSignal: () => null,
    getAnswerCandidate: () => null,
    getMistakeQueueStatus: () => ({ dueCount: 0, unresolvedCount: 0, nextEligibleAt: null }),
    getMistakeSummary: () => [],
    getNextMistake: () => null,
  };
}

module.exports = native;
module.exports.default = native;
