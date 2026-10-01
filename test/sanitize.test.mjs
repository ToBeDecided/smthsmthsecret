import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Sanitizer } from '../scripts/lib/sanitize.mjs';

// Everything personal or licensed here is invented. Tokens are assembled at
// runtime so this file passes the secret scan itself.
const NAME = 'Jordan Testperson';
const EMAIL = 'jordan.testperson@mailbox.test';
const STEM = 'The columnist concludes that the new bridge will reduce commuting times across the region.';
const CHOICE_B = 'It assumes that what is true of the whole must be true of each part.';
const CSRF = 'k3J9' + 'x'.repeat(10) + 'Q7pLm2' + 'Zr8'.repeat(6);
const USER_ID = 98765432;
const ATTEMPT = '3f2c9a1e-7b4d-4c2e-9f10-6a5b4c3d2e1f';

const state = {
  props: {
    pageProps: {
      user: { id: USER_ID, name: NAME, email: EMAIL, plan: 'PREMIUM' },
      attempt: {
        id: ATTEMPT,
        startedAt: '2026-09-28T14:03:11Z',
        timed: true,
        questions: [
          {
            id: 456789,
            number: 14,
            questionType: { name: 'Flaw', displayName: 'Flaw' },
            difficulty: 4,
            stem: STEM,
            choices: [{ letter: 'A', text: 'Nope.' }, { letter: 'B', text: CHOICE_B }],
            selected: 'B',
            correct: 'D',
            flagged: true,
            timeSpentMs: 83000,
          },
        ],
      },
    },
  },
};

const html = `<!doctype html><html><head>
<title>PrepTest 158 Section 2 Results | 7Sage</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csrf-token" content="${CSRF}">
<script>window.intercomSettings = {"app_id":"abc","email":"${EMAIL}","name":"${NAME}"};</script>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(state)}</script>
<style>.x{color:red}</style>
</head><body>
<!-- build 2026-09-28 by ${EMAIL} -->
<nav><span class="user-name">Hi, ${NAME}</span><img src="https://www.gravatar.com/avatar/0a1b2c3d4e5f60718293a4b5c6d7e8f9?s=40" alt="${NAME}"></nav>
<main data-attempt-id="${ATTEMPT}" data-user-id="${USER_ID}">
  <h1>PrepTest 158 · Section 2</h1>
  <form><input type="hidden" name="csrfmiddlewaretoken" value="${CSRF}"></form>
  <table class="results">
    <tr class="row incorrect" data-q="14">
      <td class="qnum">14</td><td class="qtype">Flaw</td><td class="diff">4</td>
      <td class="your">B</td><td class="correct">D</td><td class="time">1:23</td>
      <td class="flag" aria-label="Flagged">⚑</td>
      <td><a href="/lsat/review/${ATTEMPT}/question/14?user=${USER_ID}">Review</a></td>
    </tr>
  </table>
  <div class="stem">${STEM}</div>
  <ol class="choices"><li>(A) Nope.</li><li>(B) ${CHOICE_B}</li></ol>
  <svg viewBox="0 0 24 24"><path d="M12 2L2 22h20L12 2z"/></svg>
</main></body></html>`;

function run(extra = {}) {
  const s = new Sanitizer({ redactTerms: ['Testperson'], ...extra });
  return { s, ...s.sanitizeHtml(html) };
}

test('removes licensed text and personal details', () => {
  const { text, findings } = run();
  assert.deepEqual(findings, []);
  for (const leak of [STEM, CHOICE_B, NAME, 'Jordan', 'Testperson', EMAIL, CSRF, String(USER_ID), ATTEMPT, '0a1b2c3d4e5f60718293a4b5c6d7e8f9']) {
    assert.ok(!text.includes(leak), `leaked: ${leak}`);
  }
  assert.ok(!text.includes('mailbox.test'));
  assert.ok(!text.includes('.x{color:red}'), 'style bodies dropped');
  assert.ok(!text.includes('build 2026-09-28'), 'comments dropped');
});

test('keeps the metadata parsers need', () => {
  const { text } = run();
  const doc = new JSDOM(text).window.document;
  assert.equal(doc.title, 'PrepTest 158 Section 2 Results | 7Sage');
  assert.equal(doc.querySelector('h1').textContent, 'PrepTest 158 · Section 2');
  const row = doc.querySelector('tr.row.incorrect');
  assert.equal(row.querySelector('.qnum').textContent, '14');
  assert.equal(row.querySelector('.qtype').textContent, 'Flaw');
  assert.equal(row.querySelector('.your').textContent, 'B');
  assert.equal(row.querySelector('.correct').textContent, 'D');
  assert.equal(row.querySelector('.time').textContent, '1:23');
  assert.equal(row.querySelector('.flag').getAttribute('aria-label'), 'Flagged');
  assert.equal(doc.querySelector('meta[name=viewport]').content, 'width=device-width, initial-scale=1');
  assert.equal(doc.querySelector('svg path').getAttribute('d'), 'M12 2L2 22h20L12 2z');
});

test('keeps embedded JSON shape, swaps IDs consistently', () => {
  const { text } = run();
  const doc = new JSDOM(text).window.document;
  const data = JSON.parse(doc.getElementById('__NEXT_DATA__').textContent);
  const { user, attempt } = data.props.pageProps;
  assert.deepEqual(Object.keys(user), ['id', 'name', 'email', 'plan']);
  assert.notEqual(user.id, USER_ID);
  assert.equal(String(user.id).length, String(USER_ID).length);
  assert.equal(user.email, 'user@example.com');
  assert.equal(user.name, 'REDACTED');

  const q = attempt.questions[0];
  assert.equal(q.number, 14);
  assert.equal(q.questionType.name, 'Flaw');
  assert.equal(q.questionType.displayName, 'Flaw');
  assert.equal(q.difficulty, 4);
  assert.equal(q.stem, 'REDACTED');
  assert.equal(q.choices[0].letter, 'A');
  assert.equal(q.choices[1].letter, 'B');
  assert.equal(q.choices[1].text, 'REDACTED');
  assert.equal(q.selected, 'B');
  assert.equal(q.correct, 'D');
  assert.equal(q.flagged, true);
  assert.equal(q.timeSpentMs, 83000);
  assert.equal(attempt.startedAt, '2026-09-28T14:03:11Z');
  assert.equal(attempt.timed, true);

  // The attempt UUID in JSON, the data attribute, and the review link all map to one fake.
  assert.match(attempt.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(doc.querySelector('main').dataset.attemptId, attempt.id);
  const href = doc.querySelector('tr.row a').getAttribute('href');
  assert.ok(href.startsWith(`/lsat/review/${attempt.id}/question/14?user=`), href);
  assert.equal(doc.querySelector('main').dataset.userId, new URL(href, 'https://x.test').searchParams.get('user'));
});

test('secrets become REDACTED rather than look-alike fakes', () => {
  const { text } = run();
  const doc = new JSDOM(text).window.document;
  assert.equal(doc.querySelector('meta[name=csrf-token]').content, 'REDACTED');
  assert.equal(doc.querySelector('input[type=hidden]').value, 'REDACTED');
  assert.match(doc.querySelectorAll('script')[0].textContent, /"email": "user@example.com"/);
});

test('is deterministic', () => {
  assert.equal(run().text, run().text);
});

test('redact.txt terms are removed even inside allowed text', () => {
  const s = new Sanitizer({ redactTerms: ['Mark'] });
  const { text } = s.sanitizeHtml('<p>Mark</p><p>Flaw</p>');
  assert.ok(!text.includes('Mark'));
  assert.ok(text.includes('Flaw'));
});

test('text allowlist', () => {
  const s = new Sanitizer();
  for (const ok of ['Flaw', 'Necessary Assumption', 'Your answer: (C)', 'Q14', 'PT 158 S2', '1m 23s', 'Oct 1, 2026', '80%', 'Most Strongly Supported']) {
    assert.ok(s.isAllowedText(ok), ok);
  }
  for (const bad of [STEM, 'Hi, Jordan', 'Which one of the following most accurately expresses the conclusion?', '李明']) {
    assert.ok(!s.isAllowedText(bad), bad);
  }
});

test('flags redacted text that survives somewhere else', () => {
  const s = new Sanitizer();
  s.redact(STEM);
  const { findings } = s.finalPass(`<p data-x="${STEM}"></p>`);
  assert.equal(findings.length, 1);
});
