// Central router: {feature,type} registry pairing, sender identity/origin, effective enablement, async responses,
// notification-click and alarm ownership. Uses inert TEST features only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMiloBackground, validateRegistry} from '../shared/router.mjs';
import {createFakeChrome, createFakeStorage, deliver, contentSender, optionsSender, ORIGINS, PROD, TEST, sleep} from './helpers/fake-chrome.mjs';
import {inertFeatures, testFeature} from './helpers/test-features.mjs';

const READY = {schema: 1, state: 'ready', method: 'notify-current', decidedAt: 1, completedAt: 1};
function setup(initial = {'crit.migrationV1': READY, 'ix.migrationV1': READY}) {
  const {chrome, storage, calls} = createFakeChrome({storage: createFakeStorage(initial)});
  const f = inertFeatures();
  const app = createMiloBackground({chrome, origins: ORIGINS, features: f.modules});
  app.install();
  return {chrome, storage, calls, app, f};
}
const send = (env, message, sender = contentSender()) => deliver(env.chrome, message, sender);

test('registry validation: known names only, unique modules, unique alarm owners, non-overlapping prefixes', () => {
  assert.throws(() => validateRegistry([testFeature('evil').module]), /unknown feature/);
  assert.throws(() => validateRegistry([testFeature('kb-dark').module, testFeature('kb-dark').module]), /duplicate/);
  assert.throws(() => validateRegistry([testFeature('critical-alert', {alarms: ['a']}).module, testFeature('interaction-alert', {alarms: ['a']}).module]), /alarm a/);
  assert.throws(() => validateRegistry([testFeature('critical-alert', {prefixes: ['snTk']}).module, testFeature('interaction-alert', {prefixes: ['snTk-']}).module]), /prefix/);
  assert.throws(() => validateRegistry([testFeature('kb-dark', {messages: {bad: 42}}).module]), /handler/);
  assert.throws(() => validateRegistry([testFeature('kb-dark', {prefixes: ['']}).module]), /prefix/);
  assert.doesNotThrow(() => validateRegistry(inertFeatures().modules));
});

test('malformed messages are rejected synchronously without keeping the channel open', async () => {
  const env = setup();
  for (const m of [null, 'snTkRows', 42, [], {}, {type: 'ping'}, {feature: 'kb-dark'}, {feature: 1, type: 'ping'}, {feature: 'kb-dark', type: {}}]) {
    const r = await send(env, m);
    assert.equal(r.keptOpen, false, JSON.stringify(m));
    assert.deepEqual(r.response, {ok: false, error: 'invalid-message'});
  }
  for (const f of Object.values(env.f)) if (f.calls) assert.deepEqual(f.calls.filter(c => c[0] === 'ping'), []);
});

test('unknown feature / type pairings are rejected (legacy un-namespaced types included)', async () => {
  const env = setup();
  for (const m of [{feature: 'nope', type: 'ping'}, {feature: 'kb-dark', type: 'pong'}, {feature: 'kb-dark', type: 'snTkRows'},
    {feature: 'milo', type: 'explode'}, {feature: 'kb-dark', type: '__proto__'}, {feature: 'kb-dark', type: 'constructor'}, {feature: 'kb-dark', type: 'hasOwnProperty'}]) {
    const r = await send(env, m);
    assert.deepEqual(r.response, {ok: false, error: 'unknown-message'}, JSON.stringify(m));
    assert.equal(r.keptOpen, false);
  }
});

test('foreign senders (other extension / no id) are rejected', async () => {
  const env = setup();
  for (const sender of [{...contentSender(), id: 'otherextensionidotherextensionid'}, {...contentSender(), id: undefined}, undefined]) {
    const r = await deliver(env.chrome, {feature: 'kb-dark', type: 'ping', n: 1}, sender);
    assert.deepEqual(r.response, {ok: false, error: 'foreign-sender'});
  }
  assert.deepEqual(env.f.kb.calls.filter(c => c[0] === 'ping'), []);
});

test('sender origin policy: production for alerts/kb, test host also for informatica and timecard', async () => {
  const env = setup();
  const cases = [
    ['critical-alert', PROD, true], ['critical-alert', TEST, false], ['interaction-alert', TEST, false],
    ['informatica-button', TEST, true], ['kb-dark', TEST, false], ['kb-dark', PROD, true],
    ['timecard', TEST, true], ['timecard', PROD, true],
    ['kb-dark', 'https://evil.service-now.com', false], ['timecard', 'http://prod.service-now.com', false],
    ['kb-dark', 'https://prod.service-now.com.evil.example', false]
  ];
  for (const [feature, origin, allowed] of cases) {
    const r = await send(env, {feature, type: 'ping', n: 1}, contentSender(origin));
    assert.equal(r.response.ok, allowed, `${feature} from ${origin}: ${JSON.stringify(r.response)}`);
    if (!allowed) assert.equal(r.response.error, 'wrong-origin');
  }
  // frame on production inside a foreign top-level tab, and the reverse: both must be allowed origins
  assert.equal((await send(env, {feature: 'kb-dark', type: 'ping'}, contentSender(PROD, {tabUrl: 'https://evil.example/x'}))).response.error, 'wrong-origin');
  assert.equal((await send(env, {feature: 'kb-dark', type: 'ping'}, contentSender('https://evil.example', {tabUrl: `${PROD}/x`}))).response.error, 'wrong-origin');
  // the options page cannot send feature messages; content scripts cannot call options-only control messages
  assert.equal((await send(env, {feature: 'kb-dark', type: 'ping'}, optionsSender())).response.error, 'wrong-origin');
  for (const type of ['set-preference', 'get-status', 'import-dedupe', 'choose-fallback']) {
    assert.equal((await send(env, {feature: 'milo', type, name: 'kb-dark', enabled: false}, contentSender())).response.error, 'wrong-origin', type);
  }
  assert.equal((await send(env, {feature: 'milo', type: 'get-effective'}, optionsSender())).response.error, 'wrong-origin');
  assert.equal((await send(env, {feature: 'milo', type: 'get-effective'}, contentSender('https://evil.service-now.com'))).response.error, 'wrong-origin');
});

test('disabled and pending features never reach their handlers', async () => {
  const env = setup({features: {'kb-dark': false}});
  const r = await send(env, {feature: 'kb-dark', type: 'ping', n: 1});
  assert.deepEqual(r.response, {ok: false, error: 'feature-disabled'});
  assert.equal(r.keptOpen, true, 'decided after the readiness gate');
  assert.deepEqual(env.f.kb.calls.filter(c => c[0] === 'ping'), []);
  const pending = setup({});
  assert.equal((await send(pending, {feature: 'critical-alert', type: 'ping', n: 1})).response.error, 'feature-disabled');
  assert.equal((await send(pending, {feature: 'critical-alert', type: 'seed', n: 1})).response.error, 'feature-disabled', 'seed handler needs a seeding decision');
  assert.deepEqual(pending.f.crit.calls.filter(c => c[0] === 'ping' || c[0] === 'seed'), []);
  const seeding = setup({'crit.migrationV1': {schema: 1, state: 'seeding', method: 'seed-silently', decidedAt: 1}});
  assert.equal((await send(seeding, {feature: 'critical-alert', type: 'ping', n: 1})).response.error, 'feature-disabled');
  assert.deepEqual((await send(seeding, {feature: 'critical-alert', type: 'seed', n: 2})).response, {ok: true});
});

test('async response lifetime: channel kept open across awaits; handler errors become {ok:false}', async () => {
  const env = setup();
  const r = await send(env, {feature: 'critical-alert', type: 'ping', n: 5, delay: 40});
  assert.equal(r.keptOpen, true);
  assert.deepEqual(r.response, {ok: true, pong: 5, enabledAfterAwait: true});
  const e = await send(env, {feature: 'critical-alert', type: 'ping', n: 6, throw: true});
  assert.deepEqual(e.response, {ok: false, error: 'handler exploded'});
  // concurrent messages to two features complete independently
  const [a, b] = await Promise.all([
    send(env, {feature: 'critical-alert', type: 'ping', n: 1, delay: 30}),
    send(env, {feature: 'interaction-alert', type: 'ping', n: 2})
  ]);
  assert.deepEqual([a.response.pong, b.response.pong], [1, 2]);
});

test('disable while a handler is in flight is visible to the handler after its await', async () => {
  const env = setup();
  const inflight = send(env, {feature: 'critical-alert', type: 'ping', n: 1, delay: 60});
  await sleep(5);
  await send(env, {feature: 'milo', type: 'set-preference', name: 'critical-alert', enabled: false}, optionsSender());
  const r = await inflight;
  assert.equal(r.response.enabledAfterAwait, false);
  assert.equal((await send(env, {feature: 'critical-alert', type: 'ping', n: 2})).response.error, 'feature-disabled');
});

test('notification clicks dispatch only to the owning feature prefix', async () => {
  const env = setup();
  await env.app.onNotificationClicked('snTk-0123456789abcdef0123456789abcdef');
  await env.app.onNotificationClicked('snIxHealth');
  await env.app.onNotificationClicked('snHealth');
  await env.app.onNotificationClicked('other');
  assert.deepEqual(env.f.crit.calls.filter(c => c[0] === 'click'), [['click', 'snTk-0123456789abcdef0123456789abcdef']]);
  assert.deepEqual(env.f.ix.calls.filter(c => c[0] === 'click'), [['click', 'snIxHealth']]);
  for (const k of ['inf', 'kb', 'tc']) assert.deepEqual(env.f[k].calls.filter(c => c[0] === 'click'), []);
});

test('alarms dispatch by exact name to the owner, only while it is enabled', async () => {
  const env = setup({'crit.migrationV1': READY});
  await env.app.onAlarm({name: 'snTkHealthCheck'});
  await env.app.onAlarm({name: 'snIxHealthCheck'});
  await env.app.onAlarm({name: 'snTkHealthCheckX'});
  await env.app.onAlarm({name: 'unknown'});
  assert.deepEqual(env.f.crit.calls.filter(c => c[0] === 'alarm'), [['alarm', 'snTkHealthCheck', true]]);
  assert.deepEqual(env.f.ix.calls.filter(c => c[0] === 'alarm'), [], 'pending interaction alert gets no alarm');
});

test('get-effective returns the content-facing record (no raw preferences) for allowed origins', async () => {
  const env = setup({features: {'kb-dark': false}, 'crit.migrationV1': READY});
  for (const origin of [PROD, TEST]) {
    const {response} = await send(env, {feature: 'milo', type: 'get-effective'}, contentSender(origin));
    assert.equal(response.ok, true);
    assert.equal(response.effective.schema, 1);
    assert.equal(response.effective.features['kb-dark'].enabled, false);
    assert.equal(response.effective.features['critical-alert'].enabled, true);
    assert.equal(response.effective.features['interaction-alert'].enabled, false);
    assert.deepEqual(response.effective.origins[TEST], ['informatica-button', 'monitoring-routing', 'inbox-overlay', 'timecard']);
    assert.equal('preferences' in response.effective, false);
  }
});

test('options control messages: get-status, set-preference validation', async () => {
  const env = setup();
  const s = await send(env, {feature: 'milo', type: 'get-status'}, optionsSender());
  assert.equal(s.response.ok, true);
  assert.equal(s.response.status.features.timecard.label, 'Timecard overlay (native-form compatibility always on)');
  assert.equal(s.response.status.features['critical-alert'].migration.state, 'ready');
  for (const bad of [{name: 'evil', enabled: true}, {name: 'kb-dark', enabled: 'false'}, {name: 'kb-dark'}]) {
    const r = await send(env, {feature: 'milo', type: 'set-preference', ...bad}, optionsSender());
    assert.equal(r.response.ok, false, JSON.stringify(bad));
  }
  assert.equal(env.storage.dump().features, undefined, 'nothing written by invalid requests');
  const ok = await send(env, {feature: 'milo', type: 'set-preference', name: 'kb-dark', enabled: false}, optionsSender());
  assert.equal(ok.response.ok, true);
  assert.equal(ok.response.status.features['kb-dark'].enabled, false);
});

test('sender with a tab but no tab url fails closed', async () => {
  const env = setup();
  const sender = {...contentSender(), tab: {id: 7}};
  assert.equal((await send(env, {feature: 'kb-dark', type: 'ping', n: 1}, sender)).response.error, 'wrong-origin');
  assert.equal((await send(env, {feature: 'milo', type: 'get-effective'}, sender)).response.error, 'wrong-origin');
  assert.deepEqual(env.f.kb.calls.filter(c => c[0] === 'ping'), []);
});

test('documentLifecycle: feature messages only from active documents (absent field = older browser, allowed)', async () => {
  const env = setup();
  for (const lifecycle of ['prerender', 'cached', 'pending_deletion', 'bogus']) {
    const r = await send(env, {feature: 'kb-dark', type: 'ping', n: 1}, {...contentSender(), documentLifecycle: lifecycle});
    assert.deepEqual(r.response, {ok: false, error: 'inactive-document'}, lifecycle);
  }
  assert.equal((await send(env, {feature: 'kb-dark', type: 'ping', n: 2}, {...contentSender(), documentLifecycle: 'active'})).response.pong, 2);
  assert.equal((await send(env, {feature: 'kb-dark', type: 'ping', n: 3})).response.pong, 3);
  // read-only effective state is still served to a prerendering controller (no side effects)
  assert.equal((await send(env, {feature: 'milo', type: 'get-effective'}, {...contentSender(), documentLifecycle: 'prerender'})).response.ok, true);
  assert.deepEqual(env.f.kb.calls.filter(c => c[0] === 'ping').map(c => c[1]), [2, 3]);
});

test('notification clicks for a disabled/pending owner only clear that notification', async () => {
  const env = setup({features: {'critical-alert': false}, 'crit.migrationV1': READY});
  await env.app.onNotificationClicked('snTk-0123456789abcdef0123456789abcdef');
  await env.app.onNotificationClicked('snIxHealth'); // interaction-alert pending migration
  assert.deepEqual(env.f.crit.calls.filter(c => c[0] === 'click'), []);
  assert.deepEqual(env.f.ix.calls.filter(c => c[0] === 'click'), []);
  assert.deepEqual(env.calls.filter(c => c[0] === 'notifications.clear').map(c => c[1]), ['snTk-0123456789abcdef0123456789abcdef', 'snIxHealth']);
  const on = setup();
  await on.app.onNotificationClicked('snTk-x');
  assert.deepEqual(on.f.crit.calls.filter(c => c[0] === 'click'), [['click', 'snTk-x']]);
  assert.deepEqual(on.calls.filter(c => c[0] === 'notifications.clear'), [], 'enabled owner handles its own notification');
});
