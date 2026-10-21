// Minimal, deterministic chrome.* fakes for sn_milo unit tests (no network, no timers left behind).
// Storage mirrors the real MV3 shapes: get() resolves {key: value}, set() resolves undefined, onChanged fires
// asynchronously with {key: {oldValue, newValue}} after the write — only for keys whose value actually changed (like
// Chrome: no event for no-op writes or removes of absent keys). Failure/delay injection lives on `ctl`.
export const sleep = ms => new Promise(r => setTimeout(r, ms));
const clone = v => (v === undefined ? undefined : structuredClone(v));

export function createEvent() {
  const listeners = [];
  return {
    addListener(fn) { listeners.push(fn); },
    removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    hasListener(fn) { return listeners.includes(fn); },
    hasListeners() { return listeners.length > 0; },
    get listeners() { return [...listeners]; },
    dispatch(...args) { return listeners.map(fn => fn(...args)); }
  };
}

export function createFakeStorage(initial = {}) {
  let data = clone(initial);
  const onChanged = createEvent();
  const ctl = {failGet: null, failSet: null, getDelay: 0, setDelay: 0, gets: [], sets: [],
    accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS', accessLevelCalls: [], failAccessLevel: null};
  const pick = keys => {
    if (keys === null || keys === undefined) return clone(data);
    if (typeof keys === 'string') keys = [keys];
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter(k => k in data).map(k => [k, clone(data[k])]));
    return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in data ? clone(data[k]) : d]));
  };
  const local = {
    // Chromium: storage.local defaults to TRUSTED_AND_UNTRUSTED_CONTEXTS; content-script views in page-sim reject
    // every storage call once it is TRUSTED_CONTEXTS.
    setAccessLevel(options) {
      ctl.accessLevelCalls.push(clone(options));
      if (ctl.failAccessLevel) return Promise.reject(new Error(typeof ctl.failAccessLevel === 'string' ? ctl.failAccessLevel : 'setAccessLevel failed'));
      if (!['TRUSTED_CONTEXTS', 'TRUSTED_AND_UNTRUSTED_CONTEXTS'].includes(options?.accessLevel)) return Promise.reject(new Error('invalid accessLevel'));
      ctl.accessLevel = options.accessLevel;
      return Promise.resolve();
    },
    __accessLevel: () => ctl.accessLevel,
    async get(keys) {
      ctl.gets.push(clone(keys));
      if (ctl.getDelay) await sleep(typeof ctl.getDelay === 'function' ? ctl.getDelay() : ctl.getDelay);
      if (ctl.failGet) throw new Error(typeof ctl.failGet === 'string' ? ctl.failGet : 'storage get failed');
      return pick(keys);
    },
    async set(items) {
      if (ctl.setDelay) await sleep(ctl.setDelay);
      // failSet: true | message | (items) => falsy (write proceeds) or a message (write rejected)
      const failure = typeof ctl.failSet === 'function' ? ctl.failSet(clone(items)) : ctl.failSet;
      if (failure) throw new Error(typeof failure === 'string' ? failure : 'storage set failed');
      ctl.sets.push(clone(items));
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        if (k in data && JSON.stringify(data[k]) === JSON.stringify(v)) continue;
        changes[k] = {oldValue: clone(data[k]), newValue: clone(v)}; data[k] = clone(v);
      }
      if (Object.keys(changes).length) setTimeout(() => onChanged.dispatch(changes, 'local'), 0);
    },
    async remove(keys) {
      const changes = {};
      for (const k of [].concat(keys)) if (k in data) { changes[k] = {oldValue: data[k]}; delete data[k]; }
      if (Object.keys(changes).length) setTimeout(() => onChanged.dispatch(changes, 'local'), 0);
    }
  };
  return {local, onChanged, ctl, dump: () => clone(data), put: (k, v) => { data[k] = clone(v); }};
}

export function createFakeChrome({storage = createFakeStorage(), id = 'abcdefghijklmnopabcdefghijklmnop'} = {}) {
  const alarms = new Map();
  const calls = [];
  // Tab registry for chrome.tabs.query/sendMessage: content views (page-sim contentChrome) attach receivers.
  const tabRegistry = new Map(); // tabId -> {id, url, receivers: Set<{frameId, fn}>}
  const tabsCtl = {dropPushes: false, failQuery: null};
  const matches = (pattern, url) => typeof url === 'string' && (pattern === '<all_urls>' ||
    (pattern.endsWith('/*') && url.startsWith(pattern.slice(0, -1))));
  const chrome = {
    runtime: {
      id,
      getURL: p => `chrome-extension://${id}/${String(p).replace(/^\//, '')}`,
      onMessage: createEvent(), onInstalled: createEvent(), onStartup: createEvent(), lastError: undefined
    },
    storage: {local: storage.local, onChanged: storage.onChanged},
    alarms: {
      async create(name, info) { calls.push(['alarms.create', name]); alarms.set(name, {name, ...info}); },
      async clear(name) { calls.push(['alarms.clear', name]); return alarms.delete(name); },
      async get(name) { return alarms.get(name); },
      async getAll() { return [...alarms.values()]; },
      onAlarm: createEvent()
    },
    notifications: {
      async create(nid) { calls.push(['notifications.create', nid]); return nid; },
      async clear(nid) { calls.push(['notifications.clear', nid]); return true; },
      onClicked: createEvent(), onClosed: createEvent()
    },
    tabs: {
      async query(info = {}) {
        calls.push(['tabs.query', clone(info)]);
        if (tabsCtl.failQuery) throw new Error(tabsCtl.failQuery);
        const patterns = [].concat(info.url ?? []);
        return [...tabRegistry.values()].filter(t => !patterns.length || patterns.some(p => matches(p, t.url))).map(t => ({id: t.id, url: t.url}));
      },
      async sendMessage(tabId, message, options = {}) {
        calls.push(['tabs.sendMessage', tabId, clone(message)]);
        const receivers = [...(tabRegistry.get(tabId)?.receivers || [])].filter(r => options.frameId === undefined || r.frameId === options.frameId);
        if (!receivers.length) throw new Error('Could not establish connection. Receiving end does not exist.');
        if (tabsCtl.dropPushes) return undefined;
        await sleep(0);
        for (const r of receivers) r.fn(clone(message), {id, url: `chrome-extension://${id}/background.js`, origin: `chrome-extension://${id}`});
        return undefined;
      },
      async create(o) { calls.push(['tabs.create', o.url]); }
    },
    scripting: {async executeScript(o) { calls.push(['scripting.executeScript', o]); return []; }}
  };
  Object.defineProperty(chrome, '__fake', {enumerable: false, value: {
    tabsCtl,
    attachReceiver(tabId, url, frameId, fn) {
      if (tabId === undefined) return () => {};
      const tab = tabRegistry.get(tabId) || {id: tabId, url, receivers: new Set()};
      if (frameId === 0 && url) tab.url = url;
      tabRegistry.set(tabId, tab);
      const r = {frameId, fn};
      tab.receivers.add(r);
      return () => tab.receivers.delete(r);
    }
  }});
  return {chrome, storage, calls, tabs: tabsCtl};
}

/**
 * Deliver a message through chrome.runtime.onMessage listeners with Chrome's response semantics: the channel stays
 * open only when a listener returned `true`; otherwise it closes after the synchronous dispatch and a late
 * sendResponse is dropped. Resolves {response, keptOpen, closedWithoutResponse}.
 */
export function deliver(chrome, message, sender, {timeoutMs = 2000} = {}) {
  return new Promise((resolve, reject) => {
    let open = true;
    let done = false;
    const timer = setTimeout(() => { if (!done) reject(new Error(`no response to ${JSON.stringify(message)}`)); }, timeoutMs);
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const sendResponse = response => { if (open) { open = false; finish({response, keptOpen}); } };
    let keptOpen = false;
    const results = chrome.runtime.onMessage.dispatch(message, sender, sendResponse);
    keptOpen = results.some(r => r === true);
    if (!done && !keptOpen) { open = false; finish({response: undefined, keptOpen: false, closedWithoutResponse: true}); }
  });
}

export const PROD = 'https://prod.service-now.com';
export const TEST = 'https://prodtest.service-now.com';
export const ORIGINS = Object.freeze({production: PROD, test: TEST});
export function contentSender(origin = PROD, {path = '/now/nav/ui', frameId = 0, tabUrl, id = 'abcdefghijklmnopabcdefghijklmnop'} = {}) {
  const url = `${origin}${path}`;
  return {id, url, origin, frameId, tab: {id: 7, url: tabUrl ?? url}};
}
export function optionsSender(id = 'abcdefghijklmnopabcdefghijklmnop') {
  const url = `chrome-extension://${id}/options.html`;
  return {id, url, origin: `chrome-extension://${id}`, tab: {id: 9, url}};
}
