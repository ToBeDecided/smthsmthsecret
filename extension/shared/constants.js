'use strict';
// Shared by the background page, extension pages, and content scripts.
(function (LMC) {
  LMC.VERSION = '0.1.0';
  LMC.PROTOCOL = 1;

  LMC.STORAGE = {
    settings: 'settings', // { webAppUrl, secret, dryRun }
    outbox: 'outbox', // queued web app calls (never dropped automatically)
    config: 'sheetConfig', // { fetchedAt, fields, lists, mapping } from the Lists/Mapping tabs
    seen: 'seenCaptureIds', // capture IDs already accepted by the sheet
    inboxNew: 'inboxNewCount', // last known count of New rows in Inbox
    lastCapture: 'lastCapture', // summary + rows of the most recent capture (dry run preview)
  };

  LMC.DEFAULT_SETTINGS = { webAppUrl: '', secret: '', dryRun: false };

  // Origins the extension needs. Content-script sites are added per phase.
  // Keep in sync with manifest.json (host_permissions and content_scripts).
  LMC.SITE_ORIGINS = ['https://7sage.com/*', 'https://*.7sage.com/*'];
  LMC.CONTENT_SITES = [{ name: '7Sage', hosts: /(^|\.)7sage\.com$/ }];
  // Same order as content_scripts in manifest.json; the popup injects these
  // into tabs that were open before the add-on was allowed to run there.
  LMC.CONTENT_SCRIPT_FILES = [
    'shared/constants.js',
    'content/lib.js',
    'content/platforms/sevensage.config.js',
    'content/platforms/sevensage.js',
    'content/main.js',
  ];
  LMC.WEB_APP_ORIGINS = ['https://script.google.com/*', 'https://script.googleusercontent.com/*'];

  LMC.INBOX_STATUS = { NEW: 'New', LOGGED: 'Logged', QUICK: 'Quick note', SKIPPED: 'Skipped' };

  LMC.MSG = {
    CAPTURE: 'capture', // content -> background
    CAPTURE_NOW: 'capture-now', // popup -> content
    STATUS: 'status', // page -> background
    SAVE_SETTINGS: 'save-settings',
    TEST_CONNECTION: 'test-connection',
    REFRESH_CONFIG: 'refresh-config',
    FLUSH: 'flush',
    OUTBOX_RETRY: 'outbox-retry',
    OUTBOX_DELETE: 'outbox-delete',
  };
})((globalThis.LMC = globalThis.LMC || {}));
