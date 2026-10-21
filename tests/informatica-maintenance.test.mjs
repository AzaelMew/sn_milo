import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {maintenanceInDocument} from '../shared/informatica-maintenance.mjs';
import {createInformaticaPage, CONTENT} from './helpers/informatica-sim.mjs';
import {reinjectOpenTabs} from '../shared/reinject.mjs';
const P = 'https://prod.service-now.com';
const origins = {production: P, test: 'https://test.service-now.com'};
function browser(p, {fail = false, race = false} = {}) {
 const calls = [];
 const chrome = {tabs: {query: async () => [{id: 1, url: p.isolated.g.location.href}], get: async () => ({url: p.isolated.g.location.href})}, scripting: {
  executeScript: async i => {
   calls.push(i);
   const g = i.world === 'MAIN' ? p.main.g : p.isolated.g;
   if (i.files) { if (fail) throw Error('injection failed'); for (const f of i.files) p.run(i.world === 'MAIN' ? 'main' : 'isolated', f); return []; }
   g.__args = i.args || [];
   const result = vm.runInContext(`(${i.func.toString()})(...__args)`, g);
   if (race && i.target.allFrames) p.button().click();
   return [{frameId: 0, documentId: 'doc', result}];
  }, removeCSS: async () => {}, insertCSS: async () => {}
 }};
 p.main.g.origin = P; p.isolated.g.origin = P;
 return {chrome, calls};
}
const policy = [{id: 'content', feature: 'informatica-button', origins: ['production'], paths: ['/*'], world: 'ISOLATED', all_frames: false, js: [CONTENT]}];
test('real ISOLATED running workflow blocks reinjection without cancellation (MAIN has no controller)', async () => {
 const p = createInformaticaPage().load(); p.button().click();
 assert.equal(p.controller().lastRun.status, 'running'); assert.equal(p.main.g.__snInfController, undefined);
 const old = p.controller(); const b = browser(p);
 const s = await reinjectOpenTabs({...b, origins, policy});
 assert.equal(s.tabs[0].skipped, 'informatica-in-progress'); assert.equal(b.calls.filter(i => i.files).length, 0);
 assert.equal(p.controller(), old); assert.equal(old.lastRun.status, 'running');
 p.run('isolated', CONTENT); assert.equal(p.controller(), old, 'same-world direct injection must not cancel a running workflow');
});
test('maintenance excludes user start during async inventory and releases after takeover', async () => {
 const p = createInformaticaPage().load(); const old = p.controller(); const b = browser(p, {race: true});
 const s = await reinjectOpenTabs({...b, origins, policy});
 assert.equal(s.failed, 0); assert.equal(old.lastRun, null, 'race click did not start or cancel a workflow'); assert.deepEqual(p.ws.log, []); assert.equal(p.controller().lastRun, null);
 p.button().click(); assert.equal(p.controller().lastRun.status, 'running', 'success releases inherited interlock');
});
test('maintenance releases after injection error; existing workflow can start', async () => {
 const p = createInformaticaPage().load(); const b = browser(p, {fail: true});
 const s = await reinjectOpenTabs({...b, origins, policy}); assert.equal(s.failed, 1);
 p.button().click(); assert.equal(p.controller().lastRun.status, 'running');
});
test('unknown legacy controller fails closed, never stopped or injected', async () => {
 const p = createInformaticaPage().load(); delete p.controller().acquireMaintenance;
 const b = browser(p); const s = await reinjectOpenTabs({...b, origins, policy});
 assert.equal(s.failed, 1); assert.equal(b.calls.filter(i => i.files).length, 0);
});
test('reload creates separate old/new isolated worlds; old lock survives, new controller starts only when ready', () => {
 const p = createInformaticaPage().load(); const old = p.controller();
 assert.equal(old.acquireMaintenance('reload').ok, true);
 const fresh = {...p.isolated.g};
 delete fresh.__snInfController; delete fresh.__snInfMaintenance;
 let start;
 fresh.__snMiloController = {effective: () => ({enabled:true}), subscribe: (_, handlers) => { start = handlers.start; return () => {}; }};
 vm.createContext(fresh); vm.runInContext('window = self = globalThis', fresh);
 assert.equal(vm.runInContext('typeof __snInfController', fresh), 'undefined');
 vm.runInContext(fs.readFileSync(new URL('../features/informatica-button/content.js', import.meta.url), 'utf8'), fresh);
 assert.equal(fresh.__snInfController.active, false, 'inert while new settings controller is not ready');
 assert.equal(p.main.g.__snInfController, undefined);
 p.button().click(); assert.equal(old.lastRun, null, 'old button remains interlocked across reload');
 start(); p.button().click(); assert.equal(fresh.__snInfController.lastRun.status, 'running');
 assert.equal(old.lastRun, null); assert.equal(p.isolated.g.__snInfMaintenance.owner, 'reload');
 assert.equal(fresh.__snInfMaintenance.owner, null, 'fresh world has an independent interlock');
});
test('late document_idle controller inherits reservation acquired in an empty world', () => {
 const p = createInformaticaPage();
 vm.runInContext(`(${maintenanceInDocument.toString()})('acquire','early')`, p.isolated.g);
 p.load(); p.button().click(); assert.equal(p.controller().lastRun, null);
 p.controller().releaseMaintenance('wrong'); p.button().click(); assert.equal(p.controller().lastRun, null);
 p.controller().releaseMaintenance('early'); p.button().click(); assert.equal(p.controller().lastRun.status, 'running');
});
test('timed-out injection retains exclusion until actual late completion, then releases', async () => {
 const p = createInformaticaPage().load(); const b = browser(p); const execute = b.chrome.scripting.executeScript;
 let finish;
 b.chrome.scripting.executeScript = i => i.files ? new Promise(resolve => { finish = async () => resolve(await execute(i)); }) : execute(i);
 const s = await reinjectOpenTabs({...b, origins, policy, stepTimeoutMs:10});
 assert.equal(s.failed, 1); assert.match(s.tabs[0].errors.join(' '), /maintenance held/);
 p.button().click(); assert.equal(p.controller().lastRun, null, 'timeout must not unlock before late takeover');
 await finish(); await new Promise(resolve => setImmediate(resolve));
 p.button().click(); assert.equal(p.controller().lastRun.status, 'running', 'late completion releases inherited lock');
});
