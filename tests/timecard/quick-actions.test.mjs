import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const quickPath = new URL('../../features/timecard/quick-actions.js', import.meta.url);
const nativeActionsPath = new URL('../../features/timecard/native-actions.js', import.meta.url);

function storageStub() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    _data: data,
  };
}
function loadQuick(context = {}) {
  const ctx = vm.createContext({ globalThis: {}, console, ...context });
  ctx.globalThis = ctx;
  vm.runInContext(fs.readFileSync(quickPath, 'utf8'), ctx);
  return ctx.SnTimecardQuickActions;
}

test('quick action save/load roundtrip through localStorage', () => {
  const quick = loadQuick();
  const storage = storageStub();
  const saved = quick.add({ label: 'Valvonta 15min', minutes: 15, comment: 'Valvonta', workNotes: true }, storage);
  assert.ok(saved.id);
  assert.equal(saved.minutes, 15);
  const actions = quick.load(storage);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], saved);
  quick.remove(saved.id, storage);
  assert.equal(quick.load(storage).length, 0);
});

test('quick action normalization rejects invalid entries', () => {
  const quick = loadQuick();
  assert.equal(quick.normalize({ label: '', minutes: 15 }), null);
  assert.equal(quick.normalize({ label: 'x', minutes: 0 }), null);
  assert.equal(quick.normalize({ label: 'x', minutes: 15.5 }), null);
  assert.equal(quick.normalize({ label: 'x', minutes: 99999 }), null);
  assert.equal(quick.normalize({ label: 'x', minutes: 'abc' }), null);
  assert.equal(quick.normalize(null), null);
  const ok = quick.normalize({ label: '  y  ', minutes: '30' });
  assert.equal(ok.label, 'y');
  assert.equal(ok.minutes, 30);
  assert.equal(ok.comment, '');
  assert.equal(ok.workNotes, false);
});

test('corrupt stored JSON loads as an empty list', () => {
  const quick = loadQuick();
  const storage = storageStub();
  storage.setItem(quick.STORAGE_KEY, '{not json');
  assert.equal(quick.load(storage).length, 0);
  storage.setItem(quick.STORAGE_KEY, '{"a":1}');
  assert.equal(quick.load(storage).length, 0);
  storage.setItem(quick.STORAGE_KEY, JSON.stringify([{ label: 'ok', minutes: 5 }, { bad: true }, { label: 'ok2', minutes: 10 }]));
  const actions = quick.load(storage);
  assert.equal(actions.length, 2);
  assert.equal(actions[1].label, 'ok2');
});

test('duration formats GlideDuration strings', () => {
  const quick = loadQuick();
  assert.equal(quick.duration(15), '0 00:15:00');
  assert.equal(quick.duration(1), '0 00:01:00');
  assert.equal(quick.duration(60), '0 01:00:00');
  assert.equal(quick.duration(1500), '1 01:00:00');
  assert.equal(quick.duration(10080), '7 00:00:00');
  assert.equal(quick.duration('45'), '0 00:45:00');
});

// --- native-actions in-form rendering ---
function nativeFixture({ actions = [], ready = true } = {}) {
  const storage = storageStub();
  const setValues = [];
  const listeners = {};
  function el(tag, id = '') {
    return {
      tagName: tag.toUpperCase(), localName: tag, id, children: [], attributes: {},
      style: { setProperty() {}, cssText: '' }, textContent: '', title: '', disabled: false, hidden: false,
      parentNode: null, nextSibling: null,
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k] ?? null; },
      addEventListener(k, cb) { this.listeners[k] = cb; },
      click() { this.listeners.click?.(); },
      listeners: {},
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      append(...cs) { for (const c of cs) this.appendChild(c); },
      insertBefore(c, before) { const i = before ? this.children.indexOf(before) : -1; if (i < 0) this.appendChild(c); else { this.children.splice(i, 0, c); c.parentNode = this; } return c; },
      cloneNode() { const copy = el(this.localName, this.id); copy.attributes = { ...this.attributes }; return copy; },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); },
    };
  }
  const container = el('div'); container.className = 'form_action_button_container';
  const form = el('form'); form.children = [container]; container.parentNode = form;
  const head = { appendChild() {} };
  const document = {
    readyState: ready ? 'complete' : 'loading',
    head,
    _nodes: new Map(),
    getElementById(id) {
      const walk = (node) => {
        for (const c of node.children || []) { if (c.id === id) return c; const found = walk(c); if (found) return found; }
        return null;
      };
      return walk(form) || this._nodes.get(id) || null;
    },
    querySelector(sel) { return sel === '.form_action_button_container' ? container : null; },
    createElement: (tag) => el(tag),
    addEventListener(k, cb) { listeners['document:' + k] = cb; },
  };
  const bottom = el('button', 'sysverb_insert_bottom');
  let submitClicks = 0;
  bottom.addEventListener('click', () => { submitClicks++; });
  container.appendChild(bottom);
  const g_form = {
    setValue(name, value) { setValues.push([name, value]); },
    getControl(name) { return name === 'u_work_notes' ? {} : null; },
  };
  const window = {
    top: {},
    g_form,
    addEventListener(k, cb) { listeners['window:' + k] = cb; },
  };
  const quick = loadQuick();
  if (actions.length) quick.save(actions, storage);
  const context = vm.createContext({
    window, document, location: { origin: 'https://test.example', pathname: '/task_time_worked.do' },
    SnTimecardCore: { isAllowedOrigin: () => true }, SnTimecardConfig: {},
    localStorage: storage, setTimeout: undefined, console,
  });
  context.globalThis = context;
  // Run the shared module inside the same realm so its default localStorage
  // binding resolves to the fixture storage.
  vm.runInContext(fs.readFileSync(quickPath, 'utf8'), context);
  const quickInContext = context.SnTimecardQuickActions;
  if (actions.length) quickInContext.save(actions, storage);
  vm.runInContext(fs.readFileSync(nativeActionsPath, 'utf8'), context);
  return { document, window, container, quick: quickInContext, storage, setValues, listeners, bottom, submitClicks: () => submitClicks };
}

test('native form renders quick action buttons below the submit container', () => {
  const f = nativeFixture({ actions: [{ label: 'Valvonta 15min', minutes: 15, comment: 'Valvonta', workNotes: true }] });
  const bar = f.document.getElementById('sn-timecard-quick-actions');
  assert.ok(bar, 'quick action bar exists');
  // inserted inside the form, directly after the submit container
  assert.equal(bar.parentNode, f.container.parentNode);
  const siblings = f.container.parentNode.children;
  assert.ok(siblings.indexOf(bar) > siblings.indexOf(f.container));
  assert.equal(bar.children.length, 1);
  assert.equal(bar.children[0].textContent, 'Valvonta 15min');
});

test('clicking a quick action fills the form and clicks the native submit', () => {
  const f = nativeFixture({ actions: [{ label: 'Valvonta 15min', minutes: 15, comment: 'Valvonta', workNotes: true }] });
  const bar = f.document.getElementById('sn-timecard-quick-actions');
  bar.children[0].listeners.click();
  assert.deepEqual(f.setValues, [['time_worked', '0 00:15:00'], ['comments', 'Valvonta'], ['u_work_notes', 'true']]);
  assert.equal(f.submitClicks(), 1);
  // all bar buttons disabled during submission
  assert.equal(bar.children[0].disabled, true);
});

test('quick action without comment or work notes only sets duration and still submits', () => {
  const f = nativeFixture({ actions: [{ label: 'Meeting 30', minutes: 30 }] });
  const bar = f.document.getElementById('sn-timecard-quick-actions');
  bar.children[0].listeners.click();
  assert.deepEqual(f.setValues, [['time_worked', '0 00:30:00']]);
  assert.equal(f.submitClicks(), 1);
});

test('a storage event re-renders the quick action bar', () => {
  const f = nativeFixture();
  assert.equal(f.document.getElementById('sn-timecard-quick-actions'), null);
  f.quick.add({ label: 'Late shift', minutes: 45 }, f.storage);
  listeners_fire(f, { key: f.quick.STORAGE_KEY });
  const bar = f.document.getElementById('sn-timecard-quick-actions');
  assert.ok(bar);
  assert.equal(bar.children[0].textContent, 'Late shift');
});

function listeners_fire(f, event) {
  // The storage listener was registered on window during script load.
  for (const [key, cb] of Object.entries(f.listeners)) {
    if (key === 'window:storage') cb(event);
  }
}

test('quick actions are not rendered without the shared module', () => {
  const f = nativeFixture({ actions: [{ label: 'x', minutes: 5 }] });
  const document = f.document;
  // Strip the bar created by the first run, then re-run with the module absent.
  document.getElementById('sn-timecard-quick-actions').remove();
  const context2 = vm.createContext({
    window: f.window, document, location: { origin: 'https://test.example', pathname: '/task_time_worked.do' },
    SnTimecardCore: { isAllowedOrigin: () => true }, SnTimecardConfig: {}, setTimeout: undefined, console,
  });
  context2.globalThis = context2;
  vm.runInContext(fs.readFileSync(nativeActionsPath, 'utf8'), context2);
  assert.equal(document.getElementById('sn-timecard-quick-actions'), null);
});
