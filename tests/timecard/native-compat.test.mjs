import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=new URL('../../features/timecard/native-compat.js',import.meta.url);
function setup(existing){const window={top:{},g_form:existing};const context=vm.createContext({window,location:{origin:'https://test.example',pathname:'/task_time_worked.do'},SnTimecardCore:{isAllowedOrigin:()=>true},SnTimecardConfig:{}});assert.ok(fs.existsSync(source),'native compatibility module must exist');vm.runInContext(fs.readFileSync(source,'utf8'),context);return window;}
test('adds only the missing placeholder API before native g_form onLoad handlers run',()=>{
 const w=setup();const control={placeholder:''};const g={getControl:n=>n==='comments'?control:null};w.g_form=g;assert.equal(w.g_form,g);assert.equal(typeof g.setFieldPlaceholder,'function');g.setFieldPlaceholder('comments','Safe field help');assert.equal(control.placeholder,'Safe field help');assert.doesNotThrow(()=>g.setFieldPlaceholder('absent','Text'));
});
