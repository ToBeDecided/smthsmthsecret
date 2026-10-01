// Just enough of the Apps Script runtime (SpreadsheetApp, PropertiesService,
// LockService, ContentService, Utilities, HtmlService) to run the files in
// apps-script/ under Node against in-memory sheets.
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../../apps-script/', import.meta.url));

class FakeRange {
  constructor(sheet, row, col, rows, cols) {
    Object.assign(this, { sheet, row, col, rows, cols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const line = [];
      for (let c = 0; c < this.cols; c++) line.push(this.sheet.cell(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  getDisplayValues() {
    return this.getValues().map((line) => line.map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v))));
  }
  getValue() {
    return this.sheet.cell(this.row, this.col);
  }
  setValues(values) {
    if (values.length !== this.rows || values.some((l) => l.length !== this.cols)) {
      throw new Error(`setValues: data is ${values.length}x${values[0] && values[0].length}, range is ${this.rows}x${this.cols}`);
    }
    values.forEach((line, r) => line.forEach((v, c) => this.sheet.put(this.row + r, this.col + c, v)));
    return this;
  }
  setValue(v) {
    this.sheet.put(this.row, this.col, v);
    return this;
  }
  setFontWeight() {
    return this;
  }
  setDataValidation() {
    return this;
  }
}

export class FakeSheet {
  constructor(name, rows = []) {
    this.name = name;
    this.data = rows.map((r) => [...r]);
    this.maxRows = 1000;
  }
  cell(r, c) {
    const v = this.data[r - 1] && this.data[r - 1][c - 1];
    return v === undefined ? '' : v;
  }
  put(r, c, v) {
    // Like typing into a cell: a leading apostrophe forces text and is hidden.
    if (typeof v === 'string' && v.startsWith('=')) this.formulas = (this.formulas || 0) + 1;
    while (this.data.length < r) this.data.push([]);
    this.data[r - 1][c - 1] = v;
  }
  getName() {
    return this.name;
  }
  getLastRow() {
    for (let r = this.data.length; r > 0; r--) if (this.data[r - 1].some((v) => v !== '' && v != null)) return r;
    return 0;
  }
  getLastColumn() {
    let max = 0;
    for (const line of this.data) for (let c = line.length; c > max; c--) if (line[c - 1] !== '' && line[c - 1] != null) max = c;
    return max;
  }
  getMaxRows() {
    return this.maxRows;
  }
  getRange(row, col, rows = 1, cols = 1) {
    return new FakeRange(this, row, col, rows, cols);
  }
  setFrozenRows() {}
  // Inbox rows as objects keyed by header, for assertions.
  records() {
    const [head, ...body] = this.data;
    return body.map((line) => Object.fromEntries(head.map((h, i) => [h, line[i] === undefined ? '' : line[i]])));
  }
}

export function appsScript({ sheets = {}, secret = 'test-secret-apps-script', name = 'Test Journal' } = {}) {
  const book = new Map(Object.entries(sheets).map(([n, rows]) => [n, new FakeSheet(n, rows)]));
  const props = new Map(secret ? [['LMC_SECRET', secret]] : []);
  const spreadsheet = {
    getName: () => name,
    getSheetByName: (n) => book.get(n) || null,
    insertSheet: (n) => {
      const sh = new FakeSheet(n);
      book.set(n, sh);
      return sh;
    },
  };
  const builder = () => {
    const b = { requireValueInList: () => b, setAllowInvalid: () => b, build: () => ({}) };
    return b;
  };
  const ctx = vm.createContext({
    console: { log() {}, error() {}, warn() {} },
    Date,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      newDataValidation: builder,
      getUi: () => {
        throw new Error('Cannot call SpreadsheetApp.getUi() from this context.');
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (s) => ({ setMimeType() { return this; }, getContent: () => s }),
    },
    HtmlService: { createHtmlOutput: () => ({ setWidth() { return this; }, setHeight() { return this; } }) },
    Utilities: {
      getUuid: () => randomUUID(),
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (alg, s) => [...createHash(alg).update(s).digest()],
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64url'),
    },
  });
  for (const f of readdirSync(DIR).filter((f) => f.endsWith('.gs')).sort()) {
    vm.runInContext(readFileSync(DIR + f, 'utf8'), ctx, { filename: f });
  }

  // POST the way the extension does and return the parsed JSON body.
  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).getContent());

  // A fetch() that routes to doPost, for end-to-end tests with the extension.
  const fetch = async (url, init) => {
    const text = ctx.doPost({ postData: { contents: init.body } }).getContent();
    return { ok: true, status: 200, text: async () => text };
  };

  return { ctx, book, props, post, fetch, secret };
}
