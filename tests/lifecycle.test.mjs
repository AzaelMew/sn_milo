// Worker lifecycle: synchronous listener registration, ONE serialized readiness path on every entry (including
// before onInstalled), fail-closed migration gating, storage failures, rapid toggles, restart, stale reconciliation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMiloBackground} from '../shared/router.mjs';
import {EFFECTIVE_KEY} from '../shared/features.mjs';
import {createFakeChrome, createFakeStorage, deliver, contentSender, optionsSender, ORIGINS, sleep} from './helpers/fake-chrome.mjs';
import {inertFeatures} from './helpers/test-features.mjs';

const READY = {schema: 1, state: 'ready', method: 'notify-current', decidedAt: 1, completedAt: 1};
function boot(storage = createFakeStorage(), {install = true} = {}) {
  const {chrome, calls} = createFakeChrome({storage});
  const f = inertFeatures();
  const app = createMiloBackground({chrome, origins: ORIGINS, features: f.modules});
  if (install) app.install();
  return {chrome, storage, calls, app, f};
}
const activity = f => Object.fromEntries(['crit', 'ix', 'inf', 'kb', 'tc'].map(k => [k, f[k].calls.filter(c => c[0] !== 'effective')]));
const effectiveCalls = (f, k) => f[k].calls.filter(c => c[0] === 'effective');

test('background.js registers every listener synchronously at module evaluation (storage never resolves)', async () => {
  const storage = createFakeStorage();
  const {chrome} = createFakeChrome({storage});
  chrome.storage.local.get = () => new Promise(() => {});
  const previous = globalThis.chrome;
  globalThis.chrome = chrome;
  try {
    await import(`../background.js?case=sync-registration-${Date.now()}`);
    for (const ev of [chrome.runtime.onMessage, chrome.runtime.onInstalled, chrome.runtime.onStartup, chrome.alarms.onAlarm,
      chrome.notifications.onClicked, chrome.storage.onChanged]) assert.equal(ev.listeners.length, 1);
    assert.equal(typeof globalThis.snMilo?.status, 'function', 'console/CDP status helper');
    assert.deepEqual(storage.ctl.accessLevelCalls, [{accessLevel: 'TRUSTED_CONTEXTS'}], 'storage restricted to trusted contexts at evaluation');
    // a message while the first storage read hangs keeps the channel open and is not answered prematurely
    const {PRODUCTION_ORIGIN} = await import('../shared/origins.generated.mjs');
    let answered = false;
    const keep = chrome.runtime.onMessage.dispatch({feature: 'milo', type: 'get-effective'}, contentSender(PRODUCTION_ORIGIN, {id: chrome.runtime.id}), () => { answered = true; });
    assert.deepEqual(keep, [true]);
    await sleep(20);
    assert.equal(answered, false);
  } finally {
    globalThis.chrome = previous;
    delete globalThis.snMilo;
  }
});

test('background.js import with failing storage produces no unhandled rejection', async () => {
  const {chrome} = createFakeChrome({storage: createFakeStorage()});
  chrome.storage.local.get = async () => { throw new Error('storage down'); };
  const unhandled = [];
  const onUnhandled = e => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  const previous = globalThis.chrome;
  globalThis.chrome = chrome;
  try {
    await import(`../background.js?case=failing-storage-${Date.now()}`);
    await sleep(20);
    const status = await globalThis.snMilo.status();
    assert.match(status.error.message, /storage down/);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    globalThis.chrome = previous;
    delete globalThis.snMilo;
  }
  assert.deepEqual(unhandled, []);
});

test('messages and alarms BEFORE onInstalled on a fresh profile: alerts pending, zero premature activation', async () => {
  const env = boot();
  const results = await Promise.all([
    deliver(env.chrome, {feature: 'critical-alert', type: 'ping', n: 1}, contentSender()),
    deliver(env.chrome, {feature: 'interaction-alert', type: 'ping', n: 1}, contentSender()),
    env.app.onAlarm({name: 'snTkHealthCheck'}),
    env.app.onAlarm({name: 'snIxHealthCheck'})
  ]);
  assert.equal(results[0].response.error, 'feature-disabled');
  assert.equal(results[1].response.error, 'feature-disabled');
  await env.app.onInstalled({reason: 'install'});
  await env.app.onStartup();
  const a = activity(env.f);
  assert.deepEqual(a.crit, [], 'critical: no handler, alarm, install or startup hook');
  assert.deepEqual(a.ix, []);
  assert.deepEqual(effectiveCalls(env.f, 'crit'), [['effective', false, null, false]]);
  assert.deepEqual(a.kb, [['installed', 'install'], ['startup']], 'default-on non-alert features do get lifecycle hooks');
  const record = env.storage.dump()[EFFECTIVE_KEY];
  assert.equal(record.features['critical-alert'].enabled, false);
  assert.match(record.features['critical-alert'].reason, /pending-migration/);
  assert.equal(record.features['kb-dark'].enabled, true);
  assert.equal(env.storage.dump()['crit.migrationV1'], undefined, 'install never marks migration complete');
});

test('corrupt settings before onInstalled: everything held off, nothing activated', async () => {
  const env = boot(createFakeStorage({features: 'garbage', 'crit.migrationV1': 'ready', 'ix.migrationV1': {state: 'ready'}}));
  for (const feature of ['critical-alert', 'interaction-alert', 'informatica-button', 'kb-dark', 'timecard']) {
    assert.equal((await deliver(env.chrome, {feature, type: 'ping'}, contentSender())).response.error, 'feature-disabled', feature);
  }
  await env.app.onInstalled({reason: 'update'});
  for (const list of Object.values(activity(env.f))) assert.deepEqual(list, []);
  const status = await env.app.status();
  assert.match(status.warnings.join('\n'), /malformed/);
  assert.match(status.features['critical-alert'].migration.reason, /unrecognized/);
});

test('storage read failure on a fresh worker defers activation and exposes an error; recovery retries', async () => {
  const storage = createFakeStorage({'crit.migrationV1': READY, features: {'kb-dark': true}});
  storage.ctl.failGet = 'storage unavailable';
  const env = boot(storage);
  const r = await deliver(env.chrome, {feature: 'kb-dark', type: 'ping'}, contentSender());
  assert.equal(r.response.error, 'settings-unavailable');
  const eff = await deliver(env.chrome, {feature: 'milo', type: 'get-effective'}, contentSender());
  assert.deepEqual([eff.response.ok, eff.response.error], [false, 'settings-unavailable']);
  await env.app.onInstalled({reason: 'install'});
  for (const list of Object.values(activity(env.f))) assert.deepEqual(list, []);
  assert.equal(storage.ctl.sets.length, 0, 'never writes defaults after a failed read');
  assert.match((await env.app.status()).error.message, /storage unavailable/);
  storage.ctl.failGet = null;
  assert.deepEqual((await deliver(env.chrome, {feature: 'kb-dark', type: 'ping', n: 3}, contentSender())).response.pong, 3);
  assert.equal((await env.app.status()).error, null);
});

test('storage read failure on a warm worker retains the last known state (no reset to all-on)', async () => {
  const storage = createFakeStorage({features: {'kb-dark': false}});
  const env = boot(storage);
  await env.app.ensureReady();
  storage.ctl.failGet = true;
  storage.put('features', {});
  storage.onChanged.dispatch({features: {oldValue: {'kb-dark': false}, newValue: {}}}, 'local');
  await env.app.idle();
  assert.equal((await deliver(env.chrome, {feature: 'kb-dark', type: 'ping'}, contentSender())).response.error, 'feature-disabled');
  assert.equal(env.app.isEnabled('kb-dark'), false);
  assert.equal(env.app.isEnabled('timecard'), true);
  assert.ok((await env.app.status()).error, 'error exposed');
  storage.ctl.failGet = null;
  storage.onChanged.dispatch({features: {newValue: {}}}, 'local');
  await env.app.idle();
  assert.equal(env.app.isEnabled('kb-dark'), true, 'recovers once storage reads again');
});

test('rapid toggles reconcile in order; the record rev is monotonic and the final state wins', async () => {
  const storage = createFakeStorage();
  storage.ctl.getDelay = () => Math.floor(Math.random() * 3);
  const env = boot(storage);
  const ops = [];
  for (let i = 0; i < 12; i++) ops.push(deliver(env.chrome, {feature: 'milo', type: 'set-preference', name: 'kb-dark', enabled: i % 2 === 1}, optionsSender()));
  await Promise.all(ops);
  await sleep(10);
  await env.app.idle();
  assert.equal(env.app.isEnabled('kb-dark'), true);
  const records = storage.ctl.sets.filter(s => s[EFFECTIVE_KEY]).map(s => s[EFFECTIVE_KEY]);
  const revs = records.map(r => r.rev);
  assert.deepEqual(revs, [...revs].sort((a, b) => a - b));
  assert.equal(new Set(revs).size, revs.length);
  assert.equal(records.at(-1).features['kb-dark'].enabled, true);
  const changes = effectiveCalls(env.f, 'kb');
  assert.deepEqual(changes.at(-1).slice(0, 2), ['effective', true]);
  for (let i = 1; i < changes.length; i++) assert.notEqual(changes[i][1], changes[i - 1][1], 'every hook call is a real transition');
});

test('a slow stale reconciliation cannot re-enable a feature disabled meanwhile', async () => {
  const storage = createFakeStorage();
  const env = boot(storage);
  await env.app.ensureReady();
  assert.equal(env.app.isEnabled('timecard'), true);
  // first read (started before the disable) is slow and still sees "on"; the disable lands while it is pending
  const realGet = storage.local.get;
  let slowOnce = true;
  storage.local.get = async keys => {
    if (slowOnce) { slowOnce = false; const snap = await realGet(keys); await sleep(40); return snap; }
    return realGet(keys);
  };
  storage.onChanged.dispatch({features: {newValue: {}}}, 'local');
  await sleep(5);
  await storage.local.set({features: {timecard: false}});
  await sleep(80);
  await env.app.idle();
  assert.equal(env.app.isEnabled('timecard'), false);
  assert.equal(storage.dump()[EFFECTIVE_KEY].features.timecard.enabled, false);
  assert.deepEqual(effectiveCalls(env.f, 'tc').at(-1).slice(0, 2), ['effective', false]);
});

test('explicit completion via import/fallback activates an alert; a checkbox flip never does', async () => {
  const env = boot();
  await deliver(env.chrome, {feature: 'milo', type: 'set-preference', name: 'critical-alert', enabled: true}, optionsSender());
  assert.equal(env.app.isEnabled('critical-alert'), false);
  const bad = await deliver(env.chrome, {feature: 'milo', type: 'import-dedupe', target: 'critical-alert', snapshots: [{schema: 1, feature: 'critical-alert', key: 'seenMatchesV4', entries: ['x']}]}, optionsSender());
  assert.equal(bad.response.ok, false);
  assert.equal(env.app.isEnabled('critical-alert'), false);
  const ok = await deliver(env.chrome, {feature: 'milo', type: 'import-dedupe', target: 'critical-alert', snapshots: [{schema: 1, feature: 'critical-alert', key: 'seenMatchesV4', entries: [`${'a'.repeat(32)}|1 - Critical|New|X`]}]}, optionsSender());
  assert.equal(ok.response.ok, true);
  assert.equal(env.app.isEnabled('critical-alert'), true);
  assert.equal(ok.response.status.features['critical-alert'].migration.method, 'import');
  const fb = await deliver(env.chrome, {feature: 'milo', type: 'choose-fallback', target: 'interaction-alert', choice: 'seed-silently'}, optionsSender());
  assert.equal(fb.response.ok, true);
  assert.equal(env.app.isEnabled('interaction-alert'), false);
  assert.equal(env.app.effective('interaction-alert').seedOnly, true);
  assert.deepEqual(effectiveCalls(env.f, 'crit').at(-1), ['effective', true, false, false]);
});

test('worker restart: a fresh instance re-reconciles from storage, keeps epoch, continues rev, no reseeding', async () => {
  const storage = createFakeStorage({features: {'kb-dark': false}});
  const first = boot(storage);
  await deliver(first.chrome, {feature: 'milo', type: 'choose-fallback', target: 'critical-alert', choice: 'notify-current'}, optionsSender());
  await first.app.idle();
  const rec1 = storage.dump()[EFFECTIVE_KEY];
  const writes = storage.ctl.sets.length;
  const second = boot(storage);
  assert.deepEqual((await deliver(second.chrome, {feature: 'critical-alert', type: 'ping', n: 9}, contentSender())).response.pong, 9);
  assert.equal(second.app.isEnabled('kb-dark'), false);
  const rec2 = storage.dump()[EFFECTIVE_KEY];
  assert.equal(rec2.epoch, rec1.epoch);
  assert.equal(rec2.rev, rec1.rev, 'unchanged effective state is not rewritten');
  assert.equal(storage.ctl.sets.length, writes, 'restart writes nothing (no reseed, no default write)');
  assert.deepEqual(effectiveCalls(second.f, 'crit'), [['effective', true, null, false]], 'entry hook once per worker');
  await deliver(second.chrome, {feature: 'milo', type: 'set-preference', name: 'kb-dark', enabled: true}, optionsSender());
  assert.equal(storage.dump()[EFFECTIVE_KEY].rev, rec1.rev + 1);
});

test('one serialized readiness path: concurrent entry events share one initial read', async () => {
  const storage = createFakeStorage();
  storage.ctl.getDelay = 15;
  const env = boot(storage, {install: false});
  await Promise.all([
    env.app.onInstalled({reason: 'install'}), env.app.onStartup(), env.app.onAlarm({name: 'snTkHealthCheck'}),
    deliver(env.chrome, {feature: 'milo', type: 'get-effective'}, contentSender()).catch(() => {}),
    env.app.ensureReady()
  ]);
  assert.equal(storage.ctl.gets.length, 1);
  assert.equal(effectiveCalls(env.f, 'kb').length, 1);
});

test('hook failures in one feature do not break others or the readiness gate', async () => {
  const {chrome} = createFakeChrome();
  const f = inertFeatures();
  f.kb.module.onEffectiveChange = () => { throw new Error('kb hook broke'); };
  f.kb.module.onInstalled = async () => { throw new Error('kb install broke'); };
  const app = createMiloBackground({chrome, origins: ORIGINS, features: f.modules, log: {warn() {}, error() {}}});
  app.install();
  await app.onInstalled({reason: 'install'});
  assert.deepEqual(f.tc.calls.map(c => c[0]), ['effective', 'installed']);
  assert.equal((await deliver(chrome, {feature: 'kb-dark', type: 'ping', n: 1}, contentSender())).response.pong, 1);
  assert.match((await app.status()).hookErrors.map(e => e.message).join('\n'), /kb hook broke[\s\S]*kb install broke/);
});

// ---- effective-record persistence failures (content must converge on the worker's true state) ----
// Content-side acceptance rule, identical to shared/controller.js: same epoch → strictly higher rev only.
function contentModel() {
  let current = null;
  const handedOut = new Map(); // `${epoch}:${rev}` → JSON(features), every record content could ever see
  const conflicts = [];
  return {
    offer(r) {
      if (!r) return;
      const key = `${r.epoch}:${r.rev}`;
      const body = JSON.stringify(r.features);
      if (handedOut.has(key) && handedOut.get(key) !== body) conflicts.push(key);
      handedOut.set(key, body);
      if (current && r.epoch === current.epoch && r.rev <= current.rev) return;
      current = r;
    },
    get current() { return current; },
    conflicts
  };
}
function watchContent(env) {
  const model = contentModel();
  env.storage.onChanged.addListener(changes => { if (changes[EFFECTIVE_KEY]) model.offer(changes[EFFECTIVE_KEY].newValue); });
  const ask = async () => {
    const r = (await deliver(env.chrome, {feature: 'milo', type: 'get-effective'}, contentSender())).response;
    if (r.ok) model.offer(r.effective);
    return r;
  };
  return {model, ask};
}
const failEffectiveWrites = items => (EFFECTIVE_KEY in items ? 'quota exceeded writing effective state' : null);

for (const [label, initial, during, after] of [
  ['writes fail → disable → writes succeed → re-enable', true, false, true],
  ['writes fail → enable → writes succeed → disable', false, true, false]
]) {
  test(`effective persistence failure: ${label}: content converges, no rev reused`, async () => {
    const storage = createFakeStorage({features: {'kb-dark': initial}});
    const env = boot(storage);
    const content = watchContent(env);
    await content.ask();
    await sleep(5);
    const persisted = storage.dump()[EFFECTIVE_KEY];
    assert.equal(content.model.current.features['kb-dark'].enabled, initial);

    storage.ctl.failSet = failEffectiveWrites;
    await deliver(env.chrome, {feature: 'milo', type: 'set-preference', name: 'kb-dark', enabled: during}, optionsSender());
    assert.equal(env.app.isEnabled('kb-dark'), during, 'the worker enforces the true state internally');
    assert.match((await env.app.status()).error.message, /could not persist effective state/);
    const r = await content.ask();
    assert.equal(r.ok, true);
    assert.deepEqual([r.effective.epoch, r.effective.rev], [persisted.epoch, persisted.rev], 'only the last PERSISTED record is handed out');
    assert.equal(r.effective.features['kb-dark'].enabled, initial);

    storage.ctl.failSet = null;
    await deliver(env.chrome, {feature: 'milo', type: 'set-preference', name: 'kb-dark', enabled: after}, optionsSender());
    await env.app.idle();
    await content.ask();
    await sleep(5);
    assert.equal(env.app.isEnabled('kb-dark'), after);
    assert.equal(content.model.current.features['kb-dark'].enabled, after, 'content converges on the true state');
    assert.ok(content.model.current.rev > persisted.rev, 'a newer rev supersedes everything content saw');
    assert.deepEqual(storage.dump()[EFFECTIVE_KEY], content.model.current);
    assert.deepEqual(content.model.conflicts, [], 'no epoch:rev was ever reused for different content');
    assert.equal((await env.app.status()).error, null);
  });
}

test('effective persistence failure on a fresh profile: content gets nothing (inactive) until a write succeeds', async () => {
  const storage = createFakeStorage();
  storage.ctl.failSet = failEffectiveWrites;
  const env = boot(storage);
  const content = watchContent(env);
  assert.deepEqual(await content.ask(), {ok: false, error: 'settings-unavailable'});
  assert.equal(env.app.isEnabled('kb-dark'), true, 'worker state known');
  assert.equal(content.model.current, null);
  storage.ctl.failSet = null;
  await content.ask(); // entry point retries the pending write
  await env.app.idle();
  await content.ask();
  assert.equal(content.model.current.features['kb-dark'].enabled, true);
  assert.equal(storage.dump()[EFFECTIVE_KEY].rev, content.model.current.rev);
});

test('a write that keeps failing leaves rev monotonic across retries and worker restarts', async () => {
  const storage = createFakeStorage({features: {timecard: true}});
  const first = boot(storage);
  await first.app.ensureReady();
  const base = storage.dump()[EFFECTIVE_KEY];
  storage.ctl.failSet = failEffectiveWrites;
  for (const enabled of [false, true, false]) {
    await deliver(first.chrome, {feature: 'milo', type: 'set-preference', name: 'timecard', enabled}, optionsSender());
  }
  storage.ctl.failSet = null;
  const second = boot(storage); // worker restarted before any write succeeded
  const content = watchContent(second);
  await content.ask();
  await second.app.idle();
  await content.ask();
  const rec = storage.dump()[EFFECTIVE_KEY];
  assert.equal(rec.epoch, base.epoch);
  assert.ok(rec.rev > base.rev);
  assert.equal(rec.features.timecard.enabled, false);
  assert.equal(content.model.current.features.timecard.enabled, false);
});

// ---- hook bounds ----
test('a never-settling onEffectiveChange / onInstalled hook times out, is recorded, and does not freeze the queue', {timeout: 5000}, async () => {
  const {chrome} = createFakeChrome();
  const f = inertFeatures();
  f.kb.module.onEffectiveChange = () => new Promise(() => {});
  f.tc.module.onInstalled = () => new Promise(() => {});
  const app = createMiloBackground({chrome, origins: ORIGINS, features: f.modules, log: {warn() {}, error() {}}, hookTimeoutMs: 30});
  app.install();
  const t0 = Date.now();
  await app.onInstalled({reason: 'install'});
  assert.ok(Date.now() - t0 < 1000);
  assert.equal((await deliver(chrome, {feature: 'kb-dark', type: 'ping', n: 1}, contentSender())).response.pong, 1);
  await deliver(chrome, {feature: 'milo', type: 'set-preference', name: 'informatica-button', enabled: false}, optionsSender());
  await app.idle();
  assert.equal(app.isEnabled('informatica-button'), false, 'later reconciliations still run');
  const errors = (await app.status()).hookErrors;
  assert.ok(errors.some(e => e.feature === 'kb-dark' && e.hook === 'onEffectiveChange' && /timed out after 30ms/.test(e.message)), JSON.stringify(errors));
  assert.ok(errors.some(e => e.feature === 'timecard' && e.hook === 'onInstalled' && /timed out/.test(e.message)));
});

test('feature ctx.store exposes only serialize + completeSeed', async () => {
  const {chrome} = createFakeChrome();
  const f = inertFeatures();
  let seen;
  f.kb.module.onEffectiveChange = (next, prev, ctx) => { seen = ctx; };
  const app = createMiloBackground({chrome, origins: ORIGINS, features: f.modules});
  await app.ensureReady();
  assert.deepEqual(Object.keys(seen.store).sort(), ['completeSeed', 'serialize']);
  assert.equal(Object.isFrozen(seen.store), true);
});

test('worker restricts storage to trusted contexts before reading settings; failure fails closed and retries', async () => {
  const storage = createFakeStorage({'crit.migrationV1': READY});
  storage.ctl.failAccessLevel = 'not supported';
  const env = boot(storage);
  assert.deepEqual(storage.ctl.accessLevelCalls, [{accessLevel: 'TRUSTED_CONTEXTS'}], 'kicked off synchronously by install()');
  const r = await deliver(env.chrome, {feature: 'kb-dark', type: 'ping', n: 1}, contentSender());
  assert.equal(r.response.error, 'settings-unavailable');
  assert.equal(storage.ctl.gets.length, 0, 'settings are never read before storage is restricted');
  assert.match(env.app.status().error.message, /could not restrict storage to trusted contexts: not supported/);
  storage.ctl.failAccessLevel = null;
  assert.equal((await deliver(env.chrome, {feature: 'kb-dark', type: 'ping', n: 2}, contentSender())).response.pong, 2);
  assert.equal(storage.ctl.accessLevel, 'TRUSTED_CONTEXTS');
  const calls = storage.ctl.accessLevelCalls.length;
  await deliver(env.chrome, {feature: 'kb-dark', type: 'ping', n: 3}, contentSender());
  await env.app.onAlarm({name: 'snTkHealthCheck'});
  assert.equal(storage.ctl.accessLevelCalls.length, calls, 'not repeated once it succeeded');
});

// ---- hook transition generation / abort (I2) ----
test('a timed-out disable hook that resumes after a later enable run observes !ctx.isCurrent() and an aborted signal', {timeout: 5000}, async () => {
  const {chrome} = createFakeChrome();
  const f = inertFeatures();
  let release;
  const gate = new Promise(r => { release = r; });
  const seen = [];
  let lateDone;
  const late = new Promise(r => { lateDone = r; });
  f.kb.module.onEffectiveChange = async (next, prev, ctx) => {
    seen.push([next.enabled ? 'enable' : 'disable', 'start', ctx.isCurrent(), ctx.signal.aborted]);
    if (next.enabled) return;
    await gate; // e.g. a slow chrome.alarms.clear
    seen.push(['disable', 'resumed', ctx.isCurrent(), ctx.signal.aborted, String(ctx.signal.reason?.message || ctx.signal.reason)]);
    lateDone();
  };
  const app = createMiloBackground({chrome, origins: ORIGINS, features: f.modules, log: {warn() {}, error() {}}, hookTimeoutMs: 30});
  app.install();
  await app.ensureReady();
  await deliver(chrome, {feature: 'milo', type: 'set-preference', name: 'kb-dark', enabled: false}, optionsSender());
  await app.idle(); // disable hook timed out (gate still closed)
  await deliver(chrome, {feature: 'milo', type: 'set-preference', name: 'kb-dark', enabled: true}, optionsSender());
  await app.idle();
  release();
  await late;
  assert.deepEqual(seen.slice(0, 3), [['enable', 'start', true, false], ['disable', 'start', true, false], ['enable', 'start', true, false]]);
  assert.equal(seen[3][0], 'disable');
  assert.equal(seen[3][2], false, 'late disable is no longer current');
  assert.equal(seen[3][3], true, 'its signal was aborted');
  assert.equal(app.isEnabled('kb-dark'), true);
});

test('hook signal: aborted on timeout even without a later transition; other features are unaffected', {timeout: 5000}, async () => {
  const {chrome} = createFakeChrome();
  const f = inertFeatures();
  let kbCtx, tcCtx;
  f.kb.module.onEffectiveChange = (next, prev, ctx) => { kbCtx = ctx; return new Promise(() => {}); };
  f.tc.module.onEffectiveChange = (next, prev, ctx) => { tcCtx ||= ctx; };
  const app = createMiloBackground({chrome, origins: ORIGINS, features: f.modules, log: {warn() {}, error() {}}, hookTimeoutMs: 30});
  app.install();
  await app.ensureReady();
  assert.equal(kbCtx.signal.aborted, true);
  assert.equal(kbCtx.isCurrent(), false);
  assert.match(String(kbCtx.signal.reason?.message), /timed out after 30ms/);
  assert.equal(tcCtx.isCurrent(), true, 'a completed hook of another feature stays current until its next transition');
  await deliver(chrome, {feature: 'milo', type: 'set-preference', name: 'timecard', enabled: false}, optionsSender());
  await app.idle();
  assert.equal(tcCtx.isCurrent(), false, 'superseded by the next transition of that feature');
  assert.equal(tcCtx.signal.aborted, true);
});

test('message/alarm hook ctx becomes non-current when the feature transitions', {timeout: 5000}, async () => {
  const {chrome} = createFakeChrome({storage: createFakeStorage({'crit.migrationV1': READY})});
  const f = inertFeatures();
  let alarmCtx;
  f.crit.module.onAlarm = (alarm, ctx) => { alarmCtx = ctx; };
  const app = createMiloBackground({chrome, origins: ORIGINS, features: f.modules, log: {warn() {}, error() {}}});
  app.install();
  await app.onAlarm({name: 'snTkHealthCheck'});
  assert.equal(alarmCtx.isCurrent(), true);
  await deliver(chrome, {feature: 'milo', type: 'set-preference', name: 'critical-alert', enabled: false}, optionsSender());
  await app.idle();
  assert.equal(alarmCtx.isCurrent(), false);
  assert.equal(alarmCtx.signal.aborted, true);
});
