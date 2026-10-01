/**
 * Web app endpoint for the LSAT Miss Capture Firefox extension.
 *
 * Deploy: Deploy → New deployment → Web app
 *   Execute as:      Me
 *   Who has access:  Anyone   ← anyone with the URL can reach it, which is
 *                               why every request must carry the secret.
 *
 * The secret lives in Script Properties under LMC_SECRET (see
 * lmcSetUpCapture in Inbox.gs). It is compared in constant time and is only
 * ever accepted in the POST body, never in a URL.
 */

const LMC_PROTOCOL = 1;
const LMC_SECRET_PROPERTY = 'LMC_SECRET';
const LMC_LOCK_WAIT_MS = 20000;

// Health check only: confirms the URL works when opened in a browser.
// Returns no data and needs no secret.
function doGet() {
  return lmcJson_({ ok: true, data: { app: 'lsat-miss-capture', protocol: LMC_PROTOCOL } });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '');
  } catch (err) {
    return lmcJson_(lmcErrorBody_('bad_request', 'Request body is not JSON.'));
  }
  const auth = lmcCheckSecret_(req && req.secret);
  if (auth) return lmcJson_(lmcErrorBody_('auth', auth));

  const handler = LMC_ACTIONS[req.action];
  if (!handler) return lmcJson_(lmcErrorBody_('unknown_action', 'Unknown action: ' + req.action));

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LMC_LOCK_WAIT_MS)) return lmcJson_(lmcErrorBody_('busy', 'The sheet is busy. The extension will retry.'));
  try {
    return lmcJson_({ ok: true, data: handler(req.payload || {}, req) });
  } catch (err) {
    console.error('lsat-miss-capture ' + req.action + ' failed: ' + (err && err.stack || err));
    return lmcJson_(lmcErrorBody_((err && err.lmcCode) || 'server', String((err && err.message) || err)));
  } finally {
    lock.releaseLock();
  }
}

// Each action takes the request payload and returns plain data.
const LMC_ACTIONS = {
  ping: function () {
    return {
      protocol: LMC_PROTOCOL,
      sheet: SpreadsheetApp.getActiveSpreadsheet().getName(),
      inboxNew: lmcCountNew_(),
    };
  },
  config: function () {
    return { fields: LMC_FIELDS, lists: lmcReadLists_(), mapping: lmcReadMapping_() };
  },
  counts: function () {
    return { new: lmcCountNew_() };
  },
  append: function (payload) {
    return lmcAppendInbox_(payload.rows);
  },
  listNew: function (payload) {
    return { items: lmcListInbox_({ status: LMC_STATUS.NEW, sessionKey: payload.sessionKey, platform: payload.platform }) };
  },
  setStatus: function (payload) {
    return lmcSetInboxStatus_(payload.captureId, payload.status, payload.quickNote);
  },
};

function lmcCheckSecret_(given) {
  const expected = PropertiesService.getScriptProperties().getProperty(LMC_SECRET_PROPERTY);
  if (!expected) return 'The web app has no secret yet. In the sheet: LSAT Journal → Set up capture.';
  if (typeof given !== 'string' || given.length !== expected.length) return 'Wrong or missing secret.';
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0 ? '' : 'Wrong or missing secret.';
}

function lmcJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function lmcErrorBody_(code, message) {
  return { ok: false, error: { code: code, message: message } };
}

function lmcFail_(code, message) {
  const err = new Error(message);
  err.lmcCode = code;
  return err;
}
