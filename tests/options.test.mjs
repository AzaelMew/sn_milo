// Pure options-page logic (shared/options-view.mjs): snapshot parsing/validation, control messages, fallback
// wording + confirm text, and the render view model (incl. the storage-error banner). No DOM needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSnapshotTexts, buildImportMessage, buildFallbackMessage, FALLBACK_OPTIONS, fallbackConfirmText, viewModel
} from '../shared/options-view.mjs';
import {FEATURE_NAMES} from '../shared/features.mjs';
import {optionsPage, settleOptions} from './helpers/options-sim.mjs';

for (const duringControl of [false, true]) {
  test(`options storage refresh respects watched keys and busy=${duringControl}`, async () => {
    const p = optionsPage();
    p.requests[0].resolve({ok: true, status: statusOf()});
    await settleOptions();
    if (duringControl) {
      const box = p.boxes().find(b => b.dataset.feature === 'timecard');
      box.checked = false;
      box.listeners.change();
    }
    const before = p.requests.length;
    p.changes[0]({unrelated: {}}, 'local');
    assert.equal(p.requests.length, before, 'unrelated storage does not refresh');
    p.changes[0]({features: {}}, 'local');
    assert.equal(p.requests.length, before + (duringControl ? 0 : 1), 'watched storage refreshes only while idle');
    assert.equal(p.focus.length, 1, 'storage events never add focus listeners');
  });
}

for (const refreshFirst of [true, false]) {
  test(`options disable can re-enable after storage races control (refresh first=${refreshFirst})`, async () => {
    const p = optionsPage();
    p.requests[0].resolve({ok: true, status: statusOf()});
    await settleOptions();
    const box = p.boxes().find(b => b.dataset.feature === 'timecard');
    box.checked = false;
    box.listeners.change();
    // Worker storage notification arrives before the set-preference response.
    p.changes[0]({features: {}}, 'local');
    const response = {ok: true, status: statusOf({}, {timecard: feature({preference: false, enabled: false})})};
    if (refreshFirst && p.requests[2]) { p.requests[2].resolve(response); await settleOptions(); }
    p.requests[1].resolve(response);
    await settleOptions();
    if (!refreshFirst && p.requests[2]) { p.requests[2].resolve(response); await settleOptions(); }
    const current = p.boxes().find(b => b.dataset.feature === 'timecard');
    assert.equal(current.checked, false);
    assert.equal(current.disabled, false, 'ready for re-enable');
  });
}

const ID = n => n.toString(16).padStart(32, '0');
const crit = (entries, extra = {}) => ({schema: 1, feature: 'critical-alert', key: 'seenMatchesV4', entries, exportedAt: '2026-10-20T10:00:00.000Z', ...extra});
const ix = (entries, extra = {}) => ({schema: 1, feature: 'interaction-alert', key: 'seenInteractionsV1', entries, ...extra});

test('parseSnapshotTexts: one snapshot, an array, and several texts are unioned with counts', () => {
  const a = crit([`${ID(1)}|1 - Critical|New|A`, `${ID(2)}|1 - Critical|New|A`]);
  const b = crit([`${ID(2)}|1 - Critical|New|A`, `${ID(3)}|2 - High|New|B`]);
  const one = parseSnapshotTexts('critical-alert', [JSON.stringify(a)]);
  assert.deepEqual([one.ok, one.snapshots.length, one.entries, one.distinct], [true, 1, 2, 2]);
  const many = parseSnapshotTexts('critical-alert', [JSON.stringify(a), JSON.stringify([b])]);
  assert.deepEqual([many.ok, many.snapshots.length, many.entries, many.distinct], [true, 2, 4, 3]);
  const blanks = parseSnapshotTexts('interaction-alert', ['  ', JSON.stringify(ix([ID(9)]))]);
  assert.deepEqual([blanks.ok, blanks.snapshots.length, blanks.distinct], [true, 1, 1], 'empty inputs are skipped');
});

test('parseSnapshotTexts: validation errors name the input and the problem; nothing is sent', () => {
  const cases = [
    [[], /no snapshot/i],
    [['  '], /no snapshot/i],
    [['{not json'], /input 1.*not valid JSON/i],
    [[JSON.stringify(crit([ID(1)]))], /entry 0 is not a valid seenMatchesV4 entry/],
    [[JSON.stringify(ix([ID(1)]))], /feature "interaction-alert" != critical-alert/],
    [[JSON.stringify(crit([`${ID(1)}|x`], {key: 'seenMatchesV3'}))], /key "seenMatchesV3" != seenMatchesV4/],
    [[JSON.stringify(crit([`${ID(1)}|x`], {schema: 2}))], /schema must be 1/],
    [[JSON.stringify(crit([`${ID(1)}|x`], {exportedAt: {}}))], /exportedAt/],
    [[JSON.stringify(crit([]))], /no entries.*fallback/i],
    [[JSON.stringify(crit([`${ID(1)}|x`])), '[]'], /input 2.*empty/i],
    [['42'], /input 1.*object or an array/i]
  ];
  for (const [texts, re] of cases) {
    const r = parseSnapshotTexts('critical-alert', texts);
    assert.equal(r.ok, false, JSON.stringify(texts));
    assert.match(r.error, re, JSON.stringify(texts));
    assert.equal(r.snapshots, undefined);
  }
  assert.match(parseSnapshotTexts('kb-dark', ['{}']).error, /unknown alert feature/);
});

test('control messages use the router contract (feature milo, explicit target)', () => {
  const snaps = [crit([`${ID(1)}|x`])];
  assert.deepEqual(buildImportMessage('critical-alert', snaps), {feature: 'milo', type: 'import-dedupe', target: 'critical-alert', snapshots: snaps});
  assert.deepEqual(buildFallbackMessage('interaction-alert', 'seed-silently'), {feature: 'milo', type: 'choose-fallback', target: 'interaction-alert', choice: 'seed-silently'});
  assert.throws(() => buildFallbackMessage('interaction-alert', undefined), /choose/i, 'no default choice');
  assert.throws(() => buildFallbackMessage('interaction-alert', 'notify'), /choose/i);
  assert.throws(() => buildImportMessage('kb-dark', snaps), /alert/);
});

test('fallback choices are explicit, worded with their consequences, and confirmed', () => {
  assert.deepEqual(FALLBACK_OPTIONS.map(o => o.choice), ['notify-current', 'seed-silently']);
  const [notify, seed] = FALLBACK_OPTIONS;
  assert.match(notify.label, /notify for currently matching items/i);
  assert.match(notify.consequence, /possible duplicate alerts/i);
  assert.match(seed.label, /seed .*first successful poll silently/i);
  assert.match(seed.consequence, /permanently suppress items never previously notified/i);
  const text = fallbackConfirmText('critical-alert', 'seed-silently', 'Critical alert notifications');
  assert.match(text, /Critical alert notifications/);
  assert.match(text, /permanently suppress items never previously notified/i);
  assert.match(text, /cannot be undone|not undone/i);
  assert.match(fallbackConfirmText('critical-alert', 'notify-current', 'X'), /possible duplicate alerts/i);
});

const feature = (over = {}) => ({label: 'L', origins: ['production'], registered: false, preference: true, enabled: true, seedOnly: false, reason: 'enabled', ...over});
const statusOf = (over = {}, features = {}) => ({ready: true, error: null, warnings: [], hookErrors: [], record: {epoch: 'E', rev: 1},
  features: Object.fromEntries(FEATURE_NAMES.map(n => [n, features[n] || feature()])), ...over});
const pending = {state: 'pending-migration', reason: 'no migration decision recorded yet'};

const portableRule = {id: 'account', name: 'Account', enabled: true, priority: '', account: 'Acme Oy'};
const ruleFile = rules => JSON.stringify({schema: 1, feature: 'critical-alert', rules});
async function importRuleFile(p, text, extra = {}) {
  p.nodes['rules-file'].files = [{size: Buffer.byteLength(text), async text() { return text; }, ...extra}];
  await p.nodes['rules-file'].listeners.change();
}

test('rule list export downloads validated current edits without saving and cleans up its URL', async () => {
  const p = optionsPage();
  await settleOptions();
  const name = p.nodes['rule-list'].children[0].children[1];
  name.value = 'Edited critical'; name.listeners.input();
  p.nodes['rules-export'].click();
  const data = JSON.parse(await p.downloads[0].text());
  assert.equal(data.schema, 1);
  assert.equal(data.feature, 'critical-alert');
  assert.equal(data.rules[0].name, 'Edited critical');
  assert.equal(p.writes.length, 0);
  const link = p.document.body.children[0];
  assert.equal(link.download, 'sn-milo-critical-alert-rules.json');
  assert.equal(link.clicked, true);
  assert.equal(link.removed, true);
  p.timers.forEach(fn => fn());
  assert.deepEqual(p.revoked, ['blob:test-1']);
});

test('rule list import replaces only the draft, survives storage refresh and saves explicitly', async () => {
  const p = optionsPage(); await settleOptions();
  p.nodes['rules-import'].click();
  assert.equal(p.nodes['rules-file'].clicked, true);
  await importRuleFile(p, ruleFile([portableRule, {...portableRule, id: 'disabled', enabled: false}]));
  assert.equal(p.confirmations.length, 1);
  assert.equal(p.nodes['rule-list'].children.length, 2);
  assert.equal(p.nodes['rule-list'].children[0].children[2].value, '');
  assert.equal(p.nodes['rule-list'].children[1].children[0].checked, false);
  assert.match(p.nodes['rules-state'].textContent, /imported.*save rules/i);
  assert.equal(p.writes.length, 0);
  p.changes[0]({'crit.rulesV1': {}}, 'local'); await settleOptions();
  assert.equal(p.nodes['rule-list'].children.length, 2, 'storage events cannot overwrite imported edits');
  await p.nodes['rules-save'].click();
  assert.deepEqual(JSON.parse(JSON.stringify(p.writes)), [{'crit.rulesV1': {schema: 1, rules: [portableRule, {...portableRule, id: 'disabled', enabled: false}]}}]);
  assert.equal(p.nodes['rules-file'].value, '');
});

test('cancelled rule import preserves edits; empty lists can round trip', async () => {
  const p = optionsPage(); await settleOptions();
  p.window.confirmResult = false;
  await importRuleFile(p, ruleFile([]));
  assert.equal(p.nodes['rule-list'].children.length, 1);
  assert.equal(p.writes.length, 0);
  p.window.confirmResult = true;
  await importRuleFile(p, ruleFile([]));
  assert.equal(p.nodes['rule-list'].children.length, 0);
  p.nodes['rules-export'].click();
  assert.deepEqual(JSON.parse(await p.downloads[0].text()).rules, []);
});

test('invalid rule imports preserve the whole draft and never write storage', async () => {
  const cases = [
    ['{', {}, /JSON/i],
    [JSON.stringify({schema: 2, feature: 'critical-alert', rules: []}), {}, /schema/i],
    [JSON.stringify({schema: 1, feature: 'interaction-alert', rules: []}), {}, /critical-alert/i],
    [ruleFile([portableRule, portableRule]), {}, /duplicate/i],
    [ruleFile([{...portableRule, account: 'bad^query'}]), {}, /invalid account/i],
    [ruleFile([{...portableRule, priority: '9'}]), {}, /priority/i],
    [ruleFile(Array.from({length: 11}, (_, i) => ({...portableRule, id: `r-${i}`}))), {}, /at most/i],
    [ruleFile([]), {size: 65537}, /64 KiB/i],
    [ruleFile([]), {async text() { throw new Error('read failed'); }}, /read failed/i]
  ];
  for (const [text, extra, error] of cases) {
    const p = optionsPage(); await settleOptions();
    await importRuleFile(p, text, extra);
    assert.match(p.nodes['rules-error'].textContent, error);
    assert.equal(p.nodes['rule-list'].children[0].children[1].value, 'Critical');
    assert.equal(p.confirmations.length, 0);
    assert.equal(p.writes.length, 0);
    assert.equal(p.nodes['rules-file'].value, '');
  }
});

test('invalid draft cannot be exported', async () => {
  const p = optionsPage(); await settleOptions();
  p.nodes['rule-add'].click();
  p.nodes['rules-export'].click();
  assert.equal(p.downloads.length, 0);
  assert.match(p.nodes['rules-error'].textContent, /priority or an account/i);
});

test('viewModel: completion actions only while an alert is not ready; checkboxes never complete migration', () => {
  const vm = viewModel(statusOf({}, {
    'critical-alert': feature({enabled: false, reason: 'pending-migration: x', migration: pending}),
    'interaction-alert': feature({migration: {state: 'ready', method: 'import', reason: 'migration complete (import)'}})
  }), {busy: false});
  const by = Object.fromEntries(vm.features.map(f => [f.name, f]));
  assert.deepEqual(vm.features.map(f => f.name), FEATURE_NAMES);
  assert.equal(by['critical-alert'].actions, true);
  assert.match(by['critical-alert'].pendingText, /Pending migration: no migration decision recorded yet/);
  assert.equal(by['critical-alert'].checkbox.checked, true);
  assert.equal(by['critical-alert'].effectiveText, 'Inactive — pending-migration: x');
  assert.equal(by['interaction-alert'].actions, false, 'hidden once ready');
  assert.equal(by['interaction-alert'].pendingText, null);
  assert.equal(by['kb-dark'].actions, false, 'non-alert features have no migration actions');
  const seeding = viewModel(statusOf({}, {'critical-alert': feature({enabled: false, seedOnly: true, reason: 'seeding: s',
    migration: {state: 'seeding', method: 'seed-silently', reason: 's'}})}), {busy: false});
  const s = seeding.features.find(f => f.name === 'critical-alert');
  assert.equal(s.actions, true, 'import / notify-current still possible while seeding');
  assert.deepEqual(s.disabledChoices, ['seed-silently']);
  assert.equal(s.effectiveText, 'Seeding (seeding: s)');
  const busy = viewModel(statusOf({}, {'critical-alert': feature({migration: pending})}), {busy: true});
  assert.ok(busy.features.every(f => f.checkbox.disabled === true && f.actionsDisabled === true));
  const idle = viewModel(statusOf({}, {'critical-alert': feature({migration: pending})}), {busy: false});
  assert.ok(idle.features.every(f => f.actionsDisabled === false));
});

test('viewModel: storage-error banner (warm worker keeps state; cold worker stays inactive) and warnings', () => {
  const ok = viewModel(statusOf(), {busy: false});
  assert.deepEqual(ok.banner, {hidden: true, text: ''});
  assert.deepEqual(ok.warnings, {hidden: true, text: ''});
  const warm = viewModel(statusOf({error: {message: 'storage get failed', at: 1}, warnings: ['ignored unknown preference key x', 'w2']}), {busy: false});
  assert.equal(warm.banner.hidden, false);
  assert.equal(warm.banner.text, 'Settings storage problem: storage get failed. Showing the last known state; nothing was reset.');
  assert.deepEqual(warm.warnings, {hidden: false, text: 'ignored unknown preference key x · w2'});
  const coldFeatures = Object.fromEntries(FEATURE_NAMES.map(n => [n, feature({preference: null, enabled: false, reason: 'settings not loaded yet', migration: n.endsWith('-alert') ? null : undefined})]));
  const cold = viewModel(statusOf({ready: false, record: null, error: {message: 'quota'}}, coldFeatures), {busy: false});
  assert.equal(cold.banner.text, 'Settings storage problem: quota. Features stay inactive until settings can be read.');
  assert.ok(cold.features.every(f => f.checkbox.disabled), 'no editing without a readable state');
  assert.ok(cold.features.every(f => f.actions === false), 'no completion actions without a known migration state');
});
