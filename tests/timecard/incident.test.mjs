import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const core=createRequire(import.meta.url)('../../features/timecard/core.js');
const id='0d3f0baf2be34b10ba8ef157b891bf32';
const prod='https://example.service-now.com';
const instance='https://exampletest.service-now.com';
const config={instances:[{origin:prod,mode:'production',enableSubmission:false},{origin:instance,mode:'test',enableSubmission:true}]};
test('recognizes Incident record routes in Classic and Workspace',()=>{
 for(const url of [
  `${prod}/now/nav/ui/classic/params/target/incident.do%3Fsys_id%3D${id}`,
  `${instance}/incident.do?sys_id=${id}`,
  `${instance}/now/cwf/agent/record/incident/${id}`,
 ])assert.deepEqual(core.parseCaseUrl(url),{table:'incident',sysId:id});
});
test('builds a Time Worked URL linked to the Incident without enabling production submission',()=>{
 const url=core.nativeFormUrl(instance,{table:'incident',sysId:id},'0123456789abcdef0123456789abcdef',config);
 assert.equal(typeof url,'string');
 const parsed=new URL(url);
 assert.equal(parsed.origin,instance);
 assert.equal(parsed.pathname,'/task_time_worked.do');
 assert.equal(parsed.searchParams.get('sysparm_query'),'userDYNAMIC0123456789abcdef0123456789abcdef^taskDYNAMIC'+id);
 assert.equal(core.writesAllowed(prod,config),false);
});
test('recognizes Interaction record routes and builds a linked Time Worked URL',()=>{
 for(const url of [
  `${prod}/now/cwf/agent/record/interaction/${id}`,
  `${instance}/interaction.do?sys_id=${id}`,
 ])assert.deepEqual(core.parseCaseUrl(url),{table:'interaction',sysId:id});
 const url=core.nativeFormUrl(instance,{table:'interaction',sysId:id},'0123456789abcdef0123456789abcdef',config);
 assert.equal(new URL(url).searchParams.get('sysparm_query'),'userDYNAMIC0123456789abcdef0123456789abcdef^taskDYNAMIC'+id);
});
