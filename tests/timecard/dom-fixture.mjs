import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
// Mock-DOM fixture for features/timecard/content.js (extracted verbatim from the original content.test.mjs; Element
// stores one listener per event type). Milo addition: a MAIN settings stub (window.__snMiloMainSettings, same
// subscribe/get contract as shared/main-settings.js) so content.js can be driven enabled/disabled:
//   fixture(mode, {settings: true|false|'unknown'}) — default true: state known & enabled (the original tests'
//   behaviour); 'unknown': helper present but no state yet; 'disabled': known & disabled; false: helper absent.
//   f.settings.set(enabled) pushes a new state to subscribers; f.settings.subscribers() counts live callbacks.
const sourcePath=new URL('../../features/timecard/content.js',import.meta.url);
class Element {
 constructor(tag,doc){this.tagName=tag.toUpperCase();this.localName=tag;this.ownerDocument=doc;this.children=[];this.attributes={};this.listeners={};this.style={};this.isConnected=true;this.textContent='';this.parentNode=null;this.id='';}
 append(...children){for(const c of children){this.children.push(c);c.parentNode=this;c.isConnected=true;}}
 appendChild(c){this.append(c);return c;}
 insertBefore(c,b){const i=this.children.indexOf(b);if(i<0)this.append(c);else{this.children.splice(i,0,c);c.parentNode=this;c.isConnected=true;}}
 setAttribute(k,v){this.attributes[k]=String(v);if(k==='id')this.id=String(v);}
 getAttribute(k){return this.attributes[k]??null;}
 addEventListener(k,cb){this.listeners[k]=cb;}
 removeEventListener(k){delete this.listeners[k];}
 remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(c=>c!==this);this.isConnected=false;}
 getBoundingClientRect(){return {width:100,height:30};}
 getRootNode(){return this.ownerDocument;}
 attachShadow(){this.shadowRoot=new Element('shadow',this.ownerDocument);return this.shadowRoot;}
 querySelectorAll(selector){const all=[];function walk(e){for(const c of e.children){all.push(c);walk(c);}}walk(this);if(selector==='*')return all;if(selector.includes('iframe'))return all.filter(e=>e.localName==='iframe');return all.filter(e=>e.localName==='button'||e.getAttribute('role')==='button');}
 querySelector(selector){if(selector.startsWith('#'))return this.querySelectorAll('*').find(e=>e.id===selector.slice(1))||null;return this.querySelectorAll(selector)[0]||null;}
 focus(){this.focused=true;}
}
export function fixture(mode='test',opts={}){
 const richTheme={visibility:'visible',display:'block',fontFamily:'"Roboto", sans-serif',fontSize:'12px',fontWeight:'400',fontStyle:'normal',lineHeight:'20px',letterSpacing:'normal',textTransform:'none',color:'rgb(23, 43, 77)',backgroundColor:'rgb(244, 245, 247)',backgroundImage:'none',borderRadius:'4px',boxShadow:'none',borderTopWidth:'1px',borderTopStyle:'solid',borderTopColor:'rgb(223, 225, 230)',height:'32px'};
 const doc={createElement:tag=>new Element(tag,doc),defaultView:null,addEventListener(){},removeEventListener(){},documentElement:{},activeElement:null};doc.body=new Element('body',doc);doc.querySelectorAll=s=>doc.body.querySelectorAll(s);doc.querySelector=s=>doc.body.querySelector(s);doc.getElementById=id=>doc.querySelector('#'+id);
 const action=new Element('button',doc);action.textContent='Record Time';action.innerText='Record Time';doc.body.append(action);
 const timers=new Map();let serial=0;
 const window={document:doc,location:{origin:'https://instance.example',href:'https://instance.example/now/cwf/agent/record/sn_customerservice_case/'+'a'.repeat(32)},NOW:{user:{userID:'b'.repeat(32)}},innerWidth:1440,innerHeight:900,addEventListener(k,cb){(window.__listeners[k]??=new Set()).add(cb);},removeEventListener(k,cb){window.__listeners[k]?.delete(cb);},confirm:(...a)=>{window.__confirms.push(a);return window.__confirmAnswer;},__observers:[],__listeners:{},__confirms:[],__confirmAnswer:true};window.top=window;doc.defaultView=window;
 const subs=new Set();let state=null;
 const settings={set(enabled){state={enabled,seedOnly:false};for(const cb of [...subs])cb({...state});},subscribers:()=>subs.size};
 if(opts.settings!==false){
  if(opts.settings!=='unknown')state={enabled:opts.settings!=='disabled',seedOnly:false};
  window.__snMiloMainSettings={version:1,get:()=>state&&{...state},subscribe(feature,cb){assert.equal(feature,'timecard');subs.add(cb);if(state)cb({...state});return()=>{subs.delete(cb);};},stop(){}};
 }
 const core={isAllowedOrigin:()=>true,writesAllowed:()=>mode==='test',parseCaseUrl:()=>({table:'sn_customerservice_case',sysId:'a'.repeat(32)}),nativeFormUrl:()=> 'https://instance.example/task_time_worked.do?sys_id=-1'};
 const context=vm.createContext({window,document:doc,location:window.location,URL,URLSearchParams,console,SnTimecardCore:core,SnTimecardConfig:{instances:[{origin:'https://instance.example',mode,enableSubmission:mode==='test'}]},setInterval:cb=>{const id=++serial;timers.set(id,cb);return id;},clearInterval:id=>timers.delete(id),setTimeout:cb=>{const id=++serial;timers.set(id,cb);return id;},clearTimeout:id=>timers.delete(id),getComputedStyle:()=>opts.theme===false?{visibility:'visible',display:'block'}:richTheme,MutationObserver:class{constructor(cb){this.cb=cb;window.__observers.push(this)}observe(){}disconnect(){}}});
 return {doc,action,context,window,timers,settings,key(k){for(const cb of [...(window.__listeners.keydown||[])])cb({key:k,preventDefault(){}});},flush(){for(const cb of [...timers.values()])cb();},load(){assert.ok(fs.existsSync(sourcePath),'content script must exist');vm.runInContext(fs.readFileSync(sourcePath,'utf8'),context);return window.__snTimecardApp;}};
}

