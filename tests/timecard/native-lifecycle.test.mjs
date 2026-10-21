// Native Time Worked form compatibility is ALWAYS ON: static document_start entry in every frame, independent of the
// timecard overlay toggle, of settings arrival and of the extension's worker/controller state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {SCRIPT_POLICY} from '../../shared/script-policy.mjs';

const read = f => fs.readFileSync(new URL(`../../features/timecard/${f}`, import.meta.url), 'utf8');
const ENTRY_FILES = ['config.js', 'core.js', 'quick-actions.js', 'native-compat.js', 'native-actions.js'];

// One native-form frame (window !== top) running the real entry files in order, like the manifest entry does.
function nativeFrame({settings = 'absent', loading = false, topLevel = false, originOverride, pathname = '/task_time_worked.do'} = {}) {
  const nodes = [];
  const mk = id => ({id, hidden: false, attributes: {}, style: {setProperty() {}, getPropertyValue: () => '', getPropertyPriority: () => ''},
    setAttribute(k, v) { this.attributes[k] = String(v); }, getAttribute(k) { return this.attributes[k] ?? null; },
    cloneNode() { return mk(''); }, remove() {}, textContent: ''});
  const parent = {insertBefore(node) { node.parentNode = parent; nodes.push(node); }};
  const bottom = mk('sysverb_insert_bottom'); bottom.parentNode = parent; nodes.push(bottom);
  const callbacks = {};
  const document = {readyState: loading ? 'loading' : 'complete', getElementById: id => (document.readyState === 'loading' ? null : nodes.find(n => n.id === id) || null),
    addEventListener: (name, cb) => { callbacks[name] = cb; }, createElement: () => mk(''), querySelector: () => null, head: {appendChild(n) { nodes.push(n); }}};
  const config = vm.runInNewContext(read('config.js') + ';globalThis.SnTimecardConfig', {globalThis: {}});
  const origin = config.instances.find(i => i.mode === 'test').origin;
  const window = {top: {}};
  if (topLevel) window.top = window;
  const globals = {URL, URLSearchParams, window, document, location: {origin: originOverride ?? origin, pathname}, localStorage: {getItem: () => null, setItem() {}}, setTimeout: () => 0};
  if (settings !== 'absent') {
    // A settings helper that reports disabled / unknown / blows up must make no difference.
    window.__snMiloMainSettings = settings === 'throws'
      ? {subscribe() { throw new Error('boom'); }, get() { throw new Error('boom'); }}
      : {subscribe: (f, cb) => { if (settings === 'disabled') cb({enabled: false, seedOnly: false}); return () => {}; }, get: () => (settings === 'disabled' ? {enabled: false, seedOnly: false} : null)};
  }
  const context = vm.createContext(globals);
  const run = files => { for (const f of files) vm.runInContext(read(f), context, {filename: f}); };
  return {window, document, nodes, callbacks, context, run, origin, runEntry: () => run(ENTRY_FILES)};
}

for (const settings of ['absent', 'disabled', 'unknown', 'throws']) {
  test(`native compatibility runs in a native frame with settings ${settings} (overlay toggle irrelevant)`, () => {
    const f = nativeFrame({settings});
    f.runEntry();
    const control = {placeholder: ''};
    const g = {getControl: () => control};
    f.window.g_form = g; // assigned after document_start, like ServiceNow's onLoad bootstrap
    assert.equal(typeof g.setFieldPlaceholder, 'function', 'compat marker: placeholder API added');
    g.setFieldPlaceholder('comments', 'hint');
    assert.equal(control.placeholder, 'hint');
    const alias = f.document.getElementById('sysverb_insert');
    assert.ok(alias, 'canonical insert action restored');
    assert.equal(alias.getAttribute('data-sn-timecard-native-action'), 'alias');
  });
}

test('native frame initialisation during a reload/update: reinjection of the entry is idempotent and never submits', () => {
  const f = nativeFrame({settings: 'absent'});
  f.runEntry();
  const g = {getControl: () => null};
  f.window.g_form = g;
  f.runEntry(); // the extension updated/reloaded and the entry ran again in the same live frame
  assert.equal(f.nodes.filter(n => n.id === 'sysverb_insert').length, 1);
  assert.equal(typeof f.window.g_form.setFieldPlaceholder, 'function');
  // already-loaded form: the placeholder API is added to the existing g_form, native values untouched
  const f2 = nativeFrame();
  f2.window.g_form = {getControl: () => null, marker: 1};
  f2.run(['config.js', 'core.js', 'quick-actions.js', 'native-compat.js', 'native-actions.js']);
  assert.equal(typeof f2.window.g_form.setFieldPlaceholder, 'function');
  assert.equal(f2.window.g_form.marker, 1);
});

test('document_start installation waits for the parsed footer, with no settings available at all', () => {
  const f = nativeFrame({loading: true});
  f.runEntry();
  assert.equal(f.document.getElementById('sysverb_insert'), null);
  f.document.readyState = 'complete';
  f.callbacks.DOMContentLoaded();
  assert.ok(f.document.getElementById('sysverb_insert'));
});

test('direct top-level native forms install early with overlay off, preserve APIs and remain idempotent on reload', () => {
  for (const mode of ['production', 'test']) {
    const config = vm.runInNewContext(read('config.js') + ';globalThis.SnTimecardConfig', {globalThis: {}});
    const f = nativeFrame({topLevel: true, settings: 'disabled', loading: true, originOverride: config.instances.find(i => i.mode === mode).origin});
    f.runEntry();
    const form = {getControl: () => null, setValue() { throw new Error('must not write'); }, submit() { throw new Error('must not submit'); }};
    f.window.g_form = form;
    assert.equal(typeof form.setFieldPlaceholder, 'function');
    f.document.readyState = 'complete';
    f.callbacks.DOMContentLoaded();
    const alias = f.document.getElementById('sysverb_insert');
    assert.ok(alias);
    const placeholder = form.setFieldPlaceholder;
    f.runEntry();
    assert.equal(form.setFieldPlaceholder, placeholder);
    assert.equal(f.document.getElementById('sysverb_insert'), alias);
    assert.equal(f.nodes.filter(n => n.id === 'sysverb_insert').length, 1);
    const fresh = nativeFrame({topLevel: true, settings: 'disabled', originOverride: config.instances.find(i => i.mode === mode).origin});
    const existingApi = () => {};
    fresh.window.g_form = {setFieldPlaceholder: existingApi};
    fresh.runEntry();
    assert.equal(fresh.window.g_form.setFieldPlaceholder, existingApi);
    assert.ok(fresh.document.getElementById('sysverb_insert'));
  }
});

test('top-level native patches reject foreign, opaque and non-native documents', () => {
  for (const options of [{originOverride: 'https://foreign.invalid'}, {originOverride: 'null'}, {pathname: '/incident.do'}, {pathname: '/task_time_worked.do/extra'}]) {
    const f = nativeFrame({topLevel: true, settings: 'disabled', ...options});
    f.runEntry();
    f.window.g_form = {getControl: () => null};
    assert.equal(f.window.g_form.setFieldPlaceholder, undefined);
    assert.equal(f.document.getElementById('sysverb_insert'), null);
  }
});

test('the compatibility files never reference the settings helper or extension APIs', () => {
  for (const file of ['native-compat.js', 'native-actions.js', 'quick-actions.js', 'core.js', 'config.js']) {
    const src = read(file).replace(/\/\/.*$/gm, ''); // code only, comments may mention chrome.storage
    assert.doesNotMatch(src, /__snMiloMainSettings|sn-milo-/, file);
    assert.doesNotMatch(src, /\b(?:chrome|browser)\.(?:runtime|storage|tabs|scripting)\b/, file);
  }
});

test('native entry is a static, always-on manifest entry (document_start, MAIN, all frames, both origins); overlay entry is top-frame idle', () => {
  const tc = SCRIPT_POLICY.filter(e => e.feature === 'timecard');
  assert.deepEqual(tc.map(e => e.id), ['timecard-overlay', 'timecard-native']);
  const [overlay, native] = tc;
  assert.deepEqual([...overlay.js], ['features/timecard/config.js', 'features/timecard/core.js', 'features/timecard/quick-actions.js', 'features/timecard/content.js']);
  assert.deepEqual([...native.js], ENTRY_FILES.map(f => `features/timecard/${f}`));
  assert.deepEqual([native.run_at, native.world, native.all_frames, [...native.paths], [...native.origins]], ['document_start', 'MAIN', true, ['/task_time_worked.do*'], ['test', 'production']]);
  assert.deepEqual([overlay.run_at, overlay.world, overlay.all_frames, [...overlay.paths], [...overlay.origins]], ['document_idle', 'MAIN', false, ['/*'], ['test', 'production']]);
  assert.ok(!native.js.some(f => /main-settings|controller/.test(f)), 'native entry carries no settings dependency');
});
