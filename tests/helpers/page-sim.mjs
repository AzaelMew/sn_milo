// Simulates one document (frame) with script worlds sharing a window and DOM: MAIN (page) and one ISOLATED world
// PER EXTENSION INSTANCE (observed in Vivaldi 8.2 / Chromium: after an extension reload, scripting.executeScript runs
// in a NEW isolated world with its own globalThis; the old instance's world keeps its globals and listeners, and
// its `chrome` bindings are dead). window.postMessage is asynchronous and delivered to listeners of EVERY world,
// with event.source = that world's window and event.origin = the frame origin, like Chromium. `document` (visibility
// + visibilitychange) is shared by all worlds. setInterval/clearInterval are fake and driven by frame.advance(ms).
// Content scripts are evaluated as classic scripts.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sources = new Map();
export const source = rel => { if (!sources.has(rel)) sources.set(rel, fs.readFileSync(path.join(repo, rel), 'utf8')); return sources.get(rel); };

// Optional `document`: extra property descriptors grafted onto every world's document (e.g. a fake DOM for feature
// tests: tests/helpers/informatica-sim.mjs domMixin); visibility/visibilitychange stay page-sim's own.
export function createFrame({origin, url = `${origin}/`, logs = [], document: extraDocument} = {}) {
  const all = []; // every world ever created in this frame
  const doc = {visibilityState: 'visible', listeners: []};
  let clock = 0;
  const frame = {origin, logs, worlds: {}, staleIsolated: [], posted: []};
  function makeWorld(kind) {
    const w = {kind, listeners: [], intervals: new Map(), nextInterval: 1};
    const document = {
      get visibilityState() { return doc.visibilityState; },
      get hidden() { return doc.visibilityState !== 'visible'; },
      addEventListener(type, fn) { doc.listeners.push({w, type, fn}); },
      removeEventListener(type, fn) { const i = doc.listeners.findIndex(l => l.w === w && l.type === type && l.fn === fn); if (i >= 0) doc.listeners.splice(i, 1); }
    };
    if (extraDocument) Object.defineProperties(document, extraDocument);
    const g = {
      console: {log: (...a) => logs.push(['log', kind, ...a]), warn: (...a) => logs.push(['warn', kind, ...a]), error: (...a) => logs.push(['error', kind, ...a])},
      crypto: globalThis.crypto, setTimeout, clearTimeout, structuredClone, document,
      setInterval(fn, ms) { const id = w.nextInterval++; w.intervals.set(id, {fn, ms, next: clock + ms}); return id; },
      clearInterval(id) { w.intervals.delete(id); },
      location: {origin, href: url, pathname: (() => { try { return new URL(url).pathname; } catch { return '/'; } })()},
      addEventListener(type, fn) { w.listeners.push({type, fn}); },
      removeEventListener(type, fn) { const i = w.listeners.findIndex(l => l.type === type && l.fn === fn); if (i >= 0) w.listeners.splice(i, 1); },
      postMessage(data, targetOrigin) {
        if (targetOrigin === 'null' || targetOrigin === undefined) throw new SyntaxError(`Invalid target origin '${targetOrigin}'`);
        frame.posted.push({from: kind, data: structuredClone(data), targetOrigin});
        if (targetOrigin !== '*' && targetOrigin !== origin) return; // silently dropped, like the browser
        const copy = structuredClone(data);
        setTimeout(() => frame.dispatch(copy), 0);
      }
    };
    vm.createContext(g);
    g.window = g; g.self = g; g.globalThis = g;
    vm.runInContext('globalThis.window = this; globalThis.self = this;', g);
    g.__inner = vm.runInContext('globalThis', g); // the in-context global (=== `window` inside the world)
    w.g = g;
    all.push(w);
    return w;
  }
  const worldOf = k => (typeof k === 'string' ? frame.worlds[k] : k);
  frame.worlds.isolated = makeWorld('isolated');
  frame.worlds.main = makeWorld('main');
  frame.dispatch = (data, {eventOrigin = origin, fromForeignWindow = false} = {}) => {
    for (const w of all) {
      for (const l of [...w.listeners]) if (l.type === 'message') {
        l.fn({data: structuredClone(data), origin: eventOrigin, source: fromForeignWindow ? {} : w.g.__inner});
      }
    }
  };
  frame.setChrome = chrome => { frame.worlds.isolated.g.chrome = chrome; };
  /** Extension reloaded/updated: a NEW isolated world (fresh globalThis) for the new instance's injections. The
   *  previous world (and everything in it) stays alive in frame.staleIsolated. */
  frame.newExtensionInstance = chrome => {
    frame.staleIsolated.push(frame.worlds.isolated);
    frame.worlds.isolated = makeWorld('isolated');
    if (chrome) frame.setChrome(chrome);
    return frame.worlds.isolated;
  };
  frame.run = (k, rel) => vm.runInContext(source(rel), worldOf(k).g, {filename: rel});
  frame.eval = (k, code) => vm.runInContext(code, worldOf(k).g);
  frame.count = k => worldOf(k).listeners.filter(l => l.type === 'message').length;
  frame.intervals = k => worldOf(k).intervals.size;
  frame.docListeners = k => doc.listeners.filter(l => l.w === worldOf(k)).length;
  /** Advance fake interval time; due intervals of every world fire in time order. */
  frame.advance = ms => {
    const end = clock + ms;
    for (;;) {
      let due = null;
      for (const w of all) for (const [id, t] of w.intervals) if (t.next <= end && (!due || t.next < due.t.next)) due = {w, id, t};
      if (!due) break;
      clock = due.t.next;
      due.t.next += due.t.ms;
      due.t.fn();
    }
    clock = end;
  };
  frame.setVisibility = state => {
    doc.visibilityState = state;
    for (const l of [...doc.listeners]) if (l.type === 'visibilitychange') l.fn({type: 'visibilitychange'});
  };
  return frame;
}

export const STORAGE_DENIED = 'Access to storage is not allowed from this context.';

/** Content-script view of chrome: sendMessage routed through the router; runtime.onMessage receives the worker's
 *  chrome.tabs.sendMessage pushes (registered as a receiver of `sender.tab.id` in the fake tab registry);
 *  chrome.storage.local rejects like Chromium once the worker set accessLevel TRUSTED_CONTEXTS.
 *  Like Chromium, an invalidated (orphaned) context stops receiving extension events: invalidate() detaches every
 *  listener this context registered (storage.onChanged, runtime.onMessage), and later addListener calls are no-ops. */
export function contentChrome({backgroundChrome, deliver, sender}) {
  const shared = backgroundChrome.storage.onChanged;
  const fake = backgroundChrome.__fake;
  const mine = new Map(); // listener -> wrapper registered on the shared event
  const messageListeners = new Set();
  let dead = false;
  const detachReceiver = fake?.attachReceiver(sender.tab?.id, sender.tab?.url, sender.frameId ?? 0, (message, from) => {
    for (const fn of [...messageListeners]) fn(message, from, () => {});
  });
  const counter = {storage: 0};
  const restricted = () => backgroundChrome.storage.local.__accessLevel?.() === 'TRUSTED_CONTEXTS';
  const guarded = method => async (...args) => {
    counter.storage++;
    if (restricted()) throw new Error(STORAGE_DENIED);
    return backgroundChrome.storage.local[method](...args);
  };
  const onChanged = {
    addListener(fn) { if (dead || mine.has(fn)) return; const w = (...a) => fn(...a); mine.set(fn, w); shared.addListener(w); },
    removeListener(fn) { const w = mine.get(fn); if (w) { shared.removeListener(w); mine.delete(fn); } },
    hasListener: fn => mine.has(fn),
    get count() { return mine.size; }
  };
  const c = {
    runtime: {
      id: backgroundChrome.runtime.id,
      sendMessage: async message => (await deliver(backgroundChrome, message, sender)).response,
      onMessage: {
        addListener(fn) { if (!dead) messageListeners.add(fn); },
        removeListener(fn) { messageListeners.delete(fn); },
        hasListener: fn => messageListeners.has(fn),
        get count() { return messageListeners.size; }
      }
    },
    storage: {local: {get: guarded('get'), set: guarded('set'), remove: guarded('remove')}, onChanged},
    counter
  };
  c.invalidate = () => {
    dead = true;
    for (const w of mine.values()) shared.removeListener(w);
    mine.clear();
    messageListeners.clear();
    detachReceiver?.();
    c.runtime.id = undefined;
    c.runtime.sendMessage = async () => { throw new Error('Extension context invalidated.'); };
    c.storage.local = {get: async () => { throw new Error('Extension context invalidated.'); }};
  };
  return c;
}
