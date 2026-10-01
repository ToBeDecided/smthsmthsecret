'use strict';
// Every write to the sheet goes through this queue, persisted in
// storage.local before any network call. Items are only removed once the web
// app confirms them; nothing is ever dropped automatically. Failed items wait
// for the user (fix settings, then Retry) and are listed in the options page.
(function (LMC) {
  const KEY = () => LMC.STORAGE.outbox;
  const BACKOFF_S = [30, 60, 120, 300, 900, 1800, 3600];
  const ALARM = 'outbox-retry';
  // Errors that will fail the same way for every item; stop the run early.
  const STOP_RUN = new Set(['network', 'not_configured', 'auth', 'bad_url', 'not_json']);

  let running = null;
  const hooks = { delivered: [] };

  function newId() {
    return crypto.randomUUID();
  }

  async function list() {
    return LMC.store.get(KEY(), []);
  }

  async function enqueue(action, payload, meta = {}) {
    const item = { id: newId(), action, payload, meta, createdAt: Date.now(), attempts: 0, nextAt: 0, state: 'pending', lastError: '' };
    await LMC.store.update(KEY(), (items) => [...items, item], []);
    return item.id;
  }

  async function patch(id, fn) {
    await LMC.store.update(KEY(), (items) => items.map((it) => (it.id === id ? fn(it) : it)), []);
  }

  async function remove(id) {
    await LMC.store.update(KEY(), (items) => items.filter((it) => it.id !== id), []);
  }

  // Put failed items back in line (after the user fixes settings, or Retry).
  async function requeue(id) {
    await LMC.store.update(
      KEY(),
      (items) => items.map((it) => (!id || it.id === id ? { ...it, state: 'pending', nextAt: 0 } : it)),
      [],
    );
  }

  async function runOnce({ force, now }) {
    const delivered = {};
    const items = (await list()).filter((it) => it.state === 'pending' && (force || it.nextAt <= now()));
    for (const item of items) {
      try {
        const data = await LMC.webapp.call(item.action, item.payload, { opId: item.id });
        await remove(item.id);
        delivered[item.id] = data;
        for (const fn of hooks.delivered) await fn(item, data);
      } catch (e) {
        const attempts = item.attempts + 1;
        const retryable = e.retryable !== false;
        await patch(item.id, (it) => ({
          ...it,
          attempts,
          lastError: e.message || String(e),
          lastErrorCode: e.code || 'error',
          lastTriedAt: now(),
          state: retryable ? 'pending' : 'failed',
          nextAt: now() + BACKOFF_S[Math.min(attempts - 1, BACKOFF_S.length - 1)] * 1000,
        }));
        if (STOP_RUN.has(e.code)) break;
      }
    }
    return delivered;
  }

  // Single-flight: concurrent callers share one run.
  function flush({ force = false, now = Date.now } = {}) {
    if (running) return running.then(() => flush({ force, now }));
    running = (async () => {
      try {
        return await runOnce({ force, now });
      } finally {
        await schedule();
      }
    })();
    const done = running;
    done
      .finally(() => {
        if (running === done) running = null;
      })
      .catch(() => {});
    return done;
  }

  async function schedule() {
    if (typeof browser === 'undefined' || !browser.alarms) return;
    const pending = (await list()).some((it) => it.state === 'pending');
    if (pending) browser.alarms.create(ALARM, { periodInMinutes: 1 });
    else await browser.alarms.clear(ALARM);
  }

  LMC.outbox = {
    enqueue,
    flush,
    list,
    remove,
    requeue,
    onDelivered: (fn) => hooks.delivered.push(fn),
    ALARM,
  };
})((globalThis.LMC = globalThis.LMC || {}));
