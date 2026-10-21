// Critical-alert rules: user-defined, stored in chrome.storage.local under `crit.rulesV1` (never in source/config:
// account names are private). Pure module, shared by the service worker, the options page and the tests.
//
// A rule matches a ticket of the SOC Jono queue that is active and in state New. Conditions (all must hold; an empty
// condition means "any"; a rule needs at least one condition):
//   priority  '1'..'5' (ServiceNow priority value; the table shows "1 - Critical" etc.)
//   account   account display name, compared case-insensitively
// A ticket that matches several rules is ONE alert (dedupe is per ticket); the notification names the rules.
export const RULES_KEY = 'crit.rulesV1';
export const MAX_RULES = 10;
export const PRIORITIES = Object.freeze([['1', 'Critical'], ['2', 'High'], ['3', 'Moderate'], ['4', 'Low'], ['5', 'Planning']]);
export const DEFAULT_RULES = Object.freeze([Object.freeze({id: 'critical', name: 'Critical', enabled: true, priority: '1', account: ''})]);

const ID = /^[a-z0-9-]{1,40}$/;
const PRIORITY_VALUES = new Set(PRIORITIES.map(p => p[0]));
// '^' would splice extra conditions into the encoded query; control characters have no business in a name.
const badText = s => /[\^\u0000-\u001f\u007f]/.test(s);

/** Validates + canonicalizes rules coming from the editor. Strict: returns {ok:false, error} on the first problem. */
export function validateRules(input) {
  if (!Array.isArray(input)) return {ok: false, error: 'rules must be a list'};
  if (input.length > MAX_RULES) return {ok: false, error: `at most ${MAX_RULES} rules`};
  const seen = new Set();
  const rules = [];
  for (const [i, r] of input.entries()) {
    const where = `rule ${i + 1}`;
    if (!r || typeof r !== 'object') return {ok: false, error: `${where}: not an object`};
    const id = typeof r.id === 'string' ? r.id : '';
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    const priority = r.priority === undefined || r.priority === null ? '' : String(r.priority);
    const account = typeof r.account === 'string' ? r.account.trim() : '';
    if (!ID.test(id) || seen.has(id)) return {ok: false, error: `${where}: invalid or duplicate id`};
    if (!name || name.length > 40 || badText(name)) return {ok: false, error: `${where}: give it a name (max 40 characters, no ^)`};
    if (priority !== '' && !PRIORITY_VALUES.has(priority)) return {ok: false, error: `${where}: unknown priority`};
    if (account.length > 100 || badText(account)) return {ok: false, error: `${where}: invalid account (max 100 characters, no ^)`};
    if (!priority && !account) return {ok: false, error: `${where} (${name}): set a priority or an account, otherwise it would match every New ticket`};
    seen.add(id);
    rules.push({id, name, enabled: r.enabled === true, priority, account});
  }
  return {ok: true, rules};
}

/** Reads the stored value. Missing ⇒ the default rules. Malformed ⇒ the default rules too (an alert tool must not go
 *  silent because of a bad write) with `error` set so status/options can say so; individual bad entries are dropped. */
export function normalizeRules(stored) {
  if (stored === undefined) return {rules: DEFAULT_RULES.map(r => ({...r})), stored: false};
  const list = stored && typeof stored === 'object' && Array.isArray(stored.rules) ? stored.rules : null;
  if (!list) return {rules: DEFAULT_RULES.map(r => ({...r})), stored: true, error: 'stored rules are malformed; using the default rules'};
  const rules = [];
  const dropped = [];
  for (const r of list.slice(0, MAX_RULES)) {
    const v = validateRules([r]);
    if (v.ok && !rules.some(x => x.id === v.rules[0].id)) rules.push(v.rules[0]); else dropped.push(r?.name ?? '?');
  }
  return {rules, stored: true, ...(dropped.length ? {error: `ignored ${dropped.length} invalid rule(s)`} : {})};
}

export const enabledRules = rules => rules.filter(r => r.enabled);

/** What the poller needs from the enabled rules (deduplicated): the conditions only, no names. */
export function queryRules(rules) {
  const seen = new Set();
  const out = [];
  for (const r of enabledRules(rules)) {
    const key = `${r.priority}|${r.account.toLowerCase()}`;
    if (!seen.has(key)) { seen.add(key); out.push({priority: r.priority, account: r.account}); }
  }
  return out;
}

/** Enabled rules this ticket row satisfies (state New is part of every rule). */
export function matchingRules(row, rules) {
  if (row?.state !== 'New') return [];
  const priority = /^\s*(\d)\b/.exec(row.priority || '')?.[1] || '';
  const account = String(row.account || '').trim().toLowerCase();
  return enabledRules(rules).filter(r =>
    (!r.priority || r.priority === priority) && (!r.account || r.account.toLowerCase() === account));
}

export function newRuleId(existing) {
  const used = new Set(existing.map(r => r.id));
  for (let i = 1; ; i++) if (!used.has(`rule-${i}`)) return `rule-${i}`;
}
