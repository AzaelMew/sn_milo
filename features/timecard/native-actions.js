(() => {
 'use strict';
 if(location.pathname!=='/task_time_worked.do'||!globalThis.SnTimecardCore?.isAllowedOrigin(location.origin,globalThis.SnTimecardConfig))return;
 function restoreInsertAction(){
  const bottom=document.getElementById('sysverb_insert_bottom');
  if(!bottom?.parentNode)return;
  let canonical=document.getElementById('sysverb_insert');
  if(canonical){
   const ours=canonical.getAttribute('data-sn-timecard-native-action')==='alias';
   const legacy=canonical.hidden&&canonical.getAttribute('aria-hidden')==='true'&&canonical.getAttribute('tabindex')==='-1'&&canonical.parentNode===bottom.parentNode;
   if(!ours&&!legacy)return; // Never hide an original native header action.
  }else{
   // Preserve the authorized native action used by invoice-validation resume.
   canonical=bottom.cloneNode(true);canonical.id='sysverb_insert';
   bottom.parentNode.insertBefore(canonical,bottom);
  }
  canonical.hidden=true;
  canonical.setAttribute('data-sn-timecard-native-action','alias');
  canonical.setAttribute('aria-hidden','true');canonical.setAttribute('tabindex','-1');
  canonical.style.setProperty('display','none','important');
  // ServiceNow's button styles can override [hidden] and later restore an
  // inline display value. Keep a narrowly scoped important rule as well.
  if(!document.getElementById('sn-timecard-native-action-style')){
   const style=document.createElement('style');style.id='sn-timecard-native-action-style';
   style.textContent='#sysverb_insert[data-sn-timecard-native-action="alias"]{display:none!important;}';
   (document.head||document.documentElement).appendChild(style);
  }
 }
 function onReady(){restoreInsertAction();scheduleQuickActions();}
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',onReady,{once:true});
 else onReady();
 function applyQuickAction(form,quick,action,button){
  try{form.setValue('time_worked',quick.duration(action.minutes));}catch{/* field unavailable */}
  if(action.comment){try{form.setValue('comments',action.comment);}catch{/* field unavailable */}}
  if(action.workNotes){try{form.setValue('u_work_notes','true');}catch{/* field unavailable */}}
  const bar=button.parentNode;
  const buttons=typeof bar?.querySelectorAll==='function'?[...bar.querySelectorAll('button')]:[button];
  for(const other of buttons)other.disabled=true;
  const submit=document.getElementById('sysverb_insert_bottom');
  if(!submit){for(const other of buttons)other.disabled=false;return;}
  submit.click();
  // Validation failures keep the form open; make the bar clickable again.
  if(typeof setTimeout==='function')setTimeout(()=>{for(const other of buttons)other.disabled=false;},2000);
 }
 function renderQuickActions(){
  const quick=globalThis.SnTimecardQuickActions;
  const form=window.g_form;
  let container = null;
  try { container = typeof document.querySelector === 'function' ? document.querySelector('.form_action_button_container') : null; } catch { /* legacy document */ }
  container = container || document.getElementById('sysverb_insert_bottom')?.parentNode;
  if(!quick||!form||typeof form.setValue!=='function'||!container||!container.parentNode)return false;
  let bar=document.getElementById('sn-timecard-quick-actions');
  const actions=quick.load();
  if(!actions.length){if(bar)bar.remove();return true;}
  if(!bar){
   bar=document.createElement('div');bar.id='sn-timecard-quick-actions';
   bar.style.cssText='display:flex;flex-wrap:wrap;gap:8px;padding:10px 14px;';
   const style=document.createElement('style');style.id='sn-timecard-quick-actions-style';
   style.textContent='#sn-timecard-quick-actions button{font:13px system-ui,sans-serif;padding:6px 12px;border:1px solid #7c6bb0;border-radius:6px;background:#4a3f78;color:#fff;cursor:pointer}#sn-timecard-quick-actions button:hover{background:#5a4d92}#sn-timecard-quick-actions button:disabled{opacity:.6;cursor:default}';
   container.parentNode.insertBefore(style,container.nextSibling);
   container.parentNode.insertBefore(bar,container.nextSibling);
  }
  bar.textContent='';
  for(const action of actions){
   const button=document.createElement('button');
   button.type='button';button.textContent=action.label;
   button.title=`${action.minutes} min${action.comment?' · '+action.comment:''}${action.workNotes?' · work notes':''} · fills and submits`;
   button.addEventListener('click',()=>applyQuickAction(form,quick,action,button));
   bar.appendChild(button);
  }
  return true;
 }
 function scheduleQuickActions(){
  if(renderQuickActions())return;
  if(typeof setTimeout==='function')setTimeout(scheduleQuickActions,500);
 }
 if(typeof window.addEventListener==='function')window.addEventListener('storage',(event)=>{if(event.key===globalThis.SnTimecardQuickActions?.STORAGE_KEY)renderQuickActions();});
})();
