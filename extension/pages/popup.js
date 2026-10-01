'use strict';
(function (LMC) {
  const { ask, ago } = LMC.ui;
  const { MSG } = LMC;
  const $ = (id) => document.getElementById(id);

  function supported(url) {
    try {
      const { hostname } = new URL(url);
      return LMC.CONTENT_SITES.some((site) => site.hosts.test(hostname));
    } catch {
      return false;
    }
  }

  async function activeTab() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  function render(status, tab) {
    const problems = [];
    if (status.missingOrigins.length) problems.push('needs site access');
    if (!status.settings.hasSecret || status.urlProblem) problems.push('is not connected to your sheet yet');
    $('setup').classList.toggle('hidden', problems.length === 0);
    $('setup-text').textContent = problems.length ? `LSAT Miss Capture ${problems.join(' and ')}.` : '';
    $('dry').classList.toggle('hidden', !status.settings.dryRun);

    const c = status.counts;
    let text = `${c.inboxNew} new in Inbox`;
    if (c.unsentRows) text += ` · ${c.unsentRows} waiting to send`;
    if (c.failed) text += ` · ${c.failed} need attention`;
    $('counts').textContent = text;

    const ok = tab && supported(tab.url);
    $('capture').disabled = !ok;
    if (!ok) $('result').textContent = 'Open a 7Sage results or review page to capture it.';
    if (status.lastCapture) $('last').textContent = `Last: ${status.lastCapture.summary} (${ago(status.lastCapture.at)})`;
  }

  // The content script is normally already there; if the page was open
  // before the add-on was installed or allowed, inject it now.
  async function captureTab(tab) {
    try {
      return await browser.tabs.sendMessage(tab.id, { type: MSG.CAPTURE_NOW });
    } catch {
      await browser.scripting.executeScript({ target: { tabId: tab.id }, files: LMC.CONTENT_SCRIPT_FILES });
      return browser.tabs.sendMessage(tab.id, { type: MSG.CAPTURE_NOW });
    }
  }

  $('capture').addEventListener('click', async () => {
    const out = $('result');
    out.className = 'result muted';
    out.textContent = 'Reading the page…';
    try {
      const res = await captureTab(await activeTab());
      if (!res || !res.ok) throw new Error((res && res.error) || 'No results found on this page.');
      out.className = `result ${res.data.status === 'queued' ? 'warn' : 'ok'}`;
      out.textContent = res.data.message;
    } catch (e) {
      out.className = 'result bad';
      out.textContent = e.message;
    }
    render(await ask(MSG.STATUS), await activeTab());
  });

  $('open-setup').addEventListener('click', () => browser.runtime.openOptionsPage().then(() => window.close()));
  $('options').addEventListener('click', () => browser.runtime.openOptionsPage().then(() => window.close()));

  Promise.all([ask(MSG.STATUS), activeTab()]).then(([status, tab]) => render(status, tab));
})(globalThis.LMC);
