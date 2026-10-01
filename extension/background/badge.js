'use strict';
// Toolbar badge = captures you have not dealt with yet: New rows in Inbox
// (last count the sheet reported) plus captured rows still waiting to send.
(function (LMC) {
  const COLORS = { ok: '#1d4ed8', waiting: '#b45309', problem: '#b91c1c' };

  async function counts() {
    const [inboxNew, outbox] = await Promise.all([LMC.store.get(LMC.STORAGE.inboxNew, 0), LMC.outbox.list()]);
    const captures = outbox.filter((it) => it.action === 'append');
    const unsentRows = captures.reduce((n, it) => n + ((it.payload && it.payload.rows) || []).length, 0);
    const failed = outbox.filter((it) => it.state === 'failed').length;
    return { inboxNew, unsentRows, failed, queued: outbox.length };
  }

  async function update({ missingPermissions = false } = {}) {
    if (!browser.action) return;
    const c = await counts();
    const total = c.inboxNew + c.unsentRows;
    let text = total ? String(total > 999 ? '999+' : total) : '';
    let color = COLORS.ok;
    let title = `LSAT Miss Capture — ${c.inboxNew} new in Inbox`;
    if (c.unsentRows) {
      color = COLORS.waiting;
      title += `, ${c.unsentRows} waiting to send`;
    }
    if (c.failed || missingPermissions) {
      color = COLORS.problem;
      if (!text) text = '!';
      title += missingPermissions ? ' — needs site access (open options)' : ` — ${c.failed} need attention (open options)`;
    }
    await browser.action.setBadgeText({ text });
    await browser.action.setBadgeBackgroundColor({ color });
    await browser.action.setTitle({ title });
  }

  LMC.badge = { update, counts };
})((globalThis.LMC = globalThis.LMC || {}));
