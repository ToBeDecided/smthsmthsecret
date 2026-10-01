'use strict';
(function (LMC) {
  const { el, ask, ago } = LMC.ui;
  const { MSG } = LMC;
  const $ = (id) => document.getElementById(id);
  let missing = [];

  function renderAccess(status) {
    missing = status.missingOrigins;
    const list = $('origins');
    list.replaceChildren(
      ...[...LMC.SITE_ORIGINS, ...LMC.WEB_APP_ORIGINS].map((o) => {
        const okay = !missing.includes(o);
        const why = LMC.WEB_APP_ORIGINS.includes(o) ? 'send captures to your web app' : 'read results pages';
        return el('li', {}, el('span', { className: okay ? 'ok' : 'bad' }, okay ? '✓ ' : '✗ '), o, el('span', { className: 'muted' }, ` — ${why}`));
      }),
    );
    $('access-missing').classList.toggle('hidden', missing.length === 0);
    $('access-ok').classList.toggle('hidden', missing.length > 0);
  }

  function renderWebApp(status) {
    if (document.activeElement !== $('url')) $('url').value = status.settings.webAppUrl || '';
    $('secret').placeholder = status.settings.hasSecret ? '•••••••• (saved)' : 'Paste the secret';
    $('url-problem').textContent = status.settings.webAppUrl ? status.urlProblem : '';
    $('dry-run').checked = status.settings.dryRun;
  }

  function renderOutbox(status) {
    const body = $('outbox').tBodies[0];
    body.replaceChildren(
      ...status.outbox.map((it) => {
        const retry = el('button', { type: 'button', textContent: 'Retry' });
        retry.addEventListener('click', () => act(MSG.OUTBOX_RETRY, { id: it.id }));
        const del = el('button', { type: 'button', textContent: 'Delete' });
        del.addEventListener('click', () => {
          if (confirm(`"${it.summary}" has not reached the sheet. Delete it from this browser anyway?`)) act(MSG.OUTBOX_DELETE, { id: it.id });
        });
        const state = it.state === 'failed' ? el('span', { className: 'bad' }, 'needs you') : el('span', { className: 'warn' }, `retrying (${it.attempts})`);
        return el('tr', {}, el('td', {}, it.summary, el('br'), el('small', {}, ago(it.createdAt))), el('td', {}, state), el('td', {}, it.lastError || ''), el('td', {}, retry, ' ', del));
      }),
    );
    $('outbox').classList.toggle('hidden', status.outbox.length === 0);
    $('outbox-empty').classList.toggle('hidden', status.outbox.length > 0);
  }

  function renderConfig(status) {
    const c = status.config;
    $('config-status').textContent = c
      ? `Loaded ${ago(c.fetchedAt)}: ${c.listCount} lists, ${c.mappingRows} mapping rows. Fields: ${Object.entries(c.fields || {})
          .map(([k, v]) => `${k} → "${v}"`)
          .join(', ')}.`
      : 'Not loaded yet. Save your web app settings, then reload.';
  }

  const COLUMNS = [
    ['PT', (r) => `${r.preptest} S${r.section} Q${r.question}`],
    ['Type', (r) => r.questionType],
    ['Diff', (r) => r.difficulty],
    ['You', (r) => r.firstAnswer || '–'],
    ['Key', (r) => r.correctAnswer],
    ['BR', (r) => r.brAnswer],
    ['Flag', (r) => (r.flagged === true ? '⚑' : '')],
    ['Time', (r) => (r.timeSpentSec === '' ? '' : `${Math.floor(r.timeSpentSec / 60)}:${String(r.timeSpentSec % 60).padStart(2, '0')}`)],
    ['Reason', (r) => r.reason],
    ['Needs review', (r) => r.needsReview],
    ['Capture ID', (r) => r.captureId],
  ];

  function renderLast(status) {
    const last = status.lastCapture;
    if (!last) return;
    $('last-summary').textContent = `${last.dryRun ? 'Dry run — ' : ''}${last.summary} (${ago(last.at)})`;
    const table = $('last-rows');
    table.tHead.replaceChildren(el('tr', {}, ...COLUMNS.map(([h]) => el('th', {}, h))));
    table.tBodies[0].replaceChildren(...last.rows.map((r) => el('tr', {}, ...COLUMNS.map(([, f]) => el('td', {}, f(r))))));
    table.classList.toggle('hidden', last.rows.length === 0);
  }

  function render(status) {
    $('version').textContent = status.version;
    renderAccess(status);
    renderWebApp(status);
    renderOutbox(status);
    renderConfig(status);
    renderLast(status);
  }

  async function refresh() {
    render(await ask(MSG.STATUS));
  }

  async function act(type, extra) {
    try {
      render(await ask(type, extra));
    } catch (e) {
      alert(e.message);
    }
  }

  function candidate() {
    const out = { webAppUrl: $('url').value.trim() };
    if ($('secret').value.trim()) out.secret = $('secret').value.trim();
    return out;
  }

  $('grant').addEventListener('click', () => {
    // Must be called straight from the click for Firefox to show the prompt.
    browser.permissions.request({ origins: missing }).then(refresh, (e) => alert(e.message));
  });

  $('show-secret').addEventListener('click', () => {
    const input = $('secret');
    input.type = input.type === 'password' ? 'text' : 'password';
    $('show-secret').textContent = input.type === 'password' ? 'Show' : 'Hide';
  });

  $('webapp-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const out = $('webapp-result');
    try {
      render(await ask(MSG.SAVE_SETTINGS, { settings: candidate() }));
      $('secret').value = '';
      out.className = 'ok';
      out.textContent = 'Saved.';
    } catch (e) {
      out.className = 'bad';
      out.textContent = e.message;
    }
  });

  $('test').addEventListener('click', async () => {
    const out = $('webapp-result');
    out.className = 'muted';
    out.textContent = 'Testing…';
    try {
      const data = await ask(MSG.TEST_CONNECTION, { settings: candidate() });
      out.className = 'ok';
      out.textContent = `✓ Connected to "${data.sheet}" — Inbox has ${data.inboxNew} new.`;
    } catch (e) {
      out.className = 'bad';
      out.textContent = `✗ ${e.message}`;
    }
  });

  $('dry-run').addEventListener('change', (ev) => act(MSG.SAVE_SETTINGS, { settings: { dryRun: ev.target.checked } }));
  $('flush').addEventListener('click', () => act(MSG.FLUSH));
  $('refresh-config').addEventListener('click', () => act(MSG.REFRESH_CONFIG));

  browser.storage.onChanged.addListener(() => refresh());
  browser.permissions.onAdded.addListener(() => refresh());
  browser.permissions.onRemoved.addListener(() => refresh());
  refresh();
})(globalThis.LMC);
