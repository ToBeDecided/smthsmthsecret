import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, scanPath } from '../scripts/scan-secrets.mjs';

// Assembled at runtime so this file passes the scan itself.
const rules = (text) => scanText(text, 'x').map((f) => f.rule);
const DEPLOY = 'AKfyc' + 'bx'.repeat(20);

test('catches Apps Script URLs and deployment IDs', () => {
  assert.deepEqual(rules(`const url = 'https://script.google.com/macros/s/${DEPLOY}/exec';`), [
    'Apps Script web app URL',
    'Apps Script deployment ID',
  ]);
  assert.deepEqual(rules('https://script.googleusercontent.com/macros/' + 'echo?user_content_key=abc'), ['Apps Script redirect URL']);
  assert.deepEqual(rules(`"scriptId": "${'1'.repeat(1)}${'Ab9_'.repeat(12)}"`), ['Apps Script script ID']);
});

test('catches sheet URLs, keys and tokens', () => {
  assert.deepEqual(rules('https://docs.google.com/spreadsheets/d/' + '1aB'.repeat(10) + '/edit'), ['Google Docs/Sheets URL']);
  assert.deepEqual(rules('AI' + 'za' + 'S'.repeat(35)), ['Google API key']);
  assert.deepEqual(rules('ya' + '29.' + 'a0'.repeat(15)), ['Google OAuth access token']);
  assert.deepEqual(rules('gh' + 'p_' + 'A1'.repeat(18)), ['GitHub token']);
  assert.deepEqual(rules('WEB_EXT_API_KEY=user:' + '1234567:89'), ['AMO API key']);
  assert.deepEqual(rules(`secret: '${'q9'.repeat(10)}'`), ['hard-coded secret']);
});

test('catches personal email addresses but not placeholders', () => {
  assert.deepEqual(rules('contact ' + 'someone' + '@' + 'gmail.com'), ['email address']);
  assert.deepEqual(rules('user@example.com, x@foo.test, 12345+abc@users.noreply.github.com'), []);
});

test('allows obvious placeholders and the allow marker', () => {
  assert.deepEqual(rules(`secret: 'example-secret-value'`), []);
  assert.deepEqual(rules(`secret: '${'q9'.repeat(10)}' // scan-secrets:allow`), []);
});

test('blocks private paths', () => {
  assert.equal(scanPath('reference/Code.gs').length, 1);
  assert.equal(scanPath('fixtures/raw/7sage/drill.html').length, 1);
  assert.equal(scanPath('fixtures/README.md').length, 1);
  assert.equal(scanPath('.clasp.json').length, 1);
  assert.equal(scanPath('fixtures/clean/7sage/drill.html').length, 0);
});
