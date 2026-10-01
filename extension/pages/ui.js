'use strict';
// Small helpers shared by the options page and the popup.
(function (LMC) {
  // Builds DOM without innerHTML: el('td', { className: 'x' }, 'text', child)
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    for (const c of children) if (c != null) node.append(c instanceof Node ? c : String(c));
    return node;
  }

  async function ask(type, extra) {
    const res = await browser.runtime.sendMessage({ type, ...extra });
    if (!res) throw new Error('No answer from the extension background.');
    if (!res.ok) throw new Error(res.error);
    return res.data;
  }

  function ago(ts) {
    if (!ts) return '';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(ts).toLocaleString();
  }

  LMC.ui = { el, ask, ago };
})((globalThis.LMC = globalThis.LMC || {}));
