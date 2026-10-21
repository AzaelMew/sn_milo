(() => {
  'use strict';

  function isAllowedOrigin(origin, config) {
    if (typeof origin !== 'string') return false;
    try {
      const url = new URL(origin);
      if (url.protocol !== 'https:' || url.origin !== origin) return false;
      return Array.isArray(config?.instances) && config.instances.some((instance) =>
        instance?.origin === origin &&
        (instance.mode === 'test' || instance.mode === 'production'));
    } catch {
      return false;
    }
  }

  function writesAllowed(origin, config) {
    return isAllowedOrigin(origin, config) &&
      config.instances.filter((instance) => instance?.origin === origin)
        .every((instance) => (instance.mode === 'test' || instance.mode === 'production') &&
          (Object.prototype.hasOwnProperty.call(instance, 'enableSubmission')
            ? instance.enableSubmission === true
            : instance.mode === 'test' && config.enableSubmission === true));
  }

  function parseCaseUrl(value) {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      const match = url.pathname.match(
        /^\/now\/cwf\/agent\/record\/((?:sn_customerservice_case(?:_internal)?|incident|change_request|interaction))\/([a-fA-F0-9]{32})(?:\/sub\/.*)?$/);
      if (match) return { table: match[1], sysId: match[2] };
      const prefix = '/now/nav/ui/classic/params/target/';
      let form = url;
      if (url.pathname.startsWith(prefix)) {
        const target = decodeURIComponent(url.pathname.slice(prefix.length));
        if (/[\u0000-\u001f\u007f]/.test(target) ||
          !/^(?:sn_customerservice_case(?:_internal)?|incident?|change_request|interaction)\.do\?/.test(target)) return null;
        form = new URL(`/${target}`, url.origin);
      }
      const classic = form.pathname.match(/^\/((?:sn_customerservice_case(?:_internal)?|incident|change_request|interaction))\.do$/);
      const identifiers = form.searchParams.getAll('sys_id');
      if (identifiers.length !== 1) return null;
      const sysId = identifiers[0];
      return classic && /^[a-fA-F0-9]{32}$/.test(sysId)
        ? { table: classic[1], sysId } : null;
    } catch {
      return null;
    }
  }

  function isSysId(value) {
    return typeof value === 'string' && value.length === 32 && /^[a-fA-F0-9]{32}$/.test(value);
  }

  function nativeFormUrl(origin, context, userId, config) {
    if (!isAllowedOrigin(origin, config) || !isSysId(userId) ||
      !isSysId(context?.sysId) ||
      (context.table !== 'sn_customerservice_case' &&
        context.table !== 'sn_customerservice_case_internal' &&
        context.table !== 'incident' &&
        context.table !== 'change_request' &&
        context.table !== 'interaction')) return null;
    const url = new URL('/task_time_worked.do', origin);
    url.search = new URLSearchParams({
      sys_id: '-1',
      sysparm_view: 'csm',
      sysparm_query: `userDYNAMIC${userId}^taskDYNAMIC${context.sysId}`,
      sysparm_stack: 'no',
      sysparm_clear_stack: 'true',
      sysparm_titleless: 'true',
    }).toString();
    return url.href;
  }

  const core = { isAllowedOrigin, writesAllowed, parseCaseUrl, nativeFormUrl };
  globalThis.SnTimecardCore = core;
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
})();
