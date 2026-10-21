// Critical alert through the REAL router + worker module + content scripts (tests/helpers/alert-sim.mjs).
// Covers the Milo-specific behaviour the migrated original suite (features/critical-alert/test.cjs) cannot see:
// migration gating, enable/disable/re-enable, disable during queued and in-flight work, multi-tab single poller,
// wrong-host rejection, watchdog/reinjection, startup failures, worker restart and the seed-silently path.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAlertWorld, settle, READY, PROD, TEST, critRow, id32, sleep} from './helpers/alert-sim.mjs';
import {createFakeStorage} from './helpers/fake-chrome.mjs';

const F = 'critical-alert';
const ready = (extra = {}) => ({'crit.migrationV1': READY, ...extra});
const CASE = 'sn_customerservice_case';
const rowNotifs = w => w.notifications.filter(n => n.id.startsWith('snTk-'));

/** One full poll cycle in frame f: fire the first-poll (5 s) or a given timer, let claim → bridge → rows settle. */
async function pollCycle(f, ms = 5000) { const n = await f.fire(ms); await settle(12); return n; }

test('pending-migration: zero polling, alarms, notifications, injection — even with open tabs and alarms firing', async () => {
  const w = createAlertWorld(); // no crit.migrationV1
  const f = w.frame(PROD, {api: {rows: {[CASE]: [critRow('a')]}}});
  w.loadStatic(f);
  await w.app.ensureReady();
  await settle();
  assert.deepEqual(f.pendingTimers(), [], 'no poll timer scheduled');
  assert.equal(f.eval('main', 'window.__snTkBridge.active'), false, 'bridge inert');
  await w.app.onAlarm({name: 'snTkHealthCheck'});
  await w.app.onInstalled({reason: 'install'});
  await w.app.onStartup();
  await settle();
  assert.equal(w.polls(f).length, 0);
  assert.equal(f.api.fetches.length, 0);
  assert.deepEqual(w.notifications, []);
  assert.deepEqual(await w.chrome.alarms.getAll(), []);
  assert.deepEqual(w.injections, []);
  assert.equal(w.calls.filter(c => c[0] === 'scripting.probe').length, 0);
  // a forged content message is refused by the router
  assert.deepEqual(await w.send(f, F, {type: 'claim-poll'}), {ok: false, error: 'feature-disabled'});
  assert.deepEqual(await w.send(f, F, {type: 'rows', rows: [critRow('a')], complete: true}), {ok: false, error: 'feature-disabled'});
  assert.deepEqual(w.notifications, []);
});

test('enabled: poll → bridge GET → one notification per new matching row; health alarm owned; dedupe persists', async () => {
  const w = createAlertWorld({stored: ready()});
  const f = w.frame(PROD, {api: {rows: {[CASE]: [critRow('a'), critRow('b', {account: 'Other Oy', state: 'On Hold'})]}}});
  w.loadStatic(f);
  await settle();
  assert.deepEqual(f.pendingTimers(), [5000]);
  await pollCycle(f);
  assert.equal(w.polls(f).length, 1);
  assert.equal(f.api.fetches.length, 2, 'case + task tables');
  assert.ok(f.api.fetches.every(x => x.headers['X-UserToken'] === 'tok'));
  assert.deepEqual(rowNotifs(w).map(n => n.id), [`snTk-${id32('a')}`]);
  assert.equal(rowNotifs(w)[0].options.iconUrl, `chrome-extension://${w.chrome.runtime.id}/features/critical-alert/icons/alert.png`);
  const s = w.storage.dump();
  assert.deepEqual(s.seenMatchesV4, [`${id32('a')}|1 - Critical|New|Acme Oy`]);
  assert.ok(s['crit.lastSuccessfulPollAt'] > 0);
  assert.equal(s.lastSuccessfulPollAt, undefined, 'no un-namespaced key');
  assert.ok(s['crit.lastPollAt'] > 0, 'worker-owned heartbeat claimed');
  assert.deepEqual((await w.chrome.alarms.getAll()).map(a => [a.name, a.periodInMinutes]), [['snTkHealthCheck', 1]]);
  // interval poll (heartbeat window 105 s): denied until released; released → polls again, no duplicate notification
  f.advance(120000); await settle(12);
  assert.equal(w.polls(f).length, 1, 'heartbeat still fresh: tick skipped');
  w.storage.put('crit.lastPollAt', 0);
  f.advance(120000); await settle(12);
  assert.equal(w.polls(f).length, 2);
  assert.equal(rowNotifs(w).length, 1, 'seen row not re-notified');
  // click on an owned row notification opens task.do; on the health id nothing opens
  await w.app.onNotificationClicked(`snTk-${id32('a')}`);
  await w.app.onNotificationClicked('snCritHealth');
  assert.deepEqual(w.calls.filter(c => c[0] === 'tabs.create'), [['tabs.create', `${PROD}/task.do?sys_id=${id32('a')}`]]);
});

test('two tabs: one poller per cycle (worker heartbeat election), no duplicate notification across tabs', async () => {
  const w = createAlertWorld({stored: ready()});
  const api = {rows: {[CASE]: [critRow('c')]}};
  const a = w.frame(PROD, {api});
  const b = w.frame(PROD, {api, path: '/now/cwf/agent/list'});
  w.loadStatic(a); w.loadStatic(b);
  await settle();
  await Promise.all([a.fire(5000), b.fire(5000)]); // simultaneous first polls
  await settle(12);
  assert.equal(w.polls(a).length + w.polls(b).length, 1, 'concurrent claims: exactly one granted');
  assert.equal(rowNotifs(w).length, 1);
  // force both to poll (heartbeat released between) → rows from both tabs, still one notification
  w.storage.put('crit.lastPollAt', 0);
  a.advance(120000); await settle(12);
  w.storage.put('crit.lastPollAt', 0);
  b.advance(120000); await settle(12);
  assert.equal(w.polls(a).length + w.polls(b).length, 3);
  assert.equal(rowNotifs(w).length, 1, 'dedupe + queue across tabs');
});

test('wrong host: the test origin gets no alert behaviour; router refuses alert messages from it', async () => {
  const w = createAlertWorld({stored: ready()});
  const t = w.frame(TEST, {api: {rows: {[CASE]: [critRow('d')]}}});
  w.loadStatic(t); // even if the scripts were present there, the effective scope excludes the feature
  await settle();
  assert.deepEqual(t.pendingTimers(), []);
  assert.equal(t.eval('main', 'window.__snTkBridge.active'), false);
  for (const type of ['claim-poll', 'release-poll', 'rows', 'log']) {
    assert.deepEqual(await w.send(t, F, {type, rows: [critRow('d')], event: 'x'}), {ok: false, error: 'wrong-origin'}, type);
  }
  // production frame whose tab is on the test host (e.g. cross-origin iframe) is refused too
  const mixed = w.frame(PROD);
  mixed.sender.tab.url = `${TEST}/x`;
  assert.deepEqual(await w.send(mixed, F, {type: 'claim-poll'}), {ok: false, error: 'wrong-origin'});
  assert.deepEqual(w.notifications, []);
  // recovery injection never targets the test host
  const prodTab = w.frame(PROD);
  await w.modules[F].injectNow({...ctxLike(w), isCurrent: () => true}, 'test');
  assert.ok(w.injections.every(i => i.tabId === prodTab.tabId || w.frames.get(i.tabId).origin === PROD));
  assert.equal(w.injections.filter(i => i.tabId === t.tabId).length, 0);
});

/** A ctx equivalent for direct module calls in tests (router ctx surface). */
function ctxLike(w) {
  return {feature: F, chrome: w.chrome, origins: {production: PROD, test: TEST}, isEnabled: n => w.app.isEnabled(n),
    effective: n => w.app.effective(n), isCurrent: () => true, store: {serialize: w.app.store.serialize, completeSeed: w.app.store.completeSeed}};
}

test('disable while rows are queued / notifications in flight: nothing notifies after the disable', async () => {
  const w = createAlertWorld({stored: ready()});
  const f = w.frame(PROD);
  await w.app.ensureReady();
  let release;
  const gate = new Promise(r => { release = r; });
  const create = w.chrome.notifications.create;
  let first = true;
  w.chrome.notifications.create = async (id, o) => { const r = await create(id, o); if (first) { first = false; await gate; } return r; };
  const batch1 = w.send(f, F, {type: 'rows', rows: [critRow('1'), critRow('2'), critRow('3')]});
  const batch2 = w.send(f, F, {type: 'rows', rows: [critRow('4')]}); // queued behind batch1
  await settle();
  assert.equal(rowNotifs(w).length, 1, 'first notification in flight');
  await w.setPref(F, false);
  release();
  const [r1, r2] = await Promise.all([batch1, batch2]);
  await settle();
  assert.equal(rowNotifs(w).length, 1, 'no further notification after disable');
  assert.equal(r1.ok, false);
  assert.equal(r2.ok, false);
  assert.deepEqual(w.storage.dump().seenMatchesV4, [`${id32('1')}|1 - Critical|New|Acme Oy`], 'incremental save kept the delivered one');
  // re-enable: the undelivered rows notify, the delivered one does not (dedupe kept)
  await w.setPref(F, true);
  await w.send(f, F, {type: 'rows', rows: [critRow('1'), critRow('2'), critRow('3'), critRow('4')]});
  assert.deepEqual(rowNotifs(w).map(n => n.id.slice(-1)), ['1', '2', '3', '4']);
});

test('disable stops polling + health alarm, clears the owned health notification, resets grace; re-enable keeps dedupe', async () => {
  const w = createAlertWorld({stored: ready({'crit.healthStateV1': {startedAt: 1, alerted: true, failure: {at: 1, event: 'poll-failed', detail: 'x'}}})});
  const f = w.frame(PROD, {api: {rows: {[CASE]: [critRow('e')]}}});
  w.loadStatic(f);
  await settle();
  await pollCycle(f);
  assert.equal(rowNotifs(w).length, 1);
  await w.setPref(F, false);
  await settle();
  assert.deepEqual(await w.chrome.alarms.getAll(), []);
  assert.ok(w.cleared.includes('snCritHealth'));
  assert.deepEqual(w.storage.dump()['crit.healthStateV1'], {}, 'grace restarts at the next enabled check');
  assert.equal(w.storage.dump()['crit.lastPollAt'], 0, 'heartbeat released while off');
  assert.deepEqual(f.pendingTimers(), [], 'content timers cleared');
  assert.equal(f.eval('main', 'window.__snTkBridge.active'), false);
  f.advance(600000); await settle();
  assert.equal(w.polls(f).length, 1, 'no poll while disabled');
  await w.app.onAlarm({name: 'snTkHealthCheck'}); // stale alarm event: not dispatched to a disabled owner
  assert.equal(w.notifications.filter(n => n.id === 'snCritHealth').length, 0);
  // re-enable: fresh grace (startedAt = now), alarm back, dedupe intact → no re-alert
  const before = Date.now();
  await w.setPref(F, true);
  await settle();
  assert.ok(w.storage.dump()['crit.healthStateV1'].startedAt >= before);
  assert.equal(w.storage.dump()['crit.healthStateV1'].alerted, false);
  assert.deepEqual((await w.chrome.alarms.getAll()).map(a => a.name), ['snTkHealthCheck']);
  await pollCycle(f);
  assert.equal(w.polls(f).length, 2, 're-enabled poller polls again (same document, no reload)');
  assert.equal(rowNotifs(w).length, 1, 're-enable does not re-alert');
  assert.equal(f.count('isolated'), 2, 'controller + exactly one poller listener');
});

test('watchdog/reinjection: only enabled, only production tabs without a live poller; files feature-relative, in order', async () => {
  const w = createAlertWorld({stored: ready()});
  const live = w.frame(PROD);
  w.loadStatic(live);
  const bare = w.frame(PROD, {path: '/opened-before-install'}); // no static scripts (opened before install)
  const testTab = w.frame(TEST);
  await w.app.ensureReady();
  await w.modules[F].idle();
  await settle();
  const injected = w.injections.filter(i => i.tabId === bare.tabId).map(i => [i.world, i.file]);
  assert.deepEqual(injected, [['ISOLATED', 'shared/controller.js'], ['MAIN', 'shared/main-settings.js'],
    ['MAIN', 'features/critical-alert/page.js'], ['ISOLATED', 'features/critical-alert/content.js']]);
  assert.equal(w.injections.filter(i => i.tabId === live.tabId).length, 0, 'live poller: probe only, no reinjection');
  assert.equal(w.injections.filter(i => i.tabId === testTab.tabId).length, 0, 'never the test host');
  assert.equal(bare.eval('isolated', 'globalThis.__snTkController.active'), true, 'injected poller started');
  // extension reload: the old world dies; the new instance's worker re-attaches a fresh poller in the NEW world
  live.reloadExtension();
  await w.app.onInstalled({reason: 'update'});
  await w.modules[F].idle(); await settle();
  assert.equal(live.eval('isolated', 'globalThis.__snTkController.active'), true);
  live.advance(5000); await settle(); // old settings controller retires (liveness tick / any entry point) → old poller stopped
  assert.equal(live.staleIsolated[0].g.__snTkController.retired, true);
  assert.equal(live.staleIsolated[0].g.__snTkController.active, false);
  assert.deepEqual(live.staleIsolated[0].timers.size, 0, 'orphan left no timers');
  assert.equal(live.eval('main', 'window.__snTkBridge.active'), true, 'reinjected bridge took over the MAIN world');
  // disabled ⇒ no injection at all
  const w2 = createAlertWorld({stored: ready({features: {'critical-alert': false}})});
  w2.frame(PROD);
  await w2.app.ensureReady(); await w2.app.onInstalled({reason: 'update'}); await w2.modules[F].idle(); await settle();
  assert.deepEqual(w2.injections, []);
  assert.equal(w2.calls.filter(c => c[0] === 'scripting.probe').length, 0);
});

test('startup failures: tabs.query / executeScript failing never become unhandled rejections; alarm still ensured', async () => {
  const unhandled = [];
  const on = e => unhandled.push(e);
  process.on('unhandledRejection', on);
  try {
    const w = createAlertWorld({stored: ready()});
    w.chrome.tabs.query = async () => { throw new Error('tabs down'); };
    await w.app.ensureReady();
    await w.modules[F].idle(); await settle();
    assert.deepEqual((await w.chrome.alarms.getAll()).map(a => a.name), ['snTkHealthCheck']);
    const w2 = createAlertWorld({stored: ready()});
    w2.frame(PROD);
    w2.chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page'); };
    await w2.app.ensureReady(); await w2.modules[F].idle(); await settle();
    await w2.modules[F].idle();
    assert.ok((w2.storage.dump().diagnosticLogsV1 || []).some(e => e.event === 'dashboard-attach-failed'));
    await sleep(10);
  } finally { process.off('unhandledRejection', on); }
  assert.deepEqual(unhandled, []);
});

test('worker restart: state survives, health grace NOT reset by a wake, alarm not recreated, dedupe kept', async () => {
  const storage = createFakeStorage(ready());
  const w = createAlertWorld({storage});
  const f = w.frame(PROD, {api: {rows: {[CASE]: [critRow('9')]}}});
  w.loadStatic(f);
  await settle();
  await pollCycle(f);
  assert.equal(rowNotifs(w).length, 1);
  w.storage.put('crit.healthStateV1', {startedAt: 12345, alerted: false});
  const alarmCreates = () => w.calls.filter(c => c[0] === 'alarms.create').length;
  const w2 = createAlertWorld({storage}); // same profile storage, new worker (wake)
  await w2.app.ensureReady(); await w2.modules[F].idle(); await settle();
  assert.equal(storage.dump()['crit.healthStateV1'].startedAt, 12345, 'a wake is not a re-enable');
  assert.equal(w2.calls.filter(c => c[0] === 'alarms.create').length, 1, 'new fake chrome: ensured once');
  assert.ok(alarmCreates() >= 1);
  const again = await w2.send(f, F, {type: 'rows', rows: [critRow('9')]});
  assert.equal(again.ok, true);
  assert.equal(w2.notifications.length, 0, 'dedupe survives the restart');
});

test('seed-silently: controlled seed poll holds notifications, commits seen-set + ready together; never reseeds', async () => {
  const w = createAlertWorld();
  const api = {rows: {[CASE]: [critRow('5'), critRow('6', {state: 'Open'})]}};
  const f = w.frame(PROD, {api});
  w.loadStatic(f);
  await settle();
  assert.equal((await w.app.chooseFallback(F, 'seed-silently')).ok, true);
  await settle();
  assert.equal(w.app.effective(F).seedOnly, true);
  assert.deepEqual(await w.chrome.alarms.getAll(), [], 'no health alarm while seeding');
  assert.equal(f.eval('isolated', 'globalThis.__snTkController.mode'), 'seed');
  await pollCycle(f);
  await settle(12);
  assert.deepEqual(w.notifications, [], 'seed poll notifies nothing');
  const s = w.storage.dump();
  assert.equal(s['crit.migrationV1'].state, 'ready');
  assert.equal(s['crit.migrationV1'].method, 'seed-silently');
  assert.deepEqual(s.seenMatchesV4, [`${id32('5')}|1 - Critical|New|Acme Oy`], 'only matching rows seeded');
  assert.equal(w.app.isEnabled(F), true);
  await settle();
  assert.equal(f.eval('isolated', 'globalThis.__snTkController.mode'), 'enabled');
  // next poll: seeded row stays silent, a new row notifies
  api.rows[CASE].push(critRow('7'));
  w.storage.put('crit.lastPollAt', 0);
  await pollCycle(f);
  assert.deepEqual(rowNotifs(w).map(n => n.id), [`snTk-${id32('7')}`]);
  // never reseed: disable + re-enable, update/startup → normal handling (a new row notifies)
  await w.setPref(F, false); await w.setPref(F, true);
  await w.app.onInstalled({reason: 'update'});
  assert.equal(w.storage.dump()['crit.migrationV1'].state, 'ready');
  const r = await w.send(f, F, {type: 'rows', rows: [critRow('8')], complete: true});
  assert.equal(r.ok, true);
  assert.equal(rowNotifs(w).length, 2, 'ready ⇒ normal notification, not a seed');
});

test('seed-silently: failed, partial and concurrent first polls; empty successful poll seeds an empty set', async () => {
  const w = createAlertWorld();
  await w.app.ensureReady();
  await w.app.chooseFallback(F, 'seed-silently');
  const f = w.frame(PROD, {api: {rows: {[CASE]: [critRow('a')]}, fail: {sn_customerservice_task: 500}}});
  const g = w.frame(PROD, {api: {rows: {[CASE]: [critRow('a')]}}, path: '/second'});
  w.loadStatic(f); w.loadStatic(g);
  await settle();
  // failed poll (every table fails) → no seed
  f.api.fail[CASE] = 500;
  await pollCycle(f);
  assert.equal(w.storage.dump()['crit.migrationV1'].state, 'seeding', 'failed poll does not seed');
  assert.ok(f.pendingTimers().includes(10000), 'failure path schedules RETRY_MS');
  // partial poll (one table failed → warning) → no seed
  delete f.api.fail[CASE];
  w.storage.put('crit.lastPollAt', 0);
  await pollCycle(f, 10000);
  assert.equal(w.storage.dump()['crit.migrationV1'].state, 'seeding', 'partial result does not seed');
  assert.deepEqual(w.notifications, []);
  // concurrent first polls from two tabs (forged directly: both complete) → one seed, zero notifications
  const [r1, r2] = await Promise.all([
    w.send(f, F, {type: 'rows', rows: [critRow('a')], complete: true}),
    w.send(g, F, {type: 'rows', rows: [critRow('a'), critRow('b')], complete: true})
  ]);
  await settle();
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.deepEqual(w.notifications, [], 'no notification from either seed message');
  assert.equal(w.storage.dump()['crit.migrationV1'].state, 'ready');
  assert.deepEqual(w.storage.dump().seenMatchesV4.length >= 1, true);
  // empty but successful + complete poll seeds an empty set
  const e = createAlertWorld();
  await e.app.ensureReady();
  await e.app.chooseFallback(F, 'seed-silently');
  const h = e.frame(PROD, {api: {rows: {}}});
  e.loadStatic(h); await settle();
  await pollCycle(h);
  assert.equal(e.storage.dump()['crit.migrationV1'].state, 'ready');
  assert.deepEqual(e.storage.dump().seenMatchesV4, []);
  assert.deepEqual(e.notifications, []);
});

test('prerendered documents get inactive-document (not a poll failure) and health-failure logs need an active sender', async () => {
  const w = createAlertWorld({stored: ready()});
  const f = w.frame(PROD);
  await w.app.ensureReady();
  const r = await (await import('./helpers/fake-chrome.mjs')).deliver(w.chrome, {feature: F, type: 'claim-poll'}, {...f.sender, documentLifecycle: 'prerender'});
  assert.deepEqual(r.response, {ok: false, error: 'inactive-document'});
});
