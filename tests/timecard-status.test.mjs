// Timecard options status: the worker asks open timecard tabs (read-only MAIN probe, no injection of files) whether an
// overlay is open and reports 'disabled; current form retained until closed' on the options page status line.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createMiloBackground} from '../shared/router.mjs';
import {viewModel} from '../shared/options-view.mjs';
import {createTimecard, RETAINED_STATUS, overlayProbe} from '../features/timecard/background.mjs';
import {createFakeChrome, createFakeStorage, deliver, optionsSender, ORIGINS, PROD, TEST} from './helpers/fake-chrome.mjs';

const READY = {schema: 1, state: 'ready', method: 'notify-current', decidedAt: 1, completedAt: 1};
function setup({timecard = true, open = {}, hookTimeoutMs} = {}) {
  const {chrome, calls} = createFakeChrome({storage: createFakeStorage({'crit.migrationV1': READY, 'ix.migrationV1': READY, features: {timecard}})});
  const probes = [];
  chrome.scripting.executeScript = async o => {
    probes.push(o);
    const answer = open[o.target.tabId];
    if (answer === 'throw') throw new Error('Cannot access contents of the page');
    if (answer === 'hang') return new Promise(() => {});
    return [{result: answer === true}];
  };
  let n = 0;
  for (const [id, url] of Object.entries({1: `${PROD}/now/cwf/agent/record/x`, 2: `${TEST}/now/nav/ui/classic`, 3: `${PROD}/other`})) {
    chrome.__fake.attachReceiver(Number(id), url, 0, () => { n++; });
  }
  const app = createMiloBackground({chrome, origins: ORIGINS, features: [createTimecard()], hookTimeoutMs});
  app.install();
  const status = async () => (await deliver(chrome, {feature: 'milo', type: 'get-status'}, optionsSender())).response.status;
  return {chrome, calls, app, probes, status};
}

test('no open overlay: no status line; the probe is a read-only function call on the top frame in MAIN', async () => {
  const env = setup({timecard: false});
  const s = await env.status();
  assert.equal(s.features.timecard.statusLine, undefined);
  assert.equal(env.probes.length, 3, 'one probe per production/test tab');
  for (const p of env.probes) {
    assert.equal(p.world, 'MAIN');
    assert.equal(typeof p.func, 'function');
    assert.equal(p.files, undefined, 'never injects files');
    assert.equal(p.target.allFrames, undefined);
  }
});

test('disabled + open overlay => "disabled; current form retained until closed" (several tabs counted)', async () => {
  assert.equal(RETAINED_STATUS, 'disabled; current form retained until closed');
  let env = setup({timecard: false, open: {2: true}});
  assert.equal((await env.status()).features.timecard.statusLine, RETAINED_STATUS);
  env = setup({timecard: false, open: {1: true, 2: true}});
  assert.equal((await env.status()).features.timecard.statusLine, `${RETAINED_STATUS} (2 tabs)`);
});

test('enabled with an open overlay is the normal state: no status line', async () => {
  const env = setup({timecard: true, open: {1: true}});
  assert.equal((await env.status()).features.timecard.statusLine, undefined);
});

test('an inaccessible tab is unknown; the router also bounds the overall status hook', async () => {
  let env = setup({timecard: false, open: {1: 'throw', 2: true}});
  assert.equal((await env.status()).features.timecard.statusLine, `${RETAINED_STATUS} (1 tab, +1 not checked)`);
  env = setup({timecard: false, open: {1: 'hang', 2: 'hang', 3: 'hang'}, hookTimeoutMs: 40});
  const s = await env.status();
  assert.equal(s.ready, true);
  assert.equal(s.features.timecard.statusLine, undefined);
  assert.ok(s.hookErrors.some(e => e.feature === 'timecard' && e.hook === 'describeStatus'));
});

test('toggling through the options control message returns the line in its status too', async () => {
  const env = setup({timecard: true, open: {2: true}});
  const r = (await deliver(env.chrome, {feature: 'milo', type: 'set-preference', name: 'timecard', enabled: false}, optionsSender())).response;
  assert.equal(r.ok, true);
  assert.equal(r.status.features.timecard.enabled, false);
  assert.equal(r.status.features.timecard.statusLine, RETAINED_STATUS);
});

test('the options view model carries the status line', async () => {
  const env = setup({timecard: false, open: {1: true}});
  const vm1 = viewModel(await env.status());
  assert.equal(vm1.features.find(f => f.name === 'timecard').statusLine, RETAINED_STATUS);
  const none = viewModel(await setup({timecard: true}).status());
  assert.equal(none.features.find(f => f.name === 'timecard').statusLine, '');
});

test('overlayProbe reads only the controller status and fails closed', () => {
  const run = app => vm.runInNewContext(`(${overlayProbe})()`, {window: app === undefined ? {} : {__snTimecardApp: app}});
  assert.equal(run(undefined), false);
  assert.equal(run({status: () => ({overlayOpen: true})}), true);
  assert.equal(run({status: () => ({overlayOpen: false})}), false);
  assert.equal(run({status: () => ({overlayOpen: 'yes'})}), false);
  assert.equal(run({status() { throw new Error('page broke it'); }}), false);
  assert.equal(run({}), false);
});

test('module shape: registers no messages, alarms or notification prefixes (content stays free of extension APIs)', () => {
  const m = createTimecard();
  assert.equal(m.name, 'timecard');
  assert.deepEqual(Object.keys(m.messages || {}), []);
  assert.deepEqual(m.alarms || [], []);
  assert.deepEqual(m.notificationPrefixes || [], []);
});

test('describeStatus probes with a per-tab timeout (unknown) and a tab cap, reporting how many were not checked', {timeout: 1000}, async () => {
  const mk = (n, answers) => {
    const {chrome} = createFakeChrome({storage: createFakeStorage({features: {timecard: false}})});
    const urls = Array.from({length: n}, (_, i) => ({id: i + 1, url: `${PROD}/x${i}`}));
    chrome.tabs.query = async () => urls;
    const probed = [];
    chrome.scripting.executeScript = async o => {
      probed.push(o.target.tabId);
      const a = answers(o.target.tabId);
      if (a === 'hang') return new Promise(() => {});
      return [{result: a === true}];
    };
    return {chrome, probed, ctx: {chrome, origins: ORIGINS, isEnabled: () => false}};
  };
  // 1 hanging tab among open ones: resolves quickly via per-tab timeout, other tabs still counted
  let env = mk(3, id => (id === 1 ? 'hang' : true));
  const mod = createTimecard({tabTimeoutMs: 30});
  const t0 = Date.now();
  assert.equal(await mod.describeStatus(env.ctx), `${RETAINED_STATUS} (2 tabs, +1 not checked)`);
  assert.ok(Date.now() - t0 < 500, 'bounded by the per-tab timeout, not the hook timeout');
  // cap
  env = mk(25, () => true);
  const capped = await createTimecard({maxTabs: 20}).describeStatus(env.ctx);
  assert.equal(env.probed.length, 20);
  assert.equal(capped, `${RETAINED_STATUS} (20 tabs, +5 not checked)`);
  env = mk(25, () => false);
  assert.equal(await createTimecard({maxTabs: 20}).describeStatus(env.ctx), 'disabled; retained forms unknown (5 tabs not checked)', 'unchecked tabs must not imply no retained forms');
  // defaults
  env = mk(30, () => true);
  await createTimecard().describeStatus(env.ctx);
  assert.equal(env.probed.length, 20, 'default cap is 20');
});

test('status limits concurrent waits to ten and caps the total at twenty', async () => {
  let active = 0, peak = 0, total = 0;
  const chrome = {
    tabs: {query: async () => Array.from({length: 30}, (_, id) => ({id}))},
    scripting: {executeScript: async () => {
      total++; active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return [{result: false}];
    }}
  };
  const line = await createTimecard().describeStatus({chrome, origins: ORIGINS, isEnabled: () => false});
  assert.equal(peak, 10);
  assert.equal(total, 20);
  assert.equal(line, 'disabled; retained forms unknown (10 tabs not checked)');
});

test('twenty hanging probes use two bounded waves and report all unknown plus capped tabs', {timeout: 4500}, async () => {
  let total = 0;
  const chrome = {
    tabs: {query: async () => Array.from({length: 25}, (_, id) => ({id}))},
    scripting: {executeScript: () => { total++; return new Promise(() => {}); }}
  };
  const start = Date.now();
  const line = await createTimecard().describeStatus({chrome, origins: ORIGINS, isEnabled: () => false});
  const elapsed = Date.now() - start;
  assert.equal(total, 20);
  assert.equal(line, 'disabled; retained forms unknown (25 tabs not checked)');
  assert.ok(elapsed >= 2800 && elapsed < 4000, `two 1500ms waves, observed ${elapsed}ms`);
});
