// Training Wire — storage shim
//
// The tool used `chrome?.storage?.local?.get(keys, cb)` inline. Optional
// chaining makes that safe from throwing, but it also means the whole call
// short-circuits to undefined when chrome.storage is missing — so the callback
// never fires and whatever was waiting on it just stalls silently. That is
// survivable for a preference, and fatal for anything that gates the UI.
//
// This always calls back, exactly once: chrome.storage.local in the extension,
// localStorage when the page is opened directly, and an in-memory map if even
// that is unavailable (private mode, blocked site data).
console.log('Training Wire: Store loaded');

const TWStore = (() => {
  'use strict';

  const PREFIX = 'tw:';
  const mem = new Map();

  function hasChromeStorage() {
    try { return !!(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local); }
    catch (e) { return false; }
  }

  function lsGet(key) {
    try {
      const raw = window.localStorage.getItem(PREFIX + key);
      return raw === null ? undefined : JSON.parse(raw);
    } catch (e) { return mem.get(key); }
  }
  function lsSet(key, value) {
    try { window.localStorage.setItem(PREFIX + key, JSON.stringify(value)); }
    catch (e) { mem.set(key, value); }
  }
  function lsRemove(key) {
    try { window.localStorage.removeItem(PREFIX + key); } catch (e) {}
    mem.delete(key);
  }

  function get(keys, cb) {
    const list = Array.isArray(keys) ? keys : [keys];
    const done = (obj) => setTimeout(() => cb(obj || {}), 0);
    if (hasChromeStorage()) {
      try {
        chrome.storage.local.get(list, r => {
          void chrome.runtime?.lastError;
          cb(r || {});
        });
        return;
      } catch (e) { /* fall through to localStorage */ }
    }
    const out = {};
    list.forEach(k => { const v = lsGet(k); if (v !== undefined) out[k] = v; });
    done(out);
  }

  function set(obj, cb) {
    if (hasChromeStorage()) {
      try {
        chrome.storage.local.set(obj, () => { void chrome.runtime?.lastError; cb?.(); });
        return;
      } catch (e) { /* fall through to localStorage */ }
    }
    Object.keys(obj).forEach(k => lsSet(k, obj[k]));
    setTimeout(() => cb?.(), 0);
  }

  function remove(keys, cb) {
    const list = Array.isArray(keys) ? keys : [keys];
    if (hasChromeStorage()) {
      try {
        chrome.storage.local.remove(list, () => { void chrome.runtime?.lastError; cb?.(); });
        return;
      } catch (e) { /* fall through to localStorage */ }
    }
    list.forEach(lsRemove);
    setTimeout(() => cb?.(), 0);
  }

  return { get, set, remove };
})();

if (typeof window !== 'undefined') window.TWStore = TWStore;
