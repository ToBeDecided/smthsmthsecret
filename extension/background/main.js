'use strict';
// Background event page. Listeners are registered synchronously at top level
// so Firefox can wake the page for them after it has been unloaded.
(function (LMC) {
  const { MSG, STORAGE } = LMC;
  const CONFIG_MAX_AGE_MS = 10 * 60 * 1000;
  const COUNTS_ALARM = 'refresh-counts';
  const SEEN_LIMIT = 5000;
  const PLATFORM_HOSTS = { '7Sage': /(^|\.)7sage\.com$/ };

  // ---- permissions -------------------------------------------------------

  async function missingOrigins() {
    const missing = [];
    for (const origin of [...LMC.SITE_ORIGINS, ...LMC.WEB_APP_ORIGINS]) {
      if (!(await browser.permissions.contains({ origins: [origin] }))) missing.push(origin);
    }
    return missing;
  }

  async function refreshBadge() {
    await LMC.badge.update({ missingPermissions: (await missingOrigins()).length > 0 });
  }

  // ---- sheet config (Lists + Mapping tabs) -------------------------------

  async function getConfig({ force = false } = {}) {
    const cached = await LMC.store.get(STORAGE.config, null);
    if (!force && cached && Date.now() - cached.fetchedAt < CONFIG_MAX_AGE_MS) return cached;
    try {
      const data = await LMC.webapp.call('config', {}, { timeoutMs: 15000 });
      const fresh = { ...data, fetchedAt: Date.now() };
      await LMC.store.set(STORAGE.config, fresh);
      return fresh;
    } catch (e) {
      if (force) throw e;
      return cached; // stale or null; rows get flagged instead of failing
    }
  }

  async function refreshCounts() {
    try {
      const data = await LMC.webapp.call('counts', {}, { timeoutMs: 15000 });
      await LMC.store.set(STORAGE.inboxNew, data.new || 0);
    } catch {
      /* offline or not configured; keep the last known count */
    }
    await refreshBadge();
  }

  // ---- capture -----------------------------------------------------------

  function safeUrl(u) {
    try {
      const url = new URL(String(u));
      return url.protocol === 'https:' ? url.href.slice(0, 500) : '';
    } catch {
      return '';
    }
  }

  // The content script read this from a web page: treat it as untrusted.
  function cleanResult(r, senderUrl) {
    if (!r || typeof r !== 'object' || !r.session || !Array.isArray(r.questions)) throw new Error('Malformed capture.');
    const str = (v, n) => (v == null ? '' : String(v).trim().slice(0, n));
    const bool = (v) => (v == null || v === '' ? null : Boolean(v));
    const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    const s = r.session;
    const session = {
      platform: str(s.platform, 40),
      attemptKey: str(s.attemptKey, 200),
      kind: str(s.kind, 20),
      timed: bool(s.timed),
      attemptDate: str(s.attemptDate, 40),
      url: safeUrl(s.url),
      label: str(s.label, 80),
    };
    if (!session.platform || !session.attemptKey) throw new Error('Capture is missing platform or attempt.');
    const hostRule = PLATFORM_HOSTS[session.platform];
    if (senderUrl && hostRule && !hostRule.test(new URL(senderUrl).hostname)) throw new Error('Capture came from the wrong site.');
    const questions = r.questions.slice(0, 300).map((q) => ({
      preptest: str(q.preptest, 12),
      section: str(q.section, 4),
      question: str(q.question, 4),
      questionType: str(q.questionType, 80),
      difficulty: str(q.difficulty, 20),
      timed: bool(q.timed),
      firstAnswer: str(q.firstAnswer, 4),
      correctAnswer: str(q.correctAnswer, 4),
      brAnswer: str(q.brAnswer, 4),
      flagged: bool(q.flagged),
      timeSpentSec: num(q.timeSpentSec),
      attemptDate: str(q.attemptDate, 40),
      link: safeUrl(q.link),
    }));
    return { session, questions };
  }

  async function handleCapture(rawResult, { manual = false, senderUrl } = {}) {
    const result = cleanResult(rawResult, senderUrl);
    const settings = await LMC.store.getSettings();
    const config = await getConfig();
    const { rows, summary } = await LMC.capture.buildRows(result, config);
    await LMC.store.set(STORAGE.lastCapture, { at: Date.now(), url: result.session.url, summary, rows, dryRun: settings.dryRun });

    if (!rows.length) return { status: 'nothing', message: summary };
    if (settings.dryRun) return { status: 'dry-run', message: `Dry run: ${summary} (nothing sent)` };

    const seen = new Set(await LMC.store.get(STORAGE.seen, []));
    const fresh = rows.filter((r) => !seen.has(r.captureId));
    if (!fresh.length && !manual) return { status: 'duplicate', message: `Already in Inbox: ${summary}` };

    const id = await LMC.outbox.enqueue('append', { rows: manual ? rows : fresh }, { kind: 'capture', summary });
    await refreshBadge();
    const delivered = await LMC.outbox.flush();
    if (delivered[id]) {
      const { added = 0, duplicates = 0 } = delivered[id];
      if (!added && duplicates) return { status: 'duplicate', message: `Already in Inbox: ${summary}` };
      return { status: 'sent', message: `${summary} → Inbox` };
    }
    const item = (await LMC.outbox.list()).find((it) => it.id === id);
    const why = item && item.lastError ? ` (${item.lastError})` : '';
    return { status: 'queued', message: `${summary}: saved in the browser, will send when the sheet is reachable${why}` };
  }

  LMC.outbox.onDelivered(async (item, data) => {
    if (item.action === 'append') {
      const ids = (item.payload.rows || []).map((r) => r.captureId);
      await LMC.store.update(STORAGE.seen, (seen) => [...new Set([...seen, ...ids])].slice(-SEEN_LIMIT), []);
    }
    if (data && typeof data.newCount === 'number') await LMC.store.set(STORAGE.inboxNew, data.newCount);
    await refreshBadge();
  });

  // ---- pages -------------------------------------------------------------

  async function getStatus() {
    const settings = await LMC.store.getSettings();
    const config = await LMC.store.get(STORAGE.config, null);
    const outbox = await LMC.outbox.list();
    return {
      version: LMC.VERSION,
      settings: { webAppUrl: settings.webAppUrl, hasSecret: Boolean(settings.secret), dryRun: settings.dryRun },
      urlProblem: LMC.webapp.checkUrl(settings.webAppUrl),
      missingOrigins: await missingOrigins(),
      counts: await LMC.badge.counts(),
      outbox: outbox.map((it) => ({
        id: it.id,
        action: it.action,
        summary: (it.meta && it.meta.summary) || it.action,
        rows: it.payload && it.payload.rows ? it.payload.rows.length : 0,
        state: it.state,
        attempts: it.attempts,
        lastError: it.lastError,
        createdAt: it.createdAt,
      })),
      lastCapture: await LMC.store.get(STORAGE.lastCapture, null),
      config: config && {
        fetchedAt: config.fetchedAt,
        fields: config.fields,
        listCount: Object.keys(config.lists || {}).length,
        mappingRows: (config.mapping || []).length,
      },
    };
  }

  async function saveSettings(patch) {
    const before = await LMC.store.getSettings();
    const allowed = {};
    for (const k of ['webAppUrl', 'secret', 'dryRun']) if (k in patch) allowed[k] = k === 'dryRun' ? Boolean(patch[k]) : String(patch[k]).trim();
    const after = await LMC.store.saveSettings(allowed);
    if (after.webAppUrl !== before.webAppUrl || after.secret !== before.secret) {
      await LMC.store.set(STORAGE.config, null);
      await LMC.outbox.requeue();
      LMC.outbox.flush().then(refreshCounts);
    }
    await refreshBadge();
    return getStatus();
  }

  async function testConnection(candidate) {
    const settings = { ...(await LMC.store.getSettings()), ...candidate };
    return LMC.webapp.call('ping', {}, { settings, timeoutMs: 20000 });
  }

  // ---- wiring ------------------------------------------------------------

  const handlers = {
    [MSG.CAPTURE]: (msg, sender) => handleCapture(msg.result, { manual: Boolean(msg.manual), senderUrl: sender.tab && sender.tab.url }),
    [MSG.STATUS]: () => getStatus(),
    [MSG.SAVE_SETTINGS]: (msg) => saveSettings(msg.settings || {}),
    [MSG.TEST_CONNECTION]: (msg) => testConnection(msg.settings || {}),
    [MSG.REFRESH_CONFIG]: () => getConfig({ force: true }).then(getStatus),
    [MSG.FLUSH]: () => LMC.outbox.flush({ force: true }).then(refreshCounts).then(getStatus),
    [MSG.OUTBOX_RETRY]: (msg) => LMC.outbox.requeue(msg.id).then(() => LMC.outbox.flush({ force: true })).then(refreshBadge).then(getStatus),
    [MSG.OUTBOX_DELETE]: (msg) => LMC.outbox.remove(msg.id).then(refreshBadge).then(getStatus),
  };

  browser.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== browser.runtime.id || !msg || !handlers[msg.type]) return undefined;
    return handlers[msg.type](msg, sender).then(
      (data) => ({ ok: true, data }),
      (e) => ({ ok: false, error: e.message || String(e), code: e.code }),
    );
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === LMC.outbox.ALARM) LMC.outbox.flush().then(refreshBadge);
    if (alarm.name === COUNTS_ALARM) refreshCounts();
  });

  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    browser.alarms.create(COUNTS_ALARM, { periodInMinutes: 30 });
    const settings = await LMC.store.getSettings();
    const needsSetup = (await missingOrigins()).length > 0 || !settings.secret || LMC.webapp.checkUrl(settings.webAppUrl);
    if (reason === 'install' || needsSetup) browser.runtime.openOptionsPage();
    refreshBadge();
  });

  browser.runtime.onStartup.addListener(() => {
    browser.alarms.create(COUNTS_ALARM, { periodInMinutes: 30 });
    LMC.outbox.flush().then(refreshCounts);
  });

  browser.permissions.onAdded.addListener(refreshBadge);
  browser.permissions.onRemoved.addListener(refreshBadge);

  LMC.bg = { handleCapture, cleanResult, getConfig, getStatus, saveSettings, missingOrigins };
})((globalThis.LMC = globalThis.LMC || {}));
