'use strict';
// Client for the Apps Script web app. Every call is a POST with the shared
// secret in the body (never in the URL, which Google logs). The /exec URL
// answers with a 302 to script.googleusercontent.com; fetch follows it.
(function (LMC) {
  const TIMEOUT_MS = 30000;
  const URL_RE = /^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;

  class WebAppError extends Error {
    constructor(code, message, retryable) {
      super(message);
      this.code = code;
      this.retryable = retryable;
    }
  }

  // Error codes the user has to fix; retrying on a timer will not help.
  const NEEDS_USER = new Set(['not_configured', 'auth', 'bad_url', 'bad_request', 'unknown_action']);

  function checkUrl(url) {
    if (!url) return 'Paste the web app URL from Deploy → Manage deployments.';
    if (/\/dev$/.test(url)) return 'That is the /dev test URL, which only works while signed in. Use the /exec URL.';
    if (!URL_RE.test(url)) return 'Expected https://script.google.com/macros/s/…/exec';
    return '';
  }

  async function call(action, payload, { opId, settings, timeoutMs = TIMEOUT_MS, fetchImpl } = {}) {
    const s = settings || (await LMC.store.getSettings());
    const urlProblem = checkUrl(s.webAppUrl);
    if (!s.secret || urlProblem) {
      throw new WebAppError('not_configured', urlProblem || 'Set the shared secret in the extension options.', false);
    }
    const body = JSON.stringify({ v: LMC.PROTOCOL, secret: s.secret, action, payload: payload || {}, opId, client: LMC.VERSION });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await (fetchImpl || fetch)(s.webAppUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body,
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-store',
        signal: ctrl.signal,
      });
    } catch (e) {
      const msg = e && e.name === 'AbortError' ? `No answer from the web app within ${timeoutMs / 1000} s.` : `Network error: ${e && e.message}`;
      throw new WebAppError('network', msg, true);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) {
      const transient = res.status === 429 || res.status >= 500;
      throw new WebAppError(transient ? 'server' : 'http', `The web app returned HTTP ${res.status}.`, transient);
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      const login = /accounts\.google\.com|ServiceLogin|Sign in/i.test(text);
      throw new WebAppError(
        'not_json',
        login
          ? 'Google asked for a sign-in. In Deploy → Manage deployments set "Who has access" to "Anyone".'
          : 'The web app answered with a web page instead of data. Check the URL ends in /exec and a new version is deployed.',
        true,
      );
    }
    if (!json || json.ok !== true) {
      const err = (json && json.error) || {};
      const code = err.code || 'server';
      throw new WebAppError(code, err.message || 'The web app reported an error.', !NEEDS_USER.has(code));
    }
    return json.data;
  }

  LMC.webapp = { call, checkUrl, WebAppError, NEEDS_USER };
})((globalThis.LMC = globalThis.LMC || {}));
