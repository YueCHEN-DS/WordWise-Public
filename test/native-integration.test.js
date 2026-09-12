import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fileName = process.platform === 'win32'
  ? 'vocab_core.win32.node'
  : 'vocab_core.mac.node';
const modulePath = path.resolve(__dirname, '..', 'vocab-core', fileName);

test('native module records and exposes a repeated confusion', {
  skip: !fs.existsSync(modulePath) && `native module not built: ${fileName}`,
}, () => {
  const core = require(modulePath);
  const dbPath = path.join(os.tmpdir(), `wordwise-native-${process.pid}-${Date.now()}.db`);

  core.setupDb(dbPath);
  const source = core.addWord('abandon', '放弃；抛弃');
  core.addWord('indulge', '放纵');
  const candidate = core.getAnswerCandidate(source.id, '放纵');
  assert.equal(candidate.term, 'indulge');
  assert.equal(core.getConfusionMap(10).length, 0);
  const first = core.recordSemanticScore(source.id, 10, 18_000, '放纵');
  const second = core.recordSemanticScore(source.id, 20, 21_000, '放纵');

  assert.equal(first.confusionUpdate.isVisible, false);
  assert.equal(second.confusionUpdate.isVisible, true);
  assert.equal(second.confusionUpdate.candidateTerm, 'indulge');
  assert.equal(first.rewardEligible, true);
  assert.equal(first.mistakeId, second.mistakeId);

  const queueStatus = core.getMistakeQueueStatus();
  assert.equal(queueStatus.dueCount, 1);
  assert.equal(queueStatus.unresolvedCount, 1);
  const mistake = core.getNextMistake(null);
  assert.equal(mistake.mistakeId, second.mistakeId);
  assert.equal(mistake.answerText, '放纵');
  assert.equal(core.getNextMistake(mistake.mistakeId), null);

  const reviewWrong = core.recordSemanticScore(
    source.id, 25, 5000, '放纵', 'mistake_review', mistake.mistakeId,
  );
  assert.equal(reviewWrong.rewardEligible, false);
  assert.equal(core.getMistakeQueueStatus().dueCount, 0);
  const reviewCorrect = core.recordSemanticScore(
    source.id, 90, 1200, '放弃', 'mistake_review', mistake.mistakeId,
  );
  assert.equal(reviewCorrect.rewardEligible, false);
  assert.equal(reviewCorrect.mistakeResolved, true);
  assert.equal(core.getMistakeQueueStatus().unresolvedCount, 0);

  const signal = core.getConfusionSignal(source.id, ' 放纵！');
  assert.equal(signal.occurrenceCount, 3);
  assert.equal(signal.candidateTerm, 'indulge');
  assert.equal(signal.isConfirmed, true);

  const edges = core.getConfusionMap(10);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].sourceTerm, 'abandon');
  assert.equal(edges[0].occurrenceCount, 3);
  assert.equal(edges[0].isConfirmed, true);

  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {}
  }
});
