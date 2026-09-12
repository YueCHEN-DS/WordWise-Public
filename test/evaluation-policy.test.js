import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluationPathLabel,
  evaluationPaths,
  firstEvaluationPath,
  gateLowModelDecision,
  isExactMeaning,
  isLookAlikeWord,
  makeLevelOneHint,
  meaningAlternatives,
  needsBoundaryReview,
} from '../evaluation-policy.js';

test('meaning alternatives keep complete meanings separate', () => {
  assert.deepEqual(
    meaningAlternatives('v. 1. 抛弃，放弃 2. 离弃；遗弃'),
    ['抛弃', '放弃', '离弃', '遗弃']
  );
  assert.equal(isExactMeaning('放弃', 'v. 抛弃；放弃'), true);
  assert.equal(isExactMeaning('放', 'v. 放弃；抛弃'), false);
  assert.equal(isExactMeaning('弃抛', 'v. 放弃；抛弃'), false);
});

test('evaluation routing uses the cheapest safe path', () => {
  const cached = { score: 80, reasonCode: 'synonym', confidence: 90 };
  assert.equal(firstEvaluationPath('放弃', 'v. 放弃；抛弃', null), evaluationPaths.literal);
  assert.equal(firstEvaluationPath('舍弃', 'v. 放弃；抛弃', cached), evaluationPaths.cached);
  assert.equal(firstEvaluationPath('舍弃', 'v. 放弃；抛弃', null), evaluationPaths.compact);
  assert.equal(evaluationPathLabel(evaluationPaths.review), '边界语义复核');
});

test('boundary review is limited to uncertain decisions', () => {
  assert.equal(needsBoundaryReview({ score: 62, confidence: 90 }), true);
  assert.equal(needsBoundaryReview({ score: 85, confidence: 60 }), true);
  assert.equal(needsBoundaryReview({ score: 85, confidence: 90 }), false);
  assert.equal(needsBoundaryReview(
    { score: 96, confidence: 90, reasonCode: 'synonym' },
    { isConfirmed: true, riskScore: 78 }
  ), true);
});

test('level one hints use stored word data without inference', () => {
  assert.equal(makeLevelOneHint('abandon', 'v. 放弃；抛弃'), 'a______ (v.) 放…');
  assert.equal(makeLevelOneHint('abandon', '(释义待补充)'), null);
  assert.equal(makeLevelOneHint('abandon', '放弃'), null);
});

test('low-compute decisions require conservative quality gates', () => {
  assert.deepEqual(
    gateLowModelDecision({ score: 98, reasonCode: 'synonym', confidence: 90 }),
    { accepted: false, needsVerification: true, reason: 'verification_required' }
  );
  assert.equal(gateLowModelDecision(
    { score: 98, reasonCode: 'synonym', confidence: 90 },
    { relation: 'same', confidence: 90 }
  ).accepted, true);
  assert.equal(gateLowModelDecision(
    { score: 98, reasonCode: 'synonym', confidence: 90 },
    { relation: 'opposite', confidence: 90 }
  ).accepted, false);
  assert.equal(gateLowModelDecision(
    { score: 15, reasonCode: 'antonym', confidence: 90 }
  ).accepted, true);
  assert.equal(gateLowModelDecision(
    { score: 45, reasonCode: 'related', confidence: 90 }
  ).accepted, false);
  assert.equal(gateLowModelDecision(
    { score: 15, reasonCode: 'unrelated', confidence: 65 }
  ).accepted, false);
});

test('look-alike matching is narrow enough for local confusion checks', () => {
  assert.equal(isLookAlikeWord('affect', 'effect'), true);
  assert.equal(isLookAlikeWord('economic', 'economical'), true);
  assert.equal(isLookAlikeWord('principal', 'principle'), true);
  assert.equal(isLookAlikeWord('accept', 'except'), true);
  assert.equal(isLookAlikeWord('quiet', 'quite'), true);
  assert.equal(isLookAlikeWord('abandon', 'discard'), false);
  assert.equal(isLookAlikeWord('word', 'word'), false);
});
