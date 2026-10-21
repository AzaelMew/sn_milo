import test from 'node:test';
import assert from 'node:assert/strict';
import {createMiloBackground} from '../shared/router.mjs';
import {createFakeChrome, createFakeStorage} from './helpers/fake-chrome.mjs';
import {createInformaticaPage, EMAILS} from './helpers/informatica-sim.mjs';
import {INFORMATICA_GATE_KEY} from '../shared/informatica-gate.mjs';
import {reserveInformatica, maintenanceInDocument} from '../shared/informatica-maintenance.mjs';
import vm from 'node:vm';
const origins = {production:'https://prod.service-now.com',test:'https://test.service-now.com'};
const flush = async () => { for (let i=0;i<12;i++) await new Promise(r=>setImmediate(r)); };
function fixture(storage = createFakeStorage({'inf.recipientsV1': {schema: 1, emails: [...EMAILS]}})) {
 const {chrome} = createFakeChrome({storage});
 const app = createMiloBackground({chrome,origins}); app.install();
 function page(tab=1, documentId='old') {
  const p = createInformaticaPage();
  const sender = {id:chrome.runtime.id,tab:{id:tab,url:origins.production+'/now/record'},url:origins.production+'/now/record',origin:origins.production,documentId,frameId:0,documentLifecycle:'active'};
  p.isolated.g.chrome = {runtime:{sendMessage:(m,cb)=>app.onMessage(m,sender,cb)}};
  p.load(); return p;
 }
 return {storage,chrome,app,page};
}
test('global gate denies real controller in a new tab and replacement document during inventory', async () => {
 const f=fixture(); await f.app.ensureReady();
 const old=f.page();
 await f.app.informaticaGate.acquire('update');
 f.chrome.tabs.query=async()=>{
  const newTab=f.page(2,'new-tab'); const navigation=f.page(1,'replacement');
  newTab.button().click(); navigation.button().click(); await flush();
  assert.equal(newTab.controller().lastRun.status,'failed');
  assert.equal(navigation.controller().lastRun.status,'failed');
  assert.deepEqual(newTab.ws.log,[]); assert.deepEqual(navigation.ws.log,[]);
  return [{id:1}];
 };
 f.chrome.scripting.executeScript=async i=>{ old.isolated.g.args=i.args;return [{result:vm.runInContext(`(${i.func.toString()})(...args)`,old.isolated.g)}]; };
 await reserveInformatica(f.chrome,origins,'update',maintenanceInDocument);
 assert.equal((await f.app.informaticaGate.status()).maintenance,'update');
});
test('lease is persisted before workflow writes; existing run refuses maintenance across worker restart', async () => {
 const f=fixture(); await f.app.ensureReady(); const p=f.page();p.button().click();await flush();
 assert.equal(Object.keys(f.storage.dump()[INFORMATICA_GATE_KEY].leases).length,1);
 await assert.rejects(f.app.informaticaGate.acquire('update'),/in-progress/);
 const replacement=fixture(f.storage); await replacement.app.ensureReady();
 await assert.rejects(replacement.app.informaticaGate.acquire('update'),/in-progress/);
 assert.equal(p.controller().lastRun.status,'running');
 await p.clock.until(()=>p.controller().lastRun.status==='saved');await flush();
 assert.equal(Object.keys(f.storage.dump()[INFORMATICA_GATE_KEY].leases).length,0);
 await replacement.app.informaticaGate.acquire('update');
});
test('persisted update marker denies starts in separate new world after worker replacement until completion',async()=>{
 const old=fixture();await old.app.ensureReady();await old.app.informaticaGate.acquire('owner');
 const fresh=fixture(old.storage);await fresh.app.ensureReady();const p=fresh.page(1,'fresh-world');
 assert.equal(p.isolated.g.__snInfMaintenance.owner,null);
 p.button().click();await flush();assert.deepEqual(p.ws.log,[]);assert.equal(p.controller().lastRun.status,'failed');
 await assert.rejects(fresh.app.informaticaGate.release('wrong'),/owner-mismatch/);
 await fresh.app.informaticaGate.release('owner');p.button().click();await flush();
 assert.equal(p.controller().lastRun.status,'running');
});
test('new tab while acquisition persistence is pending cannot slip past the serialized gate',async()=>{
 const f=fixture();await f.app.ensureReady();
 let persist;const set=f.storage.local.set;
 f.storage.local.set=items=>items[INFORMATICA_GATE_KEY] ? new Promise(resolve=>{persist=()=>set(items).then(resolve);}) : set(items);
 const acquisition=f.app.informaticaGate.acquire('owner');await flush();
 const p=f.page(20,'during-acquisition');p.button().click();await flush();assert.deepEqual(p.ws.log,[]);
 await persist();await acquisition;await flush();assert.deepEqual(p.ws.log,[]);assert.equal(p.controller().lastRun.status,'failed');
});
test('serialized start/acquire races choose exactly one winner',async()=>{
 const f=fixture();await f.app.ensureReady();
 const a=f.app.informaticaGate.acquire('owner');const b=f.app.informaticaGate.start('lease','doc');
 await a;assert.equal((await b).ok,false);await f.app.informaticaGate.release('owner');
 const c=f.app.informaticaGate.start('lease','doc');const d=f.app.informaticaGate.acquire('owner');
 assert.equal((await c).ok,true);await assert.rejects(d,/in-progress/);
 await f.app.informaticaGate.end('lease','wrong');await assert.rejects(f.app.informaticaGate.acquire('owner'),/in-progress/);
 await f.app.informaticaGate.end('lease','doc');await f.app.informaticaGate.acquire('owner');
});
test('storage failures authorize no writes; failed release and orphan lease retain fail-closed exclusion',async()=>{
 const f=fixture();await f.app.ensureReady();f.storage.ctl.failSet=items=>items[INFORMATICA_GATE_KEY]?'gate write failed':false;
 const p=f.page();p.button().click();await flush();assert.deepEqual(p.ws.log,[]);assert.equal(p.controller().lastRun.status,'failed');
 f.storage.ctl.failSet=null;await f.app.informaticaGate.acquire('owner');
 f.storage.ctl.failSet=true;await assert.rejects(f.app.informaticaGate.release('owner'),/failed/);
 f.storage.ctl.failSet=null;assert.equal((await f.app.informaticaGate.start('lease','doc')).ok,false);
 await f.app.informaticaGate.recoverAfterInspection();assert.equal((await f.app.informaticaGate.start('lease','doc')).ok,true);
});
