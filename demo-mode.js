(function attachWordWiseDemo(root) {
  'use strict';

  const LISTS = Object.freeze([
    { name: 'Custom / My Words', file: 'Custom / My Words' },
    { name: 'Highschool', file: 'Highschool_edited.txt' },
    { name: 'CET4', file: 'CET4_edited.txt' },
    { name: 'CET6', file: 'CET6_edited.txt' },
    { name: 'TOEFL', file: 'TOEFL.txt' },
    { name: 'GRE', file: 'GRE_8000_Words.txt' },
  ]);

  const SHARED_WORDS = Object.freeze([
    { id: 9001, term: 'abandon', meaning: '[əˈbændən] v. 放弃；抛弃', phonetic: '[əˈbændən]' },
    { id: 9002, term: 'ability', meaning: '[əˈbɪləti] n. 能力；本领', phonetic: '[əˈbɪləti]' },
    { id: 9003, term: 'abrupt', meaning: '[əˈbrʌpt] adj. 突然的；唐突的', phonetic: '[əˈbrʌpt]' },
    { id: 9004, term: 'abate', meaning: "[əˈbeɪt] v. 减轻；减弱", phonetic: '[əˈbeɪt]' },
    { id: 9005, term: 'abjure', meaning: "[əbˈdʒʊə] v. 正式放弃；发誓弃绝", phonetic: '[əbˈdʒʊə]' },
    { id: 9006, term: 'accurate', meaning: '[ˈækjərət] adj. 准确的；精确的', phonetic: '[ˈækjərət]' },
  ]);

  const SCENARIOS = Object.freeze({
    'Custom / My Words': {
      totalWords: 6,
      position: 2,
      current: SHARED_WORDS[1],
      words: SHARED_WORDS,
      score: 120,
      mastery: 72,
      difficulty: 3,
      selectionReason: 'difficulty_match',
      answer: '能力；本领',
      hintDepth: 0,
      hints: [
        'a______ (n.) 能…',
        'the power or skill to do something',
        'Synonyms: skill, capacity. Her ___ impressed the team.',
      ],
    },
    'Highschool_edited.txt': {
      totalWords: 3650,
      position: 138,
      current: SHARED_WORDS[1],
      words: [SHARED_WORDS[1], SHARED_WORDS[0], SHARED_WORDS[5]],
      score: 130,
      mastery: 82,
      difficulty: 2,
      selectionReason: 'due_review',
      answer: '能力；本领',
      hintDepth: 0,
      hints: [
        'a______ (n.) 能…',
        'the power or skill to do something',
        'Synonyms: skill, capacity. Her ___ impressed the team.',
      ],
    },
    'CET4_edited.txt': {
      totalWords: 4615,
      position: 7,
      current: SHARED_WORDS[0],
      words: [SHARED_WORDS[0], SHARED_WORDS[1], SHARED_WORDS[5]],
      score: 100,
      mastery: 64,
      difficulty: 3,
      selectionReason: 'difficulty_match',
      answer: '放弃；抛弃',
      hintDepth: 0,
      hints: [
        'a______ (v.) 放…',
        'to leave or give up completely',
        'Synonyms: desert, forsake. They had to ___ the plan.',
      ],
    },
    'CET6_edited.txt': {
      totalWords: 2082,
      position: 5,
      current: SHARED_WORDS[2],
      words: [SHARED_WORDS[2], SHARED_WORDS[0], SHARED_WORDS[1]],
      score: 100,
      mastery: 58,
      difficulty: 5,
      selectionReason: 'due_review',
      answer: '突然的；唐突的',
      hintDepth: 1,
      hints: [
        'a_____ (adj.) 突…',
        'sudden and unexpected, sometimes unfriendly',
        'Synonyms: sudden, curt. The meeting came to an ___ end.',
      ],
    },
    'TOEFL.txt': {
      totalWords: 7543,
      position: 3,
      current: SHARED_WORDS[3],
      words: [SHARED_WORDS[3], SHARED_WORDS[0], SHARED_WORDS[2]],
      score: 110,
      mastery: 49,
      difficulty: 7,
      selectionReason: 'stubborn_word',
      answer: '减轻；减弱',
      hintDepth: 2,
      hints: [
        'a____ (v.) 减…',
        'to become or make less intense',
        'Synonyms: lessen, subside. The storm began to ___.',
      ],
    },
    'GRE_8000_Words.txt': {
      totalWords: 8000,
      position: 17,
      current: SHARED_WORDS[4],
      words: [SHARED_WORDS[4], SHARED_WORDS[3], SHARED_WORDS[2]],
      score: 150,
      mastery: 41,
      difficulty: 9,
      selectionReason: 'confusion_risk',
      answer: '正式放弃；发誓弃绝',
      hintDepth: 3,
      hints: [
        'a_____ (v.) 放…',
        'to formally renounce a belief or claim',
        'Synonyms: renounce, forsake. She chose to ___ the belief.',
      ],
    },
  });

  const CONFUSION_EDGES = Object.freeze([
    {
      sourceWordId: 9101,
      sourceTerm: 'affect',
      sourceMeaning: 'v. 影响；使发生变化',
      answerFingerprint: '结果效果',
      answerText: '结果；效果',
      candidateTerm: 'effect',
      candidateMeaning: 'n. 结果；效果',
      candidateConfidence: 96,
      isConfirmed: true,
      occurrenceCount: 5,
      riskScore: 92,
      averageScore: 18,
      averageResponseTimeMs: 7600,
      lastSeen: '2026-07-31 21:18',
    },
    {
      sourceWordId: 9102,
      sourceTerm: 'adapt',
      sourceMeaning: 'v. 适应；改编',
      answerFingerprint: '采用采纳',
      answerText: '采用；采纳',
      candidateTerm: 'adopt',
      candidateMeaning: 'v. 采用；采纳；收养',
      candidateConfidence: 91,
      isConfirmed: true,
      occurrenceCount: 4,
      riskScore: 84,
      averageScore: 24,
      averageResponseTimeMs: 6200,
      lastSeen: '2026-07-30 19:42',
    },
    {
      sourceWordId: 9103,
      sourceTerm: 'abrupt',
      sourceMeaning: 'adj. 突然的；唐突的',
      answerFingerprint: '抽象的',
      answerText: '抽象的',
      candidateTerm: '',
      candidateMeaning: '',
      candidateConfidence: 0,
      isConfirmed: false,
      occurrenceCount: 3,
      riskScore: 68,
      averageScore: 31,
      averageResponseTimeMs: 4900,
      lastSeen: '2026-07-28 20:06',
    },
  ]);

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function getLists() {
    return clone(LISTS);
  }

  function getScenario(listFile) {
    const key = Object.prototype.hasOwnProperty.call(SCENARIOS, listFile)
      ? listFile
      : 'CET4_edited.txt';
    return { listFile: key, ...clone(SCENARIOS[key]) };
  }

  function getConfusionMap() {
    return clone(CONFUSION_EDGES);
  }

  function getConfusionDetail(sourceWordId, answerFingerprint) {
    return getConfusionMap().find(item =>
      item.sourceWordId === sourceWordId && item.answerFingerprint === answerFingerprint
    ) || null;
  }

  root.WordWiseDemo = Object.freeze({
    defaultList: 'CET4_edited.txt',
    getLists,
    getScenario,
    getConfusionMap,
    getConfusionDetail,
  });
})(typeof window === 'undefined' ? globalThis : window);
