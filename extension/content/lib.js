'use strict';
// Runtime shared by every platform content script.
//
// A platform registers itself with:
//   LMC.registerPlatform({
//     name: '7Sage',
//     hosts: /(^|\.)7sage\.com$/,
//     isResultsPage(doc, url) -> boolean   cheap check, called on DOM changes
//     parse(doc, url) -> { session, questions } | null   (see shared/capture.js)
//   })
// Parsers must only read what the page already shows or embeds. They never
// fetch, and never return question, passage, or answer-choice text.
(function (LMC) {
  LMC.platforms = LMC.platforms || [];
  LMC.registerPlatform = (p) => {
    if (!LMC.platforms.some((x) => x.name === p.name)) LMC.platforms.push(p);
  };

  // ---- small DOM helpers for parsers ------------------------------------

  const text = (node) => (node ? node.textContent.replace(/\s+/g, ' ').trim() : '');

  function first(root, selectors) {
    for (const sel of [].concat(selectors || [])) {
      const n = root.querySelector(sel);
      if (n) return n;
    }
    return null;
  }

  function all(root, selectors) {
    for (const sel of [].concat(selectors || [])) {
      const n = root.querySelectorAll(sel);
      if (n.length) return [...n];
    }
    return [];
  }

  // Reads <script type="application/json"> style state, by selector.
  function jsonScript(doc, selectors) {
    const node = first(doc, selectors);
    if (!node) return null;
    try {
      return JSON.parse(node.textContent);
    } catch {
      return null;
    }
  }

  // Reads a page global such as window.__INITIAL_STATE__. Firefox content
  // scripts see the page through an X-ray wrapper; wrappedJSObject lifts it
  // for reading. Cloned so nothing from the page leaks back into ours.
  function pageGlobal(path) {
    const win = typeof window !== 'undefined' ? window.wrappedJSObject || window : null;
    if (!win) return null;
    try {
      const value = path.split('.').reduce((o, k) => (o == null ? o : o[k]), win);
      return value == null ? null : JSON.parse(JSON.stringify(value));
    } catch {
      return null;
    }
  }

  // "1:23" / "01:02:03" / "83s" / "1m 23s" -> seconds
  function seconds(s) {
    const t = String(s || '').trim();
    if (!t) return null;
    let m = t.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
    if (m) return m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
    m = t.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec)?)?$/i);
    if (m && (m[1] || m[2] || m[3])) return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
    return null;
  }

  // Local calendar date (the day you sat the set), YYYY-MM-DD.
  function isoDate(value) {
    if (value == null || value === '') return '';
    const d = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  LMC.dom = { text, first, all, jsonScript, pageGlobal, seconds, isoDate };

  // ---- toast ------------------------------------------------------------
  // Styled through element.style (not a <style> tag) so a strict page CSP
  // cannot block it; kept in a closed shadow root so page CSS cannot touch it.

  let shadow = null;
  let hideTimer = null;
  const KIND_COLORS = { ok: '#1a7f37', warn: '#9a6700', bad: '#cf222e', info: '#1d4ed8', muted: '#59636e' };

  function toast(message, kind = 'ok', ms = 7000) {
    if (typeof document === 'undefined' || !document.body) return;
    if (!shadow || !shadow.host.isConnected) {
      const host = document.createElement('div');
      host.setAttribute('data-lsat-miss-capture', '');
      Object.assign(host.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647' });
      shadow = host.attachShadow({ mode: 'closed' });
      document.body.append(host);
    }
    const box = document.createElement('div');
    box.setAttribute('role', 'status');
    Object.assign(box.style, {
      maxWidth: '380px',
      padding: '10px 14px',
      borderRadius: '8px',
      borderLeft: `4px solid ${KIND_COLORS[kind] || KIND_COLORS.info}`,
      background: '#1f2328',
      color: '#f6f8fa',
      font: '14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
      boxShadow: '0 4px 16px rgba(0,0,0,.25)',
      cursor: 'pointer',
    });
    const title = document.createElement('div');
    title.textContent = 'LSAT Miss Capture';
    Object.assign(title.style, { fontSize: '11px', opacity: '0.7', marginBottom: '2px' });
    const body = document.createElement('div');
    body.textContent = message;
    box.append(title, body);
    box.addEventListener('click', () => box.remove());
    shadow.replaceChildren(box);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => box.remove(), ms);
  }

  LMC.toast = toast;
})((globalThis.LMC = globalThis.LMC || {}));
