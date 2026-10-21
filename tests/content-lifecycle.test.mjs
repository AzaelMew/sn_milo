// Content side of the lifecycle: ISOLATED controller (shared/controller.js) + MAIN helper (shared/main-settings.js)
// against the real router with inert TEST features. Initial-state handshake in both load orders, live
// enable/disable/re-enable without reload, per-frame scoping, stale results, takeover after extension reload.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMiloBackground} from '../shared/router.mjs';
import {EFFECTIVE_KEY} from '../shared/features.mjs';
import {createFakeChrome, createFakeStorage, deliver, contentSender, optionsSender, ORIGINS, PROD, TEST, sleep} from './helpers/fake-chrome.mjs';
import {inertFeatures} from './helpers/test-features.mjs';
import {createFrame, contentChrome} from './helpers/page-sim.mjs';

const READY = {schema: 1, state: 'ready', method: 'notify-current', decidedAt: 1, completedAt: 1};
const settle = async (ms = 15) => { for (let i = 0; i < 4; i++) await sleep(ms / 4); };

function world(initial = {}) {
  const {chrome} = createFakeChrome({storage: createFakeStorage(initial)});
  const app = createMiloBackground({chrome, origins: ORIGINS, features: inertFeatures().modules});
  app.install();
  const setPref = (name, enabled) => deliver(chrome, {feature: 'milo', type: 'set-preference', name, enabled}, optionsSender());
  function frame(origin = PROD, {tabUrl} = {}) {
    const f = createFrame({origin});
    f.chrome = contentChrome({backgroundChrome: chrome, deliver, sender: contentSender(origin, {tabUrl})});
    f.setChrome(f.chrome);
    // MAIN-side probe: records every settings callback for a feature
    f.eval('main', 'globalThis.__seen = []; globalThis.__probe = n => window.__snMiloMainSettings.subscribe(n, s => __seen.push([n, s.enabled]));');
    return f;
  }
  return {chrome, app, setPref, frame};
}
const mainSeen = f => JSON.parse(JSON.stringify(f.eval('main', '__seen')));
const mainGet = (f, n) => JSON.parse(JSON.stringify(f.eval('main', `window.__snMiloMainSettings.get(${JSON.stringify(n)})`)));
const isoEffective = (f, n) => JSON.parse(JSON.stringify(f.eval('isolated', `globalThis.__snMiloController.effective(${JSON.stringify(n)})`)));

test('content scripts are IIFEs: evaluating twice in one world declares no global lexical bindings', () => {
  for (const rel of ['shared/controller.js', 'shared/main-settings.js']) {
    const f = createFrame({origin: PROD});
    f.setChrome({runtime: {id: undefined}, storage: {}});
    assert.doesNotThrow(() => { f.run('isolated', rel); f.run('isolated', rel); f.run('main', rel); f.run('main', rel); }, rel);
  }
});

test('handshake: MAIN helper loaded before or after the controller receives the initial effective state', async () => {
  const w = world({features: {'kb-dark': false}});
  const early = w.frame(); // MAIN first (document_start ordering is not guaranteed across worlds)
  early.run('main', 'shared/main-settings.js');
  early.eval('main', '__probe("kb-dark"); __probe("timecard")');
  early.run('isolated', 'shared/controller.js');
  await settle();
  assert.deepEqual(mainSeen(early), [['kb-dark', false], ['timecard', true]]);
  const late = w.frame();
  late.run('isolated', 'shared/controller.js');
  await settle();
  late.run('main', 'shared/main-settings.js'); // request → fresh broadcast
  await settle();
  late.eval('main', '__probe("kb-dark"); __probe("timecard")');
  assert.deepEqual(mainSeen(late), [['kb-dark', false], ['timecard', true]]);
  assert.deepEqual(isoEffective(late, 'kb-dark'), {enabled: false, seedOnly: false});
});

test('before any reconciliation the page sees nothing enabled (no premature activation)', async () => {
  const storage = createFakeStorage({'crit.migrationV1': READY});
  storage.ctl.failGet = true; // worker cannot read settings yet
  const {chrome} = createFakeChrome({storage});
  const app = createMiloBackground({chrome, origins: ORIGINS, features: inertFeatures().modules});
  app.install();
  const f = createFrame({origin: PROD});
  f.setChrome(contentChrome({backgroundChrome: chrome, deliver, sender: contentSender(PROD)}));
  f.run('main', 'shared/main-settings.js');
  f.run('isolated', 'shared/controller.js');
  f.eval('isolated', 'globalThis.__starts = []; __snMiloController.subscribe("critical-alert", {start: s => __starts.push(s.mode)});');
  await settle();
  assert.equal(f.eval('isolated', '__snMiloController.effective("critical-alert")'), null, 'unknown, not enabled');
  assert.equal(f.eval('main', 'window.__snMiloMainSettings.get("kb-dark")'), null);
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__starts'))), []);
  assert.equal(f.posted.filter(p => p.from === 'isolated').length, 0, 'no settings broadcast without a state');
  storage.ctl.failGet = null;
  await app.ensureReady(); // next entry succeeds → record written → worker pushes it to the tab (tabs.sendMessage)
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__starts'))), ['enabled']);
  assert.deepEqual(mainGet(f, 'kb-dark'), {enabled: true, seedOnly: false});
});

test('enable / disable / re-enable without reload: exactly one start per enable, one stop per disable', async () => {
  const w = world();
  const f = w.frame();
  f.run('isolated', 'shared/controller.js');
  f.run('main', 'shared/main-settings.js');
  f.eval('isolated', 'globalThis.__log = []; __snMiloController.subscribe("kb-dark", {start: () => __log.push("start"), stop: r => __log.push("stop:" + r)});');
  f.eval('main', '__probe("kb-dark")');
  await settle();
  for (const enabled of [false, true, false, true]) { await w.setPref('kb-dark', enabled); await settle(); }
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__log'))), ['start', 'stop:disabled', 'start', 'stop:disabled', 'start']);
  assert.deepEqual(mainSeen(f), [['kb-dark', true], ['kb-dark', false], ['kb-dark', true], ['kb-dark', false], ['kb-dark', true]]);
  assert.equal(f.count('isolated'), 1, 'one controller listener');
  assert.equal(f.count('main'), 1, 'one MAIN helper listener');
});

test('rapid toggles converge on the final state in the page', async () => {
  const w = world();
  const f = w.frame();
  f.run('isolated', 'shared/controller.js');
  f.run('main', 'shared/main-settings.js');
  f.eval('isolated', 'globalThis.__n = 0; __snMiloController.subscribe("timecard", {start: () => __n++, stop: () => __n--});');
  await settle();
  await Promise.all(Array.from({length: 9}, (_, i) => w.setPref('timecard', i % 2 === 1)));
  await settle(30);
  assert.equal(w.app.isEnabled('timecard'), false);
  assert.equal(f.eval('isolated', '__n'), 0);
  assert.deepEqual(mainGet(f, 'timecard'), {enabled: false, seedOnly: false});
});

test('a stale get-effective result cannot re-enable a feature disabled by a newer record', async () => {
  const f = createFrame({origin: PROD});
  const storage = createFakeStorage();
  const record = (rev, enabled) => ({schema: 1, epoch: 'E', rev, at: rev, origins: {[PROD]: ['kb-dark']},
    features: {'kb-dark': {enabled, seedOnly: false, reason: ''}}});
  let release;
  const pushListeners = [];
  const chrome = {runtime: {id: 'x', sendMessage: () => new Promise(r => { release = () => r({ok: true, effective: record(4, true)}); }),
    onMessage: {addListener: fn => pushListeners.push(fn), removeListener() {}}},
  storage: {local: storage.local, onChanged: storage.onChanged}};
  const push = r => { for (const fn of pushListeners) fn({feature: 'milo', type: 'effective', effective: r}, {id: 'x'}, () => {}); };
  f.setChrome(chrome);
  f.run('isolated', 'shared/controller.js');
  f.run('main', 'shared/main-settings.js');
  push(record(5, false)); // worker push (chrome.tabs.sendMessage) overtakes the pending get-effective
  await settle();
  release();
  await settle();
  assert.deepEqual(isoEffective(f, 'kb-dark'), {enabled: false, seedOnly: false});
  assert.deepEqual(mainGet(f, 'kb-dark'), {enabled: false, seedOnly: false});
  push(record(3, true)); // older rev, same epoch: ignored
  await settle();
  assert.deepEqual(isoEffective(f, 'kb-dark'), {enabled: false, seedOnly: false});
  push(record(6, true));
  await settle();
  assert.deepEqual(isoEffective(f, 'kb-dark'), {enabled: true, seedOnly: false});
});

test('per-frame scoping: test-host frames see only timecard; opaque frames stay inert', async () => {
  const w = world({'crit.migrationV1': READY});
  const top = w.frame(PROD);
  const testFrame = w.frame(TEST, {tabUrl: `${PROD}/now/nav/ui`});
  for (const f of [top, testFrame]) { f.run('isolated', 'shared/controller.js'); f.run('main', 'shared/main-settings.js'); }
  await settle();
  assert.deepEqual(isoEffective(top, 'critical-alert'), {enabled: true, seedOnly: false});
  assert.deepEqual(isoEffective(testFrame, 'critical-alert'), {enabled: false, seedOnly: false});
  assert.deepEqual(isoEffective(testFrame, 'kb-dark'), {enabled: false, seedOnly: false});
  assert.deepEqual(isoEffective(testFrame, 'timecard'), {enabled: true, seedOnly: false});
  assert.deepEqual(mainGet(testFrame, 'timecard'), {enabled: true, seedOnly: false});
  assert.deepEqual(mainGet(top, 'kb-dark'), {enabled: true, seedOnly: false});
  assert.equal(testFrame.eval('main', 'window.__snMiloMainSettings.get("kb-dark")'), null, 'out-of-scope features are not relayed');
  // a sandboxed frame has the opaque origin 'null': both scripts exit without listeners or chrome calls
  const opaque = createFrame({origin: 'null'});
  let calls = 0;
  opaque.setChrome({runtime: {id: 'x', sendMessage: async () => { calls++; }}, storage: {local: {get: async () => { calls++; return {}; }}, onChanged: {addListener: () => calls++}}});
  opaque.run('isolated', 'shared/controller.js');
  opaque.run('main', 'shared/main-settings.js');
  await settle();
  assert.deepEqual([calls, opaque.count('isolated'), opaque.count('main'), opaque.posted.length], [0, 0, 0, 0]);
});

test('protocol checks: forged source/origin/schema messages are ignored by both sides', async () => {
  const w = world();
  const f = w.frame();
  f.run('isolated', 'shared/controller.js');
  f.run('main', 'shared/main-settings.js');
  f.eval('main', '__probe("kb-dark")');
  await settle();
  const good = {source: 'sn-milo-controller', protocol: 'sn-milo-settings', version: 1, type: 'settings', controllerId: 'forged', seq: 99, epoch: 'forged-epoch', rev: 0, features: {'kb-dark': {enabled: false, seedOnly: false}}};
  f.dispatch(good, {eventOrigin: 'https://evil.example'});
  f.dispatch(good, {fromForeignWindow: true});
  f.dispatch({...good, version: 2});
  f.dispatch({...good, protocol: 'other'});
  f.dispatch({...good, features: {'kb-dark': {enabled: 'no'}}});
  f.dispatch({...good, seq: 1.5});
  assert.deepEqual(mainGet(f, 'kb-dark'), {enabled: true, seedOnly: false});
  const broadcasts = () => f.posted.filter(p => p.from === 'isolated').length;
  const before = broadcasts();
  f.dispatch({source: 'sn-milo-main', protocol: 'sn-milo-settings', version: 1, type: 'request'}, {eventOrigin: 'https://evil.example'});
  f.dispatch({source: 'sn-milo-main', protocol: 'sn-milo-settings', version: 7, type: 'request'});
  assert.equal(broadcasts(), before, 'controller ignores invalid requests');
  f.dispatch({source: 'sn-milo-main', protocol: 'sn-milo-settings', version: 1, type: 'request'});
  assert.equal(broadcasts(), before + 1);
  assert.ok(f.posted.every(p => p.targetOrigin === PROD), 'always the exact origin, never "*"');
  // documented ceiling: a same-origin page script CAN forge a valid message (not an auth boundary)
  f.dispatch(good);
  assert.deepEqual(mainGet(f, 'kb-dark'), {enabled: false, seedOnly: false});
});

test('reinjection by the SAME extension instance (shared isolated world): new controller supersedes the old one and adopts its live subscriptions', async () => {
  const w = world();
  const f = w.frame();
  f.run('isolated', 'shared/controller.js');
  f.run('main', 'shared/main-settings.js');
  f.eval('main', '__probe("kb-dark")');
  f.eval('isolated', 'globalThis.__log = []; __snMiloController.subscribe("kb-dark", {start: () => __log.push("old-start"), stop: r => __log.push("old-stop:" + r)});');
  await settle();
  const oldController = f.eval('isolated', '__snMiloController');
  f.run('isolated', 'shared/controller.js'); // watchdog reinjection while the extension instance is alive
  f.run('main', 'shared/main-settings.js');
  f.eval('isolated', '__snMiloController.subscribe("kb-dark", {start: () => __log.push("new-start"), stop: r => __log.push("new-stop:" + r)});');
  await settle();
  assert.equal(oldController.retired, true);
  assert.notEqual(f.eval('isolated', '__snMiloController'), oldController);
  assert.equal(f.count('isolated'), 1, 'old window listener removed');
  assert.equal(f.intervals('isolated'), 1, 'old liveness timer removed');
  assert.equal(f.count('main'), 1, 'old MAIN helper listener removed');
  assert.equal(f.eval('isolated', '__snMiloController.subscriptions'), 2, 'one world-level registry, no duplicates');
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__log'))), ['old-start', 'new-start'], 'handed over: not stopped, not restarted');
  await w.setPref('kb-dark', false);
  await settle();
  await w.setPref('kb-dark', true);
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__log'))),
    ['old-start', 'new-start', 'old-stop:disabled', 'new-stop:disabled', 'old-start', 'new-start'], 'the replacement drives adopted subscribers');
  assert.deepEqual(mainSeen(f).at(-1), ['kb-dark', true], 'adopted MAIN subscribers keep receiving');
});

test('same-world supersede: a feature holding the OLD controller object keeps working (effective/subscribe/unsubscribe delegate)', async () => {
  const w = world();
  const f = w.frame();
  f.run('isolated', 'shared/controller.js');
  f.eval('isolated', 'globalThis.__old = __snMiloController; globalThis.__log = []; globalThis.__un = __old.subscribe("timecard", {start: () => __log.push("start"), stop: r => __log.push("stop:" + r)});');
  await settle();
  f.run('isolated', 'shared/controller.js');
  f.run('isolated', 'shared/controller.js'); // twice: chains of supersede
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__old.effective("timecard")'))), {enabled: true, seedOnly: false}, 'old reference answers with the live state');
  await w.setPref('timecard', false);
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__old.effective("timecard")'))), {enabled: false, seedOnly: false});
  f.eval('isolated', '__old.subscribe("timecard", {start: () => __log.push("late-start")})');
  await w.setPref('timecard', true);
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__log'))), ['start', 'stop:disabled', 'start', 'late-start']);
  f.eval('isolated', '__un()');
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__log'))).at(-1), 'stop:unsubscribed');
  assert.equal(f.eval('isolated', '__snMiloController.subscriptions'), 1);
  // invalidation (dead extension) still stops every adopted subscriber
  f.chrome.invalidate();
  f.setVisibility('hidden');
  assert.equal(f.eval('isolated', '__snMiloController.retired'), true);
  assert.equal(f.eval('isolated', '__old.effective("timecard")'), null, 'no state from a dead world');
  assert.equal(f.eval('isolated', '__snMiloController.subscriptions'), 0);
});

test('subscriber update(state): called once the state is first known (also disabled), on every change, never for unknown', async () => {
  const w = world({features: {timecard: false}});
  const f = w.frame();
  f.run('isolated', 'shared/controller.js');
  f.eval('isolated', 'globalThis.__up = []; __snMiloController.subscribe("timecard", {update: s => __up.push(s.enabled)});');
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__up'))), [], 'unknown: no call');
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__up'))), [false], 'unknown -> disabled is reported');
  await w.setPref('kb-dark', false); // another feature: no change for timecard
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__up'))), [false]);
  await w.setPref('timecard', true);
  await settle();
  f.eval('isolated', '__snMiloController.subscribe("timecard", {update: s => __up.push("late:" + s.enabled)});');
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__up'))), [false, true, 'late:true'], 'late subscriber gets the known state synchronously');
});

test('same-world supersede before the first record: adopted update() subscribers get the successor state; old ready follows the successor', async () => {
  const storage = createFakeStorage({features: {timecard: false}});
  storage.ctl.failGet = true;
  const {chrome} = createFakeChrome({storage});
  const app = createMiloBackground({chrome, origins: ORIGINS, features: inertFeatures().modules});
  app.install();
  const f = createFrame({origin: PROD});
  f.chrome = contentChrome({backgroundChrome: chrome, deliver, sender: contentSender(PROD)});
  f.setChrome(f.chrome);
  f.run('isolated', 'shared/controller.js');
  f.eval('isolated', 'globalThis.__up = []; globalThis.__old = __snMiloController; __old.subscribe("timecard", {update: s => __up.push(s.enabled)}); globalThis.__readyOld = "pending"; __old.ready.then(v => { __readyOld = v; });');
  await settle();
  f.run('isolated', 'shared/controller.js');
  await settle();
  assert.equal(f.eval('isolated', '__readyOld'), 'pending', 'old ready does not resolve false while a successor lives');
  storage.ctl.failGet = null;
  await app.ensureReady();
  await settle();
  f.advance(30000);
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__up'))), [false], 'disabled reported to the adopted subscriber');
  assert.equal(f.eval('isolated', '__readyOld'), true, 'old ready resolved with the successor ready');
});

test('page-sim fidelity: an invalidated context no longer receives storage.onChanged events', async () => {
  const w = world();
  const f = w.frame();
  let got = 0;
  f.chrome.storage.onChanged.addListener(() => { got++; });
  await w.chrome.storage.local.set({probe: 1});
  await settle();
  assert.equal(got, 1);
  f.chrome.invalidate();
  await w.chrome.storage.local.set({probe: 2});
  f.chrome.storage.onChanged.addListener(() => { got += 100; });
  await w.chrome.storage.local.set({probe: 3});
  await settle();
  assert.equal(got, 1, 'no events after invalidation, late registrations are inert');
  assert.equal(f.chrome.storage.onChanged.count, 0);
});

test('an orphaned controller retires on the next MAIN request and never answers with stale state', async () => {
  const w = world();
  const f = w.frame();
  f.run('isolated', 'shared/controller.js');
  f.run('main', 'shared/main-settings.js');
  f.eval('isolated', 'globalThis.__log = []; __snMiloController.subscribe("timecard", {start: () => __log.push("start"), stop: r => __log.push("stop:" + r)});');
  f.eval('main', '__probe("timecard")');
  await settle();
  f.chrome.invalidate(); // extension reloaded/removed; no new controller injected (yet)
  await w.setPref('timecard', false); // the orphan cannot learn about this (no events reach it)
  await settle();
  assert.equal(f.eval('isolated', '__snMiloController.retired'), false, 'nothing reached the orphan yet');
  const broadcasts = () => f.posted.filter(p => p.from === 'isolated').length;
  const before = broadcasts();
  f.dispatch({source: 'sn-milo-main', protocol: 'sn-milo-settings', version: 1, type: 'request'});
  assert.equal(broadcasts(), before, 'no stale answer to the MAIN request');
  assert.equal(f.eval('isolated', '__snMiloController.retired'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__log'))), ['start', 'stop:invalidated']);
  assert.equal(f.count('isolated'), 0, 'window listener removed');
  // a MAIN helper reinjected later asks again: still no answer from the orphan
  f.run('main', 'shared/main-settings.js');
  await settle();
  assert.equal(broadcasts(), before);
});

test('an orphaned controller retires on any public entry point (subscribe / effective)', async () => {
  for (const entry of ['subscribe', 'effective']) {
    const w = world();
    const f = w.frame();
    f.run('isolated', 'shared/controller.js');
    f.eval('isolated', 'globalThis.__log = []; __snMiloController.subscribe("timecard", {start: () => __log.push("start"), stop: r => __log.push("stop:" + r)});');
    await settle();
    f.chrome.invalidate();
    const result = entry === 'subscribe'
      ? f.eval('isolated', 'globalThis.__late = 0; typeof __snMiloController.subscribe("kb-dark", {start: () => __late++})')
      : f.eval('isolated', '__snMiloController.effective("timecard")');
    if (entry === 'effective') assert.equal(result, null, 'no stale state from a dead controller');
    else assert.equal(f.eval('isolated', '__late'), 0, 'late subscriber never started');
    assert.equal(f.eval('isolated', '__snMiloController.retired'), true, entry);
    assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__log'))), ['start', 'stop:invalidated'], entry);
    assert.equal(f.count('isolated'), 0, entry);
  }
});

test('MAIN helper ignores an older record (same epoch, lower rev) from a different controller', async () => {
  const f = createFrame({origin: PROD});
  f.run('main', 'shared/main-settings.js');
  f.eval('main', 'globalThis.__seen = []; window.__snMiloMainSettings.subscribe("kb-dark", s => __seen.push(s.enabled));');
  const msg = (controllerId, epoch, rev, enabled, seq = 1) => ({source: 'sn-milo-controller', protocol: 'sn-milo-settings', version: 1,
    type: 'settings', controllerId, seq, epoch, rev, features: {'kb-dark': {enabled, seedOnly: false}}});
  f.dispatch(msg('new', 'E', 7, false));
  f.dispatch(msg('orphan', 'E', 5, true)); // stale controller with an older record
  assert.deepEqual(mainGet(f, 'kb-dark'), {enabled: false, seedOnly: false});
  f.dispatch(msg('other', 'E', 7, false)); // same rev from a replacement controller: accepted (no change)
  f.dispatch(msg('other', 'E', 8, true, 2));
  assert.deepEqual(mainGet(f, 'kb-dark'), {enabled: true, seedOnly: false});
  f.dispatch(msg('fresh-epoch', 'F', 1, false)); // storage was reset → new epoch: accepted
  assert.deepEqual(mainGet(f, 'kb-dark'), {enabled: false, seedOnly: false});
  f.dispatch({...msg('x', 'F', 9, true), rev: 1.5});
  f.dispatch({...msg('x', 'F', 9, true), epoch: 3});
  assert.deepEqual(mainGet(f, 'kb-dark'), {enabled: false, seedOnly: false}, 'malformed epoch/rev rejected');
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('main', '__seen'))), [false, true, false]);
});

test('controller relays epoch and rev of the accepted record to MAIN', async () => {
  const w = world();
  const f = w.frame();
  f.run('isolated', 'shared/controller.js');
  await settle();
  const last = f.posted.filter(p => p.from === 'isolated').at(-1).data;
  const stored = (await w.chrome.storage.local.get(EFFECTIVE_KEY))[EFFECTIVE_KEY];
  assert.equal(last.epoch, stored.epoch);
  assert.equal(last.rev, stored.rev);
});

test('seed-only subscribers: alerts in the seeding phase start only when they opt in', async () => {
  const w = world({'crit.migrationV1': {schema: 1, state: 'seeding', method: 'seed-silently', decidedAt: 1}});
  const f = w.frame();
  f.run('isolated', 'shared/controller.js');
  f.eval('isolated', `globalThis.__log = [];
    __snMiloController.subscribe("critical-alert", {start: s => __log.push("plain:" + s.mode)});
    __snMiloController.subscribe("critical-alert", {start: s => __log.push("seed:" + s.mode), stop: r => __log.push("seed-stop:" + r)}, {allowSeedOnly: true});`);
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__log'))), ['seed:seed']);
  await w.app.store.completeSeed('critical-alert', ['0123456789abcdef0123456789abcdef|1 - Critical|New|X']);
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__log'))), ['seed:seed', 'plain:enabled', 'seed-stop:mode-change', 'seed:enabled']);
});

// ---- storage isolation, worker push, liveness (separate isolated worlds per extension instance) ----
test('content scripts cannot read or write chrome.storage once the worker is up; the controller never touches it', async () => {
  const w = world();
  const f = w.frame();
  f.run('isolated', 'shared/controller.js');
  f.run('main', 'shared/main-settings.js');
  await settle();
  await assert.rejects(f.chrome.storage.local.set({'crit.migrationV1': {schema: 1, state: 'ready', method: 'import', decidedAt: 1}}), /not allowed from this context/);
  await assert.rejects(f.chrome.storage.local.get('features'), /not allowed from this context/);
  f.chrome.counter.storage = 0;
  f.eval('isolated', 'globalThis.__log = []; __snMiloController.subscribe("kb-dark", {start: () => __log.push("start"), stop: r => __log.push("stop:" + r)});');
  await w.setPref('kb-dark', false);
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__log'))), ['start', 'stop:disabled'], 'state arrives by worker push');
  assert.equal(f.chrome.counter.storage, 0, 'controller made no storage calls');
  assert.equal(f.chrome.storage.onChanged.count, 0, 'controller has no storage.onChanged listener');
  assert.equal(f.chrome.runtime.onMessage.count, 1, 'one push listener');
});

test('worker pushes every persisted record to matching tabs only after the write succeeded', async () => {
  const {chrome, storage, calls} = createFakeChrome({storage: createFakeStorage()});
  const app = createMiloBackground({chrome, origins: ORIGINS, features: inertFeatures().modules});
  app.install();
  const got = [];
  chrome.__fake.attachReceiver(7, `${PROD}/x`, 0, m => got.push(m));
  chrome.__fake.attachReceiver(8, 'https://evil.example/x', 0, m => got.push({foreign: m}));
  await app.ensureReady();
  await settle();
  const query = calls.find(c => c[0] === 'tabs.query');
  assert.deepEqual(query[1], {url: [`${PROD}/*`, `${TEST}/*`]});
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], {feature: 'milo', type: 'effective', effective: storage.dump()[EFFECTIVE_KEY]});
  storage.ctl.failSet = items => (EFFECTIVE_KEY in items ? 'quota' : null);
  await deliver(chrome, {feature: 'milo', type: 'set-preference', name: 'kb-dark', enabled: false}, optionsSender());
  await settle();
  assert.equal(got.length, 1, 'no push of an unpersisted record');
  storage.ctl.failSet = null;
  await app.ensureReady();
  await app.idle();
  await settle();
  assert.equal(got.length, 2);
  assert.equal(got[1].effective.features['kb-dark'].enabled, false);
  assert.ok(!got.some(m => m.foreign), 'foreign tabs never receive pushes');
});

test('push failures (no receiver, query error) never reject or break reconciliation', async () => {
  const unhandled = [];
  const onUnhandled = e => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const {chrome, tabs} = createFakeChrome({storage: createFakeStorage()});
    const app = createMiloBackground({chrome, origins: ORIGINS, features: inertFeatures().modules});
    app.install();
    chrome.__fake.attachReceiver(9, `${PROD}/y`, 0, () => {}); // a tab whose receiver goes away
    tabs.failQuery = 'tabs down';
    await app.ensureReady();
    tabs.failQuery = null;
    await deliver(chrome, {feature: 'milo', type: 'set-preference', name: 'kb-dark', enabled: false}, optionsSender());
    await settle();
    assert.equal(app.isEnabled('kb-dark'), false);
    assert.equal((await app.status()).error, null);
  } finally { process.off('unhandledRejection', onUnhandled); }
  assert.deepEqual(unhandled, []);
});

test('controller ignores pushes from other senders and malformed pushes', async () => {
  const record = enabled => ({schema: 1, epoch: 'E', rev: 9, at: 1, origins: {[PROD]: ['kb-dark']}, features: {'kb-dark': {enabled, seedOnly: false, reason: ''}}});
  const listeners = [];
  const f = createFrame({origin: PROD});
  f.setChrome({runtime: {id: 'me', sendMessage: async () => ({ok: false, error: 'settings-unavailable'}),
    onMessage: {addListener: fn => listeners.push(fn), removeListener() {}}}, storage: {}});
  f.run('isolated', 'shared/controller.js');
  await settle();
  assert.equal(listeners.length, 1);
  const responses = [];
  const respond = () => responses.push('respond');
  const msg = {feature: 'milo', type: 'effective', effective: record(true)};
  assert.notEqual(listeners[0](msg, {id: 'other-extension'}, respond), true);
  listeners[0](msg, {id: 'me', tab: {id: 1, url: `${PROD}/`}}, respond); // another content script, not the worker
  listeners[0]({...msg, type: 'nope'}, {id: 'me'}, respond);
  listeners[0]({...msg, feature: 'kb-dark'}, {id: 'me'}, respond);
  listeners[0]({feature: 'milo', type: 'effective', effective: {schema: 2}}, {id: 'me'}, respond);
  assert.equal(f.eval('isolated', '__snMiloController.effective("kb-dark")'), null, 'nothing accepted');
  listeners[0](msg, {id: 'me'}, respond);
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__snMiloController.effective("kb-dark")'))), {enabled: true, seedOnly: false});
  assert.deepEqual(responses, [], 'pushes are never answered (no open channels)');
});

test('lost push: the controller re-requests on visibilitychange and on its periodic backstop', async () => {
  const w = world();
  const f = w.frame();
  f.run('isolated', 'shared/controller.js');
  await settle();
  w.chrome.__fake.tabsCtl.dropPushes = true;
  await w.setPref('timecard', false);
  await settle();
  assert.deepEqual(isoEffective(f, 'timecard'), {enabled: true, seedOnly: false}, 'push lost');
  f.setVisibility('hidden');
  await settle();
  assert.deepEqual(isoEffective(f, 'timecard'), {enabled: true, seedOnly: false}, 'hidden: no request');
  f.setVisibility('visible');
  await settle();
  assert.deepEqual(isoEffective(f, 'timecard'), {enabled: false, seedOnly: false}, 'visible again: re-requested');
  await w.setPref('timecard', true);
  await settle();
  assert.deepEqual(isoEffective(f, 'timecard'), {enabled: false, seedOnly: false});
  f.advance(30000);
  await settle();
  assert.deepEqual(isoEffective(f, 'timecard'), {enabled: true, seedOnly: false}, 'periodic backstop re-requested');
});

test('extension reload (separate isolated worlds): new controller cannot see the old one; the old one retires by its liveness check and stops its subscribers', async () => {
  const w = world();
  const f = w.frame();
  f.run('isolated', 'shared/controller.js');
  f.run('main', 'shared/main-settings.js');
  f.eval('main', '__probe("kb-dark")');
  f.eval('isolated', 'globalThis.__mark = "old"; globalThis.__log = []; __snMiloController.subscribe("kb-dark", {start: () => __log.push("old-start"), stop: r => __log.push("old-stop:" + r)});');
  await settle();
  const oldWorld = f.worlds.isolated;
  assert.equal(f.intervals(oldWorld), 1, 'liveness interval running');
  f.chrome.invalidate(); // the old extension instance is gone
  const fresh = contentChrome({backgroundChrome: w.chrome, deliver, sender: contentSender(PROD)});
  f.newExtensionInstance(fresh);
  f.run('isolated', 'shared/controller.js'); // reinjected by the new instance (scripting.executeScript)
  assert.equal(f.eval('isolated', 'typeof globalThis.__mark'), 'undefined', 'new world does not see the old globals');
  f.eval('isolated', 'globalThis.__log = []; __snMiloController.subscribe("kb-dark", {start: () => __log.push("new-start"), stop: r => __log.push("new-stop:" + r)});');
  await settle();
  assert.equal(f.eval(oldWorld, '__snMiloController.retired'), false, 'nothing reached the orphan yet');
  f.advance(5000);
  assert.equal(f.eval(oldWorld, '__snMiloController.retired'), true, 'retired by the liveness check');
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval(oldWorld, '__log'))), ['old-start', 'old-stop:invalidated']);
  assert.deepEqual([f.count(oldWorld), f.intervals(oldWorld), f.docListeners(oldWorld)], [0, 0, 0], 'old listeners + timers gone');
  f.run('main', 'shared/main-settings.js'); // MAIN helper reinjected too (adopts subscribers)
  await w.setPref('kb-dark', false);
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__log'))), ['new-start', 'new-stop:disabled']);
  assert.deepEqual(mainSeen(f).at(-1), ['kb-dark', false]);
  assert.equal(f.count('main'), 1, 'MAIN helper takeover still in the shared MAIN world');
});

test('liveness: an orphan retires on visibilitychange too', async () => {
  const w = world();
  const f = w.frame();
  f.run('isolated', 'shared/controller.js');
  f.eval('isolated', 'globalThis.__log = []; __snMiloController.subscribe("timecard", {start: () => __log.push("start"), stop: r => __log.push("stop:" + r)});');
  await settle();
  f.chrome.invalidate();
  f.setVisibility('hidden');
  assert.equal(f.eval('isolated', '__snMiloController.retired'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.eval('isolated', '__log'))), ['start', 'stop:invalidated']);
  assert.deepEqual([f.intervals('isolated'), f.docListeners('isolated')], [0, 0]);
});

test('backstop: no periodic get-effective while the document is hidden; visible again re-requests', async () => {
  const w = world();
  const f = w.frame();
  let requests = 0;
  const send = f.chrome.runtime.sendMessage;
  f.chrome.runtime.sendMessage = m => { if (m?.type === 'get-effective') requests++; return send(m); };
  f.run('isolated', 'shared/controller.js');
  await settle();
  assert.equal(requests, 1, 'initial request');
  f.setVisibility('hidden');
  await settle();
  f.advance(120000);
  await settle();
  assert.equal(requests, 1, 'hidden: backstop skipped');
  f.setVisibility('visible');
  await settle();
  assert.equal(requests, 2, 'visibilitychange → visible requests');
  f.advance(30000);
  await settle();
  assert.equal(requests, 3, 'visible: backstop runs again');
});

test('ready resolves false when the controller retires before any state was accepted (no hanging awaiters)', async () => {
  const storage = createFakeStorage();
  storage.ctl.failGet = true;
  const {chrome} = createFakeChrome({storage});
  const app = createMiloBackground({chrome, origins: ORIGINS, features: inertFeatures().modules});
  app.install();
  const f = createFrame({origin: PROD});
  f.setChrome(contentChrome({backgroundChrome: chrome, deliver, sender: contentSender(PROD)}));
  f.run('isolated', 'shared/controller.js');
  f.eval('isolated', 'globalThis.__ready = "pending"; __snMiloController.ready.then(v => { globalThis.__ready = v; });');
  await settle();
  assert.equal(f.eval('isolated', '__ready'), 'pending');
  f.eval('isolated', '__snMiloController.stop("invalidated")');
  await settle();
  assert.equal(f.eval('isolated', '__ready'), false);
  // superseded by a reinjected controller in the same world: the old one's ready FOLLOWS the successor's
  // (deliberate change: it used to resolve false and never learn the successor's state) and still settles —
  // false once the successor retires without a state
  const g = createFrame({origin: PROD});
  g.setChrome(contentChrome({backgroundChrome: chrome, deliver, sender: contentSender(PROD)}));
  g.run('isolated', 'shared/controller.js');
  g.eval('isolated', 'globalThis.__old = __snMiloController; globalThis.__ready = "pending"; __old.ready.then(v => { globalThis.__ready = v; });');
  g.run('isolated', 'shared/controller.js');
  await settle();
  assert.equal(g.eval('isolated', '__ready'), 'pending', 'follows the live successor');
  g.eval('isolated', '__snMiloController.stop("invalidated")');
  await settle();
  assert.equal(g.eval('isolated', '__ready'), false);
});
