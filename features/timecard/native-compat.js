(() => {
 'use strict';
 if(location.pathname!=='/task_time_worked.do'||!globalThis.SnTimecardCore?.isAllowedOrigin(location.origin,globalThis.SnTimecardConfig))return;
 // This instance's client script detects Workspace from top.location, even
 // for an embedded Classic form. Provide only its missing, presentation-only
 // placeholder API; do not change native values, validation, or submission.
 function adapt(form){
  if(form&&typeof form.setFieldPlaceholder!=='function'){
   form.setFieldPlaceholder=function(name,text){const control=this.getControl(name);if(control)control.placeholder=text;};
  }
  return form;
 }
 const descriptor=Object.getOwnPropertyDescriptor(window,'g_form');
 if(window.g_form){adapt(window.g_form);return;}
 if(descriptor&&!descriptor.configurable)return;
 Object.defineProperty(window,'g_form',{
  configurable:true,enumerable:true,
  get(){return undefined;},
  set(form){
   Object.defineProperty(window,'g_form',{value:adapt(form),configurable:true,enumerable:true,writable:true});
  }
 });
})();
