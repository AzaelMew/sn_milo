import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const modulePath=new URL('../../features/timecard/native-actions.js',import.meta.url);
// Exact g_form.submit implementation read from the user's failed native form.
const nativeSubmit=`function(actionName) {
 actionName = actionName || 'sysverb_update';
 var action = gel(actionName);
 if (!action) action = this._getLinkActionByAttribute(actionName);
 if (action) return gsftSubmit(action);
}`;
function fixture({existingHeader=false,loading=false,allowed=true}={}){
 const nodes=[];const callbacks={};const submitted=[];
 function element(id){const props=new Map([['display',{value:'flex',priority:''}]]);return {id,hidden:false,attributes:{onclick:'return gsftSubmit(this);',value:'sysverb_insert'},style:{setProperty(k,value,priority=''){props.set(k,{value,priority});},getPropertyValue(k){return props.get(k)?.value||'';},getPropertyPriority(k){return props.get(k)?.priority||'';}},setAttribute(k,v){this.attributes[k]=String(v);},getAttribute(k){return this.attributes[k]??null;},cloneNode(){return element(this.id);}};}
 const parent={insertBefore(node,before){assert.equal(before,bottom);node.parentNode=parent;nodes.push(node);}};
 const bottom=element('sysverb_insert_bottom');bottom.parentNode=parent;nodes.push(bottom);
 if(existingHeader){const header=element('sysverb_insert');nodes.push(header);}
 const document={readyState:loading?'loading':'complete',getElementById:id=>document.readyState==='loading'?null:nodes.find(n=>n.id===id)||null,addEventListener:(name,callback)=>{callbacks[name]=callback;},createElement:()=>element(''),head:{appendChild(node){nodes.push(node);}}};
 const window={top:{}};
 const context=vm.createContext({window,document,location:{origin:'https://test.example',pathname:'/task_time_worked.do'},SnTimecardCore:{isAllowedOrigin:()=>allowed},SnTimecardConfig:{},gel:id=>document.getElementById(id),gsftSubmit:action=>{submitted.push(action);return 'native-submit';}});
 const submit=vm.runInContext('('+nativeSubmit+')',context);
 function load(){const source=fs.existsSync(modulePath)?fs.readFileSync(modulePath,'utf8'):'';vm.runInContext(source,context);}
 return {document,nodes,bottom,submitted,callbacks,load,submit:()=>submit.call({_getLinkActionByAttribute:()=>null},'sysverb_insert')};
}
test('native asynchronous invoice callback can resume through its canonical insert action',()=>{
 const f=fixture();f.load();assert.equal(f.submit(),'native-submit');assert.equal(f.submitted.length,1);const canonical=f.document.getElementById('sysverb_insert');assert.equal(canonical.hidden,true);assert.equal(canonical.attributes.onclick,f.bottom.attributes.onclick);assert.equal(canonical.attributes.value,'sysverb_insert');
});
test('document-start installation waits until the native footer has been parsed',()=>{
 const f=fixture({loading:true});f.load();assert.equal(f.submitted.length,0);assert.equal(typeof f.callbacks.DOMContentLoaded,'function');f.document.readyState='complete';f.callbacks.DOMContentLoaded();assert.equal(f.submit(),'native-submit');
});
test('restoring the action never submits automatically or creates duplicate actions',()=>{
 const f=fixture();f.load();f.load();assert.equal(f.submitted.length,0);assert.equal(f.nodes.filter(n=>n.id==='sysverb_insert').length,1);
});
test('an existing native header action is preserved unchanged',()=>{
 const f=fixture({existingHeader:true});const original=f.document.getElementById('sysverb_insert');f.load();assert.equal(f.document.getElementById('sysverb_insert'),original);assert.equal(original.hidden,false);assert.equal(f.nodes.length,2);assert.equal(f.submitted.length,0);
});
test('untrusted frame origins are left untouched',()=>{
 const f=fixture({allowed:false});f.load();assert.equal(f.document.getElementById('sysverb_insert'),null);assert.equal(f.submitted.length,0);
});
test('the compatibility action is forcibly hidden while remaining available to native submission',()=>{
 const f=fixture();f.load();const canonical=f.document.getElementById('sysverb_insert');assert.equal(canonical.style.getPropertyValue('display'),'none');assert.equal(canonical.style.getPropertyPriority('display'),'important');assert.equal(canonical.getAttribute('data-sn-timecard-native-action'),'alias');const style=f.document.getElementById('sn-timecard-native-action-style');assert.ok(style);assert.match(style.textContent,/display:\s*none\s*!important/);assert.equal(f.bottom.style.getPropertyValue('display'),'flex');assert.equal(f.submit(),'native-submit');assert.equal(f.submitted.length,1);
});
test('an already-open legacy clone is hidden in place without replacement or automatic submission',()=>{
 const f=fixture();const old=f.bottom.cloneNode(true);old.id='sysverb_insert';old.hidden=true;old.setAttribute('aria-hidden','true');old.setAttribute('tabindex','-1');f.bottom.parentNode.insertBefore(old,f.bottom);f.load();assert.equal(f.document.getElementById('sysverb_insert'),old);assert.equal(old.style.getPropertyValue('display'),'none');assert.equal(old.style.getPropertyPriority('display'),'important');assert.equal(f.submitted.length,0);assert.equal(f.nodes.filter(n=>n.id==='sysverb_insert').length,1);
});
