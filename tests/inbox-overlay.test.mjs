import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {FEATURES, parsePreferences, computeEffective} from '../shared/features.mjs';
import {SCRIPT_POLICY, buildContentScripts} from '../shared/script-policy.mjs';
import {PACKAGE_FILES} from '../scripts/package.mjs';

test('native Inbox is a default-on configurable top-only isolated feature on both origins', () => {
  assert.deepEqual(FEATURES['inbox-overlay']?.origins, ['production', 'test']);
  assert.equal(computeEffective(parsePreferences(undefined).preferences)['inbox-overlay'].enabled, true);
  assert.equal(computeEffective(parsePreferences({'inbox-overlay': false}).preferences)['inbox-overlay'].enabled, false);
  const entries = SCRIPT_POLICY.filter(e => e.feature === 'inbox-overlay');
  assert.deepEqual(buildContentScripts({production:'https://example.com',test:'https://test.example.com'}, entries), [{
    matches:['https://example.com/*','https://test.example.com/*'], js:['features/inbox-overlay/content.js'],
    run_at:'document_idle',world:'ISOLATED',all_frames:false
  }]);
  assert.ok(PACKAGE_FILES.includes('features/inbox-overlay/content.js'));
});

class Element {
  constructor(tag, doc) {
    this.localName=tag; this.ownerDocument=doc; this.children=[]; this.attrs={}; this.listeners={};
    this.style={setProperty(k,v){this[k]=v;},getPropertyValue(k){return typeof this[k]==='string'?this[k]:'';},getPropertyPriority(){return '';},removeProperty(k){delete this[k];}}; this.hidden=false;
  }
  append(...nodes) { for(const node of nodes){node.parentNode=this; this.children.push(node);} this.ownerDocument.queue?.(); }
  attachShadow() { this.shadowRoot=new Element('#shadow',this.ownerDocument); this.shadowRoot.host=this; return this.shadowRoot; }
  setAttribute(k,v){this.attrs[k]=String(v);}
  getAttribute(k){return this.attrs[k]??null;}
  removeAttribute(k){delete this.attrs[k];}
  addEventListener(k,f){(this.listeners[k]??=new Set()).add(f);}
  removeEventListener(k,f){this.listeners[k]?.delete(f);}
  fire(k,event={}){for(const f of this.listeners[k]||[])f(event);}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null;}
  getRootNode(){return this.parentNode?this.parentNode.getRootNode():this;}
  querySelector(selector){const c=selector.startsWith('.')?selector.slice(1):null;
    const walk=n=>{for(const k of n.children){if(c&&(k.attrs.class||'').split(/\s+/).includes(c))return k;const f=walk(k);if(f)return f;}return null;};return walk(this);}
  querySelectorAll(selector){return this.children.flatMap(n=>[...(selector==='*'||n.localName===selector?[n]:[]),...n.querySelectorAll(selector)]);}
  getBoundingClientRect(){return this.rect??{width:this.hidden?0:240,height:this.hidden?0:500};}
  focus(){this.ownerDocument.activeElement=this;}
  click(){this.fire('click');}
}
function doc(){
  const d={createElement(tag){return new Element(tag,d);},createElementNS(ns,tag){const e=new Element(tag,d);e.namespaceURI=ns;return e;}};
  d.documentElement=new Element('html',d);d.body=new Element('body',d);d.documentElement.append(d.body);
  d.querySelectorAll=s=>[...(s==='*'?[d.documentElement]:[]),...d.documentElement.querySelectorAll(s)];
  d.observers=new Set();let pending=false;
  d.queue=()=>{pending=true;};d.flush=()=>{if(!pending)return;pending=false;for(const o of [...d.observers])o.cb([],o);};
  class MutationObserver{constructor(cb){this.cb=cb;}observe(target,opts){this.target=target;this.opts=opts;d.observers.add(this);}disconnect(){d.observers.delete(this);}}
  d.defaultView={MutationObserver,getComputedStyle:n=>({display:n.hidden?'none':'block',visibility:n.style.visibility||d.documentElement.style.visibility||'visible'})};
  return d;
}
function page({nested=false,path='/now/platform-analytics-workspace',noSettings=false}={}){
  const document=doc(), intervals=new Map(), timeouts=new Map();let id=0, handlers, subscriptions=0;
  const window=new Element('window',document);window.top=nested?{}:window;
  const context=vm.createContext({document,window,location:{origin:'https://example.com',pathname:path},URL,
    setInterval:f=>{intervals.set(++id,f);return id;},clearInterval:i=>intervals.delete(i),
    setTimeout:f=>{timeouts.set(++id,f);return id;},clearTimeout:i=>timeouts.delete(i),
    __snMiloController:{subscribe(feature,h){assert.equal(feature,'inbox-overlay');handlers=h;subscriptions++;return()=>{subscriptions--;};}}});
  const run=()=>vm.runInContext(fs.readFileSync(new URL('../features/inbox-overlay/content.js',import.meta.url),'utf8'),context);
  if(noSettings)delete context.__snMiloController;
  run();
  const nodes=()=>document.body.children.flatMap(n=>[n,...(n.shadowRoot?.querySelectorAll('*')||[])]);
  return {context,document,window,run,nodes,intervals,timeouts,get subscriptions(){return subscriptions;},
    enable:()=>handlers.start(),disable:()=>handlers.stop('disabled'),tick:()=>{for(const f of [...intervals.values()])f();}};
}
test('Inbox preloads one same-origin frame on enable, stays collapsed, and reuses it on click and collapse',()=>{
  const p=page(); assert.equal(p.nodes().length,0);p.enable();
  const frames=()=>p.nodes().filter(n=>n.localName==='iframe');
  const button=p.nodes().find(n=>n.getAttribute('aria-expanded')!==null);assert.ok(button);
  assert.equal(button.getAttribute('aria-expanded'),'false');assert.equal(frames().length,1);
  const frame=frames()[0];
  assert.equal(frame.src,'https://example.com/now/cwf/agent/inbox');assert.equal(frame.name,'sn-milo-native-inbox');
  assert.equal(p.nodes().find(n=>n.localName==='section').hidden,true);assert.equal(p.intervals.size,1);
  button.fire('click');assert.equal(frames().length,1);assert.equal(frames()[0],frame);
  assert.equal(button.getAttribute('aria-expanded'),'true');button.fire('click');
  assert.equal(button.getAttribute('aria-expanded'),'false');assert.ok(frame.parentNode);
  button.fire('click');assert.equal(frames().length,1);assert.equal(frames()[0],frame);
});
function open(p){p.enable();p.nodes().find(n=>n.getAttribute('aria-expanded')!==null).fire('click');return p.nodes().find(n=>n.localName==='iframe');}
test('isolates only the visible native Inbox through nested open shadows without moving it or hiding style assets',()=>{
  const p=page(),frame=open(p),d=doc();frame.contentDocument=d;
  const shell=d.createElement('sn-shell');d.body.append(shell);const root=shell.attachShadow();
  const hidden=d.createElement('sn-agent-inbox');hidden.hidden=true;root.append(hidden);
  const container=d.createElement('div');container.rect={width:0,height:0};root.append(container);
  const sidebar=d.createElement('sn-canvas-sidebar');container.append(sidebar);const sr=sidebar.attachShadow();
  const inbox=d.createElement('sn-agent-inbox');inbox.rect={width:240,height:500,x:0,y:-239};sr.append(inbox);
  const assets=d.createElement('style');root.append(assets);
  frame.fire('load');p.tick();
  assert.equal(d.documentElement.style.visibility,'hidden');assert.equal(inbox.style.visibility,'visible');
  assert.equal(inbox.style.position,'fixed');assert.equal(inbox.style.width,'100vw');assert.equal(inbox.style.height,'100vh');
  assert.equal(container.style.display,'block');assert.equal(container.style.transform,'none');assert.equal(container.style.contain,'none');
  assert.equal(hidden.style.visibility,undefined);assert.equal(assets.style.display,undefined);assert.equal(inbox.parentNode,sr);
});
test('reinjection retains native frame; disabling tears down resources and re-enabling immediately preloads again, collapsed',()=>{
  const p=page({path:'/nav_to.do'}),frame=open(p);p.run();
  assert.equal(p.subscriptions,1);assert.equal(p.nodes().find(n=>n.localName==='iframe'),frame);
  p.disable();assert.equal(p.nodes().length,0);assert.equal(p.intervals.size,0);assert.equal(p.timeouts.size,0);
  p.enable();const again=p.nodes().filter(n=>n.localName==='iframe');assert.equal(again.length,1);assert.notEqual(again[0],frame);
  assert.equal(p.nodes().find(n=>n.getAttribute('aria-expanded')!==null).getAttribute('aria-expanded'),'false');
  open(p);p.context.__snMiloInboxOverlay.stop('invalidated');
  assert.equal(p.subscriptions,0);assert.equal(p.nodes().length,0);assert.equal(p.intervals.size,0);
});
test('embedded workspace cannot recursively subscribe or create another panel',()=>{
  const p=page({nested:true});assert.equal(p.subscriptions,0);assert.equal(p.nodes().length,0);
});
test('loading timeout and blocked embedding offer the native link without exposing the full shell',()=>{
  const p=page(),frame=open(p);
  const status=p.nodes().find(n=>n.getAttribute('role')==='status');assert.match(status?.textContent||'',/Loading/);
  assert.equal(frame.style.opacity,'0');assert.equal(frame.style.pointerEvents,'none');
  assert.equal(frame.inert,true);
  for(const f of [...p.timeouts.values()])f();assert.match(status.textContent,/could not|unavailable/i);
  const link=p.nodes().find(n=>n.localName==='a');assert.equal(link.href,'https://example.com/now/cwf/agent/inbox');assert.match(link.rel,/noopener/);
  Object.defineProperty(frame,'contentDocument',{get(){throw new Error('cross-origin redirect');}});
  assert.doesNotThrow(()=>frame.fire('load'));assert.doesNotThrow(()=>p.tick());
  assert.equal(frame.style.opacity,'0');assert.match(status.textContent,/could not|unavailable/i);
  frame.fire('error');assert.match(status.textContent,/could not|unavailable/i);
});
test('a delayed native Inbox recovers after timeout and load navigation masks the shell again',()=>{
  const p=page(),frame=open(p);for(const f of [...p.timeouts.values()])f();
  const d=doc(),inbox=d.createElement('sn-agent-inbox');d.body.append(inbox);frame.contentDocument=d;p.tick();
  const status=p.nodes().find(n=>n.getAttribute('role')==='status');
  assert.equal(status.hidden,true);assert.equal(frame.style.opacity,'1');assert.equal(frame.style.pointerEvents,'auto');
  assert.equal(frame.inert,false);
  frame.contentDocument=doc();frame.fire('load');assert.equal(frame.style.opacity,'0');assert.equal(status.hidden,false);
});
test('native re-render replaces the selected Inbox without selecting a visibility-hidden duplicate',()=>{
  const p=page(),frame=open(p),d=doc();frame.contentDocument=d;
  const hidden=d.createElement('sn-agent-inbox');hidden.style.visibility='hidden';d.body.append(hidden);
  const first=d.createElement('sn-agent-inbox');d.body.append(first);frame.fire('load');
  assert.equal(first.style.position,'fixed');first.remove();
  const next=d.createElement('sn-agent-inbox');d.body.append(next);p.tick();
  assert.equal(next.style.position,'fixed');assert.equal(hidden.style.position,undefined);assert.equal(d.documentElement.style.visibility,'hidden');
});
test('retired callbacks cannot resurrect UI and missing settings do not install a takeover blocker',()=>{
  const missing=page({noSettings:true});assert.equal(missing.context.__snMiloInboxOverlay,undefined);
  const p=page();p.enable();p.context.__snMiloInboxOverlay.stop();p.enable();
  assert.equal(p.nodes().length,0);assert.equal(p.intervals.size,0);
});
test('native hiding the previous Inbox selects its visible replacement',()=>{
  const p=page(),frame=open(p),d=doc();frame.contentDocument=d;
  const first=d.createElement('sn-agent-inbox');d.body.append(first);frame.fire('load');first.style.visibility='hidden';
  const next=d.createElement('sn-agent-inbox');d.body.append(next);p.tick();assert.equal(next.style.position,'fixed');
});

function popObs(d){return [...d.observers].filter(o=>o.target===d.documentElement).length;}
function rule(css,selector){
  const m=css.match(new RegExp('(?:^|})\\s*'+selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*{([^}]*)}'));
  assert.ok(m,'missing rule '+selector);return m[1];
}
test('launcher is independently anchored bottom-right 12px and never moves on expand/collapse',()=>{
  const p=page();p.enable();
  const css=p.nodes().find(n=>n.localName==='style').textContent;
  const host=rule(css,':host'),btn=rule(css,'button.launcher'),panel=rule(css,'section');
  assert.match(host,/width:0/);assert.match(host,/height:0/);
  assert.match(btn,/position:fixed/);assert.match(btn,/bottom:12px/);assert.match(btn,/right:12px/);
  assert.doesNotMatch(btn+rule(css,'button.launcher:hover')+rule(css,'button.launcher:focus-visible'),/transform|scale|translate|margin|top:|left:/);
  assert.match(panel,/position:fixed/);assert.match(panel,/right:12px/);assert.match(panel,/bottom:6\dpx|bottom:calc\(/);
  assert.doesNotMatch(host,/bottom:76px|right:20px/);
  const button=p.nodes().find(n=>n.getAttribute('aria-expanded')!==null);
  assert.ok(button.getAttribute('class')==='launcher'||button.className==='launcher');
  const before=css;button.fire('click');button.fire('click');
  assert.equal(p.nodes().find(n=>n.localName==='style').textContent,before);
});
test('launcher has dark purple accent, hover and focus styles, and decorative SVG inbox icon with text label',()=>{
  const p=page();p.enable();
  const css=p.nodes().find(n=>n.localName==='style').textContent;
  assert.match(rule(css,'button.launcher'),/background:#[2-5][0-9a-f][0-3][0-9a-f][6-9a-f][0-9a-f]/i);
  assert.match(css,/button\.launcher:hover/);assert.match(css,/button\.launcher:focus-visible/);
  const button=p.nodes().find(n=>n.getAttribute('aria-expanded')!==null);
  const svg=button.children.find(n=>n.localName==='svg');assert.ok(svg);
  assert.equal(svg.namespaceURI,'http://www.w3.org/2000/svg');
  assert.equal(svg.getAttribute('aria-hidden'),'true');assert.equal(svg.getAttribute('focusable'),'false');
  assert.ok(svg.children.some(n=>n.localName==='path'));
  const label=button.children.find(n=>n.localName==='span');assert.equal(label.textContent,'Inbox');
});
test('narrow native layout: sole hidden zero-size Inbox is forced to render, never cloned or moved',()=>{
  const p=page(),frame=open(p),d=doc();frame.contentDocument=d;
  const shell=d.createElement('sn-shell');d.body.append(shell);const root=shell.attachShadow();
  const inbox=d.createElement('sn-agent-inbox');inbox.rect={width:0,height:0};inbox.style.visibility='hidden';root.append(inbox);
  const empty=d.createElement('sn-agent-inbox-empty');root.append(empty);
  frame.fire('load');p.tick();
  assert.equal(inbox.style.display,'block');assert.equal(inbox.style.visibility,'visible');assert.equal(inbox.style.position,'fixed');
  assert.equal(inbox.style.width,'100vw');assert.equal(inbox.style.height,'100vh');assert.equal(inbox.parentNode,root);
  assert.equal(d.documentElement.style.visibility,'hidden');assert.equal(frame.style.opacity,'1');
  assert.equal(root.querySelectorAll('sn-agent-inbox').length,1);
});
test('hidden fallback prefers a visible candidate, else the last duplicate',()=>{
  const p=page(),frame=open(p),d=doc();frame.contentDocument=d;
  const a=d.createElement('sn-agent-inbox'),b=d.createElement('sn-agent-inbox');
  for(const n of [a,b]){n.rect={width:0,height:0};n.style.visibility='hidden';d.body.append(n);}
  frame.fire('load');assert.equal(b.style.position,'fixed');assert.equal(a.style.position,undefined);
  const v=d.createElement('sn-agent-inbox');d.body.append(v);p.tick();
  assert.equal(v.style.position,'fixed');assert.equal(v.style.display,'block');
});

const ID='vx0001',SEL=`sn-presence-popover-content[component-id="${ID}"]`;
function nativeWithPresence(d,id=ID,tag='sn-presence-popover-content'){
  const inbox=d.createElement('sn-agent-inbox');d.body.append(inbox);const sr=inbox.attachShadow();
  const inner=d.createElement('div');sr.append(inner);const src=d.createElement(tag);src.setAttribute('component-id',id);inner.append(src);
  return inbox;
}
function popover(d,target,{attach=true}={}){
  const panel=d.createElement('now-popover-panel'),hoist=d.createElement('seismic-hoist');
  hoist.setAttribute('target-for',target);hoist.setAttribute('slot','content');panel.append(hoist);if(attach)d.body.append(panel);return panel;
}
function inboxPage(){const p=page(),frame=open(p),d=doc();frame.contentDocument=d;return {p,frame,d};}
test('late hoisted presence popover is raised immediately by the observer, not the 1s scan',()=>{
  const {p,frame,d}=inboxPage();nativeWithPresence(d);frame.fire('load');
  assert.equal(popObs(d),1);
  const panel=popover(d,SEL);const ticksBefore=p.intervals.size;
  d.flush();
  assert.equal(panel.style.visibility,'visible');assert.equal(panel.style.position,'relative');assert.equal(panel.style['z-index'],'2147483647');
  assert.equal(p.intervals.size,ticksBefore);
  for(const k of ['top','left','width','height','transform','inset'])assert.equal(panel.style[k],undefined,k);
});
test('popover is above the native fixed Inbox (same max z, later in DOM)',()=>{
  const {frame,d}=inboxPage();const inbox=nativeWithPresence(d);frame.fire('load');
  const panel=popover(d,SEL);d.flush();
  assert.equal(inbox.style['z-index'],panel.style['z-index']);
  assert.ok(d.body.children.indexOf(panel)>d.body.children.indexOf(inbox));
});
test('native alert settings popup owned by the Inbox is handled too, via any owned component',()=>{
  const {frame,d}=inboxPage();nativeWithPresence(d);
  const inbox=d.body.children[0];const x=d.createElement('sn-alert-settings-popover-content');x.setAttribute('component-id','vx0002');inbox.shadowRoot.append(x);
  frame.fire('load');const panel=popover(d,'sn-alert-settings-popover-content[component-id="vx0002"]');d.flush();
  assert.equal(panel.style.visibility,'visible');
});
test('unrelated shell popovers and look-alike ids stay untouched',()=>{
  const {frame,d}=inboxPage();nativeWithPresence(d);frame.fire('load');
  const other=popover(d,'sn-presence-popover-content[component-id="vx9999"]');
  const wrongTag=popover(d,`sn-other-content[component-id="${ID}"]`);
  const none=d.createElement('now-popover-panel');d.body.append(none);
  const mixed=popover(d,SEL);const extra=d.createElement('seismic-hoist');extra.setAttribute('target-for','sn-x[component-id="vx9999"]');mixed.append(extra);
  const outside=d.createElement('sn-presence-popover-content');outside.setAttribute('component-id','vx7777');d.body.append(outside);
  const shellPanel=popover(d,'sn-presence-popover-content[component-id="vx7777"]');
  d.flush();
  for(const n of [other,wrongTag,none,mixed,shellPanel])assert.equal(n.style.visibility,undefined);
  const p2=popover(d,SEL);d.flush();assert.equal(p2.style.visibility,'visible');
});
test('popover already present when the Inbox is selected is handled by scan, and nested hoists count',()=>{
  const {p,frame,d}=inboxPage();nativeWithPresence(d);
  const panel=d.createElement('now-popover-panel'),wrap=d.createElement('div'),hoist=d.createElement('seismic-hoist');
  hoist.setAttribute('target-for',SEL);wrap.append(hoist);panel.append(wrap);d.body.append(panel);
  frame.fire('load');assert.equal(panel.style.visibility,'visible');
});
test('cleanup: observer disconnects and inline styles are restored on reload, disable and panel pre-existing values',()=>{
  const {p,frame,d}=inboxPage();nativeWithPresence(d);frame.fire('load');
  const panel=popover(d,SEL);panel.style.setProperty('z-index','5');d.flush();
  assert.equal(panel.style['z-index'],'2147483647');
  frame.contentDocument=doc();frame.fire('load');
  assert.equal(popObs(d),0);assert.equal(panel.style['z-index'],'5');assert.equal(panel.style.visibility,undefined);assert.equal(panel.style.position,undefined);
  const q=inboxPage();nativeWithPresence(q.d);q.frame.fire('load');const pp=popover(q.d,SEL);q.d.flush();
  assert.equal(popObs(q.d),1);q.p.disable();
  assert.equal(q.d.observers.size,0);assert.equal(pp.style.visibility,undefined);assert.equal(pp.style['z-index'],undefined);
  q.p.enable();assert.equal(q.d.observers.size,0);
});
test('stop() via invalidation also disconnects the observer and restores popovers',()=>{
  const {p,frame,d}=inboxPage();nativeWithPresence(d);frame.fire('load');const panel=popover(d,SEL);d.flush();
  p.context.__snMiloInboxOverlay.stop('invalidated');assert.equal(d.observers.size,0);assert.equal(panel.style.visibility,undefined);
});
test('observer callbacks after cleanup cannot restyle popovers',()=>{
  const {p,frame,d}=inboxPage();nativeWithPresence(d);frame.fire('load');const cb=[...d.observers].find(o=>o.target===d.documentElement).cb;
  p.disable();const panel=popover(d,SEL);cb([],{});assert.equal(panel.style.visibility,undefined);
});
test('live shapes: presence (…1412) and notification-setting (…1415) refs are both owned and raised',()=>{
  const {frame,d}=inboxPage();const inbox=nativeWithPresence(d,'vx1412');
  const n=d.createElement('notification-setting-popover-content');n.setAttribute('component-id','vx1415');inbox.shadowRoot.append(n);
  frame.fire('load');
  const a=popover(d,'sn-presence-popover-content[component-id="vx1412"]'),b=popover(d,'notification-setting-popover-content[component-id="vx1415"]');
  d.flush();for(const x of [a,b])assert.equal(x.style.visibility,'visible');
});

// ---- Native Inbox red-dot indicator. SIMULATION: detached fixture using the literal native markup
// <span class="now-a11y-label test-announce-work-items" aria-live="polite">N work items in Inbox</span>.
// Nothing here touches a live browser, the live count or any audio.
function nativeCount(d,text){
  const inbox=d.createElement('sn-agent-inbox');d.body.append(inbox);const sr=inbox.attachShadow();
  const wrap=d.createElement('div');sr.append(wrap);
  const label=d.createElement('span');label.setAttribute('class','now-a11y-label test-announce-work-items');
  label.setAttribute('aria-live','polite');label.textContent=text;wrap.append(label);
  return {inbox,sr,wrap,label};
}
const setText=(d,label,t)=>{label.textContent=t;d.queue();d.flush();};
const launcher=p=>p.nodes().find(n=>n.getAttribute('aria-expanded')!==null);
const dot=p=>p.nodes().find(n=>n.getAttribute('class')==='dot');
function counted(text='0 work items in Inbox'){const {p,frame,d}=inboxPage();const n=nativeCount(d,text);frame.fire('load');return {p,frame,d,...n};}
test('red dot: 0 -> 1 -> 3 -> 0 follows the native count immediately via observer, without the 1s scan',()=>{
  const {p,d,label}=counted();const b=launcher(p),r=dot(p);assert.ok(r);
  assert.equal(r.hidden,true);assert.equal(b.getAttribute('aria-label'),null);
  setText(d,label,'1 work item in Inbox');
  assert.equal(r.hidden,false);assert.equal(b.getAttribute('aria-label'),'Inbox, 1 work item');
  setText(d,label,'3 work items in Inbox');
  assert.equal(r.hidden,false);assert.equal(b.getAttribute('aria-label'),'Inbox, 3 work items');
  setText(d,label,'0 work items in Inbox');
  assert.equal(r.hidden,true);assert.equal(b.getAttribute('aria-label'),null);
});
test('red dot: initial count already present shows on selection; visible text, expansion and iframe identity unchanged',()=>{
  const {p,frame}=counted('2 work items in Inbox');const b=launcher(p);
  assert.equal(dot(p).hidden,false);assert.equal(b.getAttribute('aria-label'),'Inbox, 2 work items');
  assert.equal(b.children.find(n=>n.localName==='span'&&n.textContent==='Inbox').textContent,'Inbox');
  assert.equal(b.getAttribute('aria-expanded'),'true');b.fire('click');
  assert.equal(b.getAttribute('aria-expanded'),'false');assert.equal(dot(p).hidden,false);assert.equal(p.nodes().filter(n=>n.localName==='iframe')[0],frame);
  b.fire('click');assert.equal(b.getAttribute('aria-expanded'),'true');assert.equal(p.nodes().filter(n=>n.localName==='iframe').length,1);
});
test('red dot: malformed, partial, negative or unrelated text never shows a dot and clears a stale one',()=>{
  const {p,d,label}=counted('4 work items in Inbox');const r=dot(p),b=launcher(p);assert.equal(r.hidden,false);
  for(const bad of ['','Inbox','work items in Inbox','-1 work items in Inbox','1.5 work items in Inbox','3 work items in Outbox',
    '3 work items in Inbox extra','x3 work items in Inbox','1 work itemz in Inbox','NaN work items in Inbox']){
    setText(d,label,'4 work items in Inbox');assert.equal(r.hidden,false,'precondition');
    setText(d,label,bad);assert.equal(r.hidden,true,JSON.stringify(bad));assert.equal(b.getAttribute('aria-label'),null,bad);
  }
  setText(d,label,'  5 Work Items in inbox \n');assert.equal(r.hidden,false);assert.equal(b.getAttribute('aria-label'),'Inbox, 5 work items');
});
test('red dot: only the selected Inbox own shadow-root label counts; unrelated shell labels and light DOM are ignored',()=>{
  const {p,frame,d}=inboxPage();
  const shell=d.createElement('sn-shell');d.body.append(shell);const sr=shell.attachShadow();
  const stray=d.createElement('span');stray.setAttribute('class','now-a11y-label test-announce-work-items');stray.textContent='9 work items in Inbox';sr.append(stray);
  const inbox=d.createElement('sn-agent-inbox');sr.append(inbox);const isr=inbox.attachShadow();
  frame.fire('load');p.tick();assert.equal(dot(p).hidden,true);
  const own=d.createElement('span');own.setAttribute('class','test-announce-work-items');own.textContent='1 work item in Inbox';isr.append(own);d.flush();
  assert.equal(dot(p).hidden,false);
});
test('red dot: label appearing later or being replaced inside the shadow root is picked up by the observer',()=>{
  const {p,d,sr,wrap,label}=counted('2 work items in Inbox');assert.equal(dot(p).hidden,false);
  label.remove();d.queue();d.flush();assert.equal(dot(p).hidden,true,'no label -> unknown');
  const again=d.createElement('span');again.setAttribute('class','test-announce-work-items');again.textContent='7 work items in Inbox';wrap.append(again);d.flush();
  assert.equal(dot(p).hidden,false);assert.equal(launcher(p).getAttribute('aria-label'),'Inbox, 7 work items');
  const obs=[...d.observers].find(o=>o.target===sr);assert.ok(obs);
  assert.deepEqual({c:obs.opts.childList,s:obs.opts.subtree,d:obs.opts.characterData},{c:true,s:true,d:true});
});
test('red dot: native Inbox replacement reconnects the observer; old shadow root is disconnected and cannot update',()=>{
  const {p,d,inbox,sr,label}=counted('2 work items in Inbox');
  inbox.remove();const next=nativeCount(d,'0 work items in Inbox');p.tick();
  assert.equal(dot(p).hidden,true);assert.equal([...d.observers].filter(o=>o.target===sr).length,0);
  setText(d,label,'8 work items in Inbox');assert.equal(dot(p).hidden,true,'stale old label ignored');
  setText(d,next.label,'1 work item in Inbox');assert.equal(dot(p).hidden,false);
});
test('red dot: removed Inbox with no replacement hides the stale dot; reload and failure also clear it',()=>{
  const a=counted('2 work items in Inbox');a.inbox.remove();a.p.tick();assert.equal(dot(a.p).hidden,true);assert.equal(launcher(a.p).getAttribute('aria-label'),null);
  const b=counted('2 work items in Inbox');b.frame.contentDocument=doc();b.frame.fire('load');
  assert.equal(dot(b.p).hidden,true);assert.equal(b.d.observers.size,0);
  const c=counted('2 work items in Inbox');c.frame.fire('error');
  assert.equal(dot(c.p).hidden,true);
});
test('red dot: the 1s scan also syncs when a change was not observed',()=>{
  const {p,label}=counted('0 work items in Inbox');label.textContent='3 work items in Inbox';p.tick();
  assert.equal(dot(p).hidden,false);
});
test('red dot: disable/stop disconnect the count observer and late callbacks cannot touch anything',()=>{
  const {p,d,sr,label}=counted('2 work items in Inbox');const cb=[...d.observers].find(o=>o.target===sr).cb;
  p.disable();assert.equal(d.observers.size,0);assert.doesNotThrow(()=>cb([],{}));
  p.enable();assert.equal(dot(p).hidden,true);assert.equal(launcher(p).getAttribute('aria-label'),null);
  const q=counted('2 work items in Inbox');q.p.context.__snMiloInboxOverlay.stop('invalidated');assert.equal(q.d.observers.size,0);
});
test('red dot: small red circle on the fixed pill upper-right, out of flow, with no bounds-affecting styles and no audio/status/storage',()=>{
  const p=page();p.enable();const css=p.nodes().find(n=>n.localName==='style').textContent;
  const r=rule(css,'button.launcher .dot');
  assert.match(r,/position:absolute/);assert.match(r,/border-radius:50%/);assert.match(r,/background:#[ef][0-9a-f]{2}[0-4][0-9a-f]{2}|background:red/i);
  assert.match(r,/width:8px/);assert.match(r,/height:8px/);assert.match(r,/border:\d+px solid/);assert.match(r,/pointer-events:none/);
  assert.match(r,/top:-?\d+px/);assert.match(r,/right:-?\d+px/);
  assert.match(css,/button\.launcher \.dot\[hidden\]\{display:none\}/);
  const btn=rule(css,'button.launcher');assert.match(btn,/position:fixed/);assert.match(btn,/bottom:12px/);assert.match(btn,/right:12px/);assert.match(btn,/height:40px/);
  assert.doesNotMatch(btn,/width:|overflow|margin|transform/);
  const d=dot(p);assert.equal(d.getAttribute('aria-hidden'),'true');assert.equal(d.textContent??'','');
  assert.ok(launcher(p).children.includes(d));assert.equal(launcher(p).children.find(n=>n.localName==='span'&&n.textContent==='Inbox').textContent,'Inbox');
  const src=fs.readFileSync(new URL('../features/inbox-overlay/content.js',import.meta.url),'utf8');
  assert.doesNotMatch(src,/\bAudio\b|new Audio|AudioContext|\.play\(|Notification|localStorage|sessionStorage|chrome\.storage|fetch\(|XMLHttpRequest|sendMessage/);
});

// Simulation of the native document's inline frame-buster guard (markup-derived, no live data).
const NATIVE_FRAME_BUSTER = `var inAiuxFrame=false;try{inAiuxFrame=window!=window.top&&window.top.location.pathname.startsWith('/aiux/ui')}catch(e){}
if(!inAiuxFrame&&window&&(window!=window.top)&&(frameElement&&frameElement.id!='testFrame')){const res=window.top.frameBusterRouteChangeWithoutRedirect?window.top.frameBusterRouteChangeWithoutRedirect(window.__initialRoutePayload):false;if(res&&typeof res.then==='function'){res.then(function(ok){if(!ok)window.top.location.href=window.location.href;}).catch(function(){window.top.location.href=window.location.href;});}}`;
function runFrameBuster(frameElement){
  const top={location:{pathname:'/now/nav/ui/classic',href:'https://example.com/top'},routeCalls:0,
    frameBusterRouteChangeWithoutRedirect(){top.routeCalls++;return false;}};
  const win={top,location:{href:'https://example.com/now/cwf/agent/inbox'},__initialRoutePayload:{}};
  vm.runInContext(NATIVE_FRAME_BUSTER,vm.createContext({window:win,frameElement}));
  return top;
}
test('extension frame carries the native embedding exemption id before it loads, so the parent router is not invoked',()=>{
  const p=page(), idAtSrc=[];
  const create=p.document.createElement;
  p.document.createElement=tag=>{const e=create(tag);
    if(tag==='iframe'){let src;Object.defineProperty(e,'src',{get:()=>src,set:v=>{idAtSrc.push(e.id);src=v;}});}
    return e;};
  p.enable();
  const frame=p.nodes().find(n=>n.localName==='iframe');
  assert.deepEqual(idAtSrc,['testFrame']);
  assert.equal(frame.id,'testFrame');
  assert.equal(frame.name,'sn-milo-native-inbox');
  assert.equal(frame.getAttribute('data-sn-milo-native-inbox'),'');
  const top=runFrameBuster(frame);
  assert.equal(top.routeCalls,0);
  assert.equal(top.location.href,'https://example.com/top');
});
test('positive control: an ordinary embedded frame still triggers the native frame-buster route call',()=>{
  const top=runFrameBuster({id:'other-frame'});
  assert.equal(top.routeCalls,1);
});


// ---- Native presence bubble. SIMULATION: detached fixtures with the verified markup
// (sn-agent-presence-state > shadow > button#presenceBar[aria-label="Agent presence state: X"] > span.status;
// sn-presence-popover-content > shadow > ul[role=listbox][aria-label="Status Options"] > li[role=option][title][selected]).
// No live status is touched; the native trigger is never needed.
const STATUSES=['Available','Busy','WrapUp','Away','Offline'];
function optionList(d,host,{names=STATUSES,current='Offline',label='Status Options'}={},f){
  const sr=host.shadowRoot??host.attachShadow();const ul=d.createElement('ul');ul.setAttribute('role','listbox');ul.setAttribute('aria-label',label);
  for(const s of names){const li=d.createElement('li');li.setAttribute('role','option');li.setAttribute('title',s);
    li.setAttribute('aria-label',`${s}, selectable presence state, agent in this state is able to receive work items`);
    if(s===current)li.setAttribute('selected','');li.addEventListener('click',()=>f?.clicks.push(s));ul.append(li);}
  sr.append(ul);return ul;
}
function presented(name='Offline',{statusText=name}={}){
  const {p,frame,d}=inboxPage();const n=nativeCount(d,'0 work items in Inbox');
  const comp=d.createElement('sn-agent-presence-state');n.wrap.append(comp);const csr=comp.attachShadow();
  const bar=d.createElement('button');bar.id='presenceBar';bar.setAttribute('aria-haspopup','listbox');
  bar.setAttribute('aria-label',`Agent presence state: ${name}`);const span=d.createElement('span');span.setAttribute('class','status');span.textContent=statusText;
  bar.append(span);csr.append(bar);
  const src=d.createElement('sn-presence-popover-content');src.setAttribute('component-id',ID);n.wrap.append(src);
  const f={p,frame,d,...n,comp,csr,bar,span,src,clicks:[],barClicks:0};
  f.ul=optionList(d,src,{current:name},f);
  bar.addEventListener('click',()=>f.barClicks++);
  frame.fire('load');return f;
}
const bubble=p=>p.nodes().find(n=>n.getAttribute('class')==='presence');
const menuOf=p=>p.nodes().find(n=>n.getAttribute('role')==='menu');
const items=p=>p.nodes().filter(n=>n.getAttribute('role')==='menuitemradio');
const lab=n=>n.children[1].textContent;
const notes=p=>p.nodes().filter(n=>n.getAttribute('role')==='status').map(n=>n.textContent).join(' ');
const setState=(f,name)=>{f.bar.setAttribute('aria-label',`Agent presence state: ${name}`);f.span.textContent=name;
  for(const li of f.ul.children){if(li.getAttribute('title')===name)li.setAttribute('selected','');else li.removeAttribute('selected');}f.d.queue();f.d.flush();};
const pstate=p=>bubble(p).getAttribute('data-state');

test('presence bubble is an independent sibling of the Inbox launcher, not nested, and starts grey/unknown before a native state exists',()=>{
  const p=page();p.enable();const b=bubble(p),l=launcher(p);assert.ok(b);assert.notEqual(b,l);
  assert.equal(b.localName,'button');assert.ok(!l.children.includes(b));assert.equal(b.parentNode,l.parentNode);
  assert.equal(pstate(p),'grey');assert.match(b.getAttribute('title'),/unknown/i);
});
test('presence colors follow the native state immediately: green Available/Online, red Offline, yellow Busy/Away/WrapUp, tooltip + aria-label name it',()=>{
  const f=presented('Offline');assert.equal(pstate(f.p),'red');assert.equal(bubble(f.p).getAttribute('title'),'Offline');assert.match(bubble(f.p).getAttribute('aria-label'),/Offline/);
  for(const [n,c] of [['Available','green'],['Online','green'],['Busy','yellow'],['Away','yellow'],['WrapUp','yellow'],['Offline','red']]){
    setState(f,n);assert.equal(pstate(f.p),c,n);assert.equal(bubble(f.p).getAttribute('title'),n);assert.match(bubble(f.p).getAttribute('aria-label'),new RegExp(n));
  }
});
test('presence: unrecognised, malformed or contradictory native state is grey (never red/green) and clears a stale color',()=>{
  const f=presented('Available');assert.equal(pstate(f.p),'green');
  for(const bad of ['Do Not Disturb','Offlinex','']){setState(f,'Available');assert.equal(pstate(f.p),'green');setState(f,bad);assert.equal(pstate(f.p),'grey',bad);}
  setState(f,'Available');f.bar.removeAttribute('aria-label');f.d.queue();f.d.flush();assert.equal(pstate(f.p),'grey');
  setState(f,'Offline');f.span.textContent='Available';f.d.queue();f.d.flush();assert.equal(pstate(f.p),'grey','label/status text disagree');
  setState(f,'Offline');f.bar.setAttribute('aria-label','Something else: Offline');f.d.queue();f.d.flush();assert.equal(pstate(f.p),'grey');
});
test('presence: removed Inbox, reload and load failure clear the color; replaced presence component reconnects and the old root is disconnected',()=>{
  const a=presented('Offline');a.inbox.remove();a.p.tick();assert.equal(pstate(a.p),'grey');
  const b=presented('Offline');b.frame.contentDocument=doc();b.frame.fire('load');assert.equal(pstate(b.p),'grey');
  const c=presented('Offline');c.frame.fire('error');assert.equal(pstate(c.p),'grey');
  const e=presented('Offline');const old=e.csr;e.comp.remove();e.d.queue();e.d.flush();e.p.tick();assert.equal(pstate(e.p),'grey');
  assert.equal([...e.d.observers].filter(o=>o.target===old).length,0);
  const comp2=e.d.createElement('sn-agent-presence-state');e.wrap.append(comp2);const csr2=comp2.attachShadow();
  const bar2=e.d.createElement('button');bar2.id='presenceBar';bar2.setAttribute('aria-label','Agent presence state: Busy');csr2.append(bar2);e.d.flush();
  assert.equal(pstate(e.p),'yellow');
  bar2.setAttribute('aria-label','Agent presence state: Available');e.d.queue();e.d.flush();assert.equal(pstate(e.p),'green');
  e.bar.setAttribute('aria-label','Agent presence state: Offline');e.d.queue();e.d.flush();assert.equal(pstate(e.p),'green','stale old component ignored');
});
test('presence: 1s scan also syncs an unobserved change',()=>{const f=presented('Offline');f.bar.setAttribute('aria-label','Agent presence state: Busy');f.span.textContent='Busy';f.p.tick();assert.equal(pstate(f.p),'yellow');});
test('presence: only the selected Inbox own presence component counts; shell-level lookalikes are ignored',()=>{
  const {p,frame,d}=inboxPage();const shell=d.createElement('sn-shell');d.body.append(shell);const sr=shell.attachShadow();
  const comp=d.createElement('sn-agent-presence-state');sr.append(comp);const csr=comp.attachShadow();const bar=d.createElement('button');bar.id='presenceBar';
  bar.setAttribute('aria-label','Agent presence state: Offline');csr.append(bar);
  const inbox=d.createElement('sn-agent-inbox');sr.append(inbox);inbox.attachShadow();frame.fire('load');p.tick();assert.equal(pstate(p),'grey');
});

test('opening the bubble only reads: compact menu lists the real native options, marks the selected one, clicks nothing and keeps the Inbox collapsed',()=>{
  const f=presented('Offline');const b=bubble(f.p);const dotBefore=dot(f.p).hidden;launcher(f.p).fire('click');assert.equal(launcher(f.p).getAttribute('aria-expanded'),'false');
  assert.equal(menuOf(f.p).hidden,true);b.fire('click');
  assert.equal(f.barClicks,0);assert.deepEqual(f.clicks,[]);
  assert.equal(menuOf(f.p).hidden,false);assert.equal(b.getAttribute('aria-expanded'),'true');
  assert.deepEqual(items(f.p).map(lab),STATUSES);
  assert.deepEqual(items(f.p).map(n=>n.getAttribute('aria-checked')),['false','false','false','false','true']);
  assert.equal(launcher(f.p).getAttribute('aria-expanded'),'false');
  assert.equal(pstate(f.p),'red');assert.equal(dot(f.p).hidden,dotBefore);
  assert.equal(f.p.nodes().filter(n=>n.localName==='iframe').length,1);assert.equal(f.p.timeouts.size,0,'menu adds no timers');
  setState(f,'Busy');assert.equal(items(f.p).find(n=>n.getAttribute('aria-checked')==='true').children[1].textContent,'Busy','open menu follows native');
});
test('menu mirrors only the selected Inbox presence source: foreign components, other owned popups and other listboxes are excluded',()=>{
  const f=presented('Offline');
  const shellSrc=f.d.createElement('sn-presence-popover-content');f.d.body.append(shellSrc);optionList(f.d,shellSrc,{names:['Hacker']},f);
  const alert=f.d.createElement('sn-alert-settings-popover-content');f.inbox.shadowRoot.append(alert);optionList(f.d,alert,{names:['Mute']},f);
  optionList(f.d,f.src,{names:['Sneaky'],label:'Other Options'},f);
  bubble(f.p).fire('click');assert.deepEqual(items(f.p).map(lab),STATUSES);
});
test('explicit menu choice clicks the matching native option exactly once; no optimistic indicator; read back from native',()=>{
  const f=presented('Offline');const b=bubble(f.p);b.fire('click');
  const busy=items(f.p).find(n=>lab(n)==='Busy');busy.fire('click');busy.fire('click');
  assert.deepEqual(f.clicks,['Busy']);assert.equal(f.barClicks,0);assert.equal(pstate(f.p),'red','still native state');
  assert.equal(menuOf(f.p).hidden,true);assert.equal(b.getAttribute('aria-expanded'),'false');
  setState(f,'Busy');assert.equal(pstate(f.p),'yellow');
  setState(f,'Offline');assert.equal(pstate(f.p),'red','native reverts => indicator follows native');
  assert.deepEqual(f.clicks,['Busy']);
});
test('choosing the current status sends no native click; closing by toggle or Escape clicks nothing',()=>{
  const f=presented('Offline');const b=bubble(f.p);b.fire('click');items(f.p).find(n=>lab(n)==='Offline').fire('click');
  assert.deepEqual(f.clicks,[]);assert.equal(menuOf(f.p).hidden,true);
  b.fire('click');b.fire('click');assert.equal(menuOf(f.p).hidden,true);
  b.fire('click');menuOf(f.p).fire('keydown',{key:'Escape',preventDefault(){}});assert.equal(menuOf(f.p).hidden,true);
  assert.deepEqual(f.clicks,[]);assert.equal(f.barClicks,0);
});
test('a vanished native option is never guessed: no click, menu says so',()=>{
  const f=presented('Offline');bubble(f.p).fire('click');const busy=items(f.p).find(n=>lab(n)==='Busy');
  f.ul.children.find(li=>li.getAttribute('title')==='Busy').remove();f.d.queue();f.d.flush();busy.fire('click');
  assert.deepEqual(f.clicks,[]);assert.match(notes(f.p),/no longer|unavailable/i);
});
test('unknown presence / no native list: bubble menu explains and clicks nothing',()=>{
  const p=page();p.enable();bubble(p).fire('click');assert.equal(items(p).length,0);assert.match(notes(p),/unavailable|unknown/i);
  const f=presented('Offline');f.src.remove();f.p.tick();bubble(f.p).fire('click');assert.equal(items(f.p).length,0);assert.match(notes(f.p),/unavailable/i);
});
test('presence cleanup: disable/stop/reload disconnect observers, timers and document listeners; late callbacks do nothing',()=>{
  const adds=[],rems=[];
  const f=presented('Offline');f.p.document.addEventListener=(k,fn)=>adds.push([k,fn]);f.p.document.removeEventListener=(k,fn)=>rems.push([k,fn]);
  const cb=[...f.d.observers].find(o=>o.target===f.csr).cb;
  bubble(f.p).fire('click');assert.ok(adds.length>0);
  f.p.disable();assert.equal(f.d.observers.size,0);assert.equal(f.p.timeouts.size,0);assert.equal(f.p.intervals.size,0);
  assert.equal(adds.length,rems.length);assert.doesNotThrow(()=>cb([],{}));assert.deepEqual(f.clicks,[]);
  f.p.enable();assert.equal(pstate(f.p),'grey');
  const g=presented('Offline');g.p.context.__snMiloInboxOverlay.stop('invalidated');assert.equal(g.d.observers.size,0);
  const h=presented('Offline');bubble(h.p).fire('click');h.frame.contentDocument=doc();h.frame.fire('load');assert.equal(menuOf(h.p).hidden,true);assert.equal(h.d.observers.size,0);
});
test('presence geometry: fixed bottom-right beside Inbox, launcher bounds/CSS untouched, nothing moves on state change or menu open',()=>{
  const f=presented('Offline');const css=f.p.nodes().find(n=>n.localName==='style').textContent;
  const pr=rule(css,'button.presence'),lr=rule(css,'button.launcher');
  for(const m of [/position:fixed/,/bottom:12px/,/right:\d+px/,/width:40px/,/height:40px/,/border-radius:50%/])assert.match(pr,m);
  assert.doesNotMatch(pr+rule(css,'button.presence:hover')+rule(css,'button.presence:focus-visible'),/transform|scale|translate|margin|top:|left:/);
  assert.match(lr,/bottom:12px/);assert.match(lr,/right:12px/);assert.doesNotMatch(lr,/width:/);
  assert.match(rule(css,'button.presence[data-state="green"] .orb'),/background:#[0-5]/i);
  assert.match(rule(css,'button.presence[data-state="red"] .orb'),/background:#e/i);
  assert.match(rule(css,'button.presence[data-state="yellow"] .orb'),/background:#f/i);
  const menuRule=rule(css,'.menu');assert.match(menuRule,/position:fixed/);assert.match(menuRule,/bottom:\d+px/);
  const l=launcher(f.p);l.rect={width:100,height:40};f.p.tick();
  assert.equal(bubble(f.p).style.right,'120px');
  const snap=JSON.stringify([l.rect,l.style]);bubble(f.p).fire('click');setState(f,'Busy');items(f.p)[0].fire('click');assert.equal(JSON.stringify([l.rect,l.style]),snap);
  assert.equal(f.p.nodes().find(n=>n.localName==='style').textContent,css);
  assert.ok(bubble(f.p).parentNode===l.parentNode);
});
test('presence source is read/click only: no storage, network, audio, event synthesis or native trigger',()=>{
  const src=fs.readFileSync(new URL('../features/inbox-overlay/content.js',import.meta.url),'utf8');
  assert.doesNotMatch(src,/\bAudio\b|new Audio|\.play\(|Notification|localStorage|sessionStorage|chrome\.|fetch\(|XMLHttpRequest|sendMessage|\.dispatchEvent\(|new (Mouse|Pointer|Keyboard)?Event\(|presenceBar\S*\.click|bar\.click/);
});
