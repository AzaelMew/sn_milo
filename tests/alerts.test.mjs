// Both alert features together through the REAL router (tests/helpers/alert-sim.mjs): simultaneous polls from the
// same documents, independent state/keys/alarms/notifications, per-feature migration gating and toggles, ownership
// of alarms and notification clicks, combined reinjection. Plus the interaction-specific integration paths
// (enabled flow, disable during in-flight work, seed-silently, watchdog) that tests/critical-alert.test.mjs covers
// for the critical alert.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAlertWorld, settle, READY, PROD, TEST, critRow, ixRow, id32} from './helpers/alert-sim.mjs';

const BOTH = ['critical-alert', 'interaction-alert'];
const CASE = 'sn_customerservice_case';
const IX = 'interaction';
const both = (extra = {}) => ({'crit.migrationV1': READY, 'ix.migrationV1': READY, ...extra});
const ids = (w, prefix) => w.notifications.filter(n => n.id.startsWith(prefix)).map(n => n.id);

test('both alerts on the same documents: simultaneous first polls, one notification per new row per feature', async () => {
  const w = createAlertWorld({stored: both(), features: BOTH});
  const api = {rows: {[CASE]: [critRow('a')], [IX]: [ixRow('a'), ixRow('b')]}};
  const f = w.frame(PROD, {api});
  const g = w.frame(PROD, {api, path: '/now/cwf/agent/list'});
  w.loadStatic(f); w.loadStatic(g);
  await settle();
  assert.deepEqual(f.pendingTimers().sort(), [5000, 5000], 'one first-poll timer per feature');
  await Promise.all([f.fire(5000), g.fire(5000)]);
  await settle(16);
  assert.equal(w.polls(f, 'sn-tk').length + w.polls(g, 'sn-tk').length, 1, 'critical: one poller across tabs');
  assert.equal(w.polls(f, 'sn-ix').length + w.polls(g, 'sn-ix').length, 1, 'interaction: one poller across tabs');
  assert.deepEqual(ids(w, 'snTk-'), [`snTk-${id32('a')}`]);
  assert.deepEqual(ids(w, 'snIx-').sort(), [`snIx-${id32('a')}`, `snIx-${id32('b')}`]);
  const s = w.storage.dump();
  assert.deepEqual(s.seenMatchesV4, [`${id32('a')}|1 - Critical|New|Acme Oy`]);
  assert.deepEqual(s.seenInteractionsV1.sort(), [id32('a'), id32('b')]);
  for (const k of ['crit.lastPollAt', 'ix.lastPollAt', 'crit.lastSuccessfulPollAt', 'ix.lastSuccessfulPollAt']) assert.ok(s[k] > 0, k);
  assert.ok(s.diagnosticLogsV1.length && s.diagnosticLogsIxV1.length, 'separate diagnostic logs');
  assert.equal(s.lastPollAt ?? s.lastSuccessfulPollAt ?? s.healthStateV1, undefined, 'no shared un-namespaced keys');
  assert.deepEqual((await w.chrome.alarms.getAll()).map(a => a.name).sort(), ['snIxHealthCheck', 'snTkHealthCheck']);
  // the interaction heartbeat window (45 s) is independent of the critical one (105 s)
  // both heartbeats 50 s old (worker clock): the 60 s interaction tick claims, the 120 s critical window still blocks
  w.storage.put('ix.lastPollAt', Date.now() - 50000);
  w.storage.put('crit.lastPollAt', Date.now() - 50000);
  f.advance(60000); await settle(16);
  assert.equal(w.polls(f, 'sn-ix').length + w.polls(g, 'sn-ix').length, 2, 'interaction polls again after 60 s');
  assert.equal(w.polls(f, 'sn-tk').length + w.polls(g, 'sn-tk').length, 1, 'critical still inside its window');
});

test('independent state: migration, toggles, alarms, health notifications and clicks are per feature', async () => {
  const w = createAlertWorld({stored: {'ix.migrationV1': READY}, features: BOTH}); // critical pending
  const f = w.frame(PROD, {api: {rows: {[CASE]: [critRow('c')], [IX]: [ixRow('c')]}}});
  w.loadStatic(f);
  await settle();
  await f.fire(5000); await settle(16);
  assert.equal(w.polls(f, 'sn-tk').length, 0, 'pending critical never polls');
  assert.deepEqual(ids(w, 'snIx-'), [`snIx-${id32('c')}`]);
  assert.deepEqual(ids(w, 'snTk-'), []);
  assert.deepEqual((await w.chrome.alarms.getAll()).map(a => a.name), ['snIxHealthCheck']);
  // a critical alarm / click is not dispatched while critical is pending; the interaction click works
  await w.app.onAlarm({name: 'snTkHealthCheck'});
  await w.app.onNotificationClicked(`snTk-${id32('c')}`);
  await w.app.onNotificationClicked(`snIx-${id32('c')}`);
  assert.deepEqual(w.calls.filter(c => c[0] === 'tabs.create').map(c => c[1]), [`${PROD}/now/cwf/agent/record/interaction/${id32('c')}`]);
  assert.ok(w.cleared.includes(`snTk-${id32('c')}`), 'stale click for a non-enabled owner only clears');
  // complete critical migration, then disable interaction only: critical keeps working, interaction stops
  await w.app.importDedupe('critical-alert', [{schema: 1, feature: 'critical-alert', key: 'seenMatchesV4', entries: [`${id32('c')}|1 - Critical|New|Acme Oy`]}]);
  await settle();
  const critClears = w.cleared.filter(x => x === 'snCritHealth').length;
  await w.setPref('interaction-alert', false);
  await settle();
  assert.deepEqual((await w.chrome.alarms.getAll()).map(a => a.name), ['snTkHealthCheck']);
  assert.ok(w.cleared.includes('snIxHealth'));
  assert.equal(w.cleared.filter(x => x === 'snCritHealth').length, critClears, 'disabling one alert never touches the other\'s health notification');
  assert.equal(f.eval('main', 'window.__snIxBridge.active'), false);
  assert.equal(f.eval('main', 'window.__snTkBridge.active'), true);
  f.api.rows[CASE].push(critRow('d'));
  f.api.rows[IX].push(ixRow('d'));
  await f.fire(5000); await settle(16);
  assert.deepEqual(ids(w, 'snTk-'), [`snTk-${id32('d')}`], 'imported row silent, new row notified');
  assert.deepEqual(ids(w, 'snIx-'), [`snIx-${id32('c')}`], 'disabled interaction: nothing new');
  // health checks are independent: stale interaction state does not alert while it is disabled
  w.storage.put('ix.lastSuccessfulPollAt', 1);
  w.storage.put('ix.healthStateV1', {startedAt: 1});
  await w.app.onAlarm({name: 'snIxHealthCheck'});
  await w.app.onAlarm({name: 'snTkHealthCheck'});
  assert.equal(w.notifications.filter(n => n.id.endsWith('Health')).length, 0);
});

test('interaction: disable while a batch is in flight → no notification after the disable; re-enable no re-alert', async () => {
  const w = createAlertWorld({stored: both(), features: BOTH});
  const f = w.frame(PROD);
  await w.app.ensureReady();
  let release;
  const gate = new Promise(r => { release = r; });
  const create = w.chrome.notifications.create;
  let first = true;
  w.chrome.notifications.create = async (id, o) => { const r = await create(id, o); if (first && id.startsWith('snIx-')) { first = false; await gate; } return r; };
  const ix = w.send(f, 'interaction-alert', {type: 'rows', rows: [ixRow('1'), ixRow('2')]});
  const crit = w.send(f, 'critical-alert', {type: 'rows', rows: [critRow('1')]});
  await settle();
  await w.setPref('interaction-alert', false);
  release();
  await Promise.all([ix, crit]);
  await settle();
  assert.deepEqual(ids(w, 'snIx-'), [`snIx-${id32('1')}`], 'only the in-flight one');
  assert.deepEqual(ids(w, 'snTk-'), [`snTk-${id32('1')}`], 'critical unaffected');
  await w.setPref('interaction-alert', true);
  await w.send(f, 'interaction-alert', {type: 'rows', rows: [ixRow('1'), ixRow('2')]});
  assert.deepEqual(ids(w, 'snIx-'), [`snIx-${id32('1')}`, `snIx-${id32('2')}`]);
});

test('interaction seed-silently: seed poll silent, then normal; critical stays pending meanwhile', async () => {
  const w = createAlertWorld({features: BOTH});
  const api = {rows: {[IX]: [ixRow('5'), ixRow('6')]}};
  const f = w.frame(PROD, {api});
  w.loadStatic(f);
  await settle();
  await w.app.chooseFallback('interaction-alert', 'seed-silently');
  await settle();
  assert.equal(f.eval('isolated', 'globalThis.__snIxController.mode'), 'seed');
  assert.equal(f.eval('isolated', 'globalThis.__snTkController.active'), false);
  await f.fire(5000); await settle(16);
  assert.deepEqual(w.notifications, []);
  const s = w.storage.dump();
  assert.equal(s['ix.migrationV1'].state, 'ready');
  assert.deepEqual(s.seenInteractionsV1.sort(), [id32('5'), id32('6')]);
  assert.equal(s['crit.migrationV1'], undefined);
  api.rows[IX].push(ixRow('7'));
  w.storage.put('ix.lastPollAt', 0);
  f.advance(60000); await settle(16);
  assert.deepEqual(ids(w, 'snIx-'), [`snIx-${id32('7')}`]);
  assert.equal(w.polls(f, 'sn-tk').length, 0);
});

test('combined watchdog: one probe per feature per tab, only missing features injected, never the test host', async () => {
  const w = createAlertWorld({stored: both(), features: BOTH});
  const crit = w.frame(PROD);
  crit.run('isolated', 'shared/controller.js'); crit.run('main', 'shared/main-settings.js');
  crit.run('main', 'features/critical-alert/page.js'); crit.run('isolated', 'features/critical-alert/content.js');
  const bare = w.frame(PROD, {path: '/bare'});
  const t = w.frame(TEST);
  await w.app.ensureReady();
  for (const m of Object.values(w.modules)) await m.idle();
  await settle();
  const files = tab => w.injections.filter(i => i.tabId === tab.tabId).map(i => i.file);
  assert.deepEqual(files(crit), ['shared/controller.js', 'shared/main-settings.js', 'features/interaction-alert/page.js', 'features/interaction-alert/content.js'],
    'tab with a live critical poller only gets the interaction scripts');
  assert.deepEqual(files(bare).filter(x => x.startsWith('features/')).sort(), ['features/critical-alert/content.js', 'features/critical-alert/page.js', 'features/interaction-alert/content.js', 'features/interaction-alert/page.js']);
  assert.deepEqual(files(t), []);
  assert.equal(crit.eval('isolated', '__snMiloController.subscriptions'), 2, 'one subscription per feature after the shared re-injection');
  assert.equal(crit.eval('isolated', 'globalThis.__snIxController.active && globalThis.__snTkController.active'), true);
  // second scan: everything live ⇒ probes only
  const before = w.injections.length;
  await w.app.onInstalled({reason: 'update'});
  for (const m of Object.values(w.modules)) await m.idle();
  await settle();
  assert.equal(w.injections.length, before);
});

test('registry: alarm names and notification prefixes are owned exactly once (router validation)', () => {
  const w = createAlertWorld({stored: both(), features: BOTH});
  const [c, i] = BOTH.map(n => w.modules[n]);
  assert.deepEqual(c.alarms, ['snTkHealthCheck']);
  assert.deepEqual(i.alarms, ['snIxHealthCheck']);
  assert.deepEqual(c.notificationPrefixes, ['snTk-', 'snCritHealth']);
  assert.deepEqual(i.notificationPrefixes, ['snIx-', 'snIxHealth']);
  assert.deepEqual(Object.keys(c.messages).sort(), ['claim-poll', 'get-rules', 'log', 'release-poll', 'rows']);
  assert.deepEqual(Object.keys(i.messages).sort(), ['claim-poll', 'get-accounts', 'log', 'release-poll', 'rows']);
});

// ---- Task 6 review fixes, both alerts ------------------------------------------------------------------------
const CFG = {
  'critical-alert': {F: 'critical-alert', tag: 'sn-tk', mig: 'crit.migrationV1', hb: 'crit.lastPollAt', alarm: 'snTkHealthCheck', pollMs: 120000,
    table: CASE, row: critRow, prefix: 'snTk-', ctl: '__snTkController', pollNow: 'snTkPollNow', health: 'crit.healthStateV1', rowMsg: 'a'},
  'interaction-alert': {F: 'interaction-alert', tag: 'sn-ix', mig: 'ix.migrationV1', hb: 'ix.lastPollAt', alarm: 'snIxHealthCheck', pollMs: 60000,
    table: IX, row: ixRow, prefix: 'snIx-', ctl: '__snIxController', pollNow: 'snIxPollNow', health: 'ix.healthStateV1', rowMsg: 'a'}
};
const worldFor = (c, extra = {}) => createAlertWorld({stored: {[c.mig]: READY}, features: [c.F], ...extra});
const withMsg = (log, event) => log.filter(l => l.event === event);

for (const c of Object.values(CFG)) {
  test(`${c.F}: partial seed result answers ok (reason partial-result), is remembered in status, never seeds`, async () => {
    const w = createAlertWorld({features: [c.F]});
    await w.app.ensureReady();
    await w.app.chooseFallback(c.F, 'seed-silently');
    const f = w.frame(PROD, {api: {rows: {[c.table]: [c.row('a')]}}});
    w.loadStatic(f); await settle();
    const r = await w.send(f, c.F, {type: 'rows', rows: [c.row('a')], complete: false});
    assert.deepEqual(r, {ok: true, seeded: 0, reason: 'partial-result'});
    assert.equal(w.storage.dump()[c.mig].state, 'seeding');
    assert.deepEqual(w.notifications, []);
    const st = await w.modules[c.F].status(w.chrome, {production: PROD});
    assert.equal(st.lastSeedAttempt.reason, 'partial-result');
    assert.equal(st.lastSeedAttempt.ok, false);
    const done = await w.send(f, c.F, {type: 'rows', rows: [c.row('a')], complete: true});
    assert.equal(done.ok, true);
    await settle();
    const st2 = await w.modules[c.F].status(w.chrome, {production: PROD});
    assert.equal(st2.lastSeedAttempt.ok, true, 'attempt record updated by the successful seed');
    assert.equal(st2.lastSeedAttempt.reason, undefined);
  });

  test(`${c.F}: stale failure text from seeding is cleared once the feature is ready`, async () => {
    const w = createAlertWorld({features: [c.F]});
    await w.app.ensureReady();
    await w.app.chooseFallback(c.F, 'seed-silently');
    const f = w.frame(PROD);
    w.loadStatic(f); await settle();
    await w.send(f, c.F, {type: 'log', event: 'poll-failed', detail: 'boom', level: 'warn'});
    await w.modules[c.F].idle();
    assert.equal(w.storage.dump()[c.health].failure.event, 'poll-failed');
    const r = await w.send(f, c.F, {type: 'rows', rows: [], complete: true});
    assert.equal(r.ok, true);
    await settle(16); await w.modules[c.F].idle();
    assert.equal(w.storage.dump()[c.mig].state, 'ready');
    assert.equal(w.storage.dump()[c.health].failure, undefined);
  });

  test(`${c.F}: health alarm is self-healing (recreated on claim-poll and onStartup after being lost)`, async () => {
    const w = worldFor(c);
    const f = w.frame(PROD);
    w.loadStatic(f); await settle();
    await w.app.ensureReady(); await settle();
    assert.deepEqual((await w.chrome.alarms.getAll()).map(a => a.name), [c.alarm]);
    await w.chrome.alarms.clear(c.alarm); // e.g. the enable hook timed out before alarms.create
    assert.deepEqual(await w.chrome.alarms.getAll(), []);
    assert.equal((await w.send(f, c.F, {type: 'claim-poll'})).granted, true);
    assert.deepEqual((await w.chrome.alarms.getAll()).map(a => [a.name, a.periodInMinutes]), [[c.alarm, 1]]);
    await w.chrome.alarms.clear(c.alarm);
    await w.app.onStartup(); await settle();
    assert.deepEqual((await w.chrome.alarms.getAll()).map(a => a.name), [c.alarm]);
    // disabled ⇒ a claim must not create it
    await w.setPref(c.F, false); await settle(12);
    assert.deepEqual(await w.chrome.alarms.getAll(), []);
    await w.send(f, c.F, {type: 'claim-poll'}); await w.app.onStartup(); await settle();
    assert.deepEqual(await w.chrome.alarms.getAll(), []);
  });

  test(`${c.F}: notifications.create rejecting mid-batch keeps the first row, answers ok:false, retry notifies only the rest`, async () => {
    const w = worldFor(c);
    const f = w.frame(PROD);
    w.loadStatic(f); await settle();
    const real = w.chrome.notifications.create;
    let n = 0;
    w.chrome.notifications.create = async (id, o) => { if (String(id).startsWith(c.prefix) && ++n === 2) throw new Error('notification backend down'); return real(id, o); };
    const rows = [c.row('a'), c.row('b'), c.row('c')];
    const r1 = await w.send(f, c.F, {type: 'rows', rows, complete: true});
    assert.equal(r1.ok, false);
    assert.deepEqual(w.notifications.filter(x => x.id.startsWith(c.prefix)).map(x => x.id), [`${c.prefix}${id32('a')}`]);
    const r2 = await w.send(f, c.F, {type: 'rows', rows, complete: true});
    assert.equal(r2.ok, true);
    assert.deepEqual(w.notifications.filter(x => x.id.startsWith(c.prefix)).map(x => x.id),
      [`${c.prefix}${id32('a')}`, `${c.prefix}${id32('b')}`, `${c.prefix}${id32('c')}`], 'a once, b and c on the retry');
  });

  test(`${c.F}: claim granted but session stopped before posting → heartbeat released`, async () => {
    const w = worldFor(c);
    const f = w.frame(PROD, {api: {rows: {[c.table]: [c.row('a')]}}});
    w.loadStatic(f); await settle();
    const [t] = [...f.worlds.isolated.timers.values()].filter(x => x.ms === 5000);
    t.fn(); // poll() → claim-poll in flight
    f.eval('isolated', `globalThis.${c.ctl}.stop('test')`);
    await settle(12);
    assert.equal(w.polls(f, c.tag).length, 0, 'nothing posted for a stopped session');
    assert.equal(w.storage.dump()[c.hb], 0, 'heartbeat released');
  });

  test(`${c.F}: prerendered document → quiet wait (no failure log, no release, no 10 s retry), polls on activation`, async () => {
    const w = worldFor(c);
    const f = w.frame(PROD, {api: {rows: {[c.table]: [c.row('a')]}}});
    f.sender.documentLifecycle = 'prerender';
    w.loadStatic(f); await settle();
    await f.fire(5000);
    await settle(12);
    assert.equal(w.polls(f, c.tag).length, 0);
    assert.ok(!f.pendingTimers().includes(10000), 'no RETRY_MS timer for an inactive document');
    const logs = w.storage.dump()[c.F === 'critical-alert' ? 'diagnosticLogsV1' : 'diagnosticLogsIxV1'] || [];
    assert.deepEqual(logs.filter(l => /poll-start-failed|background-failed/.test(l.event)), []);
    assert.equal(w.storage.dump()[c.health]?.failure, undefined);
    // interval ticks while still prerendered stay quiet too
    f.advance(c.pollMs); await settle(12);
    assert.ok(!f.pendingTimers().includes(10000));
    // activation
    f.sender.documentLifecycle = 'active';
    f.setVisibility('visible'); await settle(16);
    assert.equal(w.polls(f, c.tag).length, 1, 'poll starts on activation without waiting a full interval');
  });
}

test('critical: partial poll (one table failed) while seeding → normal interval cadence, not the 10 s retry storm', async () => {
  const w = createAlertWorld();
  await w.app.ensureReady();
  await w.app.chooseFallback('critical-alert', 'seed-silently');
  const f = w.frame(PROD, {api: {rows: {[CASE]: [critRow('a')]}, fail: {sn_customerservice_task: 500}}});
  w.loadStatic(f); await settle();
  await f.fire(5000); await settle(12);
  assert.equal(w.polls(f).length, 1);
  assert.equal(f.api.fetches.length, 2);
  assert.ok(!f.pendingTimers().includes(10000), 'no 10 s retry scheduled');
  assert.ok(w.storage.dump()['crit.lastPollAt'] > 0, 'heartbeat kept (not released)');
  assert.equal(w.storage.dump()['crit.healthStateV1']?.failure, undefined, 'no background-failed health signal');
  assert.equal(w.storage.dump()['crit.migrationV1'].state, 'seeding');
  f.advance(10000); await settle(12);
  assert.equal(w.polls(f).length, 1, 'nothing at +10 s');
  w.storage.put('crit.lastPollAt', 0); // heartbeat window elapsed on the worker clock
  f.advance(110000); await settle(12);
  assert.equal(w.polls(f).length, 2, 'next poll at the normal 120 s interval');
  assert.equal(f.api.fetches.length, 4);
});
