// sn_milo MAIN-world settings helper (classic content script, IIFE: no global lexical declarations).
// MAIN scripts cannot read chrome.storage; this helper receives EFFECTIVE state from the ISOLATED controller
// (shared/controller.js) over the versioned window.postMessage protocol documented there, and exposes:
//   window.__snMiloMainSettings = {version, id, subscribe(feature, cb) → unsubscribe, get(feature), stop()}
//   cb({enabled, seedOnly}) runs once when the state first becomes known and on every change of that feature.
// Pattern for MAIN features (load after this entry): stay inert until cb reports enabled; on disabled, stop
// timers/observers/listeners and remove owned UI (draft-preserving where required). Re-check get(feature)
// after every await before side effects.
// ponytail: accepted risk — the page shares this window and can forge or observe these messages; nothing here is
// an authentication boundary. Privileged enforcement stays in the service worker.
// Ordering: messages carry the controller's record epoch/rev; a record older than the last accepted one in the
// same epoch is ignored even from a different controllerId (a new epoch means storage was reset: accepted).
// Takeover: a reinjected helper adopts the previous helper's subscribers and state, then stops it.
(() => {
  'use strict';
  const PROTOCOL = 'sn-milo-settings';
  const VERSION = 1;
  const ORIGIN = location.origin;
  if (typeof ORIGIN !== 'string' || !/^https:\/\/[^/]+$/.test(ORIGIN)) return;

  const previous = window.__snMiloMainSettings;
  const subscribers = new Map(); // feature -> Set<cb>
  let features = null;
  let controllerId = null;
  let seq = 0;
  let epoch = null;
  let rev = -1;
  let stopped = false;
  const id = (() => { try { return crypto.randomUUID(); } catch { return `m${Date.now()}${Math.random()}`; } })();

  const same = (a, b) => Boolean(a) && Boolean(b) && a.enabled === b.enabled && a.seedOnly === b.seedOnly;
  function get(feature) { const s = features?.[feature]; return s ? {enabled: s.enabled, seedOnly: s.seedOnly} : null; }
  function notify(feature, state) {
    for (const cb of [...(subscribers.get(feature) || [])]) {
      try { cb({...state}); } catch (error) { console.warn('[SN-MILO] settings subscriber failed', feature, error); }
    }
  }
  function subscribe(feature, cb) {
    if (typeof cb !== 'function') throw new TypeError('callback required');
    if (!subscribers.has(feature)) subscribers.set(feature, new Set());
    subscribers.get(feature).add(cb);
    const s = get(feature);
    if (s) { try { cb(s); } catch (error) { console.warn('[SN-MILO] settings subscriber failed', feature, error); } }
    return () => { subscribers.get(feature)?.delete(cb); };
  }

  function validFeatures(f) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
    return Object.values(f).every(s => s && typeof s === 'object' && typeof s.enabled === 'boolean' && typeof s.seedOnly === 'boolean');
  }
  function onMessage(event) {
    if (stopped || event.source !== window || event.origin !== ORIGIN) return;
    const d = event.data;
    if (!d || typeof d !== 'object' || d.source !== 'sn-milo-controller' || d.protocol !== PROTOCOL || d.version !== VERSION || d.type !== 'settings') return;
    if (typeof d.controllerId !== 'string' || !Number.isSafeInteger(d.seq) || !validFeatures(d.features)) return;
    if (typeof d.epoch !== 'string' || !Number.isSafeInteger(d.rev)) return;
    if (d.controllerId === controllerId && d.seq <= seq) return; // out-of-date duplicate
    if (d.epoch === epoch && d.rev < rev) return; // older record (e.g. from an orphaned controller)
    controllerId = d.controllerId;
    seq = d.seq;
    epoch = d.epoch;
    rev = d.rev;
    const before = features || {};
    const next = {};
    for (const [name, s] of Object.entries(d.features)) next[name] = {enabled: s.enabled, seedOnly: s.seedOnly};
    features = next;
    const names = new Set([...Object.keys(before), ...Object.keys(next), ...subscribers.keys()]);
    for (const name of names) {
      const now = next[name] || {enabled: false, seedOnly: false};
      if (!same(before[name], now)) notify(name, now);
    }
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    window.removeEventListener('message', onMessage);
  }

  const api = Object.freeze({version: VERSION, id, subscribe, get, stop, _adopt: () => ({subscribers, features, controllerId, seq, epoch, rev})});
  window.addEventListener('message', onMessage);
  if (previous && typeof previous.stop === 'function') {
    try {
      const old = typeof previous._adopt === 'function' ? previous._adopt() : null;
      if (old) {
        for (const [feature, set] of old.subscribers) for (const cb of set) { if (!subscribers.has(feature)) subscribers.set(feature, new Set()); subscribers.get(feature).add(cb); }
        features = old.features; controllerId = old.controllerId; seq = old.seq;
        if (typeof old.epoch === 'string') { epoch = old.epoch; rev = old.rev; }
      }
      previous.stop();
    } catch {}
  }
  window.__snMiloMainSettings = api;
  try { window.postMessage({source: 'sn-milo-main', protocol: PROTOCOL, version: VERSION, type: 'request'}, ORIGIN); } catch {}
})();
