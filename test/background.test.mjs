import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadExtension, plain } from './helpers/load.mjs';
import { fakeBrowser, send } from './helpers/fake-browser.mjs';

const BACKGROUND = [
  'shared/constants.js',
  'shared/mapping.js',
  'shared/capture.js',
  'background/storage.js',
  'background/webapp.js',
  'background/outbox.js',
  'background/badge.js',
  'background/main.js',
];
const URL_OK = 'https://script.google.com/macros/s/' + 'x'.repeat(40) + '/exec';
const SECRET = 'test-secret-for-unit-tests';

// A pretend web app that answers like apps-script/WebApp.gs.
function fakeServer() {
  const server = { inbox: new Map(), offline: false, calls: [] };
  server.fetch = async (url, init) => {
    if (server.offline) throw new TypeError('NetworkError when attempting to fetch resource.');
    const req = JSON.parse(init.body);
    server.calls.push(req.action);
    const reply = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (req.secret !== SECRET) return reply({ ok: false, error: { code: 'auth', message: 'Wrong secret.' } });
    if (req.action === 'ping') return reply({ ok: true, data: { protocol: 1 } });
    if (req.action === 'counts') return reply({ ok: true, data: { new: server.inbox.size } });
    if (req.action === 'config') {
      return reply({
        ok: true,
        data: { fields: { platform: 'Platform', questionType: 'Question Type', difficulty: 'Difficulty' }, lists: { Platform: ['7Sage'], 'Question Type': ['Flaw'], Difficulty: ['4'] }, mapping: [] },
      });
    }
    if (req.action === 'append') {
      let added = 0;
      let duplicates = 0;
      for (const r of req.payload.rows) {
        if (server.inbox.has(r.captureId)) duplicates++;
        else {
          server.inbox.set(r.captureId, r);
          added++;
        }
      }
      return reply({ ok: true, data: { added, duplicates, newCount: server.inbox.size } });
    }
    return reply({ ok: false, error: { code: 'unknown_action', message: req.action } });
  };
  return server;
}

const result = {
  session: { platform: '7Sage', attemptKey: 'a-1', kind: 'section', timed: true, attemptDate: '2026-09-28', url: 'https://7sage.com/r/1' },
  questions: [
    { preptest: '158', section: '2', question: '14', questionType: 'Flaw', difficulty: '4', firstAnswer: 'B', correctAnswer: 'D' },
    { preptest: '158', section: '2', question: '15', questionType: 'Flaw', difficulty: '4', firstAnswer: 'C', correctAnswer: 'C', flagged: true },
    { preptest: '158', section: '2', question: '16', questionType: 'Flaw', difficulty: '4', firstAnswer: 'A', correctAnswer: 'A' },
  ],
};
const fromSite = { tab: { url: 'https://7sage.com/r/1' } };

function setup() {
  const browser = fakeBrowser();
  const server = fakeServer();
  const LMC = loadExtension(BACKGROUND, { browser, fetch: server.fetch, AbortController });
  return { browser, server, LMC };
}

async function configure(browser, patch = {}) {
  return send(browser, { type: 'save-settings', settings: { webAppUrl: URL_OK, secret: SECRET, ...patch } });
}

test('captures go to Inbox and reopening the page does not resend', async () => {
  const { browser, server } = setup();
  await configure(browser);
  const r1 = await send(browser, { type: 'capture', result }, fromSite);
  assert.equal(r1.data.status, 'sent');
  assert.equal(r1.data.message, '1 miss + 1 flagged from PT 158 S2 → Inbox');
  assert.equal(server.inbox.size, 2);
  assert.equal(browser.badge.text, '2');

  server.calls.length = 0;
  const r2 = await send(browser, { type: 'capture', result }, fromSite);
  assert.equal(r2.data.status, 'duplicate');
  assert.deepEqual(server.calls.filter((c) => c === 'append'), [], 'no network call for a known capture');
});

test('offline captures are kept and delivered later', async () => {
  const { browser, server } = setup();
  await configure(browser);
  server.offline = true;
  const r = await send(browser, { type: 'capture', result }, fromSite);
  assert.equal(r.data.status, 'queued');
  assert.match(r.data.message, /saved in the browser/);
  assert.equal(browser.data.outbox.length, 1);
  assert.equal(browser.badge.text, '2', 'unsent rows count toward the badge');
  assert.ok(browser.alarmsMap.has('outbox-retry'));

  server.offline = false;
  await send(browser, { type: 'flush' });
  assert.equal(server.inbox.size, 2);
  assert.equal(browser.data.outbox.length, 0);
  assert.ok(!browser.alarmsMap.has('outbox-retry'));
});

test('a wrong secret parks the capture until settings are fixed', async () => {
  const { browser, server } = setup();
  await configure(browser, { secret: 'wrong-test-secret' });
  const r = await send(browser, { type: 'capture', result }, fromSite);
  assert.equal(r.data.status, 'queued');
  assert.equal(browser.data.outbox[0].state, 'failed');
  assert.equal(browser.data.outbox[0].lastErrorCode, 'auth');

  await configure(browser); // correct secret: failed items are requeued and sent
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(server.inbox.size, 2);
  assert.equal(browser.data.outbox.length, 0);
});

test('dry run shows what would be sent without sending', async () => {
  const { browser, server } = setup();
  await configure(browser, { dryRun: true });
  const r = await send(browser, { type: 'capture', result }, fromSite);
  assert.equal(r.data.status, 'dry-run');
  assert.equal(r.data.message, 'Dry run: 1 miss + 1 flagged from PT 158 S2 (nothing sent)');
  assert.equal(server.inbox.size, 0);
  assert.equal((browser.data.outbox || []).length, 0);
  const preview = plain(browser.data.lastCapture.rows);
  assert.deepEqual(preview.map((x) => x.question), ['14', '15']);
  assert.equal(preview[0].questionType, 'Flaw');
});

test('captures from the wrong site or with junk are rejected', async () => {
  const { browser } = setup();
  await configure(browser);
  const wrong = await send(browser, { type: 'capture', result }, { tab: { url: 'https://evil.example/' } });
  assert.equal(wrong.ok, false);
  const junk = await send(browser, { type: 'capture', result: { questions: 'x' } }, fromSite);
  assert.equal(junk.ok, false);
});

test('messages from other extensions are ignored', async () => {
  const { browser } = setup();
  const [listener] = browser.listeners.message;
  assert.equal(listener({ type: 'status' }, { id: 'someone-else' }), undefined);
});

test('rejects the /dev URL and non-script URLs', () => {
  const { LMC } = setup();
  assert.match(LMC.webapp.checkUrl(URL_OK.replace('/exec', '/dev')), /\/dev/);
  assert.match(LMC.webapp.checkUrl('https://example.com/exec'), /Expected/);
  assert.equal(LMC.webapp.checkUrl(URL_OK), '');
});
