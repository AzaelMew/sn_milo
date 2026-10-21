// User-supplied lists kept in chrome.storage.local (entered on the options page, never in source or config, so no
// client or person is named in the repository). Pure module shared by the worker, the options page and the tests.
//   ix.accountsV1    {schema:1, accounts:[name,…]}     interaction alert: accounts whose new interactions alert
//   inf.recipientsV1 {schema:1, emails:[address,…]}    Informatica button: people added to the external work notes list
// Nothing stored (or malformed) ⇒ an EMPTY list: the interaction alert polls nothing and the Informatica button
// refuses to run until something is configured.
export const IX_ACCOUNTS_KEY = 'ix.accountsV1';
export const INF_RECIPIENTS_KEY = 'inf.recipientsV1';
export const MAX_ACCOUNTS = 20;
export const MAX_RECIPIENTS = 10;

// '^' would splice extra conditions into an encoded query; control characters have no business in a name.
const badText = s => /[\^\u0000-\u001f\u007f]/.test(s);
const EMAIL = /^[^\s@,;^]+@[^\s@,;^]+\.[^\s@,;^]+$/;

function cleanList(input, {max, label, map, ok, what}) {
  if (!Array.isArray(input)) return {ok: false, error: `${label} must be a list`};
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return {ok: false, error: `${label}: every entry must be text`};
    const v = map(raw.trim());
    if (!v) continue; // blank lines are fine
    if (!ok(v)) return {ok: false, error: `${label}: "${v.slice(0, 40)}" is not a valid ${what}`};
    if (seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  if (out.length > max) return {ok: false, error: `${label}: at most ${max} entries`};
  return {ok: true, list: out};
}

export function validateAccounts(input) {
  const r = cleanList(input, {max: MAX_ACCOUNTS, label: 'accounts', map: s => s, what: 'account name (max 100 characters, no ^)', ok: s => s.length <= 100 && !badText(s)});
  return r.ok ? {ok: true, accounts: r.list} : r;
}
export function validateRecipients(input) {
  const r = cleanList(input, {max: MAX_RECIPIENTS, label: 'recipients', map: s => s.toLowerCase(), what: 'email address', ok: s => s.length <= 100 && EMAIL.test(s)});
  return r.ok ? {ok: true, emails: r.list} : r;
}

function normalize(stored, field, validate) {
  if (stored === undefined) return {[field]: []};
  const list = stored && typeof stored === 'object' && Array.isArray(stored[field]) ? stored[field] : null;
  if (!list) return {[field]: [], error: 'stored list is malformed and was ignored'};
  const v = validate(list);
  return v.ok ? {[field]: v[field]} : {[field]: [], error: `stored list ignored: ${v.error}`};
}
export const normalizeAccounts = stored => normalize(stored, 'accounts', validateAccounts);
export const normalizeRecipients = stored => normalize(stored, 'emails', validateRecipients);
