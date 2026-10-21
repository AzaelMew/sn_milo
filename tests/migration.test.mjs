// Alert storage migration API: importDedupe / chooseFallback / completeSeed (shared/features.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSettingsStore, parseMigration} from '../shared/features.mjs';
import {createFakeStorage} from './helpers/fake-chrome.mjs';

const id = n => n.toString(16).padStart(32, '0');
const crit = n => `${id(n)}|1 - Critical|New|Acme Oy`;
const snap = (feature, key, entries) => ({schema: 1, feature, key, entries});
const critSnap = entries => snap('critical-alert', 'seenMatchesV4', entries);
const ixSnap = entries => snap('interaction-alert', 'seenInteractionsV1', entries);
const setup = (initial = {}) => { const s = createFakeStorage(initial); return {s, store: createSettingsStore({storage: s.local, now: () => 1000})}; };

test('importDedupe unions snapshots into the exact dedupe key and marks migrated in ONE storage.set', async () => {
  const {s, store} = setup();
  const r = await store.importDedupe('critical-alert', [critSnap([crit(1), crit(2)]), critSnap([crit(2), crit(3)])]);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(s.ctl.sets.length, 1, 'atomic: one set');
  assert.deepEqual(Object.keys(s.ctl.sets[0]).sort(), ['crit.migrationV1', 'seenMatchesV4']);
  assert.deepEqual(s.dump().seenMatchesV4, [crit(1), crit(2), crit(3)]);
  const m = parseMigration(s.dump()['crit.migrationV1']);
  assert.deepEqual([m.state, m.method], ['ready', 'import']);
  assert.equal(s.dump()['ix.migrationV1'], undefined, 'other alert untouched');
  assert.equal(s.dump().seenInteractionsV1, undefined);
});

test('import is idempotent and keeps previously imported + locally accumulated entries (never shrinks)', async () => {
  const {s, store} = setup({seenInteractionsV1: [id(9)]});
  await store.importDedupe('interaction-alert', [ixSnap([id(1), id(2)])]);
  assert.deepEqual(s.dump().seenInteractionsV1, [id(9), id(1), id(2)]);
  const writes = s.ctl.sets.length;
  const again = await store.importDedupe('interaction-alert', [ixSnap([id(1), id(2)])]);
  assert.deepEqual([again.ok, again.changed], [true, false]);
  assert.equal(s.ctl.sets.length, writes, 'idempotent re-import writes nothing');
  // final snapshot taken later, with entries added between snapshots; a smaller snapshot never shrinks the set
  await store.importDedupe('interaction-alert', [ixSnap([id(1)]), ixSnap([id(1), id(2), id(3)])]);
  assert.deepEqual(s.dump().seenInteractionsV1, [id(9), id(1), id(2), id(3)]);
  await store.importDedupe('interaction-alert', [ixSnap([])]);
  assert.deepEqual(s.dump().seenInteractionsV1, [id(9), id(1), id(2), id(3)]);
  assert.equal(parseMigration(s.dump()['ix.migrationV1']).state, 'ready');
});

test('malformed payloads are rejected without any write', async () => {
  const {s, store} = setup({seenMatchesV4: [crit(1)]});
  const bad = [
    undefined, null, {}, [], 'x', [null], [critSnap('nope')],
    [snap('critical-alert', 'seenInteractionsV1', [crit(2)])],
    [snap('interaction-alert', 'seenMatchesV4', [crit(2)])],
    [{feature: 'critical-alert', key: 'seenMatchesV4', entries: [crit(2)]}],
    [critSnap([crit(2), 42])], [critSnap([''])], [critSnap(['zz|1 - Critical|New|Acme Oy'])], [critSnap([id(2)])],
    [critSnap([crit(2)]), critSnap([{}])], [critSnap(['x'.repeat(5000)])]
  ];
  for (const payload of bad) {
    const r = await store.importDedupe('critical-alert', payload);
    assert.equal(r.ok, false, JSON.stringify(payload)?.slice(0, 80));
    assert.ok(r.error);
  }
  const ixBad = await store.importDedupe('interaction-alert', [ixSnap([crit(1)])]);
  assert.equal(ixBad.ok, false, 'interaction entries are bare sys_ids');
  for (const f of ['kb-dark', 'timecard', 'nope']) assert.equal((await store.importDedupe(f, [critSnap([crit(1)])])).ok, false);
  assert.equal(s.ctl.sets.length, 0);
  assert.deepEqual(s.dump(), {seenMatchesV4: [crit(1)]});
});

test('an existing non-array dedupe value is refused, not overwritten', async () => {
  const {s, store} = setup({seenMatchesV4: {corrupt: true}});
  const r = await store.importDedupe('critical-alert', [critSnap([crit(1)])]);
  assert.equal(r.ok, false);
  assert.match(r.error, /existing/);
  assert.equal(s.ctl.sets.length, 0);
});

test('storage failures during import never write partially', async () => {
  const {s, store} = setup();
  s.ctl.failGet = true;
  await assert.rejects(store.importDedupe('critical-alert', [critSnap([crit(1)])]));
  s.ctl.failGet = null;
  s.ctl.failSet = true;
  await assert.rejects(store.importDedupe('critical-alert', [critSnap([crit(1)])]));
  assert.deepEqual(s.dump(), {});
  s.ctl.failSet = null;
  assert.equal((await store.importDedupe('critical-alert', [critSnap([crit(1)])])).ok, true, 'queue not poisoned');
});

test('concurrent imports are serialized per feature (no lost entries)', async () => {
  const {s, store} = setup();
  s.ctl.getDelay = () => Math.floor(Math.random() * 4);
  await Promise.all([1, 2, 3, 4, 5].map(n => store.importDedupe('critical-alert', [critSnap([crit(n)])])));
  assert.deepEqual([...s.dump().seenMatchesV4].sort(), [1, 2, 3, 4, 5].map(crit).sort());
});

test('chooseFallback notify-current records the decision and completes migration; idempotent', async () => {
  const {s, store} = setup();
  const r = await store.chooseFallback('critical-alert', 'notify-current');
  assert.deepEqual([r.ok, r.changed], [true, true]);
  const m = parseMigration(s.dump()['crit.migrationV1']);
  assert.deepEqual([m.state, m.method], ['ready', 'notify-current']);
  const writes = s.ctl.sets.length;
  assert.equal((await store.chooseFallback('critical-alert', 'notify-current')).changed, false);
  assert.equal((await store.chooseFallback('critical-alert', 'seed-silently')).changed, false, 'never reseed once ready');
  assert.equal(s.ctl.sets.length, writes);
  assert.equal(s.dump().seenMatchesV4, undefined, 'notify-current does not touch dedupe');
});

test('chooseFallback seed-silently holds activation until completeSeed persists seen-set + marker together', async () => {
  const {s, store} = setup({seenInteractionsV1: [id(7)]});
  await store.chooseFallback('interaction-alert', 'seed-silently');
  assert.equal(parseMigration(s.dump()['ix.migrationV1']).state, 'seeding');
  assert.equal((await store.completeSeed('interaction-alert', [id(1), 'bad'])).ok, false, 'validated seed only');
  const before = s.ctl.sets.length;
  const r = await store.completeSeed('interaction-alert', [id(1), id(2)]);
  assert.equal(r.ok, true);
  assert.equal(s.ctl.sets.length, before + 1);
  assert.deepEqual(Object.keys(s.ctl.sets.at(-1)).sort(), ['ix.migrationV1', 'seenInteractionsV1']);
  assert.deepEqual(s.dump().seenInteractionsV1, [id(7), id(1), id(2)]);
  const m = parseMigration(s.dump()['ix.migrationV1']);
  assert.deepEqual([m.state, m.method], ['ready', 'seed-silently']);
  assert.equal((await store.completeSeed('interaction-alert', [id(3)])).changed, false, 'never reseed');
  assert.deepEqual(s.dump().seenInteractionsV1, [id(7), id(1), id(2)]);
});

test('completeSeed without a seed-silently decision is refused; fallback rejects bad input', async () => {
  const {s, store} = setup();
  assert.equal((await store.completeSeed('critical-alert', [crit(1)])).ok, false);
  for (const [f, c] of [['critical-alert', 'seed'], ['critical-alert', undefined], ['kb-dark', 'notify-current'], ['x', 'notify-current']]) {
    assert.equal((await store.chooseFallback(f, c)).ok, false, `${f}/${c}`);
  }
  assert.equal(s.ctl.sets.length, 0);
});

test('seeding can be switched to notify-current before the seed completes; import completes it too', async () => {
  const {s, store} = setup();
  await store.chooseFallback('critical-alert', 'seed-silently');
  await store.chooseFallback('critical-alert', 'notify-current');
  assert.equal(parseMigration(s.dump()['crit.migrationV1']).method, 'notify-current');
  const {s: s2, store: store2} = setup();
  await store2.chooseFallback('critical-alert', 'seed-silently');
  await store2.importDedupe('critical-alert', [critSnap([crit(1)])]);
  assert.deepEqual([parseMigration(s2.dump()['crit.migrationV1']).state, parseMigration(s2.dump()['crit.migrationV1']).method], ['ready', 'import']);
  // import after a notify-current decision keeps the set and stays ready
  await store.importDedupe('critical-alert', [critSnap([crit(4)])]);
  assert.deepEqual(s.dump().seenMatchesV4, [crit(4)]);
  assert.equal(parseMigration(s.dump()['crit.migrationV1']).state, 'ready');
});

test('import caps: entry length, entry count and total size have clear errors; nothing is written', async () => {
  const {DEDUPE_LIMITS} = await import('../shared/features.mjs');
  assert.deepEqual(DEDUPE_LIMITS, {maxEntries: 50000, maxEntryLength: 512, maxBytes: 4 * 1024 * 1024, maxCombinedBytes: 5 * 1024 * 1024});
  const {s, store} = setup();
  const long = `${id(1)}|1 - Critical|New|${'x'.repeat(512)}`;
  let r = await store.importDedupe('critical-alert', [critSnap([crit(1), long])]);
  assert.deepEqual(r, {ok: false, error: 'snapshot 0: entry 1 is longer than 512 characters'});
  r = await store.importDedupe('interaction-alert', [ixSnap(Array.from({length: 50001}, (_, i) => id(i)))]);
  assert.deepEqual(r, {ok: false, error: 'snapshot 0: too many entries (50001; max 50000)'});
  // 9000 distinct ~500-char entries ≈ 4.5 MB > 4 MiB total
  const big = Array.from({length: 9000}, (_, i) => `${id(i)}|1 - Critical|New|${'y'.repeat(460)}`);
  r = await store.importDedupe('critical-alert', [critSnap(big)]);
  assert.equal(r.ok, false);
  assert.match(r.error, /seenMatchesV4 would be \d+ bytes \(max 4194304\); refusing to import/);
  assert.equal(s.ctl.sets.length, 0);
  assert.deepEqual(s.dump(), {});
});

test('import caps apply to the UNION with the existing set', async () => {
  const existing = Array.from({length: 49999}, (_, i) => id(i));
  const {s, store} = setup({seenInteractionsV1: existing});
  const r = await store.importDedupe('interaction-alert', [ixSnap([id(70000), id(70001)])]);
  assert.deepEqual(r, {ok: false, error: 'seenInteractionsV1 would have 50001 entries (max 50000); refusing to import'});
  assert.equal(s.ctl.sets.length, 0);
  const seed = await setup({'ix.migrationV1': {schema: 1, state: 'seeding', method: 'seed-silently', decidedAt: 1}, seenInteractionsV1: existing})
    .store.completeSeed('interaction-alert', [id(70000), id(70001)]);
  assert.equal(seed.ok, false);
  assert.match(seed.error, /would have 50001 entries/);
});

test('combined cap: both dedupe sets together stay under 5 MiB (10 MB quota); import and seed refuse with a clear error', async () => {
  // per-set caps alone would allow ~4.2 MB (critical) + ~1.75 MB (interaction, 50k × 32-hex) ≈ 5.9 MB
  const critBig = Array.from({length: 8000}, (_, i) => `${id(i)}|1 - Critical|New|${'y'.repeat(440)}`); // ≈ 3.9 MB
  const ix = Array.from({length: 45000}, (_, i) => id(100000 + i)); // ≈ 1.6 MB
  const {s, store} = setup({seenMatchesV4: critBig});
  const r = await store.importDedupe('interaction-alert', [ixSnap(ix)]);
  assert.equal(r.ok, false);
  assert.match(r.error, /^seenMatchesV4 \+ seenInteractionsV1 would total \d+ bytes \(combined max 5242880; chrome\.storage\.local quota is 10 MB\); refusing to import$/);
  assert.equal(s.ctl.sets.length, 0, 'nothing written');
  // the other direction, through completeSeed
  const {s: s2, store: store2} = setup({seenInteractionsV1: ix, 'crit.migrationV1': {schema: 1, state: 'seeding', method: 'seed-silently', decidedAt: 1}});
  const seed = await store2.completeSeed('critical-alert', critBig);
  assert.equal(seed.ok, false);
  assert.match(seed.error, /would total \d+ bytes \(combined max 5242880;.*refusing to complete the seed$/);
  assert.equal(s2.ctl.sets.length, 0);
  // below the combined cap still succeeds
  const {store: store3} = setup({seenMatchesV4: critBig.slice(0, 2000)});
  assert.equal((await store3.importDedupe('interaction-alert', [ixSnap(ix)])).ok, true);
});

test('combined cap holds under concurrent imports into both sets (no check-then-write race)', async () => {
  const critBig = Array.from({length: 8000}, (_, i) => `${id(i)}|1 - Critical|New|${'y'.repeat(440)}`);
  const ix = Array.from({length: 45000}, (_, i) => id(100000 + i));
  const {s, store} = setup();
  const [a, b] = await Promise.all([store.importDedupe('critical-alert', [critSnap(critBig)]), store.importDedupe('interaction-alert', [ixSnap(ix)])]);
  assert.deepEqual([a.ok, b.ok], [true, false], JSON.stringify([a.error, b.error]));
  assert.equal(s.dump().seenInteractionsV1, undefined);
});
