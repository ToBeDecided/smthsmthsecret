/**
 * Inbox and Mapping tabs for LSAT Miss Capture.
 *
 * Inbox: one row per captured question attempt, keyed by Capture ID. The
 * extension appends here; you turn rows into Journal entries (Logged), a
 * one-line Quick note, or Skip them. Columns are found by header name, so
 * you can reorder them or add your own columns to the right.
 *
 * Mapping: translates site labels to your Lists values.
 *   Field        Platform   Site value                Journal value
 *   Question type 7Sage     Most Strongly Supported   MSS
 * Leave Platform blank to apply to every site. Values that already match a
 * Lists entry (ignoring case) need no row.
 */

const LMC_INBOX_SHEET = 'Inbox';
const LMC_MAPPING_SHEET = 'Mapping';
const LMC_LISTS_SHEET = 'Lists';

// Which Lists column (by its header) holds the allowed values for each
// captured field. Edit the right-hand side if your Lists headers differ.
const LMC_FIELDS = {
  platform: 'Platform',
  questionType: 'Question Type',
  difficulty: 'Difficulty',
};

const LMC_STATUS = { NEW: 'New', LOGGED: 'Logged', QUICK: 'Quick note', SKIPPED: 'Skipped' };

// [header, key]. Order is only used when the tab is first created.
const LMC_INBOX_COLUMNS = [
  ['Capture ID', 'captureId'],
  ['Status', 'status'],
  ['Captured', 'capturedAt'],
  ['Platform', 'platform'],
  ['PT', 'preptest'],
  ['Section', 'section'],
  ['Q#', 'question'],
  ['Question type', 'questionType'],
  ['Difficulty', 'difficulty'],
  ['Timed', 'timed'],
  ['My answer', 'firstAnswer'],
  ['Correct', 'correctAnswer'],
  ['BR answer', 'brAnswer'],
  ['Flagged', 'flagged'],
  ['Time (s)', 'timeSpentSec'],
  ['Attempt date', 'attemptDate'],
  ['Why captured', 'reason'],
  ['Needs review', 'needsReview'],
  ['Quick note', 'quickNote'],
  ['Session', 'session'],
  ['Session key', 'sessionKey'],
  ['Link', 'link'],
  ['Journal row', 'journalRow'],
  ['Updated', 'updatedAt'],
];

const LMC_MAPPING_HEADERS = ['Field', 'Platform', 'Site value', 'Journal value', 'Notes'];
const LMC_MAX_ROWS_PER_APPEND = 500;

// ---- setup --------------------------------------------------------------

/**
 * Creates the Inbox and Mapping tabs if missing and makes a capture secret.
 * Run it from the LSAT Journal menu (or the editor's Run button).
 */
function lmcSetUpCapture() {
  lmcInboxSheet_();
  lmcMappingSheet_();
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty(LMC_SECRET_PROPERTY);
  let fresh = false;
  if (!secret) {
    secret = lmcNewSecret_();
    props.setProperty(LMC_SECRET_PROPERTY, secret);
    fresh = true;
  }
  lmcShowSecret_(secret, fresh);
}

/** Replaces the secret. The extension stops working until you paste the new one. */
function lmcRotateCaptureSecret() {
  const secret = lmcNewSecret_();
  PropertiesService.getScriptProperties().setProperty(LMC_SECRET_PROPERTY, secret);
  lmcShowSecret_(secret, true);
}

function lmcNewSecret_() {
  const seed = Utilities.getUuid() + Utilities.getUuid() + Date.now();
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed);
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '');
}

function lmcShowSecret_(secret, fresh) {
  const intro = fresh ? 'New capture secret created.' : 'Capture secret (unchanged).';
  try {
    const html = HtmlService.createHtmlOutput(
      '<p style="font:14px system-ui">' + intro + ' Paste it into the extension options (step 2), together with the web app URL.</p>' +
        '<input style="width:100%;font:13px monospace;padding:6px" readonly onclick="this.select()" value="' + secret + '">' +
        '<p style="font:12px system-ui;color:#555">It is stored in Project Settings → Script Properties as ' + LMC_SECRET_PROPERTY +
        '. Anyone with the secret and the URL can add rows to your Inbox, so keep both private.</p>',
    )
      .setWidth(460)
      .setHeight(200);
    SpreadsheetApp.getUi().showModalDialog(html, 'LSAT Miss Capture');
  } catch (err) {
    // Run from the editor: no dialog available. The log is visible only to you.
    console.log(intro + ' Copy it from Project Settings → Script Properties → ' + LMC_SECRET_PROPERTY + '.');
  }
}

function lmcInboxSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(LMC_INBOX_SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(LMC_INBOX_SHEET);
  const headers = LMC_INBOX_COLUMNS.map(function (c) { return c[0]; });
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  const statusCol = headers.indexOf('Status') + 1;
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList([LMC_STATUS.NEW, LMC_STATUS.LOGGED, LMC_STATUS.QUICK, LMC_STATUS.SKIPPED], true)
    .setAllowInvalid(false)
    .build();
  sh.getRange(2, statusCol, sh.getMaxRows() - 1, 1).setDataValidation(rule);
  return sh;
}

function lmcMappingSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(LMC_MAPPING_SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(LMC_MAPPING_SHEET);
  sh.getRange(1, 1, 1, LMC_MAPPING_HEADERS.length).setValues([LMC_MAPPING_HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  const fieldRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(Object.keys(LMC_FIELDS).map(function (k) { return LMC_FIELDS[k]; }), true)
    .build();
  sh.getRange(2, 1, sh.getMaxRows() - 1, 1).setDataValidation(fieldRule);
  return sh;
}

// ---- reading ------------------------------------------------------------

// { header: columnNumber } for the first row of a sheet.
function lmcHeaderIndex_(sh) {
  const width = Math.max(sh.getLastColumn(), 1);
  const headers = sh.getRange(1, 1, 1, width).getValues()[0];
  const index = {};
  headers.forEach(function (h, i) {
    const name = String(h).trim();
    if (name && !index[name]) index[name] = i + 1;
  });
  return { index: index, width: width };
}

// Inbox column numbers by key, adding any of our headers that are missing.
function lmcInboxColumns_(sh) {
  let info = lmcHeaderIndex_(sh);
  const missing = LMC_INBOX_COLUMNS.filter(function (c) { return !info.index[c[0]]; });
  if (missing.length) {
    const start = sh.getLastColumn() + 1;
    sh.getRange(1, start, 1, missing.length).setValues([missing.map(function (c) { return c[0]; })]).setFontWeight('bold');
    info = lmcHeaderIndex_(sh);
  }
  const byKey = {};
  LMC_INBOX_COLUMNS.forEach(function (c) { byKey[c[1]] = info.index[c[0]]; });
  return { byKey: byKey, width: info.width };
}

function lmcInboxData_() {
  const sh = lmcInboxSheet_();
  const cols = lmcInboxColumns_(sh);
  const n = sh.getLastRow() - 1;
  const values = n > 0 ? sh.getRange(2, 1, n, cols.width).getValues() : [];
  return { sh: sh, cols: cols, values: values };
}

function lmcRowObject_(cols, line, rowNumber) {
  const out = { row: rowNumber };
  Object.keys(cols.byKey).forEach(function (key) {
    let v = line[cols.byKey[key] - 1];
    if (v instanceof Date) v = v.toISOString();
    out[key] = v;
  });
  return out;
}

function lmcCountNew_() {
  const d = lmcInboxData_();
  const statusIdx = d.cols.byKey.status - 1;
  return d.values.filter(function (line) { return line[statusIdx] === LMC_STATUS.NEW; }).length;
}

function lmcListInbox_(filter) {
  const d = lmcInboxData_();
  const out = [];
  d.values.forEach(function (line, i) {
    const item = lmcRowObject_(d.cols, line, i + 2);
    if (filter.status && item.status !== filter.status) return;
    if (filter.sessionKey && item.sessionKey !== filter.sessionKey) return;
    if (filter.platform && item.platform !== filter.platform) return;
    out.push(item);
  });
  return out.slice(-200);
}

// { header: [values...] } from the Lists tab: each column is one list, header on top.
function lmcReadLists_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LMC_LISTS_SHEET);
  if (!sh || sh.getLastRow() < 1) return {};
  const values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
  const lists = {};
  values[0].forEach(function (header, c) {
    const name = String(header).trim();
    if (!name) return;
    const items = [];
    for (let r = 1; r < values.length; r++) {
      const v = String(values[r][c]).trim();
      if (v) items.push(v);
    }
    lists[name] = items;
  });
  return lists;
}

function lmcReadMapping_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LMC_MAPPING_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  const info = lmcHeaderIndex_(sh);
  const col = function (name) { return info.index[name] - 1; };
  return sh
    .getRange(2, 1, sh.getLastRow() - 1, info.width)
    .getDisplayValues()
    .map(function (line) {
      return {
        field: String(line[col('Field')] || '').trim(),
        platform: String(line[col('Platform')] || '').trim(),
        from: String(line[col('Site value')] || '').trim(),
        to: String(line[col('Journal value')] || '').trim(),
      };
    })
    .filter(function (m) { return m.field && m.from && m.to; });
}

// ---- writing ------------------------------------------------------------

// Strings starting with = + - @ would be read as formulas by setValues.
function lmcSafeCell_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = String(v).slice(0, 1000);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function lmcAppendInbox_(rows) {
  if (!Array.isArray(rows)) throw lmcFail_('bad_request', 'rows must be a list.');
  if (rows.length > LMC_MAX_ROWS_PER_APPEND) throw lmcFail_('bad_request', 'Too many rows in one request.');
  const d = lmcInboxData_();
  const idIdx = d.cols.byKey.captureId - 1;
  const known = {};
  d.values.forEach(function (line) { known[line[idIdx]] = true; });

  const now = new Date();
  const out = [];
  let duplicates = 0;
  rows.forEach(function (r) {
    const id = String((r && r.captureId) || '');
    if (!/^[A-Za-z0-9?-]{6,80}$/.test(id)) throw lmcFail_('bad_request', 'Bad capture ID: ' + id.slice(0, 40));
    if (known[id]) {
      duplicates++;
      return;
    }
    known[id] = true;
    const line = new Array(d.cols.width).fill('');
    LMC_INBOX_COLUMNS.forEach(function (c) {
      line[d.cols.byKey[c[1]] - 1] = lmcSafeCell_(r[c[1]]);
    });
    line[d.cols.byKey.status - 1] = LMC_STATUS.NEW;
    line[d.cols.byKey.capturedAt - 1] = r.capturedAt ? new Date(r.capturedAt) : now;
    line[d.cols.byKey.updatedAt - 1] = now;
    line[d.cols.byKey.journalRow - 1] = '';
    line[d.cols.byKey.quickNote - 1] = '';
    out.push(line);
  });
  if (out.length) d.sh.getRange(d.sh.getLastRow() + 1, 1, out.length, d.cols.width).setValues(out);
  return { added: out.length, duplicates: duplicates, newCount: lmcCountNew_() };
}

function lmcFindInboxRow_(captureId) {
  const d = lmcInboxData_();
  const idIdx = d.cols.byKey.captureId - 1;
  for (let i = 0; i < d.values.length; i++) {
    if (d.values[i][idIdx] === captureId) return { sh: d.sh, cols: d.cols, row: i + 2, line: d.values[i] };
  }
  throw lmcFail_('not_found', 'No Inbox row with capture ID ' + captureId);
}

function lmcSetInboxStatus_(captureId, status, quickNote) {
  const allowed = [LMC_STATUS.NEW, LMC_STATUS.QUICK, LMC_STATUS.SKIPPED];
  if (allowed.indexOf(status) < 0) throw lmcFail_('bad_request', 'Status must be one of: ' + allowed.join(', '));
  if (status === LMC_STATUS.QUICK && !String(quickNote || '').trim()) throw lmcFail_('bad_request', 'A quick note needs text.');
  const hit = lmcFindInboxRow_(String(captureId || ''));
  const set = function (key, value) { hit.sh.getRange(hit.row, hit.cols.byKey[key]).setValue(value); };
  set('status', status);
  if (quickNote !== undefined) set('quickNote', lmcSafeCell_(String(quickNote).trim()));
  set('updatedAt', new Date());
  return { row: hit.row, status: status, newCount: lmcCountNew_() };
}
