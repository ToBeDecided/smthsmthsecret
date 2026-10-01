'use strict';
// Watches a single-page app for results to render, then hands the parsed
// result to the background page. Loaded last, after the platform parser.
(function (LMC) {
  if (LMC.contentStarted) return; // re-injected by the popup: already running
  const platform = LMC.platforms.find((p) => p.hosts.test(location.hostname));
  if (!platform) return;
  LMC.contentStarted = true;

  const SETTLE_MS = 800; // wait for the DOM to stop changing before parsing
  const handled = new Set();
  let timer = null;
  let busy = false;

  const TOAST_KIND = { sent: 'ok', queued: 'warn', 'dry-run': 'info', duplicate: 'muted', nothing: 'muted' };

  async function send(result, manual) {
    const res = await browser.runtime.sendMessage({ type: LMC.MSG.CAPTURE, result, manual });
    if (!res) throw new Error('The extension did not answer. Try reloading the page.');
    if (!res.ok) throw new Error(res.error);
    LMC.toast(res.data.message, TOAST_KIND[res.data.status] || 'info');
    return res;
  }

  function parse() {
    const result = platform.parse(document, location.href);
    return result && result.questions && result.questions.length ? result : null;
  }

  async function check() {
    if (busy) return schedule();
    let result;
    try {
      if (!platform.isResultsPage(document, location.href)) return;
      result = parse();
    } catch (e) {
      console.warn(`[LSAT Miss Capture] ${platform.name} parser failed:`, e);
      return;
    }
    if (!result) return;
    const key = `${location.href}|${result.session.attemptKey}|${result.questions.length}`;
    if (handled.has(key)) return;
    handled.add(key);
    busy = true;
    try {
      await send(result, false);
    } catch (e) {
      LMC.toast(`Capture failed: ${e.message}`, 'bad');
    } finally {
      busy = false;
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(check, SETTLE_MS);
  }

  // SPA navigation (pushState) fires no event, but it always changes the DOM,
  // so one observer covers route changes and late-rendering results alike.
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.addEventListener('popstate', schedule);
  window.addEventListener('hashchange', schedule);
  schedule();

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== LMC.MSG.CAPTURE_NOW) return undefined;
    return (async () => {
      try {
        const result = parse();
        if (!result) return { ok: false, error: `No ${platform.name} results found on this page. Wait for it to finish loading, then try again.` };
        return await send(result, true);
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })();
  });
})(globalThis.LMC);
