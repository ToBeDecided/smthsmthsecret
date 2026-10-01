// Minimal stand-in for the Firefox WebExtension APIs the background page uses.
export function fakeBrowser({ granted = true } = {}) {
  const data = {};
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => (listeners[name] = listeners[name] || []).push(fn) });
  const badge = { text: '', color: '', title: '' };
  const alarms = new Map();
  return {
    data,
    listeners,
    badge,
    alarmsMap: alarms,
    openedOptions: 0,
    storage: {
      local: {
        get: async (k) => (k in data ? { [k]: structuredClone(data[k]) } : {}),
        set: async (o) => {
          for (const [k, v] of Object.entries(o)) data[k] = structuredClone(v);
        },
      },
    },
    runtime: {
      id: 'lsat-miss-capture@test',
      onMessage: on('message'),
      onInstalled: on('installed'),
      onStartup: on('startup'),
      openOptionsPage() {
        this._opened = (this._opened || 0) + 1;
      },
    },
    alarms: {
      create: (name, info) => alarms.set(name, info),
      clear: async (name) => alarms.delete(name),
      onAlarm: on('alarm'),
    },
    permissions: {
      contains: async () => granted,
      onAdded: on('permAdded'),
      onRemoved: on('permRemoved'),
    },
    action: {
      setBadgeText: async ({ text }) => (badge.text = text),
      setBadgeBackgroundColor: async ({ color }) => (badge.color = color),
      setTitle: async ({ title }) => (badge.title = title),
    },
  };
}

// Sends a runtime message the way a content script or extension page would.
export async function send(browser, msg, sender = {}) {
  const [listener] = browser.listeners.message;
  return listener(msg, { id: browser.runtime.id, ...sender });
}
