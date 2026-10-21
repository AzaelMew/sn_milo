import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const core=createRequire(import.meta.url)('../../features/timecard/core.js');
test('submission enablement follows each explicitly configured instance',()=>{
 const config={instances:[{origin:'https://test.example',mode:'test',enableSubmission:true},{origin:'https://disabled.example',mode:'test',enableSubmission:false},{origin:'https://production.example',mode:'production',enableSubmission:true}]};
 assert.equal(core.writesAllowed('https://test.example',config),true);
 assert.equal(core.writesAllowed('https://disabled.example',config),false);
 assert.equal(core.writesAllowed('https://production.example',config),true);
});
