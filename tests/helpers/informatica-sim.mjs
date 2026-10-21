// Test-only simulation for the Informatica button: a deterministic fake clock, a minimal DOM (light + shadow trees,
// focus/selection, execCommand, iframes) and a mocked "AMS Informatica" workspace record whose Save / Post are
// local fakes that only append to `log` / `server`. Nothing here talks to a network or a real ServiceNow instance.
//
// createInformaticaPage() wires two vm worlds that share the document, localStorage and a window.postMessage bus
// (asynchronous, delivered to every world with event.source = that world's window, like Chromium):
//   isolated: features/informatica-button/content.js + a stub __snMiloController (enable/disable/retire)
//   main:     features/informatica-button/page.js + a stub __snMiloMainSettings + mocked g_ck/fetch (GET only)
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONTENT = 'features/informatica-button/content.js';
export const PAGE = 'features/informatica-button/page.js';
export const FEATURE = 'informatica-button';
export const EMAILS = Object.freeze(['alice@example.com', 'bob@example.com', 'team-list@example.com']);
export const LIST_LABEL = 'External work notes list';
export const SYS_ID = '0123456789abcdef0123456789abcdef';
const read = rel => fs.readFileSync(path.join(repo, rel), 'utf8');

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r)); };

/** Fake timers + Date.now for the vm worlds; advance() runs due timers in time order and drains microtasks. */
export function createClock(start = 1_700_000_000_000) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  const errors = [];
  const add = (fn, ms, repeat) => {
    const id = ++seq;
    const delay = Math.max(0, Number(ms) || 0);
    timers.set(id, {fn, at: now + delay, every: Math.max(1, delay), repeat});
    return id;
  };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const clock = {
    get now() { return now; },
    errors,
    Date: FakeDate,
    setTimeout: (fn, ms, ...a) => add(() => fn(...a), ms, false),
    clearTimeout: id => { timers.delete(id); },
    setInterval: (fn, ms, ...a) => add(() => fn(...a), ms, true),
    clearInterval: id => { timers.delete(id); },
    intervals: () => [...timers.values()].filter(t => t.repeat).length,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        let due = null;
        for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due.t.at || (t.at === due.t.at && id < due.id))) due = {id, t};
        if (!due) break;
        now = due.t.at;
        if (due.t.repeat) due.t.at += due.t.every; else timers.delete(due.id);
        try { due.t.fn(); } catch (error) { errors.push(error); }
      }
      now = end;
      await flush();
    },
    /** Advance in small steps until pred() is true (or max ms elapsed); returns pred(). */
    async until(pred, {max = 60000, step = 50} = {}) {
      for (let t = 0; t <= max; t += step) { if (pred()) return true; await clock.advance(step); }
      return Boolean(pred());
    }
  };
  return clock;
}

// ---- minimal DOM -------------------------------------------------------------------------------------------------
const ZERO = Object.freeze({x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0});

export function createDocument({clientWidth = 1280} = {}) {
  class Node {
    constructor(nodeType, ownerDocument) { this.nodeType = nodeType; this.ownerDocument = ownerDocument; this.childNodes = []; this.parentNode = null; }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    removeChild(child) {
      const i = this.childNodes.indexOf(child);
      if (i >= 0) { this.childNodes.splice(i, 1); child.parentNode = null; }
      return child;
    }
    /** Light-DOM descendants only (shadow roots are NOT crossed), like the real querySelectorAll. */
    querySelectorAll(selector) {
      const sel = String(selector).toUpperCase();
      const out = [];
      const walk = n => { for (const c of n.childNodes) { if (c.nodeType === 1 && (sel === '*' || c.tagName === sel)) out.push(c); walk(c); } };
      walk(this);
      return out;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getRootNode() { let n = this; while (n.parentNode) n = n.parentNode; return n; }
    get isConnected() {
      let n = this;
      for (;;) {
        if (n === doc) return true;
        if (n.parentNode) n = n.parentNode;
        else if (n.nodeType === 11 && n.host) n = n.host;
        else return false;
      }
    }
  }
  class ShadowRoot extends Node {
    constructor(host) { super(11, host.ownerDocument); this.host = host; }
    getElementById(id) { return this.querySelectorAll('*').find(e => e.id === id) || null; }
  }
  class Element extends Node {
    constructor(tag, ownerDocument) {
      super(1, ownerDocument);
      this.tagName = String(tag).toUpperCase();
      this.id = '';
      this.attributes = new Map();
      this.listeners = [];
      this.style = {};
      this.value = '';
      this.disabled = false;
      this.shadowRoot = null;
      this.shown = true; // test switch: false => zero-size rect
      this.rect = null;
      this._text = '';
      this._selected = false;
    }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'id') this.id = String(value); }
    attachShadow() { this.shadowRoot = new ShadowRoot(this); return this.shadowRoot; }
    get textContent() { return this._text + this.childNodes.map(c => c.textContent ?? '').join(''); }
    set textContent(v) { this._text = String(v); for (const c of [...this.childNodes]) this.removeChild(c); }
    get innerText() { return this.textContent; }
    get dataset() { return this._dataset || (this._dataset = {}); }
    addEventListener(type, fn) { this.listeners.push({type, fn}); }
    removeEventListener(type, fn) { const i = this.listeners.findIndex(l => l.type === type && l.fn === fn); if (i >= 0) this.listeners.splice(i, 1); }
    dispatchEvent(event) { for (const l of [...this.listeners]) if (l.type === event.type) l.fn(event); return true; }
    click() {
      if (this.disabled && ['BUTTON', 'INPUT'].includes(this.tagName)) return; // like the browser
      this.dispatchEvent({type: 'click', target: this});
    }
    focus() { this.ownerDocument.activeElement = this; }
    select() { this._selected = true; }
    remove() { this.parentNode?.removeChild(this); }
    visibleChain() {
      let n = this;
      while (n) {
        if (n.nodeType === 1 && !n.shown) return false;
        n = n.parentNode || n.host || null;
      }
      return true;
    }
    getBoundingClientRect() {
      if (!this.isConnected || !this.visibleChain()) return ZERO;
      return this.rect || {x: 10, y: 10, top: 10, left: 10, right: 110, bottom: 30, width: 100, height: 20};
    }
  }
  class Doc extends Node {
    constructor() {
      super(9, null);
      this.ownerDocument = null;
      this.activeElement = null;
      this.selectAllActive = false;
      this.inputHooks = new Set(); // (el) => void, after execCommand edits an input
      this.editorHooks = new Set(); // (doc) => void, after execCommand edits this document's body
    }
    createElement(tag) { return new Element(tag, this); }
    getElementById(id) { return this.querySelectorAll('*').find(e => e.id === id) || null; }
    execCommand(command, _ui, value) {
      const target = this.activeElement;
      if (command === 'selectAll') { this.selectAllActive = true; return true; }
      if (target && target.tagName === 'INPUT') {
        if (command === 'insertText') target.value = target._selected ? String(value) : target.value + String(value);
        else if (command === 'delete') { if (target._selected) target.value = ''; else target.value = target.value.slice(0, -1); }
        else return false;
        target._selected = false;
        for (const h of this.inputHooks) h(target);
        return true;
      }
      if (target === this.body && command === 'insertText') {
        this.body.textContent = this.selectAllActive ? String(value) : this.body.textContent + String(value);
        this.selectAllActive = false;
        for (const h of this.editorHooks) h(this);
        return true;
      }
      return false;
    }
  }
  const doc = new Doc();
  doc.ownerDocument = null;
  const html = doc.createElement('html');
  Object.defineProperty(html, 'clientWidth', {value: clientWidth});
  doc.appendChild(html);
  doc.documentElement = html;
  doc.body = doc.createElement('body');
  html.appendChild(doc.body);
  doc.Element = Element;
  return doc;
}

const el = (doc, tag, attrs = {}, text = '') => {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
};

/**
 * Mocked AMS Informatica workspace record. Every "write" is local: picking people adds chips, Save copies the chips
 * into server.list after saveDelay (it does not submit a pending note unless saveSubmitsNote); the compose pane's Post
 * button submits the pending note (server.posts, editor emptied after postDelay) unless postWorks is false. Hooks let
 * tests intervene at exact points (e.g. disable the feature right after a chip appears).
 */
export function createWorkspace({clock, doc = createDocument(), title = 'AMS Informatica: nightly load failed', description = 'Nightly Informatica load failed at step 3; please investigate the DW job.',
  savedList = '', presetChips = [], saveButton = true, saveDelay = 300, postDelay = 300, saveWorks = true, postWorks = true, saveSubmitsNote = false, hooks = {}} = {}) {
  const log = [];
  const server = {list: savedList, posts: []};
  const scope = el(doc, 'macroponent-f51912f4c700201072b211d4d8c26010');
  doc.body.appendChild(scope);
  const sr = scope.attachShadow();
  const h1 = el(doc, 'h1', {}, title);
  sr.appendChild(h1);
  // action bar (Save)
  const bar = el(doc, 'now-record-common-uiactionbar');
  sr.appendChild(bar);
  const barSr = bar.attachShadow();
  const save = el(doc, 'button', {}, 'Save');
  save.rect = {x: 1040, y: 40, top: 40, left: 1040, right: 1100, bottom: 68, width: 60, height: 28};
  if (saveButton) barSr.appendChild(save);
  save.addEventListener('click', () => {
    log.push('save');
    hooks.onSave?.();
    clock.setTimeout(() => { if (saveWorks) server.list = chips().join(','); }, saveDelay);
    // Real instances: the record's Save does NOT submit a pending external note (only Post does).
    const pending = editor.body.innerText.trim();
    if (saveSubmitsNote && pending && extFrame.shown) {
      clock.setTimeout(() => { server.posts.push(pending); editor.body.textContent = ''; post.disabled = true; }, postDelay);
    }
  });
  // form: External work notes list (glide list with chips) + Description
  const field = el(doc, 'sn-record-list-field');
  sr.appendChild(field);
  const fieldSr = field.attachShadow();
  const input = el(doc, 'input', {'aria-label': LIST_LABEL});
  fieldSr.appendChild(input);
  const chipEls = () => fieldSr.querySelectorAll('li').filter(li => li.getAttribute('aria-selected') === 'true');
  const chips = () => chipEls().map(li => li.id);
  const addChip = email => { const li = el(doc, 'li', {role: 'option', 'aria-selected': 'true', id: email}, email); fieldSr.appendChild(li); };
  for (const email of presetChips) addChip(email);
  const desc = el(doc, 'textarea', {'aria-label': 'Description'});
  desc.value = description;
  sr.appendChild(desc);
  // suggestions dropdown (document light DOM, like a popover)
  const listbox = el(doc, 'ul', {role: 'listbox'});
  doc.body.appendChild(listbox);
  let suggestionTimer = null;
  doc.inputHooks.add(target => {
    if (target !== input) return;
    log.push(`type:${target.value}`);
    for (const li of listbox.querySelectorAll('li')) li.remove();
    clock.clearTimeout(suggestionTimer);
    const typed = target.value.trim().toLowerCase();
    if (!typed) return;
    suggestionTimer = clock.setTimeout(() => {
      if (input.value.trim().toLowerCase() !== typed) return;
      const li = el(doc, 'li', {role: 'option', 'aria-selected': 'false'}, typed);
      li.addEventListener('click', () => {
        log.push(`pick:${typed}`);
        hooks.onPick?.(typed);
        clock.setTimeout(() => {
          li.remove();
          input.value = '';
          addChip(typed);
          log.push(`chip:${typed}`);
          hooks.onChip?.(typed, chips().length);
        }, 100);
      });
      listbox.appendChild(li);
    }, 100);
  });
  // compose pane: Work notes / External work notes tabs, one editor iframe each, Post button
  const compose = el(doc, 'now-activity-stream-compose-connected');
  sr.appendChild(compose);
  const csr = compose.attachShadow();
  const tabWn = el(doc, 'div', {role: 'tab', 'aria-label': 'Work notes', 'aria-selected': 'true'}, 'Work notes');
  const tabExt = el(doc, 'div', {role: 'tab', 'aria-label': 'External work notes', 'aria-selected': 'false'}, 'External work notes');
  csr.appendChild(tabWn);
  csr.appendChild(tabExt);
  const makeFrame = id => {
    const frame = el(doc, 'iframe', {id});
    frame.contentDocument = createDocument();
    frame.contentWindow = {KeyboardEvent: class KeyboardEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }};
    csr.appendChild(frame);
    return frame;
  };
  const wnFrame = makeFrame('wn_ifr');
  const extFrame = makeFrame('ext_ifr');
  extFrame.shown = false;
  const post = el(doc, 'now-button', {id: 'postButton-u_external_work_notes'});
  post.disabled = true;
  post.shown = false;
  csr.appendChild(post);
  const postInner = el(doc, 'button', {}, 'Post');
  post.attachShadow().appendChild(postInner);
  const editor = extFrame.contentDocument;
  editor.editorHooks.add(() => log.push('paste'));
  editor.body.addEventListener('keyup', () => { if (editor.body.innerText.trim()) post.disabled = false; });
  postInner.addEventListener('click', () => {
    if (post.disabled) return;
    log.push('post');
    hooks.onPost?.();
    const text = editor.body.innerText;
    if (postWorks) clock.setTimeout(() => { server.posts.push(text); editor.body.textContent = ''; post.disabled = true; }, postDelay);
  });
  tabExt.addEventListener('click', () => {
    log.push('tab');
    clock.setTimeout(() => {
      tabExt.setAttribute('aria-selected', 'true');
      tabWn.setAttribute('aria-selected', 'false');
      wnFrame.shown = false;
      extFrame.shown = true;
      post.shown = true;
    }, 100);
  });
  return {doc, log, server, scope, h1, save, input, chips, desc, tabExt, extFrame, editor, post, postInner, listbox,
    writes: () => log.filter(e => e === 'save' || e === 'post')};
}

/** Stub of shared/controller.js's API (subscribe/effective/retire) with an explicit enabled switch. */
function createMiloStub(state) {
  const subs = new Set();
  const want = () => !state.retired && state.enabled;
  const reconcile = sub => {
    if (!sub.active) return;
    if (want() && !sub.mode) { sub.mode = 'enabled'; sub.starts++; sub.handlers.start?.({enabled: true, seedOnly: false, mode: 'enabled'}); }
    else if (!want() && sub.mode) { sub.mode = null; sub.handlers.stop?.(state.retired ? 'invalidated' : 'disabled'); }
  };
  const api = {
    subscribe(feature, handlers) {
      if (state.retired) return () => {};
      const sub = {feature, handlers: handlers || {}, mode: null, active: true, starts: 0};
      subs.add(sub);
      reconcile(sub);
      return () => { if (!sub.active) return; if (sub.mode) { sub.mode = null; sub.handlers.stop?.('unsubscribed'); } sub.active = false; subs.delete(sub); };
    },
    effective(feature) {
      if (state.retired) return null;
      return feature === FEATURE ? {enabled: state.enabled, seedOnly: false} : {enabled: false, seedOnly: false};
    },
    get retired() { return state.retired; }
  };
  return {api, subs, reconcileAll: () => { for (const s of [...subs]) reconcile(s); }};
}

function createMainSettingsStub(state) {
  const cbs = new Set();
  const api = {
    subscribe(feature, cb) {
      if (feature !== FEATURE) return () => {};
      cbs.add(cb);
      if (state.known) cb({enabled: state.enabled, seedOnly: false});
      return () => { cbs.delete(cb); };
    },
    get: feature => (feature === FEATURE && state.known ? {enabled: state.enabled, seedOnly: false} : null)
  };
  return {api, cbs, notify: () => { for (const cb of [...cbs]) cb({enabled: state.enabled, seedOnly: false}); }};
}

export function createInformaticaPage({origin = 'https://prod.service-now.com', pathname = `/now/sow/record/incident/${SYS_ID}`, enabled = true,
  clock = createClock(), workspace = {}, dryRun = false, fetchDelay = 50, token = 'tok', resolve = null, incident = {}, patchWorks = true} = {}) {
  const doc = createDocument();
  const ws = createWorkspace({clock, doc, ...workspace});
  const logs = [];
  const fetches = [];
  const storage = new Map(dryRun ? [['snInfDryRun', '1']] : []);
  const localStorage = {getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k)};
  const worlds = [];
  const settingsState = {enabled, known: true, retired: false};
  function makeWorld(kind) {
    const w = {kind, listeners: []};
    const g = {
      console: {log: (...a) => logs.push(['log', kind, ...a]), warn: (...a) => logs.push(['warn', kind, ...a]), error: (...a) => logs.push(['error', kind, ...a])},
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval,
      Date: clock.Date, document: doc, localStorage, AbortController, structuredClone,
      crypto: globalThis.crypto,
      // Workflow-only tests mock authorization; gate integration tests replace this with the real router.
      chrome: {runtime: {sendMessage: (_message, callback) => callback({ok:true, emails: EMAILS, resolve})}},
      location: {origin, pathname, href: `${origin}${pathname}`},
      addEventListener(type, fn) { w.listeners.push({type, fn}); },
      removeEventListener(type, fn) { const i = w.listeners.findIndex(l => l.type === type && l.fn === fn); if (i >= 0) w.listeners.splice(i, 1); },
      postMessage(data, targetOrigin) {
        if (targetOrigin !== origin && targetOrigin !== '*') return;
        const copy = structuredClone(data);
        clock.setTimeout(() => { for (const x of worlds) for (const l of [...x.listeners]) if (l.type === 'message') l.fn({data: structuredClone(copy), origin, source: x.inner}); }, 0);
      }
    };
    vm.createContext(g);
    vm.runInContext('globalThis.window = this; globalThis.self = this;', g);
    w.inner = vm.runInContext('globalThis', g);
    w.g = g;
    worlds.push(w);
    return w;
  }
  const isolated = makeWorld('isolated');
  const main = makeWorld('main');
  const milo = createMiloStub(settingsState);
  const mainSettings = createMainSettingsStub(settingsState);
  isolated.g.__snMiloController = milo.api;
  main.g.__snMiloMainSettings = mainSettings.api;
  main.g.g_ck = token;
  // Modelled incident for the guarded resolve (GET/PATCH on the record with the resolve field list).
  const record = {number: 'INC0000001', short_description: 'AMS Informatica error: example', state: '1', close_code: '', close_notes: '', ...incident};
  main.g.fetch = (url, opts = {}) => {
    fetches.push({url, method: opts.method || 'GET', opts});
    return new Promise((resolveFetch, reject) => {
      const isResolve = url.includes('short_description') || opts.method === 'PATCH';
      const t = clock.setTimeout(() => {
        if (isResolve && opts.method === 'PATCH' && patchWorks) Object.assign(record, JSON.parse(opts.body));
        resolveFetch({ok: true, status: 200, json: async () => ({result: isResolve ? {...record} : {u_external_work_notes_list: ws.server.list}})});
      }, fetchDelay);
      opts.signal?.addEventListener?.('abort', () => { clock.clearTimeout(t); reject(new Error('aborted')); });
    });
  };
  const page = {
    clock, doc, ws, logs, fetches, isolated, main, milo, mainSettings, localStorage, record,
    run(kind, rel) { vm.runInContext(read(rel), (kind === 'main' ? main : isolated).g, {filename: rel}); },
    load() { page.run('main', PAGE); page.run('isolated', CONTENT); return page; },
    setEnabled(v) { settingsState.enabled = v; milo.reconcileAll(); mainSettings.notify(); },
    /** Extension context invalidated: the controller retires and stops its subscribers ('invalidated'). */
    retire() { settingsState.retired = true; milo.reconcileAll(); },
    buttons: () => doc.querySelectorAll('button').filter(b => b.id === 'sn-inf-button'),
    button: () => doc.getElementById('sn-inf-button'),
    notice: () => doc.getElementById('sn-inf-notice'),
    messageListeners: kind => (kind === 'main' ? main : isolated).listeners.filter(l => l.type === 'message').length,
    controller: () => isolated.g.__snInfController,
    warnings: () => logs.filter(l => l[0] === 'warn').map(l => l.slice(2).map(String).join(' '))
  };
  return page;
}

/** DOM descriptors to graft onto page-sim world documents (integration tests with the real controller). */
export function domMixin(doc) {
  return {
    nodeType: {get: () => 9},
    body: {get: () => doc.body},
    documentElement: {get: () => doc.documentElement},
    activeElement: {get: () => doc.activeElement},
    createElement: {value: tag => doc.createElement(tag)},
    getElementById: {value: id => doc.getElementById(id)},
    querySelectorAll: {value: s => doc.querySelectorAll(s)},
    querySelector: {value: s => doc.querySelector(s)},
    execCommand: {value: (...a) => doc.execCommand(...a)}
  };
}
