// Minimal in-page stand-in for the chrome.* APIs the extension uses, so the real content script and popup
// can run together on one ordinary web page (the test harness).
(function () {
  'use strict';
  const store = {};
  const storageListeners = [];
  const messageListeners = [];
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  window.chrome = {
    storage: {
      local: {
        async get(keys) {
          const ks = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of ks) if (k in store) out[k] = clone(store[k]);
          return out;
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: clone(store[k]), newValue: clone(v) };
            store[k] = clone(v);
          }
          setTimeout(() => storageListeners.forEach(l => l(changes, 'local')), 0);
        },
      },
      onChanged: { addListener(f) { storageListeners.push(f); } },
    },
    runtime: { onMessage: { addListener(f) { messageListeners.push(f); } } },
    tabs: {
      async query() { return [{ id: 1 }]; },
      sendMessage(tabId, msg) {
        return new Promise((resolve) => {
          let done = false;
          const respond = r => { if (!done) { done = true; resolve(r); } };
          for (const l of messageListeners) l(msg, {}, respond);
          setTimeout(() => respond(undefined), 1000);
        });
      },
    },
  };
})();
