import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadExtension } from './helpers/load.mjs';

const LMC = loadExtension(['shared/constants.js', 'content/lib.js']);

test('seconds() reads the time formats sites use', () => {
  const s = LMC.dom.seconds;
  assert.equal(s('1:23'), 83);
  assert.equal(s('01:02:03'), 3723);
  assert.equal(s('83s'), 83);
  assert.equal(s('1m 23s'), 83);
  assert.equal(s('2 min'), 120);
  assert.equal(s(''), null);
  assert.equal(s('n/a'), null);
});

test('isoDate() gives the local calendar date', () => {
  assert.equal(LMC.dom.isoDate('2026-09-28T14:03:11'), '2026-09-28');
  assert.equal(LMC.dom.isoDate(''), '');
  assert.equal(LMC.dom.isoDate('garbage'), '');
  assert.match(LMC.dom.isoDate(1790000000), /^\d{4}-\d{2}-\d{2}$/);
});

test('registerPlatform ignores duplicates (popup re-injection)', () => {
  LMC.registerPlatform({ name: 'X' });
  LMC.registerPlatform({ name: 'X' });
  assert.equal(LMC.platforms.length, 1);
});

test('manifest permissions match the origins the code checks', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  for (const origin of [...LMC.SITE_ORIGINS, ...LMC.WEB_APP_ORIGINS]) {
    assert.ok(manifest.host_permissions.includes(origin), `missing host permission ${origin}`);
  }
  for (const cs of manifest.content_scripts || []) {
    assert.deepEqual([...cs.js], [...LMC.CONTENT_SCRIPT_FILES], 'content_scripts must match CONTENT_SCRIPT_FILES');
  }
});
