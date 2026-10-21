import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createInformaticaPage} from './helpers/informatica-sim.mjs';
import {loadWithSafety} from '../scripts/dev-tools.mjs';
import {createMiloBackground} from '../shared/router.mjs';
import {createFakeChrome, createFakeStorage} from './helpers/fake-chrome.mjs';
const root = '/fixture/extension';
const origins = {production: 'https://prod.service-now.com', test: 'https://test.service-now.com'};
function fixture({busy = false, unknown = false, fail = false, installed = true, noWorker = false, noInventory = false, lostAcquire = false} = {}) {
 const p = createInformaticaPage().load(); if (busy) p.button().click();
 if (unknown) delete p.controller().acquireMaintenance;
 const calls = [];
 const chrome = {tabs: {query: async () => [{id: 1}]}, scripting: {executeScript: async i => {
  assert.equal(i.world, 'ISOLATED'); p.isolated.g.__args = i.args;
  return [{result: vm.runInContext(`(${i.func.toString()})(...__args)`, p.isolated.g)}];
 }}};
 const {chrome: base} = createFakeChrome({storage:createFakeStorage()});
 const app = createMiloBackground({chrome:base, origins});
 const worker = vm.createContext({chrome, snMilo:{informaticaMaintenance:app.informaticaGate}});
 const browser = {call: async (method, params) => {
  calls.push(method);
  if (method === 'Extensions.getExtensions') return noInventory ? {} : {extensions: installed ? [{id: 'old', path: root, enabled: true}] : []};
  if (method === 'Target.getTargets') return {targetInfos: noWorker ? [] : [{type: 'service_worker', url: 'chrome-extension://old/background.js', targetId: 'worker'}]};
  if (method === 'Target.attachToTarget') return {sessionId: 'old-worker'};
  if (method === 'Runtime.evaluate') {
   // Simulate a click while safety async operations are awaiting their responses.
   const value = await vm.runInContext(params.expression, worker); p.button().click();
   if (lostAcquire && params.expression.includes('const locks =')) throw Error('CDP timeout: Runtime.evaluate');
   return {result: {value}};
  }
  if (method === 'Extensions.loadUnpacked') {
   if (installed) assert.equal(p.controller().lastRun, null, 'click between preflight and load was excluded');
   if (fail) throw Error(typeof fail === 'string' ? fail : 'load failed'); return {id: 'new'};
  }
  return {};
 }};
 return {p, browser, calls, app};
}
for (const state of ['busy', 'unknown']) test(`pre-load ${state} actual isolated controller refuses load entirely`, async () => {
 const f = fixture({[state]: true});
 await assert.rejects(loadWithSafety({browser: f.browser, root, origins}), /informatica/);
 assert.equal(f.calls.includes('Extensions.loadUnpacked'), false);
 if (state === 'busy') assert.equal(f.p.controller().lastRun.status, 'running');
});
test('pre-load interlock excludes race clicks, releases on load failure', async () => {
 const f = fixture({fail: true}); await assert.rejects(loadWithSafety({browser: f.browser, root, origins}), /load failed/);
 assert.equal((await f.app.informaticaGate.status()).maintenance,null);
 f.p.button().click(); assert.equal(f.p.controller().lastRun.status, 'running');
});
test('fresh install requires explicit inventory first, not a worker', async () => {
 const f = fixture({installed: false}); await loadWithSafety({browser: f.browser, root, origins});
 assert.deepEqual(f.calls.slice(0, 2), ['Extensions.getExtensions', 'Extensions.loadUnpacked']);
});
for (const state of ['noWorker', 'noInventory']) test(`${state}: uncertainty refuses load`, async () => {
 const f = fixture({[state]:true}); await assert.rejects(loadWithSafety({browser:f.browser,root,origins}), /unavailable/);
 assert.equal(f.calls.includes('Extensions.loadUnpacked'), false);
});
test('lost preflight response fails closed and releases worker-retained reservations', async () => {
 const f = fixture({lostAcquire:true}); await assert.rejects(loadWithSafety({browser:f.browser,root,origins}), /timeout/);
 assert.equal(f.calls.includes('Extensions.loadUnpacked'), false);
 assert.equal((await f.app.informaticaGate.status()).maintenance,null);
 f.p.button().click(); assert.equal(f.p.controller().lastRun.status, 'running');
});
test('ambiguous load timeout retains exclusion rather than allowing a run before late invalidation', async () => {
 const f = fixture({fail:'CDP timeout: Extensions.loadUnpacked'});
 await assert.rejects(loadWithSafety({browser:f.browser,root,origins}), /maintenance retained/);
 f.p.button().click(); assert.equal(f.p.controller().lastRun, null);
 assert.match((await f.app.informaticaGate.status()).maintenance,/^update-/);
});
