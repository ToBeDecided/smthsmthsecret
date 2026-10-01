// Turns a saved results page into a fixture that is safe to commit.
//
// Allowlist, not blocklist: every piece of text (text nodes, text-bearing
// attributes, JSON strings) is replaced unless it is short and made only of
// words in sanitize-vocab.txt, numbers, dates, times, or answer letters.
// IDs are swapped for consistent fakes of the same shape, so links and
// cross-references between the DOM and embedded JSON still line up.
//
// The page structure, tag names, classes, data-* attribute names, and the
// shape of embedded JSON are kept so parsers can be tested against it.

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { RULES as SECRET_RULES } from '../scan-secrets.mjs';

const VOCAB_FILE = new URL('./sanitize-vocab.txt', import.meta.url);
const MAX_TEXT_TOKENS = 8;
const TEXT_PLACEHOLDER = '[redacted]';
const VALUE_PLACEHOLDER = 'REDACTED';
const FAKE_EMAIL = 'user@example.com';
const LEAK_MIN_LENGTH = 16;

export function loadVocab(text = readFileSync(VOCAB_FILE, 'utf8')) {
  const vocab = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim().toLowerCase();
    if (!line) continue;
    for (const word of line.split(/\s+/)) {
      vocab.add(word);
      for (const part of word.split(/[-/]/)) if (part) vocab.add(part);
    }
  }
  return vocab;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const USERISH_EMBEDDED_RE = /(user|account|member|student|customer|profile)([-_=:/]?)(\d{3,}|[0-9a-f]{16,})/gi;

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'cite', 'data', 'xlink:href', 'ping', 'background', 'manifest', 'longdesc']);
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);
const TEXT_ATTRS = new Set(['alt', 'title', 'placeholder', 'label', 'summary', 'abbr', 'download', 'aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext', 'aria-keyshortcuts']);
const IDREF_ATTRS = new Set(['id', 'for', 'name', 'headers', 'list', 'form', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'aria-details', 'aria-errormessage', 'aria-flowto']);

// Keys whose value is always replaced with REDACTED (credentials).
const SECRET_KEY_RE = /(password|passwd|secret|token|csrf|xsrf|jwt|cookie|apikey|authorization|authkey|signature|hmac|userhash|stripe|intercom|recaptcha)/;
// Keys whose value is always replaced with a fake (personal details).
const PERSON_KEY_RE = /(email|phone|firstname|lastname|fullname|username|nickname|givenname|familyname|avatar|photo|picture|gravatar|ipaddress|billing|initials|birth|address)/;
// Keys whose subtree belongs to a person.
const PII_CONTAINER_KEY_RE = /^(user|users|currentuser|viewer|me|account|profile|member|student|customer|person|owner|author|subscriber|subscription|identity)$/;
// Scalar keys that hold a person's ID.
const USERISH_KEY_RE = /^(uid|sub|(user|account|member|customer|student|owner|profile|person|subscriber|author|createdby|updatedby)(id|uuid|guid)?)$/;
// Keys that hold licensed test content.
const CONTENT_KEY_RE = /^(stem|stimulus|passage|passages|prompt|questiontext|questionstem|body|html|content|contents|text|richtext|markdown|explanation|explanations|rationale|solution|solutions|transcript|choicetext|answertext|choices|answerchoices|options|description|summary|comment|comments|note|notes|excerpt|snippet|highlight|highlights|annotation|annotations)$/;
const ID_KEY_RE = /^(id|uuid|guid)$|(_id|Id|ID|_uuid|Uuid)$/;

const SVG_NS = 'http://www.w3.org/2000/svg';
const KEEP_META = /^(viewport|charset|themecolor|colorscheme|robots|referrer|formatdetection|generator|contenttype|xuacompatible)$/;
const EMAIL_TEST_RE = new RegExp(EMAIL_RE.source);

const normKey = (k) => String(k).replace(/[^A-Za-z0-9]/g, '').toLowerCase();

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isEpoch(s) {
  return /^1\d{9}(\d{3})?$/.test(s);
}

export class Sanitizer {
  constructor({ vocab = loadVocab(), redactTerms = [] } = {}) {
    this.vocab = vocab;
    this.redactTerms = redactTerms.map((t) => t.trim()).filter((t) => t.length >= 2);
    this.ids = new Map();
    this.redactedOriginals = new Set();
  }

  // ---- classification ----------------------------------------------------

  isAllowedToken(token) {
    const t = token.toLowerCase().replace(/['’]s$/, '').replace(/[.:,]+$/, '');
    if (!t) return true;
    if (/^\d+([.,:/-]\d+)*%?$/.test(t)) return true; // numbers, scores, times, dates
    if (/^\d+(st|nd|rd|th)$/.test(t)) return true;
    if (/^(\d+(h|hr|hrs|m|min|mins|s|sec|secs|ms))+$/.test(t)) return true; // 1m23s
    if (/^[a-z]$/.test(t)) return true; // answer letters
    if (/^(pt|s|q|lr|rc|ar|sec|v)\d+$/.test(t)) return true; // PT158, S2, Q14
    if (this.vocab.has(t)) return true;
    const parts = t.split(/[-/+.:#]/).filter(Boolean);
    return parts.length > 1 && parts.every((p) => this.isAllowedToken(p));
  }

  isAllowedText(s) {
    const spaced = String(s).replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2');
    const tokens = spaced.match(/[\p{L}\p{N}][\p{L}\p{N}'’.:%/+#-]*/gu) || [];
    if (tokens.length > MAX_TEXT_TOKENS) return false;
    return tokens.every((t) => this.isAllowedToken(t));
  }

  isIdLike(s) {
    if (typeof s !== 'string' || s.length < 5) return false;
    if (new RegExp(`^${UUID_RE.source}$`, 'i').test(s)) return true;
    if (/^[0-9a-f]{16,}$/i.test(s) && /\d/.test(s)) return true;
    if (/^\d{5,}$/.test(s)) return !isEpoch(s);
    if (/^[a-z]{2,12}_[A-Za-z0-9]{12,}$/.test(s)) return true; // user_2abc…, cus_…
    return this.isRandomish(s);
  }

  isRandomish(s) {
    if (s.length < 16 || !/^[A-Za-z0-9_\-+/=.]+$/.test(s)) return false;
    return s.split(/[-_.+/=]/).some((p) => p.length >= 12 && /\d/.test(p) && /[A-Za-z]/.test(p)) ||
      s.split(/[-_.+/=]/).some((p) => p.length >= 20 && /[a-z]/.test(p) && /[A-Z]/.test(p));
  }

  // ---- replacements ------------------------------------------------------

  fakeId(orig) {
    if (this.ids.has(orig)) return this.ids.get(orig);
    const rnd = mulberry32(0x5eed + this.ids.size * 7919);
    const hexOnly = /^[0-9a-f-]+$/.test(orig);
    const HEX = '0123456789abcdef';
    const LOWER = 'abcdefghijklmnopqrstuvwxyz';
    const UPPER = LOWER.toUpperCase();
    let out = '';
    for (let i = 0; i < orig.length; i++) {
      const ch = orig[i];
      const pick = (alphabet) => alphabet[Math.floor(rnd() * alphabet.length)];
      if (/[0-9]/.test(ch)) out += i === 0 && ch !== '0' ? String(1 + Math.floor(rnd() * 9)) : pick('0123456789');
      else if (/[a-z]/.test(ch)) out += hexOnly ? pick(HEX.slice(10)) : pick(LOWER);
      else if (/[A-Z]/.test(ch)) out += pick(UPPER);
      else out += ch;
    }
    // Keep a recognisable prefix such as "user_" or "cus_".
    const prefix = orig.match(/^[a-z]{2,12}_/);
    if (prefix) out = prefix[0] + out.slice(prefix[0].length);
    this.ids.set(orig, out);
    return out;
  }

  fakeNumber(n) {
    const s = String(Math.abs(n));
    return Number((n < 0 ? '-' : '') + this.fakeId(s));
  }

  redact(original, placeholder = VALUE_PLACEHOLDER) {
    const norm = String(original).replace(/\s+/g, ' ').trim();
    if (norm.length >= LEAK_MIN_LENGTH) this.redactedOriginals.add(norm);
    return placeholder;
  }

  replaceEmbedded(s) {
    return String(s)
      .replace(EMAIL_RE, (m) => (m === FAKE_EMAIL ? m : FAKE_EMAIL))
      .replace(UUID_RE, (m) => this.fakeId(m.toLowerCase()))
      .replace(USERISH_EMBEDDED_RE, (m, word, sep, id) => word + sep + this.fakeId(id));
  }

  sanitizeText(s, placeholder = TEXT_PLACEHOLDER) {
    if (!String(s).trim()) return s;
    if (this.isAllowedText(s)) return s;
    const lead = String(s).match(/^\s*/)[0];
    const trail = String(s).match(/\s*$/)[0];
    return lead + this.redact(s, placeholder) + trail;
  }

  sanitizeUrl(value) {
    const s = String(value).trim();
    if (!s) return value;
    if (/^(javascript|vbscript|blob):/i.test(s)) return 'about:blank';
    if (/^data:/i.test(s)) return 'data:,';
    if (/^mailto:/i.test(s)) return `mailto:${FAKE_EMAIL}`;
    if (/^tel:/i.test(s)) return 'tel:0000000000';
    if (/^(#|about:)/.test(s) && !s.startsWith('#/')) return s.startsWith('#') ? '#' + this.sanitizeValue(s.slice(1)) : s;

    const BASE = 'https://relative.invalid';
    let url;
    let kind = 'absolute';
    try {
      url = new URL(s);
    } catch {
      try {
        url = new URL(s, `${BASE}/`);
        kind = s.startsWith('//') ? 'protocol-relative' : s.startsWith('/') ? 'root-relative' : 'relative';
      } catch {
        return this.sanitizeValue(s);
      }
    }
    if (!/^https?:$/.test(url.protocol) && kind === 'absolute') return this.sanitizeValue(s);
    url.username = '';
    url.password = '';
    url.pathname = url.pathname
      .split('/')
      .map((seg) => this.sanitizePathSegment(seg))
      .join('/');
    const params = [...url.searchParams];
    url.search = '';
    for (const [k, v] of params) url.searchParams.append(k, this.sanitizeValue(v, k));
    if (url.hash) {
      const h = url.hash.slice(1);
      url.hash = h.startsWith('/') ? this.sanitizeUrl(h).replace(/^https:\/\/relative\.invalid/, '') : this.sanitizeValue(h);
    }
    let out = url.toString();
    if (kind === 'protocol-relative') out = out.replace(/^https?:/, '');
    if (kind === 'root-relative') out = out.slice(BASE.length);
    if (kind === 'relative') out = out.slice(BASE.length + 1);
    return out;
  }

  sanitizePathSegment(seg) {
    if (!seg) return seg;
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      /* keep raw */
    }
    if (EMAIL_TEST_RE.test(decoded)) return encodeURIComponent(FAKE_EMAIL);
    if (this.isIdLike(decoded)) return encodeURIComponent(this.fakeId(decoded));
    const words = decoded.split(/[-_]/);
    if (words.length >= 4 && !words.every((w) => this.isAllowedToken(w))) {
      this.redact(decoded);
      return words.map((w) => (this.isAllowedToken(w) ? w : 'x')).join('-');
    }
    return encodeURIComponent(this.replaceEmbedded(decoded)).replace(/%2F/gi, '/');
  }

  // Attribute values, query values, short JSON strings with no key hint.
  sanitizeValue(value, name = '') {
    const s = String(value);
    if (!s.trim()) return value;
    const key = normKey(name);
    if (key && SECRET_KEY_RE.test(key)) return VALUE_PLACEHOLDER;
    if (key && (PERSON_KEY_RE.test(key) || USERISH_KEY_RE.test(key))) {
      if (/@/.test(s)) return FAKE_EMAIL;
      return this.isIdLike(s) ? this.fakeId(s) : this.redact(s);
    }
    if (/^(https?:)?\/\/|^\/[^\s]*$/.test(s)) return this.sanitizeUrl(s);
    if (/^[[{]/.test(s.trim())) {
      try {
        return JSON.stringify(this.sanitizeJson(JSON.parse(s)));
      } catch {
        /* not JSON */
      }
    }
    if (this.isIdLike(s)) return this.fakeId(s);
    if (ISO_DATE_RE.test(s) || isEpoch(s)) return s;
    if (/^[\w.:#%+,-]{1,40}$/.test(s) && !this.isRandomish(s)) return this.replaceEmbedded(s);
    if (this.isAllowedText(s)) return this.replaceEmbedded(s);
    return this.redact(s);
  }

  sanitizeJson(value, ctx = { key: '', pii: false, content: false }) {
    if (Array.isArray(value)) return value.map((v) => this.sanitizeJson(v, ctx));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        const nk = normKey(k);
        const outKey = /@/.test(k) ? FAKE_EMAIL : this.isIdLike(k) ? this.fakeId(k) : k;
        out[outKey] = this.sanitizeJson(v, {
          key: k,
          pii: ctx.pii || PII_CONTAINER_KEY_RE.test(nk),
          content: ctx.content || CONTENT_KEY_RE.test(nk),
        });
      }
      return out;
    }
    if (typeof value === 'number') {
      const nk = normKey(ctx.key);
      const personal = ctx.pii || USERISH_KEY_RE.test(nk) || PERSON_KEY_RE.test(nk);
      if (Number.isInteger(value) && !isEpoch(String(Math.abs(value)))) {
        if (personal && Math.abs(value) >= 10) return this.fakeNumber(value);
        if (ID_KEY_RE.test(ctx.key) && Math.abs(value) >= 10000) return this.fakeNumber(value);
      }
      return value;
    }
    if (typeof value === 'string') return this.sanitizeJsonString(value, ctx);
    return value;
  }

  sanitizeJsonString(s, ctx) {
    if (s === '') return s;
    const nk = normKey(ctx.key);
    if (SECRET_KEY_RE.test(nk)) return VALUE_PLACEHOLDER;
    if (PERSON_KEY_RE.test(nk)) {
      if (/email/.test(nk) || /@/.test(s)) return FAKE_EMAIL;
      if (/avatar|photo|picture|gravatar/.test(nk)) return 'https://example.com/avatar.png';
      return this.isIdLike(s) ? this.fakeId(s) : this.redact(s);
    }
    if (/^\s*[[{]/.test(s)) {
      try {
        return JSON.stringify(this.sanitizeJson(JSON.parse(s), ctx));
      } catch {
        /* not JSON */
      }
    }
    if (ctx.pii || USERISH_KEY_RE.test(nk)) {
      if (/@/.test(s)) return FAKE_EMAIL;
      if (this.isIdLike(s)) return this.fakeId(s);
      if (ISO_DATE_RE.test(s)) return s;
      if (/^(https?:)?\/\//.test(s)) return this.sanitizeUrl(s);
      return /^(true|false|[A-Z_]{2,30}|[a-z_]{2,30})$/.test(s) && this.isAllowedText(s) ? s : this.redact(s);
    }
    if (ctx.content) {
      // Only answer letters, numbers, and vocabulary labels survive inside content.
      const t = s.trim();
      if (/^\(?[A-Ea-e]\)?$/.test(t) || /^\d+$/.test(t)) return s;
      if (t.length <= 40 && this.isAllowedText(t)) return s;
      return this.redact(s);
    }
    if (/^(https?:)?\/\//.test(s) || (/^\/\S*$/.test(s) && s.length > 1)) return this.sanitizeUrl(s);
    if (this.isIdLike(s)) return this.fakeId(s);
    if (ISO_DATE_RE.test(s) || isEpoch(s)) return s;
    if (this.isAllowedText(s)) return this.replaceEmbedded(s);
    return this.redact(s);
  }

  // ---- HTML --------------------------------------------------------------

  sanitizeAttributes(el) {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      const v = attr.value;
      let out;
      if (n.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (n === 'srcdoc' || n === 'integrity' || n === 'nonce') out = '';
      else if (n === 'value' && el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'hidden')
        out = /^[\w.:-]{1,12}$/.test(v) ? v : VALUE_PLACEHOLDER;
      else if (el.namespaceURI === SVG_NS && !URL_ATTRS.has(n) && !TEXT_ATTRS.has(n)) out = this.replaceEmbedded(v);
      else if (URL_ATTRS.has(n)) out = this.sanitizeUrl(v);
      else if (SRCSET_ATTRS.has(n))
        out = v
          .split(',')
          .map((part) => {
            const [u, ...rest] = part.trim().split(/\s+/);
            return [this.sanitizeUrl(u), ...rest].join(' ');
          })
          .join(', ');
      else if (TEXT_ATTRS.has(n)) out = this.sanitizeText(v);
      else if (n === 'style') out = v.replace(/url\((['"]?)(.*?)\1\)/g, (m, q, u) => `url(${q}${this.sanitizeUrl(u)}${q})`);
      else if (n === 'class' || IDREF_ATTRS.has(n))
        out = v
          .split(/(\s+)/)
          .map((t) => (t.trim() ? (this.isIdLike(t) ? this.fakeId(t) : this.replaceEmbedded(t)) : t))
          .join('');
      else if (n === 'content' && el.tagName === 'META') {
        const metaName = normKey(el.getAttribute('name') || el.getAttribute('property') || el.getAttribute('http-equiv') || '');
        out = KEEP_META.test(metaName) ? v : /refresh/.test(metaName) ? '0' : this.sanitizeValue(v, metaName);
      } else out = this.sanitizeValue(v, n.replace(/^data-/, ''));
      if (out !== v) el.setAttribute(attr.name, out);
    }
  }

  sanitizeScript(el) {
    const text = el.textContent;
    if (!text.trim()) return;
    const type = (el.getAttribute('type') || '').toLowerCase();
    const pretty = (v) => JSON.stringify(v, null, 2).replace(/</g, '\\u003c');
    if (/json/.test(type) || el.id === '__NEXT_DATA__' || el.id === '__NUXT_DATA__') {
      try {
        el.textContent = pretty(this.sanitizeJson(JSON.parse(text)));
      } catch {
        el.textContent = '';
      }
      return;
    }
    // window.__STATE__ = {...};  /  var initialState = {...};
    const assign = text.match(/^\s*((?:window|self|globalThis)(?:\.[\w$]+|\[["'][\w$]+["']\])+|(?:var|let|const)\s+[\w$]+)\s*=\s*([\s\S]*?);?\s*$/);
    if (assign) {
      try {
        el.textContent = `${assign[1]} = ${pretty(this.sanitizeJson(JSON.parse(assign[2])))};`;
        return;
      } catch {
        /* not a JSON literal */
      }
    }
    // Next.js app router flight data: self.__next_f.push([1,"..."])
    const flight = text.match(/^\s*\(?self\.__next_f\s*=\s*self\.__next_f\s*\|\|\s*\[\]\)?\.push\(([\s\S]*)\)\s*;?\s*$|^\s*self\.__next_f\.push\(([\s\S]*)\)\s*;?\s*$/);
    if (flight) {
      try {
        const arr = JSON.parse(flight[1] || flight[2]);
        const clean = arr.map((x) => (typeof x === 'string' ? this.sanitizeFlight(x) : x));
        el.textContent = `self.__next_f.push(${JSON.stringify(clean).replace(/</g, '\\u003c')})`;
        return;
      } catch {
        /* fall through */
      }
    }
    el.textContent = '/* inline script removed by sanitizer */';
  }

  sanitizeFlight(chunk) {
    return chunk
      .split('\n')
      .map((line) => {
        const m = line.match(/^([0-9a-f]+):([A-Z]{0,2})(.*)$/i);
        if (!m) return line ? this.redact(line, '"[redacted]"') : line;
        const [, id, tag, rest] = m;
        if (tag === 'T') return `${id}:T0,`;
        try {
          return `${id}:${tag}${JSON.stringify(this.sanitizeJson(JSON.parse(rest)))}`;
        } catch {
          return `${id}:${tag}${this.redact(rest, '"[redacted]"')}`;
        }
      })
      .join('\n');
  }

  walk(root, doc) {
    const NodeFilter = doc.defaultView.NodeFilter;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT);
    const nodes = [];
    for (let n = walker.currentNode; n; n = walker.nextNode()) nodes.push(n);
    for (const node of nodes) {
      if (node.nodeType === 8) {
        node.remove();
      } else if (node.nodeType === 3) {
        if (!node.parentNode) continue; // script/style text already replaced
        const parent = node.parentNode.nodeName;
        if (parent === 'SCRIPT' || parent === 'STYLE') continue;
        const out = this.sanitizeText(node.data);
        if (out !== node.data) node.data = out;
      } else if (node.nodeType === 1) {
        this.sanitizeAttributes(node);
        if (node.tagName === 'SCRIPT') this.sanitizeScript(node);
        else if (node.tagName === 'STYLE') node.textContent = '';
        else if (node.tagName === 'TEMPLATE') this.walk(node.content, doc);
      }
    }
  }

  sanitizeHtml(html) {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    this.walk(doc, doc);
    const out = dom.serialize();
    dom.window.close();
    return this.finalPass(out);
  }

  sanitizeJsonFile(text) {
    return this.finalPass(JSON.stringify(this.sanitizeJson(JSON.parse(text)), null, 2) + '\n');
  }

  // Free text you wrote yourself (fixtures/README.md): only URLs, emails and
  // redact terms are changed.
  sanitizeNotes(text) {
    const out = text.replace(/https?:\/\/[^\s)>\]"'`]+/g, (u) => this.sanitizeUrl(u));
    return this.finalPass(out, { leakCheck: false });
  }

  // ---- last line of defence ---------------------------------------------

  finalPass(text, { leakCheck = true } = {}) {
    let out = text;
    for (const term of this.redactTerms) {
      for (const variant of new Set([term, encodeURIComponent(term)])) {
        out = out.replace(new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), VALUE_PLACEHOLDER);
      }
    }
    out = out.replace(EMAIL_RE, (m) => (/@example\.com$/i.test(m) ? m : FAKE_EMAIL));

    const findings = [];
    out.split('\n').forEach((line, i) => {
      for (const rule of SECRET_RULES) {
        const re = new RegExp(rule.re.source, rule.re.flags.replace('g', ''));
        const m = line.match(re);
        if (!m) continue;
        if (rule.allow && rule.allow.test(m[0])) continue;
        if (rule.allowMatch && rule.allowMatch.test(m[0])) continue;
        findings.push({ line: i + 1, problem: rule.name, excerpt: m[0].slice(0, 40) });
      }
    });
    if (leakCheck) {
      const flat = out.replace(/\s+/g, ' ');
      for (const orig of this.redactedOriginals) {
        if (flat.includes(orig)) findings.push({ line: 0, problem: 'redacted text survived elsewhere in the file', excerpt: orig.slice(0, 40) });
      }
    }
    return { text: out, findings };
  }
}
