// Preferences, migration-state parsing and effective-state computation (shared/features.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURES, FEATURE_NAMES, PREFERENCES_KEY, EFFECTIVE_KEY, parsePreferences, parseMigration, computeEffective,
  createSettingsStore, buildEffectiveRecord
} from '../shared/features.mjs';
import {createFakeStorage, ORIGINS, PROD, TEST} from './helpers/fake-chrome.mjs';

const ALL = ['critical-alert', 'interaction-alert', 'informatica-button', 'kb-dark', 'timecard'];
const READY = {schema: 1, state: 'ready', method: 'notify-current', decidedAt: 1, completedAt: 1};

test('catalog: exactly the five known features, labels, origin roles and preserved alert keys', () => {
  assert.deepEqual(FEATURE_NAMES, ALL);
  assert.equal(FEATURES.timecard.label, 'Timecard overlay (native-form compatibility always on)');
  for (const name of ALL) assert.deepEqual(FEATURES[name].origins, name === 'timecard' ? ['production', 'test'] : ['production']);
  assert.equal(FEATURES['critical-alert'].alert.dedupeKey, 'seenMatchesV4');
  assert.equal(FEATURES['interaction-alert'].alert.dedupeKey, 'seenInteractionsV1');
  assert.equal(FEATURES['critical-alert'].alert.migrationKey, 'crit.migrationV1');
  assert.equal(FEATURES['interaction-alert'].alert.migrationKey, 'ix.migrationV1');
  for (const name of ['informatica-button', 'kb-dark', 'timecard']) assert.equal(FEATURES[name].alert, undefined);
  assert.equal(PREFERENCES_KEY, 'features');
  assert.ok(Object.isFrozen(FEATURES) && Object.isFrozen(FEATURES['critical-alert'].alert));
});

test('missing preferences default every known feature on', () => {
  assert.deepEqual(parsePreferences(undefined).preferences, Object.fromEntries(ALL.map(n => [n, true])));
  assert.deepEqual(parsePreferences({}).problems, []);
  assert.deepEqual(parsePreferences({'kb-dark': false}).preferences['kb-dark'], false);
  assert.equal(parsePreferences({'kb-dark': false}).preferences.timecard, true, 'other missing keys stay default-on');
});

test('malformed/unknown values never enable anything', () => {
  for (const raw of [null, 'all', 1, true, ['kb-dark'], () => 1]) {
    const r = parsePreferences(raw);
    assert.deepEqual(Object.values(r.preferences), ALL.map(() => false), JSON.stringify(raw));
    assert.match(r.problems.join(), /malformed/);
  }
  const mixed = parsePreferences({'kb-dark': 'yes', timecard: 1, 'critical-alert': null, 'informatica-button': true, evil: true, __proto__x: true});
  assert.equal(mixed.preferences['kb-dark'], false);
  assert.equal(mixed.preferences.timecard, false);
  assert.equal(mixed.preferences['critical-alert'], false);
  assert.equal(mixed.preferences['informatica-button'], true);
  assert.equal('evil' in mixed.preferences, false);
  assert.match(mixed.problems.join('\n'), /kb-dark/);
  assert.match(mixed.problems.join('\n'), /unknown preference key evil/);
  const proto = parsePreferences(JSON.parse('{"__proto__": {"kb-dark": true}, "kb-dark": false}'));
  assert.equal(proto.preferences['kb-dark'], false);
});

test('migration state: missing/unrecognized is pending-migration (fail closed)', () => {
  for (const raw of [undefined, null, 'ready', {}, {state: 'ready'}, {state: 'ready', method: 'guess'}, {schema: 2, state: 'ready', method: 'import'},
    {schema: 1, state: 'seeding', method: 'notify-current'}, {schema: 1, state: 'done', method: 'import'}, []]) {
    assert.equal(parseMigration(raw).state, 'pending-migration', JSON.stringify(raw));
    assert.ok(parseMigration(raw).reason.length > 0);
  }
  assert.match(parseMigration(undefined).reason, /no migration/i);
  assert.match(parseMigration({state: 'x'}).reason, /unrecognized/i);
  assert.equal(parseMigration(READY).state, 'ready');
  assert.equal(parseMigration({schema: 1, state: 'ready', method: 'import', decidedAt: 1, completedAt: 2}).method, 'import');
  assert.equal(parseMigration({schema: 1, state: 'seeding', method: 'seed-silently', decidedAt: 1}).state, 'seeding');
});

test('effective = preference AND completed migration for alerts; preference alone otherwise', () => {
  const prefs = parsePreferences(undefined).preferences;
  const pending = computeEffective(prefs, {});
  assert.equal(pending['critical-alert'].enabled, false);
  assert.match(pending['critical-alert'].reason, /pending-migration/);
  assert.equal(pending['interaction-alert'].enabled, false);
  for (const n of ['informatica-button', 'kb-dark', 'timecard']) assert.equal(pending[n].enabled, true);
  const ready = computeEffective(prefs, {'critical-alert': parseMigration(READY), 'interaction-alert': parseMigration(READY)});
  assert.equal(ready['critical-alert'].enabled, true);
  const off = computeEffective({...prefs, 'critical-alert': false}, {'critical-alert': parseMigration(READY)});
  assert.equal(off['critical-alert'].enabled, false);
  assert.match(off['critical-alert'].reason, /disabled/);
  const seeding = computeEffective(prefs, {'critical-alert': parseMigration({schema: 1, state: 'seeding', method: 'seed-silently', decidedAt: 1})});
  assert.deepEqual([seeding['critical-alert'].enabled, seeding['critical-alert'].seedOnly], [false, true]);
  const seedingOff = computeEffective({...prefs, 'critical-alert': false}, {'critical-alert': parseMigration({schema: 1, state: 'seeding', method: 'seed-silently', decidedAt: 1})});
  assert.equal(seedingOff['critical-alert'].seedOnly, false);
});

test('effective record carries per-origin scope: production all five, test host timecard only', () => {
  const effective = computeEffective(parsePreferences(undefined).preferences, {});
  const record = buildEffectiveRecord({effective, origins: ORIGINS, epoch: 'e', rev: 3, at: 5});
  assert.equal(record.schema, 1);
  assert.deepEqual(record.origins[PROD], ALL);
  assert.deepEqual(record.origins[TEST], ['timecard']);
  assert.equal(record.rev, 3);
  assert.equal(JSON.stringify(record).includes('"features":{"critical-alert":{"enabled":false'), true);
  assert.equal('preferences' in record, false, 'raw preferences are never part of the content-facing record');
});

test('store.readState reads all settings keys in ONE get; storage failure throws (no silent all-on)', async () => {
  const s = createFakeStorage({features: {'kb-dark': false}});
  const store = createSettingsStore({storage: s.local});
  const state = await store.readState();
  assert.equal(s.ctl.gets.length, 1);
  assert.deepEqual([...s.ctl.gets[0]].sort(), ['crit.migrationV1', EFFECTIVE_KEY, 'features', 'ix.migrationV1'].sort());
  assert.equal(state.preferences['kb-dark'], false);
  assert.equal(state.effective['kb-dark'].enabled, false);
  s.ctl.failGet = 'boom';
  await assert.rejects(store.readState(), /boom/);
});

test('setPreference: validates, writes all five explicit booleans, malformed siblings become explicit false', async () => {
  const s = createFakeStorage({features: {'kb-dark': 'garbage', timecard: false}});
  const store = createSettingsStore({storage: s.local});
  await store.setPreference('informatica-button', false);
  assert.deepEqual(s.dump().features, {'critical-alert': true, 'interaction-alert': true, 'informatica-button': false, 'kb-dark': false, timecard: false});
  await assert.rejects(store.setPreference('evil', true), /unknown feature/);
  await assert.rejects(store.setPreference('kb-dark', 'true'), /boolean/);
  s.ctl.failGet = true;
  const before = s.ctl.sets.length;
  await assert.rejects(store.setPreference('kb-dark', true));
  assert.equal(s.ctl.sets.length, before, 'no write after a failed read');
});

test('setPreference cannot bypass alert migration', async () => {
  const s = createFakeStorage({});
  const store = createSettingsStore({storage: s.local});
  await store.setPreference('critical-alert', true);
  const state = await store.readState();
  assert.equal(state.preferences['critical-alert'], true);
  assert.equal(state.effective['critical-alert'].enabled, false);
  assert.equal(s.dump()['crit.migrationV1'], undefined);
});

test('rapid setPreference toggles are serialized: last write wins, no lost update', async () => {
  const s = createFakeStorage({});
  s.ctl.getDelay = () => Math.floor(Math.random() * 4);
  const store = createSettingsStore({storage: s.local});
  const ops = [];
  for (let i = 0; i < 10; i++) {
    ops.push(store.setPreference('kb-dark', i % 2 === 1));
    ops.push(store.setPreference('timecard', i % 2 === 0));
  }
  await Promise.all(ops);
  assert.deepEqual(s.dump().features, {'critical-alert': true, 'interaction-alert': true, 'informatica-button': true, 'kb-dark': true, timecard: false});
});

test('feature catalog: alert config has only the fields in use', async () => {
  const {FEATURES} = await import('../shared/features.mjs');
  for (const name of ['critical-alert', 'interaction-alert']) {
    assert.deepEqual(Object.keys(FEATURES[name].alert).sort(), ['dedupeKey', 'entryPattern', 'migrationKey']);
  }
});

test('fake storage mirrors Chrome: no onChanged event for no-op writes or removes of absent keys', async () => {
  const {createFakeStorage, sleep} = await import('./helpers/fake-chrome.mjs');
  const s = createFakeStorage({a: {x: 1}, b: 2});
  const events = [];
  s.onChanged.addListener(changes => events.push(Object.keys(changes)));
  await s.local.set({a: {x: 1}, b: 2});
  await s.local.remove(['missing']);
  await s.local.remove([]);
  await sleep(5);
  assert.deepEqual(events, []);
  await s.local.set({a: {x: 1}, b: 3});
  await s.local.remove(['a', 'missing']);
  await sleep(5);
  assert.deepEqual(events, [['b'], ['a']], 'only actually changed keys are reported');
});
