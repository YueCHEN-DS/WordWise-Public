import { normalizeMeaning } from './scoring.js';

export const evaluationPaths = Object.freeze({
  literal: 'literal_fast_path',
  cached: 'cached_semantic_result',
  compact: 'compact_semantic_eval',
  review: 'boundary_semantic_review',
  lowVerify: 'low_compute_quality_gate',
});

const pathLabels = Object.freeze({
  [evaluationPaths.literal]: '本地快速判定',
  [evaluationPaths.cached]: '复用已验证结果',
  [evaluationPaths.compact]: '紧凑语义评估',
  [evaluationPaths.review]: '边界语义复核',
  [evaluationPaths.lowVerify]: '低算力质量复核',
});

const positiveReasons = new Set(['exact', 'synonym', 'partial']);
const safeNegativeReasons = new Set(['wrong_sense', 'antonym', 'unrelated']);

export function meaningAlternatives(meaning) {
  if (!meaning || meaning.includes('(释义待补充)')) return [];

  return String(meaning)
    .replace(/(?:^|\s)\d+[.)、]\s*/g, '；')
    .split(/[；;，,、/]/)
    .map(part => normalizeMeaning(part))
    .filter(part => Array.from(part).length >= 2);
}

export function isExactMeaning(answer, meaning) {
  const normalized = normalizeMeaning(answer);
  if (Array.from(normalized).length < 2) return false;
  return meaningAlternatives(meaning).includes(normalized);
}

export function isLookAlikeWord(source, candidate) {
  const left = String(source || '').trim().toLowerCase();
  const right = String(candidate || '').trim().toLowerCase();
  if (!/^[a-z]+$/.test(left) || !/^[a-z]+$/.test(right) || left === right) return false;
  if (isSingleSwap(left, right)) return true;
  const distance = editDistance(left, right);
  return distance <= 2 && 1 - distance / Math.max(left.length, right.length) >= 0.65;
}

export function firstEvaluationPath(answer, meaning, cachedDecision) {
  if (isExactMeaning(answer, meaning)) return evaluationPaths.literal;
  if (cachedDecision) return evaluationPaths.cached;
  return evaluationPaths.compact;
}

export function needsBoundaryReview(decision, confusionSignal = null) {
  if (!decision) return false;
  const uncertain = decision.confidence < 65 || (decision.score >= 55 && decision.score <= 70);
  const contradictsRepeatedError = Boolean(confusionSignal?.isConfirmed &&
    confusionSignal.riskScore >= 60 &&
    (decision.reasonCode === 'exact' || decision.reasonCode === 'synonym'));
  return uncertain || contradictsRepeatedError;
}

export function gateLowModelDecision(decision, verification = null) {
  if (!decision || decision.confidence < 90) {
    return { accepted: false, needsVerification: false, reason: 'low_confidence' };
  }
  if (safeNegativeReasons.has(decision.reasonCode) && decision.score <= 29) {
    return { accepted: true, needsVerification: false, reason: 'safe_negative' };
  }
  if (positiveReasons.has(decision.reasonCode) && decision.score >= 60) {
    if (!verification) {
      return { accepted: false, needsVerification: true, reason: 'verification_required' };
    }
    const accepted = verification.relation === 'same' && verification.confidence >= 90;
    return {
      accepted,
      needsVerification: false,
      reason: accepted ? 'verified_positive' : 'contradiction_or_uncertain',
    };
  }
  return { accepted: false, needsVerification: false, reason: 'unsafe_relation' };
}

export function evaluationPathLabel(path) {
  return pathLabels[path] || '语义评估';
}

export function makeLevelOneHint(word, meaning) {
  const term = String(word || '').trim();
  const definition = String(meaning || '');
  if (!term || !definition || definition.includes('(释义待补充)')) return null;

  const pos = definition.match(/(?:^|\s)(n|v|vt|vi|adj|adv|prep|conj|art)\./i)?.[1];
  const firstChinese = definition.match(/[\u3400-\u9fff]/u)?.[0];
  if (!pos || !firstChinese) return null;

  const shape = Array.from(term)
    .map((char, index) => index === 0 || !/[a-z]/i.test(char) ? char : '_')
    .join('');
  return `${shape} (${pos.toLowerCase()}.) ${firstChinese}…`;
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function isSingleSwap(left, right) {
  if (left.length !== right.length) return false;
  const changed = [];
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) changed.push(index);
  }
  return changed.length === 2 &&
    changed[1] === changed[0] + 1 &&
    left[changed[0]] === right[changed[1]] &&
    left[changed[1]] === right[changed[0]];
}
