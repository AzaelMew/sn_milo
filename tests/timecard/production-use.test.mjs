import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const core=createRequire(import.meta.url)('../../features/timecard/core.js');
test('explicit production permission enables user use without weakening origin checks',()=>{
 const origin='https://production.example';
 const config={instances:[{origin,mode:'production',enableSubmission:true}]};
 assert.equal(core.writesAllowed(origin,config),true);
 assert.equal(core.writesAllowed('https://production.example.evil.invalid',config),false);
 assert.equal(core.writesAllowed(origin,{instances:[{origin,mode:'production',enableSubmission:false}]}),false);
 assert.equal(core.writesAllowed(origin,{instances:[{origin,mode:'production'}],enableSubmission:true}),false);
});
test('both shipped configuration copies enable approved manual production use',()=>{
 const local=JSON.parse(readFileSync(new URL('../../config.json',import.meta.url),'utf8'));
 const browser={};vm.runInNewContext(readFileSync(new URL('../../features/timecard/config.js',import.meta.url),'utf8'),browser);
 for(const config of [local,browser.SnTimecardConfig]){
  const prod=config.instances.find(i=>i.mode==='production');
  assert.equal(prod.mode,'production');
  assert.equal(core.writesAllowed(prod.origin,config),true);
  const testInstance=config.instances.find(i=>i.mode==='test');
  assert.ok(testInstance);
  assert.equal(core.writesAllowed(testInstance.origin,config),true);
 }
});
