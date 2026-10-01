import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadExtension, plain } from './helpers/load.mjs';

const LMC = loadExtension(['shared/constants.js', 'shared/mapping.js', 'shared/capture.js']);

const config = {
  fields: { platform: 'Platform', questionType: 'Question Type', difficulty: 'Difficulty' },
  lists: {
    Platform: ['7Sage', 'LSAT Demon'],
    'Question Type': ['Flaw', 'MSS', 'Necessary Assumption'],
    Difficulty: ['1', '2', '3', '4', '5'],
  },
  mapping: [
    { field: 'Question Type', platform: '', from: 'Most Strongly Supported', to: 'MSS' },
    { field: 'Question Type', platform: '7Sage', from: 'NA', to: 'Necessary Assumption' },
  ],
};

const session = {
  platform: '7Sage',
  attemptKey: 'attempt-1',
  kind: 'section',
  timed: true,
  attemptDate: '2026-09-28',
  url: 'https://7sage.com/x',
};
const q = (n, extra) => ({ preptest: 158, section: 2, question: n, questionType: 'Flaw', difficulty: 4, ...extra });

test('selects misses, flagged-right, and right→wrong in blind review', () => {
  const r = LMC.capture.reasonsFor;
  assert.deepEqual(plain(r(q(1, { firstAnswer: 'B', correctAnswer: 'D' }))), ['miss']);
  assert.deepEqual(plain(r(q(2, { firstAnswer: '', correctAnswer: 'D' }))), ['miss'], 'unanswered is a miss');
  assert.deepEqual(plain(r(q(3, { firstAnswer: 'D', correctAnswer: 'D', flagged: true }))), ['flagged']);
  assert.deepEqual(plain(r(q(4, { firstAnswer: 'D', correctAnswer: 'D', brAnswer: 'A' }))), ['br-changed']);
  assert.deepEqual(plain(r(q(5, { firstAnswer: 'D', correctAnswer: 'D', brAnswer: 'A', flagged: true }))), ['br-changed', 'flagged']);
  assert.deepEqual(plain(r(q(6, { firstAnswer: 'D', correctAnswer: 'D' }))), []);
  assert.deepEqual(plain(r(q(7, { firstAnswer: '(d)', correctAnswer: 'D' }))), []);
  assert.deepEqual(plain(r(q(8, { firstAnswer: 'B' }))), [], 'no answer key, no judgement');
});

test('capture IDs are stable per attempt and differ across attempts', async () => {
  const a = await LMC.capture.captureId('7Sage', 'attempt-1', q(14));
  const b = await LMC.capture.captureId('7Sage', 'attempt-1', q(14));
  const c = await LMC.capture.captureId('7Sage', 'attempt-2', q(14));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^7S-PT158-S2-Q14-[0-9a-f]{8}$/);
});

test('builds Inbox rows with mapped values and a summary', async () => {
  const result = {
    session,
    questions: [
      q(1, { firstAnswer: 'B', correctAnswer: 'D', timeSpentSec: 83.4 }),
      q(2, { firstAnswer: 'A', correctAnswer: 'A' }),
      q(3, { firstAnswer: 'C', correctAnswer: 'C', flagged: true, questionType: 'Most Strongly Supported' }),
      q(4, { firstAnswer: 'E', correctAnswer: 'A', questionType: 'NA', difficulty: 5 }),
      q(5, { firstAnswer: 'E', correctAnswer: 'A', questionType: 'Principle (Apply)' }),
    ],
  };
  const { rows, summary } = await LMC.capture.buildRows(result, config, new Date('2026-09-28T15:00:00Z'));
  assert.equal(rows.length, 4);
  assert.equal(summary, '3 misses + 1 flagged from PT 158 S2');
  const [r1, r3, r4, r5] = rows;
  assert.equal(r1.platform, '7Sage');
  assert.equal(r1.questionType, 'Flaw');
  assert.equal(r1.difficulty, '4');
  assert.equal(r1.timeSpentSec, 83);
  assert.equal(r1.timed, true);
  assert.equal(r1.reason, 'Miss');
  assert.equal(r1.needsReview, '');
  assert.equal(r3.questionType, 'MSS');
  assert.equal(r3.reason, 'Flagged (right)');
  assert.equal(r4.questionType, 'Necessary Assumption');
  assert.equal(r5.questionType, 'Principle (Apply)', 'unmapped values pass through as-is');
  assert.equal(r5.needsReview, 'Unmapped Question type: Principle (Apply)');
});

test('without sheet config, values pass through and are flagged', async () => {
  const { rows } = await LMC.capture.buildRows({ session, questions: [q(1, { firstAnswer: 'B', correctAnswer: 'D' })] }, null);
  assert.equal(rows[0].questionType, 'Flaw');
  assert.match(rows[0].needsReview, /not checked \(sheet lists not loaded\)/);
});

test('mapping prefers platform-specific rows and warns on values missing from Lists', () => {
  const flags = [];
  const cfg = { ...config, mapping: [...config.mapping, { field: 'Question Type', platform: 'LSAT Demon', from: 'NA', to: 'Nec. Assumption' }] };
  assert.equal(LMC.mapping.mapValue('questionType', 'NA', 'LSAT Demon', cfg, flags), 'Nec. Assumption');
  assert.match(flags[0], /not in Lists/);
  assert.equal(LMC.mapping.mapValue('questionType', '  flaw ', '7Sage', cfg, []), 'Flaw');
});
