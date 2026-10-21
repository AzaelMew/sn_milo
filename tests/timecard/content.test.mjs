import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fixture} from './dom-fixture.mjs';
test('mounts one Add timecard button beside native Record Time',()=>{
 const f=fixture();f.load();const buttons=f.doc.querySelectorAll('button').filter(b=>b.textContent==='Add timecard');assert.equal(buttons.length,1);assert.equal(buttons[0].getAttribute('type'),'button');assert.equal(buttons[0].parentNode,f.action.parentNode);
});
test('mounts as soon as the native button renders, without waiting for the poll',()=>{
 const f=fixture();
 f.action.remove();
 const app=f.load();
 assert.equal(f.doc.querySelector('#sn-timecard-add'),null);
 f.doc.body.append(f.action);
 for(const observer of f.window.__observers)observer.cb([]);
 f.flush();
 const buttons=f.doc.querySelectorAll('button').filter(b=>b.textContent==='Add timecard');
 assert.equal(buttons.length,1);
});
test('copies the native button computed theme instead of the built-in style',()=>{
 const f=fixture();f.load();
 const button=f.doc.querySelectorAll('button').find(b=>b.textContent==='Add timecard');
 assert.equal(button.style.fontSize,'12px');
 assert.equal(button.style.color,'rgb(23, 43, 77)');
 assert.equal(button.style.backgroundColor,'rgb(244, 245, 247)');
 assert.equal(button.style.border,'1px solid rgb(223, 225, 230)');
 assert.equal(button.style.borderRadius,'4px');
});
test('falls back to the built-in style when computed theme is unavailable',()=>{
 const f=fixture('test',{theme:false});f.load();
 const button=f.doc.querySelectorAll('button').find(b=>b.textContent==='Add timecard');
 assert.match(String(button.style.cssText),/#6552b8/);
});
test('matches a native button label containing extra whitespace',()=>{
 const f=fixture();
 f.action.innerText='Record\n  Time';f.action.textContent='Record\n  Time';
 f.load();
 const buttons=f.doc.querySelectorAll('button').filter(b=>b.textContent==='Add timecard');
 assert.equal(buttons.length,1);
});
test('opens exactly one same-origin native form overlay on an enabled test instance',()=>{
 const f=fixture();const app=f.load();assert.equal(typeof app.open,'function');app.open();app.open();const overlays=f.doc.querySelectorAll('*').filter(e=>e.id==='sn-timecard-overlay');assert.equal(overlays.length,1);const frames=overlays[0].shadowRoot.querySelectorAll('iframe');assert.equal(frames.length,1);assert.equal(frames[0].src,'https://instance.example/task_time_worked.do?sys_id=-1');assert.match(frames[0].getAttribute('sandbox'),/allow-forms/);assert.doesNotMatch(frames[0].getAttribute('sandbox'),/allow-top-navigation/);app.close();assert.equal(f.doc.querySelector('#sn-timecard-overlay'),null);
});
test('an explicitly disabled instance never creates a writable native form',()=>{
 const f=fixture('production');const app=f.load();app.open();const overlay=f.doc.querySelector('#sn-timecard-overlay');assert.ok(overlay);assert.equal(overlay.shadowRoot.querySelectorAll('iframe').length,0);assert.ok(overlay.shadowRoot.querySelectorAll('*').some(e=>e.textContent.includes('Time-entry submissions are disabled for this instance')));
});
test('rejects a missing native form URL without creating an iframe',()=>{
 const f=fixture();f.context.SnTimecardCore.nativeFormUrl=()=>null;const app=f.load();app.open();assert.equal(f.doc.querySelector('#sn-timecard-overlay'),null);
});
test('reinjection preserves an open native form instead of discarding its draft',()=>{
 const f=fixture();const first=f.load();first.open();const original=f.doc.querySelector('#sn-timecard-overlay');f.load();assert.equal(Boolean(original.isConnected),true);assert.equal(f.window.__snTimecardApp,first);assert.equal(f.doc.querySelectorAll('*').filter(e=>e.id==='sn-timecard-overlay').length,1);
});
test('reinjection replaces a locked notice after the instance is enabled',()=>{
 const f=fixture('production');const first=f.load();first.open();f.context.SnTimecardCore.writesAllowed=()=>true;f.context.SnTimecardConfig.instances[0].enableSubmission=true;const updated=f.load();assert.equal(updated!==first,true);assert.equal(Boolean(f.doc.querySelector('#sn-timecard-overlay')),false);updated.open();assert.equal(f.doc.querySelector('#sn-timecard-overlay').shadowRoot.querySelectorAll('iframe').length,1);
});
test('real core opens the native form for explicitly enabled production without any automatic request',()=>{
 const f=fixture('production');f.context.SnTimecardConfig.instances[0].enableSubmission=true;vm.runInContext(fs.readFileSync(new URL('../../features/timecard/core.js',import.meta.url),'utf8'),f.context);let requests=0;f.context.fetch=()=>{requests++;throw new Error('No automatic network request expected');};f.load().open();const frame=f.doc.querySelector('#sn-timecard-overlay').shadowRoot.querySelector('iframe');assert.equal(Boolean(frame),true);assert.equal(new URL(frame.src).origin,f.window.location.origin);assert.equal(requests,0);
});
test('overlay closes itself once the frame leaves the new-record form after a submit',()=>{
 const f=fixture();const app=f.load();app.open();
 const iframe=f.doc.querySelector('#sn-timecard-overlay').shadowRoot.querySelector('iframe');
 // Initial form load keeps the overlay open.
 iframe.contentWindow={location:{href:'https://instance.example/task_time_worked.do?sys_id=-1&sysparm_view=csm'}};
 iframe.listeners.load();
 assert.ok(f.doc.querySelector('#sn-timecard-overlay'));
 // ServiceNow redirects to the created record after a successful insert.
 iframe.contentWindow={location:{href:'https://instance.example/task_time_worked.do?sys_id='+'c'.repeat(32)}};
 iframe.listeners.load();
 assert.equal(f.doc.querySelector('#sn-timecard-overlay'),null);
});
test('overlay closes itself when the frame lands on welcome.do after a submit',()=>{
 const f=fixture();const app=f.load();app.open();
 const iframe=f.doc.querySelector('#sn-timecard-overlay').shadowRoot.querySelector('iframe');
 iframe.contentWindow={location:{href:'https://instance.example/welcome.do'}};
 iframe.listeners.load();
 assert.equal(f.doc.querySelector('#sn-timecard-overlay'),null);
});
