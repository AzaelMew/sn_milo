(() => {
 'use strict';
 const core=globalThis.SnTimecardCore;
 const config=globalThis.SnTimecardConfig;
 if(window!==window.top||!core?.isAllowedOrigin(location.origin,config))return;
 // There are no extension API bindings in this controller. Keep an open
 // native form alive across updates so reinjection never discards a draft.
 // Milo: the overlay/launch UI is driven by the MAIN settings helper
 // (shared/main-settings.js, window.__snMiloMainSettings). Until it reports the
 // 'timecard' feature enabled this controller is inert (no polling, observers,
 // launch button or overlay). Disabling is draft-preserving: it removes the
 // launch UI and stops polling but retains an open form until the user closes it.
 // Native-form compatibility (native-compat.js/native-actions.js) is a separate
 // always-on entry and never depends on these settings.
 if(window.__snTimecardApp?.status?.().overlayOpen &&
    document.getElementById('sn-timecard-overlay')?.shadowRoot?.querySelector('iframe'))return;
 window.__snTimecardApp?.stop();
 let button=null;
 let nativeAnchor=null;
 let caseContext=null;
 const loadWatchToken={};
 const loadWatches=new Map();
 let stopped=false;
 let enabled=false;
 let timer=null;
 let unsubscribe=null;
 let overlay=null;
 let frame=null;
 function close(force=false){
  if(!overlay)return true;
  if(!force){try{if(frame?.contentWindow?.g_form?.modified&&!window.confirm('Discard the unsaved time entry?'))return false;}catch{/* inaccessible frame */}}
  overlay.remove();overlay=null;frame=null;button?.focus();return true;
 }
 function buildQuickPanel(){
  const quick=globalThis.SnTimecardQuickActions;
  const details=document.createElement('details');details.className='quick';
  const summary=document.createElement('summary');summary.textContent='Quick actions';
  details.append(summary);
  if(!quick){const note=document.createElement('p');note.className='quick-note';note.textContent='Quick-action storage is unavailable in this browser.';details.append(note);return details;}
  const list=document.createElement('div');list.className='quick-list';
  function renderList(){
   list.textContent='';
   const actions=quick.load();
   if(!actions.length){const empty=document.createElement('p');empty.className='quick-note';empty.textContent='No quick actions saved yet. Create one below — it appears under the Submit button in the form.';list.append(empty);return;}
   for(const action of actions){
    const row=document.createElement('div');row.className='quick-row';
    const label=document.createElement('span');label.className='quick-label';
    label.textContent=action.label+' — '+action.minutes+' min'+(action.workNotes?' · work notes':'')+(action.comment?' · “'+action.comment+'”':'');
    const removeButton=document.createElement('button');removeButton.type='button';removeButton.textContent='Delete';
    removeButton.addEventListener('click',()=>{quick.remove(action.id);renderList();});
    row.append(label,removeButton);list.append(row);
   }
  }
  const form=document.createElement('form');form.className='quick-form';
  const labelInput=document.createElement('input');labelInput.name='label';labelInput.placeholder='Label, e.g. Valvonta 15min';labelInput.maxLength=60;labelInput.required=true;
  const minutesInput=document.createElement('input');minutesInput.name='minutes';minutesInput.type='number';minutesInput.min='1';minutesInput.max='10080';minutesInput.value='15';minutesInput.title='Minutes';minutesInput.required=true;
  const commentInput=document.createElement('input');commentInput.name='comment';commentInput.placeholder='Comment (optional)';commentInput.maxLength=500;
  const workNotesLabel=document.createElement('label');const workNotesInput=document.createElement('input');workNotesInput.name='workNotes';workNotesInput.type='checkbox';workNotesLabel.append(workNotesInput,'Work notes');
  const saveButton=document.createElement('button');saveButton.type='submit';saveButton.textContent='Save quick action';
  form.append(labelInput,minutesInput,commentInput,workNotesLabel,saveButton);
  form.addEventListener('submit',(event)=>{
   event.preventDefault();
   const saved=quick.add({label:labelInput.value,minutes:Number(minutesInput.value),comment:commentInput.value,workNotes:workNotesInput.checked});
   if(!saved)return;
   form.reset();minutesInput.value='15';renderList();
  });
  renderList();details.append(list,form);
  return details;
 }
 function open(){
  if(stopped||!enabled||overlay)return;
  const context=core.parseCaseUrl(location.href);
  if(!context)return;
  const userId=window.NOW?.user?.userID||window.g_user?.userID;
  let formUrl;
  try{formUrl=core.nativeFormUrl(location.origin,context,userId,config);if(!formUrl)throw new Error('Case or signed-in user could not be identified');}catch(error){window.alert?.('Cannot open Time Worked: '+error.message);return;}
  overlay=document.createElement('div');overlay.id='sn-timecard-overlay';
  overlay.style.cssText='position:fixed;inset:0;z-index:2147483646;';
  const shadow=overlay.attachShadow({mode:'open'});
  const style=document.createElement('style');
  style.textContent=':host{font:14px system-ui,sans-serif;color:#e9edf5}*{box-sizing:border-box}.backdrop{position:absolute;inset:0;background:#080b16b8;display:flex;align-items:center;justify-content:center;padding:32px}.panel{display:flex;flex-direction:column;width:min(1200px,96vw);height:min(960px,90vh);background:#27313f;border:1px solid #81719e;border-radius:12px;overflow:hidden;box-shadow:0 24px 100px #0008}header{padding:18px 22px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #536075}h2{font-size:18px;margin:0}.subtitle{margin:5px 0 0;color:#bdc5d6;font-size:12px}.close{font:inherit;color:inherit;background:#374457;border:1px solid #66738b;border-radius:6px;padding:7px 14px;cursor:pointer}iframe{border:0;width:100%;flex:1;min-height:0;background:#27313f}details.quick{border-top:1px solid #536075;padding:10px 22px;font-size:13px}details.quick summary{cursor:pointer;color:#c5cedc;font-weight:600}details.quick .quick-note{color:#bdc5d6;font-size:12px;margin:8px 0}details.quick .quick-list{display:flex;flex-direction:column;gap:6px;margin:10px 0}details.quick .quick-row{display:flex;justify-content:space-between;align-items:center;gap:12px}details.quick .quick-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}details.quick form{display:flex;flex-wrap:wrap;gap:8px;align-items:center}details.quick input{font:inherit;font-size:12px;padding:6px 10px;border:1px solid #536075;border-radius:6px;background:#1d2532;color:#e9edf5}details.quick input[name=label]{flex:1;min-width:180px}details.quick input[name=minutes]{width:80px}details.quick input[name=comment]{flex:2;min-width:180px}details.quick label{display:inline-flex;gap:6px;align-items:center;color:#c5cedc}details.quick button{font:inherit;font-size:12px;padding:6px 12px;border:1px solid #66738b;border-radius:6px;background:#374457;color:#e9edf5;cursor:pointer}details.quick button[type=submit]{background:#6552b8;border-color:#b8aaff;color:#fff}footer{padding:12px 22px;font-size:12px;line-height:1.5;color:#c5cedc;border-top:1px solid #536075}.locked{padding:32px;font-size:16px;line-height:1.6}';
  const backdrop=document.createElement('div');backdrop.className='backdrop';
  const panel=document.createElement('section');panel.className='panel';panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby','sn-timecard-title');
  const header=document.createElement('header');const heading=document.createElement('div');const title=document.createElement('h2');title.id='sn-timecard-title';title.textContent='Add timecard';const subtitle=document.createElement('p');subtitle.className='subtitle';subtitle.textContent='Native Time Worked form · '+location.origin;
  const closeButton=document.createElement('button');closeButton.className='close';closeButton.setAttribute('type','button');closeButton.textContent='Close';closeButton.addEventListener('click',()=>close());
  heading.append(title,subtitle);header.append(heading,closeButton);panel.append(header);
  if(core.writesAllowed(location.origin,config)){
   frame=document.createElement('iframe');frame.id='sn-timecard-form';frame.title='Add timecard — ServiceNow Time Worked';frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms allow-modals allow-popups');frame.src=formUrl;
   // A successful Submit navigates the frame away from the new-record form
   // (to the created record or welcome.do); a failed validation stays put.
   frame.addEventListener('load',()=>{
    try{
     const url=new URL(frame.contentWindow.location.href);
     if(url.pathname==='/task_time_worked.do'&&url.searchParams.get('sys_id')==='-1')return;
     close(true);
    }catch{/* inaccessible frame */}
   });
   panel.append(frame);
  }else{
   const locked=document.createElement('p');locked.className='locked';locked.textContent='Time-entry submissions are disabled for this instance in the extension configuration. No writable form has been loaded.';panel.append(locked);
  }
  panel.append(buildQuickPanel());
  const footer=document.createElement('footer');footer.textContent='Use Submit inside the form to save. Nothing is saved merely by opening this overlay. Work notes avoid the case’s customer comment, but time-entry comments can still be visible in invoice reports.';panel.append(footer);
  backdrop.append(panel);shadow.append(style,backdrop);document.body.append(overlay);closeButton.focus();
 }
 function onKey(event){if(event.key==='Escape'&&overlay){event.preventDefault();close();}}
 window.addEventListener('keydown',onKey);
 function roots(){
  const result=[document];const seen=new Set();
  for(let i=0;i<result.length;i++){
   const root=result[i];if(seen.has(root))continue;seen.add(root);
   for(const el of root.querySelectorAll('*')){
    if(el.shadowRoot)result.push(el.shadowRoot);
    if(el.localName==='iframe'&&el.id==='gsft_main'){
     try{
      if(el.contentDocument)result.push(el.contentDocument);
      if(el.__snTimecardLoadWatch!==loadWatchToken){
       const listener=()=>{if(el.__snTimecardLoadWatch===loadWatchToken)scheduleRefresh();};
       el.__snTimecardLoadWatch=loadWatchToken;
       loadWatches.set(el,listener);
       el.addEventListener('load',listener);
      }
     }catch{/* inaccessible frame */}
    }
   }
  }
  return result;
 }
 const FALLBACK_BUTTON_STYLE='font:inherit;font-size:12px;line-height:20px;padding:2px 12px;margin:0 6px;border:1px solid #b8aaff;border-radius:4px;background:#6552b8;color:#fff;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;';
 // Mirror the native action button's computed theme so the injected button
 // blends into the Classic or Workspace skin instead of carrying its own.
 function styleButton(button,action){
  button.style.cssText=FALLBACK_BUTTON_STYLE;
  let computed=null;
  try{computed=getComputedStyle(action);}catch{/* no view */}
  if(!computed)return;
  const copy=['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','textTransform','color','backgroundColor','backgroundImage','borderRadius','boxShadow','height'];
  for(const prop of copy){
   const value=computed[prop];
   if(typeof value==='string'&&value&&value!=='none')button.style[prop]=value;
  }
  if(computed.borderTopStyle&&computed.borderTopStyle!=='none'){
   button.style.border=`${computed.borderTopWidth} ${computed.borderTopStyle} ${computed.borderTopColor}`;
  }
  button.style.margin='0 6px';
  button.style.whiteSpace='nowrap';
  button.style.cursor='pointer';
  button.style.display='inline-flex';
  button.style.alignItems='center';
 }
 function ensureHoverStyle(doc){
  if(doc.getElementById('sn-timecard-add-hover-style'))return;
  const style=doc.createElement('style');style.id='sn-timecard-add-hover-style';
  style.textContent='#sn-timecard-add:hover{filter:brightness(1.12)}';
  const parent=doc.head||doc.documentElement;
  if(parent&&typeof parent.appendChild==='function')parent.appendChild(style);
 }
 const observedRoots=new Set();
 let refreshTimer=null;
 function scheduleRefresh(){
  if(stopped||!enabled||refreshTimer!==null)return;
  refreshTimer=setTimeout(()=>{refreshTimer=null;if(!stopped&&enabled)refresh();},100);
 }
 const mutationObserver=typeof MutationObserver==='function'?new MutationObserver(scheduleRefresh):null;
 function watch(root){
  if(!mutationObserver||observedRoots.has(root))return;
  try{
   const target=root.nodeType===9?root.documentElement:root;
   if(!target)return;
   mutationObserver.observe(target,{childList:true,subtree:true,characterData:true});
   observedRoots.add(root);
  }catch{/* detached */}
 }
 function refresh(){
  if(stopped||!enabled)return;
  caseContext=core.parseCaseUrl(location.href);
  if(!caseContext){button?.remove();button=null;nativeAnchor=null;return;}
  let action=null;
  for(const root of roots()){
   watch(root);
   if(action)continue;
   action=[...root.querySelectorAll('button,[role="button"]')].find(el=>{
    const raw=el.innerText||el.textContent||el.getAttribute('aria-label')||'';
    const text=String(raw).replace(/\s+/g,' ').trim();
    const rect=el.getBoundingClientRect();const style=getComputedStyle(el);
    return text==='Record Time'&&rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none';
   });
  }
  if(!action){button?.remove();button=null;nativeAnchor=null;return;}
  const host=action.getRootNode().host;
  const anchor=host?.localName==='now-button'?host:action;
  // Workspace can retain a hidden toolbar at the same URL. Revalidate the
  // visible native action, not just our old button's document connection.
  if(button?.isConnected&&nativeAnchor===anchor&&button.parentNode===anchor.parentNode)return;
  button?.remove();button=null;nativeAnchor=anchor;
  button=anchor.ownerDocument.createElement('button');
  button.id='sn-timecard-add';button.setAttribute('type','button');button.textContent='Add timecard';
  styleButton(button,action);
  button.addEventListener('click',open);
  anchor.parentNode.insertBefore(button,anchor);
  ensureHoverStyle(button.ownerDocument);
 }
 function resume(){
  if(stopped||enabled)return;
  enabled=true;
  timer=setInterval(refresh,1500);
  refresh();
 }
 // Draft-preserving disable: removes the launch UI and stops polling/observers, but never closes an open
 // overlay (a clean or dirty form stays until the user closes it; Escape/Close/submit still work).
 function disable(){
  if(stopped||!enabled)return;
  enabled=false;
  if(timer!==null){clearInterval(timer);timer=null;}
  if(refreshTimer!==null){clearTimeout(refreshTimer);refreshTimer=null;}
  try{mutationObserver?.disconnect();}catch{/* none */}
  observedRoots.clear();
  button?.remove();button=null;nativeAnchor=null;
 }
 // Full teardown for reinjection of a controller that holds no open form. Not used for settings changes.
 function stop(){
  stopped=true;
  for(const [el,listener] of loadWatches){
   el.removeEventListener('load',listener);
   if(el.__snTimecardLoadWatch===loadWatchToken)delete el.__snTimecardLoadWatch;
  }
  loadWatches.clear();
  enabled=false;
  if(unsubscribe){try{unsubscribe();}catch{/* helper gone */}unsubscribe=null;}
  if(timer!==null){clearInterval(timer);timer=null;}
  if(refreshTimer!==null){clearTimeout(refreshTimer);refreshTimer=null;}
  try{mutationObserver?.disconnect();}catch{/* none */}
  window.removeEventListener('keydown',onKey);close(true);button?.remove();
 }
 const RETAINED_NOTE='disabled; current form retained until closed';
 function status(){
  const overlayOpen=Boolean(overlay);
  const retained=overlayOpen&&!enabled&&!stopped;
  return {mounted:Boolean(button?.isConnected),overlayOpen,caseContext,enabled,retained,note:retained?RETAINED_NOTE:null};
 }
 const app={refresh,open,close,stop,status};
 window.__snTimecardApp=app;
 const settings=window.__snMiloMainSettings;
 if(settings&&typeof settings.subscribe==='function'){
  try{unsubscribe=settings.subscribe('timecard',(state)=>{if(stopped)return;if(state?.enabled===true)resume();else disable();});}catch{/* stay inert */}
 }
})();
