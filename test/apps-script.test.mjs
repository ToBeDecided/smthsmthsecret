import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appsScript } from './helpers/apps-script.mjs';
import { loadExtension } from './helpers/load.mjs';
import { fakeBrowser, send } from './helpers/fake-browser.mjs';

const LISTS = [
  ['Platform', 'Question Type', 'Difficulty', 'Error Category'],
  ['7Sage', 'Flaw', '1', 'Misread stem'],
  ['LSAT Demon', 'MSS', '2', 'Trap answer'],
  ['', 'Necessary Assumption', '3', ''],
];
const MAPPING = [
  ['Field', 'Platform', 'Site value', 'Journal value', 'Notes'],
  ['Question Type', '', 'Most Strongly Supported', 'MSS', ''],
];

const row = (n, extra = {}) => ({
  captureId: `7S-PT158-S2-Q${n}-abcd1234`,
  capturedAt: '2026-09-28T15:00:00.000Z',
  platform: '7Sage',
  preptest: '158',
  section: '2',
  question: String(n),
  questionType: 'Flaw',
  difficulty: '3',
  timed: true,
  firstAnswer: 'B',
  correctAnswer: 'D',
  brAnswer: '',
  flagged: false,
  timeSpentSec: 83,
  attemptDate: '2026-09-28',
  reason: 'Miss',
  needsReview: '',
  session: 'PT 158 S2',
  sessionKey: 'attempt-1',
  link: 'https://7sage.com/q/14',
  ...extra,
});

function env(opts) {
  const a = appsScript({ sheets: { Lists: LISTS, Mapping: MAPPING }, ...opts });
  a.call = (action, payload) => a.post({ v: 1, secret: a.secret, action, payload });
  return a;
}

test('rejects requests without the right secret', () => {
  const a = env();
  assert.equal(a.post({ action: 'counts' }).error.code, 'auth');
  assert.equal(a.post({ action: 'counts', secret: 'nope' }).error.code, 'auth');
  assert.equal(a.post('not json').error.code, 'bad_request');
  const none = appsScript({ secret: null });
  assert.match(none.post({ action: 'counts', secret: '' }).error.message, /no secret yet/);
});

test('doGet is a health check that reveals nothing', () => {
  const a = env();
  const body = JSON.parse(a.ctx.doGet().getContent());
  assert.deepEqual(body, { ok: true, data: { app: 'lsat-miss-capture', protocol: 1 } });
});

test('append creates the Inbox tab and dedupes on capture ID', () => {
  const a = env();
  const r1 = a.call('append', { rows: [row(14), row(15)] });
  assert.deepEqual(r1, { ok: true, data: { added: 2, duplicates: 0, newCount: 2 } });
  const r2 = a.call('append', { rows: [row(14), row(16)] });
  assert.deepEqual(r2.data, { added: 1, duplicates: 1, newCount: 3 });

  const inbox = a.book.get('Inbox').records();
  assert.equal(inbox.length, 3);
  assert.equal(inbox[0]['Capture ID'], '7S-PT158-S2-Q14-abcd1234');
  assert.equal(inbox[0].Status, 'New');
  assert.equal(inbox[0]['Q#'], '14');
  assert.equal(inbox[0]['Time (s)'], 83);
  assert.equal(inbox[0].Timed, true);
  assert.ok(inbox[0].Captured instanceof Date);
  assert.equal(inbox[0].Link, 'https://7sage.com/q/14');
});

test('page text can never become a formula', () => {
  const a = env();
  a.call('append', { rows: [row(1, { questionType: '=IMPORTXML("http://x","//a")', needsReview: '+1', session: '@me' })] });
  const sheet = a.book.get('Inbox');
  assert.equal(sheet.formulas || 0, 0);
  const [rec] = sheet.records();
  assert.equal(rec['Question type'], `'=IMPORTXML("http://x","//a")`);
});

test('rejects malformed rows', () => {
  const a = env();
  assert.equal(a.call('append', { rows: 'x' }).error.code, 'bad_request');
  assert.equal(a.call('append', { rows: [row(1, { captureId: 'bad id with spaces' })] }).error.code, 'bad_request');
  assert.equal(a.call('nope', {}).error.code, 'unknown_action');
});

test('finds Inbox columns by header after you rearrange them', () => {
  const a = env();
  a.call('append', { rows: [row(1)] });
  const sheet = a.book.get('Inbox');
  // Move "Status" to the far right and add a column of your own in its place.
  const head = sheet.data[0];
  const s = head.indexOf('Status');
  for (const line of sheet.data) {
    const [v] = line.splice(s, 1, line === head ? 'My column' : 'mine');
    line.push(v);
  }
  a.call('append', { rows: [row(2)] });
  const recs = sheet.records();
  assert.equal(recs[1].Status, 'New');
  assert.equal(recs[1]['My column'], '');
  assert.equal(a.call('counts').data.new, 2);
});

test('config returns Lists and Mapping', () => {
  const a = env();
  const { data } = a.call('config');
  assert.deepEqual(data.lists['Question Type'], ['Flaw', 'MSS', 'Necessary Assumption']);
  assert.deepEqual(data.lists.Platform, ['7Sage', 'LSAT Demon']);
  assert.deepEqual(data.mapping, [{ field: 'Question Type', platform: '', from: 'Most Strongly Supported', to: 'MSS' }]);
  assert.equal(data.fields.questionType, 'Question Type');
});

test('quick note and skip update the Inbox row', () => {
  const a = env();
  a.call('append', { rows: [row(1), row(2)] });
  assert.equal(a.call('setStatus', { captureId: row(1).captureId, status: 'Quick note', quickNote: 'Shifted scope: "some" vs "most"' }).data.newCount, 1);
  assert.equal(a.call('setStatus', { captureId: row(2).captureId, status: 'Skipped' }).data.newCount, 0);
  assert.equal(a.call('setStatus', { captureId: row(2).captureId, status: 'Logged' }).error.code, 'bad_request');
  assert.equal(a.call('setStatus', { captureId: row(1).captureId, status: 'Quick note', quickNote: ' ' }).error.code, 'bad_request');
  assert.equal(a.call('setStatus', { captureId: 'XX-nope-1', status: 'Skipped' }).error.code, 'not_found');
  const recs = a.book.get('Inbox').records();
  assert.equal(recs[0]['Quick note'], 'Shifted scope: "some" vs "most"');
  assert.equal(recs[1].Status, 'Skipped');
  assert.deepEqual(a.call('listNew', {}).data.items, []);
});

test('setup creates tabs and a secret once', () => {
  const a = appsScript({ secret: null, sheets: { Lists: LISTS } });
  a.ctx.lmcSetUpCapture();
  const first = a.props.get('LMC_SECRET');
  assert.ok(first.length >= 40);
  assert.ok(a.book.get('Inbox') && a.book.get('Mapping'));
  a.ctx.lmcSetUpCapture();
  assert.equal(a.props.get('LMC_SECRET'), first, 'setup does not rotate an existing secret');
});

test('end to end: the extension captures a page into the Inbox tab', async () => {
  const a = env();
  const browser = fakeBrowser();
  loadExtension(
    ['shared/constants.js', 'shared/mapping.js', 'shared/capture.js', 'background/storage.js', 'background/webapp.js', 'background/outbox.js', 'background/badge.js', 'background/main.js'],
    { browser, fetch: a.fetch, AbortController },
  );
  await send(browser, { type: 'save-settings', settings: { webAppUrl: 'https://script.google.com/macros/s/' + 'x'.repeat(40) + '/exec', secret: a.secret } });
  const result = {
    session: { platform: '7Sage', attemptKey: 'a-9', kind: 'drill', timed: false, attemptDate: '2026-09-30', url: 'https://7sage.com/r/9' },
    questions: [
      { preptest: '101', section: '3', question: '7', questionType: 'Most Strongly Supported', difficulty: '2', firstAnswer: 'A', correctAnswer: 'C' },
      { preptest: '101', section: '3', question: '8', questionType: 'Weird New Type', difficulty: '3', firstAnswer: 'B', correctAnswer: 'B', flagged: true },
      { preptest: '101', section: '3', question: '9', questionType: 'Flaw', difficulty: '3', firstAnswer: 'B', correctAnswer: 'B' },
    ],
  };
  const res = await send(browser, { type: 'capture', result }, { tab: { url: 'https://7sage.com/r/9' } });
  assert.equal(res.data.message, '1 miss + 1 flagged from PT 101 S3 → Inbox');
  const recs = a.book.get('Inbox').records();
  assert.equal(recs.length, 2);
  assert.equal(recs[0]['Question type'], 'MSS', 'mapped through the Mapping tab');
  assert.equal(recs[1]['Question type'], 'Weird New Type', 'unmapped passes through');
  assert.equal(recs[1]['Needs review'], 'Unmapped Question type: Weird New Type');
  assert.equal(recs[1]['Why captured'], 'Flagged (right)');
  assert.equal(browser.badge.text, '2');

  const again = await send(browser, { type: 'capture', result }, { tab: { url: 'https://7sage.com/r/9' } });
  assert.equal(again.data.status, 'duplicate');
  assert.equal(a.book.get('Inbox').records().length, 2);
});
