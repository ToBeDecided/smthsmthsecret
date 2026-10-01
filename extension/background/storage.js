'use strict';
// browser.storage.local helpers. Read-modify-write updates are serialized per
// key so two captures arriving together can never overwrite each other.
(function (LMC) {
  const chains = new Map();

  async function get(key, fallback) {
    const result = await browser.storage.local.get(key);
    return result[key] === undefined ? fallback : result[key];
  }

  async function set(key, value) {
    await browser.storage.local.set({ [key]: value });
  }

  function update(key, fn, fallback) {
    const prev = chains.get(key) || Promise.resolve();
    const next = prev.then(async () => {
      const value = await fn(await get(key, fallback));
      await set(key, value);
      return value;
    });
    chains.set(key, next.catch(() => {}));
    return next;
  }

  async function getSettings() {
    return { ...LMC.DEFAULT_SETTINGS, ...(await get(LMC.STORAGE.settings, {})) };
  }

  function saveSettings(patch) {
    return update(LMC.STORAGE.settings, (s) => ({ ...LMC.DEFAULT_SETTINGS, ...s, ...patch }), {});
  }

  LMC.store = { get, set, update, getSettings, saveSettings };
})((globalThis.LMC = globalThis.LMC || {}));
