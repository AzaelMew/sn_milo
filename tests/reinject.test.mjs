// Reinjection plan builder (pure) and the worker-side executor (fake chrome). The plan is derived ONLY from
// shared/script-policy.mjs + tab URLs; these tests pin which files/worlds/frames land on which tab.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SCRIPT_POLICY, validatePolicy} from '../shared/script-policy.mjs';
import {planReinjection, matchesPath, reinjectOpenTabs} from '../shared/reinject.mjs';

const P = 'https://prod.service-now.com';
const T = 'https://prodtest.service-now.com';
const ORIGINS = {production: P, test: T};
const ids = plan => plan.steps.map(s => s.id);

test('matchesPath mirrors Chrome match-pattern paths (path+query, * glob, no fragment)', () => {
  assert.equal(matchesPath(['/kb', '/kb?*'], `${P}/kb`), true);
  assert.equal(matchesPath(['/kb', '/kb?*'], `${P}/kb?id=kb_view`), true);
  assert.equal(matchesPath(['/kb', '/kb?*'], `${P}/kb#frag`), true);
  assert.equal(matchesPath(['/kb', '/kb?*'], `${P}/kb-other`), false);
  assert.equal(matchesPath(['/kb', '/kb?*'], `${P}/kb_view.do?x=1`), false);
  assert.equal(matchesPath(['/kb', '/kb?*'], `${P}/kb/`), false);
  assert.equal(matchesPath(['/*'], `${P}/anything?a=b`), true);
  assert.equal(matchesPath(['/task_time_worked.do*'], `${P}/task_time_worked.do?sys_id=-1`), true);
  assert.equal(matchesPath(['/a.b*'], `${P}/aXb`), false, 'dots are literal');
});

test('production case page: shared first, every production feature, timecard overlay, never the native-form entry', () => {
  const plan = planReinjection([{id: 1, url: `${P}/now/cwf/agent/record/x/1`}], {origins: ORIGINS});
  assert.equal(plan.length, 1);
  assert.deepEqual(ids(plan[0]), ['settings-controller', 'main-settings', 'informatica-bridge', 'informatica-button', 'inbox-overlay',
    'critical-alert-bridge', 'critical-alert-poller', 'interaction-alert-bridge', 'interaction-alert-poller', 'timecard-overlay']);
  const byId = Object.fromEntries(plan[0].steps.map(s => [s.id, s]));
  assert.deepEqual([byId['settings-controller'].world, byId['settings-controller'].allFrames, byId['settings-controller'].files], ['ISOLATED', true, ['shared/controller.js']]);
  assert.deepEqual([byId['main-settings'].world, byId['main-settings'].allFrames, byId['main-settings'].files], ['MAIN', true, ['shared/main-settings.js']]);
  assert.deepEqual([byId['timecard-overlay'].world, byId['timecard-overlay'].allFrames, byId['timecard-overlay'].files],
    ['MAIN', false, ['features/timecard/config.js', 'features/timecard/core.js', 'features/timecard/quick-actions.js', 'features/timecard/content.js']]);
  for (const s of plan[0].steps) assert.equal(s.allFrames, s.id.startsWith('settings') || s.id === 'main-settings', `${s.id} frames`);
  assert.ok(!ids(plan[0]).includes('timecard-native'));
  assert.ok(!ids(plan[0]).includes('kb-dark-toggle'));
});

test('test host receives timecard overlay, informatica button, Inbox + shared on workspace pages', () => {
  const [plan] = planReinjection([{id: 2, url: `${T}/now/cwf/agent/record/x/1`}], {origins: ORIGINS});
  assert.deepEqual(ids(plan), ['settings-controller', 'main-settings', 'informatica-bridge', 'informatica-button', 'inbox-overlay', 'timecard-overlay']);
  for (const s of plan.steps) assert.ok(['shared', 'timecard', 'informatica-button', 'inbox-overlay'].includes(s.feature));
});

test('/kb and /kb?* get the KB toggle (JS); gated css even while disabled; other kb-like paths do not', () => {
  const [kb] = planReinjection([{id: 3, url: `${P}/kb`}], {origins: ORIGINS});
  assert.ok(ids(kb).includes('kb-dark-toggle'));
  assert.ok(ids(kb).includes('kb-dark-css'), 'css installed for later enable');
  const [kbq] = planReinjection([{id: 4, url: `${P}/kb?id=kb_home`}], {origins: ORIGINS, enabled: {'kb-dark': true}});
  assert.ok(ids(kbq).includes('kb-dark-toggle'));
  const css = kbq.steps.find(s => s.id === 'kb-dark-css');
  assert.deepEqual([css.css, css.files, css.world], [['features/kb-dark/dark.css'], [], 'ISOLATED']);
  for (const url of [`${P}/kb-other`, `${P}/kb_view.do?sys_kb_id=1`, `${P}/kb/`, `${T}/kb`, `${T}/kb?x=1`]) {
    const out = planReinjection([{id: 5, url}], {origins: ORIGINS, enabled: {'kb-dark': true}});
    assert.ok(!out.some(p => ids(p).some(i => i.startsWith('kb-dark'))), url);
  }
});

test('exact origin only: lookalike hosts, other schemes/ports, unknown tabs and bad URLs are skipped', () => {
  const tabs = [
    {id: 1, url: 'https://prod.service-now.com.evil.example/'}, {id: 2, url: 'https://evilprod.service-now.com/'},
    {id: 3, url: 'http://prod.service-now.com/'}, {id: 4, url: 'https://prod.service-now.com:8443/'},
    {id: 5, url: 'https://other.service-now.com/'}, {id: 6, url: 'chrome://extensions/'}, {id: 7, url: ''},
    {id: 8}, {id: 9, url: 'not a url'}, {url: `${P}/`}, {id: 10, url: `${P}/x`, discarded: true}, {id: 11, url: `${P}/x`}
  ];
  assert.deepEqual(planReinjection(tabs, {origins: ORIGINS}).map(p => p.tabId), [11]);
});

test('timecard-native is excluded (policy reinject:false); validatePolicy checks the flag; plan follows policy order', () => {
  const native = SCRIPT_POLICY.find(e => e.id === 'timecard-native');
  assert.equal(native.reinject, false);
  const policy = [...SCRIPT_POLICY, {...SCRIPT_POLICY[0], id: 'bad', reinject: 'yes'}];
  assert.ok(validatePolicy(policy).some(p => /reinject must be boolean/.test(p)));
  const [plan] = planReinjection([{id: 1, url: `${P}/task_time_worked.do?sys_id=-1`}], {origins: ORIGINS});
  assert.ok(!ids(plan).includes('timecard-native'));
  const order = SCRIPT_POLICY.map(e => e.id);
  assert.deepEqual(ids(plan), order.filter(i => ids(plan).includes(i)));
});

test('plan is built from the supplied policy (single source of truth)', () => {
  const policy = [{id: 'only', feature: 'shared', origins: ['production'], paths: ['/*'], world: 'MAIN', run_at: 'document_idle', all_frames: false, js: ['shared/x.js']}];
  const plan = planReinjection([{id: 1, url: `${P}/a`}, {id: 2, url: `${T}/a`}], {origins: ORIGINS, policy});
  assert.deepEqual(plan.map(p => [p.tabId, ids(p)]), [[1, ['only']]]);
});

function fakeChrome(tabs, {failOn = () => false, navigateAfter = null} = {}) {
  const calls = [];
  const current = new Map(tabs.map(t => [t.id, {...t}]));
  return {calls, current, chrome: {
    tabs: {
      async query(q) { calls.push(['query', q]); return [...current.values()].map(t => ({...t})); },
      async get(id) { if (!current.has(id)) throw new Error('no tab'); return {...current.get(id)}; }
    },
    scripting: {
      async executeScript(inj) {
        calls.push(['execute', inj]);
        if (inj.func) {
          const tab = current.get(inj.target.tabId);
          return [{frameId: 0, documentId: `doc-${tab.id}`, result: inj.target.frameIds ? {ok: true} : {href: tab.url, origin: new URL(tab.url).origin}}];
        }
        if (navigateAfter && navigateAfter.n-- === 0) current.get(navigateAfter.tab).url = navigateAfter.to;
        if (failOn(inj)) throw new Error('Cannot access contents of the page');
        return [{result: null}];
      },
      async insertCSS(inj) { calls.push(['css', inj]); },
      async removeCSS(inj) { calls.push(['remove-css', inj]); }
    }
  }};
}

test('reinjectOpenTabs: exact targets, per-step injection, no other chrome API', async () => {
  const {chrome, calls} = fakeChrome([{id: 1, url: `${P}/kb`}, {id: 2, url: `${T}/x`}, {id: 3, url: 'https://elsewhere.example/'}]);
  const summary = await reinjectOpenTabs({chrome, origins: ORIGINS, isEnabled: f => f === 'kb-dark'});
  assert.deepEqual(calls[0], ['query', {url: [`${P}/*`, `${T}/*`]}]);
  const exec = calls.filter(c => c[0] === 'execute' && c[1].files).map(c => c[1]);
  assert.ok(exec.every(i => i.target.tabId !== 3));
  const ctl = exec.find(i => i.files[0] === 'shared/controller.js' && i.target.tabId === 1);
  assert.deepEqual(ctl, {target: {tabId: 1, documentIds: ['doc-1']}, files: ['shared/controller.js'], world: 'ISOLATED'});
  const bridge = exec.find(i => i.files[0] === 'features/informatica-button/page.js');
  assert.deepEqual(bridge, {target: {tabId: 1, documentIds: ['doc-1']}, files: ['features/informatica-button/page.js'], world: 'MAIN'});
  assert.equal(exec.filter(i => i.target.tabId === 2).length, 6);
  assert.deepEqual(calls.filter(c => c[0] === 'css').map(c => c[1]), [{target: {tabId: 1, documentIds: ['doc-1']}, files: ['features/kb-dark/dark.css']}]);
  assert.deepEqual(summary.tabs.map(t => [t.tabId, t.ok]), [[1, true], [2, true]]);
  assert.equal(summary.failed, 0);
});

test('reinjectOpenTabs: a failing step is reported, other tabs still processed; navigation away stops the tab', async () => {
  const f = fakeChrome([{id: 1, url: `${P}/a`}, {id: 2, url: `${P}/b`}], {failOn: i => i.target.tabId === 1 && i.files?.[0] === 'shared/main-settings.js'});
  const s = await reinjectOpenTabs({chrome: f.chrome, origins: ORIGINS, isEnabled: () => false});
  assert.equal(s.tabs.find(t => t.tabId === 1).ok, false);
  assert.match(s.tabs.find(t => t.tabId === 1).errors[0], /main-settings/);
  assert.equal(s.tabs.find(t => t.tabId === 2).ok, true);
  assert.equal(s.failed, 1);

  const nav = fakeChrome([{id: 1, url: `${P}/kb`}], {navigateAfter: {n: 1, tab: 1, to: 'https://elsewhere.example/'}});
  const s2 = await reinjectOpenTabs({chrome: nav.chrome, origins: ORIGINS, isEnabled: () => false});
  assert.equal(nav.calls.filter(c => c[0] === 'execute' && c[1].files).length, 2, 'stops after the tab left the configured origin');
  assert.equal(s2.tabs[0].skipped, 'navigated');
});
