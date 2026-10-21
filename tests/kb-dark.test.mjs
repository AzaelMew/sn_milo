// KB dark mode toggle (features/kb-dark/content.js) against the REAL router + settings controller (page-sim).
// The declarative CSS is always injected on /kb and /kb?*; this ISOLATED subscriber owns the off attribute on <html>:
// absent (dark) until the effective state says off, set when off, removed when on — live, without reload.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMiloBackground} from '../shared/router.mjs';
import {createFakeChrome, createFakeStorage, deliver, contentSender, optionsSender, ORIGINS, PROD, TEST, sleep} from './helpers/fake-chrome.mjs';
import {createFrame, contentChrome} from './helpers/page-sim.mjs';
import {SCRIPT_POLICY, KB_PATHS, buildContentScripts} from '../shared/script-policy.mjs';

const TOGGLE = 'features/kb-dark/content.js';
const ATTR = 'data-milo-kb-off';
const settle = async (ms = 15) => { for (let i = 0; i < 4; i++) await sleep(ms / 4); };

/** Shared <html> element for every world of the frame (attribute log records each write). */
function htmlElement() {
  const attrs = new Map();
  const writes = [];
  return {
    attrs, writes,
    hasAttribute: n => attrs.has(n),
    getAttribute: n => (attrs.has(n) ? attrs.get(n) : null),
    setAttribute: (n, v) => { writes.push(['set', n]); attrs.set(n, String(v)); },
    removeAttribute: n => { writes.push(['remove', n]); attrs.delete(n); }
  };
}

function world(initial = {}, {failGet = false} = {}) {
  const storage = createFakeStorage(initial);
  if (failGet) storage.ctl.failGet = true;
  const {chrome} = createFakeChrome({storage});
  const app = createMiloBackground({chrome, origins: ORIGINS, features: []});
  app.install();
  const setPref = (name, enabled) => deliver(chrome, {feature: 'milo', type: 'set-preference', name, enabled}, optionsSender());
  function frame(origin = PROD, path = '/kb?id=kb_article') {
    const html = htmlElement();
    const f = createFrame({origin, url: `${origin}${path}`, document: {documentElement: {get: () => html, configurable: true}}});
    f.html = html;
    f.chrome = contentChrome({backgroundChrome: chrome, deliver, sender: contentSender(origin, {path})});
    f.setChrome(f.chrome);
    return f;
  }
  return {chrome, storage, app, setPref, frame};
}
const off = f => f.html.hasAttribute(ATTR);
const load = f => { f.run('isolated', 'shared/controller.js'); f.run('isolated', TOGGLE); };

test('enabled (default): no off attribute; nothing written', async () => {
  const w = world();
  const f = w.frame();
  load(f);
  await settle();
  assert.equal(off(f), false);
  assert.deepEqual(f.html.writes, [], 'already in the right state: no attribute churn');
});

test('saved-disabled: default dark until the effective state arrives, then the off attribute is set', async () => {
  const w = world({features: {'kb-dark': false}}, {failGet: true}); // worker cannot read settings yet
  const f = w.frame();
  load(f);
  await settle();
  assert.equal(off(f), false, 'unknown state ⇒ default dark (documented first-paint tradeoff)');
  w.storage.ctl.failGet = null;
  await w.app.ensureReady();
  await settle();
  assert.equal(off(f), true, 'off once the state is known');
  const g = w.frame(); // a later page load in the same profile
  load(g);
  assert.equal(off(g), false, 'synchronously after injection: still dark (state is asynchronous)');
  await settle();
  assert.equal(off(g), true);
});

test('live toggles without reload: off on disable, removed on enable, idempotent', async () => {
  const w = world();
  const f = w.frame();
  load(f);
  await settle();
  for (const enabled of [false, true, false, false, true]) {
    await w.setPref('kb-dark', enabled);
    await settle();
    assert.equal(off(f), !enabled, `enabled=${enabled}`);
  }
  assert.deepEqual(f.html.writes, [['set', ATTR], ['remove', ATTR], ['set', ATTR], ['remove', ATTR]]);
});

test('other features toggling never touch the KB attribute', async () => {
  const w = world({features: {'kb-dark': false}});
  const f = w.frame();
  load(f);
  await settle();
  const before = f.html.writes.length;
  await w.setPref('timecard', false);
  await w.setPref('informatica-button', false);
  await settle();
  assert.equal(f.html.writes.length, before);
  assert.equal(off(f), true);
});

test('no settings controller ⇒ inert (CSS stays dark, no attribute writes, no throw)', () => {
  const f = createFrame({origin: PROD, url: `${PROD}/kb`, document: {documentElement: {get: () => html}}});
  const html = htmlElement();
  f.setChrome({runtime: {id: undefined}});
  f.run('isolated', TOGGLE);
  assert.deepEqual(html.writes, []);
  const opaque = createFrame({origin: 'null'});
  opaque.run('isolated', TOGGLE);
  assert.equal(opaque.eval('isolated', 'typeof globalThis.__snMiloKbDark'), 'undefined');
});

test('double injection of the toggle in one world: one subscription, previous unsubscribed, still live', async () => {
  const w = world();
  const f = w.frame();
  load(f);
  await settle();
  f.run('isolated', TOGGLE);
  await settle();
  assert.equal(f.eval('isolated', '__snMiloController.subscriptions'), 1);
  await w.setPref('kb-dark', false);
  await settle();
  assert.equal(off(f), true);
  await w.setPref('kb-dark', true);
  await settle();
  assert.equal(off(f), false);
});

test('same-world controller reinjection (handoff): the toggle keeps following settings without resubscribing', async () => {
  const w = world();
  const f = w.frame();
  load(f);
  await settle();
  f.run('isolated', 'shared/controller.js');
  await settle();
  assert.equal(f.eval('isolated', '__snMiloController.subscriptions'), 1);
  await w.setPref('kb-dark', false);
  await settle();
  assert.equal(off(f), true);
  await w.setPref('kb-dark', true);
  await settle();
  assert.equal(off(f), false);
});

test('same-world controller supersede BEFORE the first record, saved-disabled: the off attribute is still set', async () => {
  const w = world({features: {'kb-dark': false}}, {failGet: true}); // no record reaches the first controller
  const f = w.frame();
  load(f);
  await settle();
  f.run('isolated', 'shared/controller.js'); // same-world reinjection while the state is still unknown
  await settle();
  assert.equal(off(f), false, 'still unknown: default dark, untouched');
  w.storage.ctl.failGet = null;
  await w.app.ensureReady();
  await settle();
  f.advance(30000); // successor's backstop get-effective
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__snMiloController.effective("kb-dark")'))), {enabled: false, seedOnly: false});
  assert.equal(off(f), true, 'known-disabled after the handoff must set the attribute');
});

test('extension context invalidated: the attribute keeps its last value (no flip either way)', async () => {
  for (const enabled of [true, false]) {
    const w = world({features: {'kb-dark': enabled}});
    const f = w.frame();
    load(f);
    await settle();
    const writes = f.html.writes.length;
    f.chrome.invalidate();
    f.advance(5000); // liveness check retires the controller and stops subscribers ('invalidated')
    assert.equal(f.eval('isolated', '__snMiloController.retired'), true);
    assert.equal(off(f), !enabled);
    assert.equal(f.html.writes.length, writes, `enabled=${enabled}: untouched`);
  }
});

test('policy: CSS + toggle on production /kb and /kb?* only, document_start, top frame, toggle after the controller', () => {
  const kb = SCRIPT_POLICY.filter(e => e.feature === 'kb-dark');
  assert.deepEqual(kb.map(e => e.id), ['kb-dark-css', 'kb-dark-toggle']);
  const built = buildContentScripts({production: PROD, test: TEST}, kb);
  assert.deepEqual(built, [
    {matches: [`${PROD}/kb`, `${PROD}/kb?*`], css: ['features/kb-dark/dark.css'], run_at: 'document_start', world: 'ISOLATED', all_frames: false},
    {matches: [`${PROD}/kb`, `${PROD}/kb?*`], js: [TOGGLE], run_at: 'document_start', world: 'ISOLATED', all_frames: false}
  ]);
  for (const e of kb) { assert.deepEqual([...e.paths], [...KB_PATHS]); assert.deepEqual([...e.origins], ['production']); }
  const idx = id => SCRIPT_POLICY.findIndex(e => e.id === id);
  assert.ok(idx('settings-controller') < idx('kb-dark-toggle'), 'controller evaluates first (same world + timing ⇒ manifest order)');
});
