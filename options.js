// sn_milo options page (MV3 extension page; no inline scripts). Talks to the service worker through the
// router's options-only control messages ({feature:'milo', type:'get-status'|'set-preference'|'import-dedupe'|
// 'choose-fallback'}) and, for the critical-alert rules section, reads/writes chrome.storage.local directly (crit.rulesV1, ix.accountsV1, inf.recipientsV1,
// and seenMatchesV4 for "forget known tickets"; trusted contexts only); renders with textContent only. View logic lives in shared/options-view.mjs (unit-tested).
// Alert migration completion is a separate explicit action per pending alert (import a dedupe snapshot, or a
// confirmed first-run fallback choice); the checkbox never completes it.
// Rendering: only the newest status response renders (request counter), and a pending alert's migration section
// is reused across re-renders so in-progress inputs (chosen files, pasted JSON, radio choice, errors) survive
// unrelated refreshes.
import {RULES_KEY, MAX_RULES, PRIORITIES, normalizeRules, validateRules, newRuleId} from './shared/rules.mjs';
import {IX_ACCOUNTS_KEY, INF_RECIPIENTS_KEY, INF_RESOLVE_KEY, validateAccounts, validateRecipients, normalizeAccounts, normalizeRecipients, normalizeResolve, validateResolveNotes} from './shared/user-lists.mjs';
import {viewModel, parseSnapshotTexts, buildImportMessage, buildFallbackMessage, FALLBACK_OPTIONS, fallbackConfirmText} from './shared/options-view.mjs';

const list = document.getElementById('features');
const errorBox = document.getElementById('error');
const warningsBox = document.getElementById('warnings');
const notice = document.getElementById('notice');
const WATCHED = new Set(['features', 'miloEffectiveV1', 'crit.migrationV1', 'ix.migrationV1']);
let busy = false;
let viewSeq = 0;               // bumped by every status request / control result; stale responses never render
const sections = new Map();    // feature -> {key, node}: live migration sections reused across renders

const send = message => chrome.runtime.sendMessage(message.feature ? message : {feature: 'milo', ...message});
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c) node.append(c);
  return node;
};
const withData = (node, data) => { Object.assign(node.dataset, data); return node; };

function showError(text) {
  errorBox.textContent = text || '';
  errorBox.hidden = !text;
}
function showNotice(text) {
  notice.textContent = text || '';
  notice.hidden = !text;
}
function setBusy(value) {
  busy = value;
  for (const c of list.querySelectorAll('input, textarea, button')) c.disabled = value || c.dataset.locked === 'true';
}

function migrationSection(f) {
  const section = withData(el('section', {className: 'migration'}), {migrationFor: f.name});
  section.append(el('h3', {textContent: 'Complete the migration (choose one)'}));

  // 1) Import dedupe snapshot(s) exported from the old extension.
  const files = withData(el('input', {type: 'file', multiple: true, accept: '.json,application/json'}), {role: 'snapshot-file'});
  const text = withData(el('textarea', {rows: 3, placeholder: `…or paste the exported ${f.dedupeKey} snapshot JSON (one object or an array)`}), {role: 'snapshot-text'});
  const importBtn = withData(el('button', {type: 'button', textContent: 'Import dedupe snapshot'}), {action: 'import'});
  const importError = withData(el('p', {className: 'action-error', hidden: true, role: 'alert'}), {role: 'import-error'});
  importBtn.addEventListener('click', () => importSnapshots(f, files, text, importError));
  section.append(el('fieldset', {},
    el('legend', {textContent: 'Import dedupe snapshot (recommended)'}),
    el('p', {className: 'hint', textContent: `Snapshot file(s) exported from the old extension's ${f.dedupeKey} (README → Alert migration). Several snapshots are merged.`}),
    files, text, importBtn, importError));

  // 2) Explicit first-run fallback. No default selection; a confirm() states the consequence.
  const group = `fallback-${f.name}`;
  const fallback = el('fieldset', {}, el('legend', {textContent: 'Or: first-run fallback without the old dedupe set'}));
  for (const o of FALLBACK_OPTIONS) {
    const radio = withData(el('input', {type: 'radio', name: group, value: o.choice, checked: false}), {choice: o.choice});
    if (f.disabledChoices.includes(o.choice)) radio.dataset.locked = 'true';
    fallback.append(withData(el('label', {className: 'choice'}, radio, el('span', {textContent: `${o.label} — ${o.consequence}`})), {choiceLabel: o.choice}));
  }
  const fallbackBtn = withData(el('button', {type: 'button', textContent: 'Apply fallback choice…'}), {action: 'fallback'});
  const fallbackError = withData(el('p', {className: 'action-error', hidden: true, role: 'alert'}), {role: 'fallback-error'});
  fallbackBtn.addEventListener('click', () => {
    const picked = fallback.querySelector(`input[name="${group}"]:checked`);
    applyFallback(f, picked ? picked.value : undefined, fallbackError);
  });
  fallback.append(fallbackBtn, fallbackError);
  section.append(fallback);
  return section;
}

function render(status) {
  const vm = viewModel(status, {busy});
  showError(vm.banner.text);
  warningsBox.textContent = vm.warnings.text;
  warningsBox.hidden = vm.warnings.hidden;
  list.replaceChildren();
  const live = new Set();
  for (const f of vm.features) {
    const box = el('input', {type: 'checkbox', checked: f.checkbox.checked, disabled: f.checkbox.disabled});
    box.dataset.feature = f.name;
    box.addEventListener('change', () => toggle(f.name, box.checked));
    const item = el('li', {}, el('label', {}, box, el('span', {textContent: f.label})));
    item.dataset.feature = f.name;
    const eff = el('p', {className: 'effective', textContent: f.effectiveText});
    eff.dataset.enabled = String(f.enabled);
    item.append(eff);
    if (f.pendingText) item.append(el('p', {className: 'pending', textContent: f.pendingText}));
    if (f.actions) {
      const key = JSON.stringify([f.disabledChoices, f.dedupeKey, f.label]);
      let entry = sections.get(f.name);
      if (!entry || entry.key !== key) { entry = {key, node: migrationSection(f)}; sections.set(f.name, entry); }
      for (const c of entry.node.querySelectorAll('input, textarea, button')) c.disabled = f.actionsDisabled || c.dataset.locked === 'true';
      item.append(entry.node);
      live.add(f.name);
    }
    if (f.name === 'timecard') {
      const line = el('p', {className: 'status-line', id: 'timecard-status', textContent: f.statusLine});
      line.dataset.statusFor = 'timecard';
      item.append(line);
    }
    list.append(item);
  }
  for (const name of [...sections.keys()]) if (!live.has(name)) sections.delete(name);
  list.setAttribute('aria-busy', 'false');
  document.documentElement.dataset.rendered = String(Number(document.documentElement.dataset.rendered || 0) + 1);
}

async function refresh() {
  const mine = ++viewSeq;
  try {
    const r = await send({type: 'get-status'});
    if (mine !== viewSeq) return; // a newer request/result superseded this one
    if (!r?.ok) throw new Error(r?.error || 'no response from the service worker');
    render(r.status);
  } catch (error) {
    if (mine === viewSeq) showError(`Could not load settings: ${error.message}`);
  }
}

/** Run one control message with the page locked; re-render from the returned status (or a fresh one on error). */
async function control(message) {
  setBusy(true);
  const mine = ++viewSeq; // supersedes any refresh still in flight
  try {
    const r = await send(message);
    if (!r?.ok) throw new Error(r?.error || 'no response from the service worker');
    busy = false;
    if (mine === viewSeq) render(r.status);
    return r;
  } finally {
    if (busy) { setBusy(false); await refresh(); }
  }
}

async function toggle(name, enabled) {
  try { await control({type: 'set-preference', name, enabled}); } catch (error) { showError(`Could not save: ${error.message}`); }
}

const fail = (box, text) => { box.textContent = text; box.hidden = false; };
// After an error the list was re-rendered; report in the fresh section's error slot when it still exists.
const currentBox = (f, role, fallbackBox) => list.querySelector(`.migration[data-migration-for="${f.name}"] [data-role=${role}]`) || fallbackBox;

async function importSnapshots(f, filesInput, textArea, box) {
  box.hidden = true;
  let texts;
  try { texts = [...await Promise.all([...filesInput.files].map(file => file.text())), textArea.value]; } catch (error) {
    fail(box, `Could not read the selected file(s): ${error.message}`); return;
  }
  const parsed = parseSnapshotTexts(f.name, texts);
  if (!parsed.ok) { fail(box, parsed.error); return; }
  try {
    const r = await control(buildImportMessage(f.name, parsed.snapshots));
    showNotice(`${f.label}: imported ${parsed.snapshots.length} snapshot(s) (${parsed.distinct} distinct). ` +
      `${f.dedupeKey} now has ${r.entries} entries (${r.added} new). Migration complete.`);
  } catch (error) {
    fail(currentBox(f, 'import-error', box), `Import failed: ${error.message}`);
  }
}

async function applyFallback(f, choice, box) {
  box.hidden = true;
  let message;
  try { message = buildFallbackMessage(f.name, choice); } catch (error) { fail(box, error.message); return; }
  if (!window.confirm(fallbackConfirmText(f.name, choice, f.label))) return;
  try {
    const r = await control(message);
    showNotice(`${f.label}: fallback recorded (${r.method}; state ${r.state}).`);
  } catch (error) {
    fail(currentBox(f, 'fallback-error', box), `Could not record the fallback: ${error.message}`);
  }
}

// ---- critical alert rules (stored by this page directly: chrome.storage.local, trusted contexts only) ----------
const SEEN_KEY = 'seenMatchesV4';
const ruleList = document.getElementById('rule-list');
const rulesError = document.getElementById('rules-error');
const rulesState = document.getElementById('rules-state');
let draft = [];          // the rules being edited
let dirty = false;       // unsaved edits: storage changes from elsewhere never overwrite them
const setDirty = value => { dirty = value; rulesState.textContent = value ? 'Unsaved changes' : ''; };
const showRulesError = text => { rulesError.textContent = text || ''; rulesError.hidden = !text; };

function renderRules() {
  ruleList.replaceChildren();
  draft.forEach((rule, i) => {
    const enabled = el('input', {type: 'checkbox', checked: rule.enabled, title: 'Enabled'});
    enabled.addEventListener('change', () => { rule.enabled = enabled.checked; setDirty(true); });
    const name = el('input', {type: 'text', value: rule.name, placeholder: 'Name', maxLength: 40, ariaLabel: 'Rule name'});
    name.addEventListener('input', () => { rule.name = name.value; setDirty(true); });
    const priority = el('select', {ariaLabel: 'Priority'});
    priority.append(el('option', {value: '', textContent: 'Any priority'}));
    for (const [value, label] of PRIORITIES) priority.append(el('option', {value, textContent: `${value} - ${label}`}));
    priority.value = rule.priority;
    priority.addEventListener('change', () => { rule.priority = priority.value; setDirty(true); });
    const account = el('input', {type: 'text', value: rule.account, placeholder: 'Account (empty = any)', maxLength: 100, ariaLabel: 'Account'});
    account.addEventListener('input', () => { rule.account = account.value; setDirty(true); });
    const remove = el('button', {type: 'button', textContent: 'Delete', ariaLabel: `Delete rule ${rule.name}`});
    remove.addEventListener('click', () => { draft.splice(i, 1); setDirty(true); renderRules(); });
    const row = el('div', {className: 'rule'}, enabled, name, priority, account, remove);
    row.dataset.ruleId = rule.id;
    ruleList.append(row);
  });
  document.getElementById('rule-add').disabled = draft.length >= MAX_RULES;
}

async function loadRules() {
  try {
    const stored = (await chrome.storage.local.get(RULES_KEY))[RULES_KEY];
    const n = normalizeRules(stored);
    draft = n.rules.map(r => ({...r}));
    showRulesError(n.error ? `${n.error}. Saving writes a clean list.` : '');
    renderRules();
    setDirty(false);
  } catch (error) { showRulesError(`Could not load the rules: ${error.message}`); }
}

async function saveRules() {
  const v = validateRules(draft);
  if (!v.ok) { showRulesError(v.error); return; }
  try {
    await chrome.storage.local.set({[RULES_KEY]: {schema: 1, rules: v.rules}});
    draft = v.rules.map(r => ({...r}));
    showRulesError('');
    renderRules();
    setDirty(false);
    rulesState.textContent = 'Saved — applies from the next poll';
  } catch (error) { showRulesError(`Could not save the rules: ${error.message}`); }
}

function exportRules() {
  const v = validateRules(draft);
  if (!v.ok) { showRulesError(v.error); return; }
  try {
    const text = JSON.stringify({schema: 1, feature: 'critical-alert', rules: v.rules}, null, 2) + '\n';
    const url = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
    const link = el('a', {href: url, download: 'sn-milo-critical-alert-rules.json'});
    try {
      document.body.append(link);
      link.click();
      showRulesError('');
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } catch (error) { showRulesError(`Could not export the rules: ${error.message}`); }
}

const rulesFile = document.getElementById('rules-file');
async function importRules() {
  const file = rulesFile.files?.[0];
  if (!file) return;
  try {
    if (file.size > 65536) throw new Error('Rule files must be at most 64 KiB.');
    let data;
    try { data = JSON.parse(await file.text()); }
    catch (error) { throw new Error(`Could not read rule JSON: ${error.message}`); }
    if (!data || data.schema !== 1) throw new Error('Rule file schema must be 1.');
    if (data.feature !== 'critical-alert') throw new Error('Expected a critical-alert rule export.');
    const v = validateRules(data.rules);
    if (!v.ok) throw new Error(v.error);
    if (!window.confirm(`Replace the rule list in this editor with ${v.rules.length} imported rule(s)?\n\nUnsaved edits will be replaced. Nothing takes effect until you click Save rules. Known tickets and other settings are not changed.`)) return;
    draft = v.rules.map(r => ({...r}));
    showRulesError('');
    renderRules();
    setDirty(true);
    rulesState.textContent = `Imported ${draft.length} rule(s) — review, then click Save rules`;
  } catch (error) { showRulesError(`Could not import the rules: ${error.message}`); }
  finally { rulesFile.value = ''; } // allow selecting the same file again, including after a failed import
}

async function forgetSeen() {
  if (!window.confirm('Forget every ticket that already alerted?\n\nEvery ticket matching your rules right now will alert again on the next poll (within about 2 minutes, while a ServiceNow tab is open).')) return;
  try {
    await chrome.storage.local.set({[SEEN_KEY]: []});
    showNotice('Known tickets forgotten. Matching tickets alert again on the next poll.');
  } catch (error) { showRulesError(`Could not clear the known tickets: ${error.message}`); }
}

document.getElementById('rule-add').addEventListener('click', () => {
  if (draft.length >= MAX_RULES) return;
  draft.push({id: newRuleId(draft), name: 'New rule', enabled: true, priority: '', account: ''});
  setDirty(true);
  renderRules();
});
document.getElementById('rules-save').addEventListener('click', saveRules);
document.getElementById('rules-export').addEventListener('click', exportRules);
document.getElementById('rules-import').addEventListener('click', () => rulesFile.click());
rulesFile.addEventListener('change', importRules);
document.getElementById('forget-seen').addEventListener('click', forgetSeen);

// ---- one-entry-per-line lists (interaction accounts, Informatica recipients) ------------------------------------
const listEditors = [];
function listEditor({prefix, key, field, validate, normalize}) {
  const text = document.getElementById(`${prefix}-text`);
  const err = document.getElementById(`${prefix}-error`);
  const state = document.getElementById(`${prefix}-state`);
  const ed = {key, dirty: false};
  const showErr = msg => { err.textContent = msg || ''; err.hidden = !msg; };
  const setDirty = value => { ed.dirty = value; state.textContent = value ? 'Unsaved changes' : ''; };
  ed.load = async () => {
    try {
      const n = normalize((await chrome.storage.local.get(key))[key]);
      text.value = n[field].join('\n');
      showErr(n.error ? `${n.error}. Saving writes a clean list.` : '');
      setDirty(false);
    } catch (error) { showErr(`Could not load: ${error.message}`); }
  };
  text.addEventListener('input', () => setDirty(true));
  document.getElementById(`${prefix}-save`).addEventListener('click', async () => {
    const v = validate(text.value.split('\n'));
    if (!v.ok) { showErr(v.error); return; }
    try {
      await chrome.storage.local.set({[key]: {schema: 1, [field]: v[field]}});
      text.value = v[field].join('\n');
      showErr('');
      setDirty(false);
      state.textContent = `Saved (${v[field].length}) — applies from the next use`;
    } catch (error) { showErr(`Could not save: ${error.message}`); }
  });
  listEditors.push(ed);
  ed.load();
}
listEditor({prefix: 'ix-accounts', key: IX_ACCOUNTS_KEY, field: 'accounts', validate: validateAccounts, normalize: normalizeAccounts});
listEditor({prefix: 'inf-recipients', key: INF_RECIPIENTS_KEY, field: 'emails', validate: validateRecipients, normalize: normalizeRecipients});

// ---- Informatica: resolve the ticket after the note is saved (checkbox + notes, saved explicitly) ---------------
const resolveBox = document.getElementById('inf-resolve-enabled');
const resolveNotes = document.getElementById('inf-resolve-notes');
const resolveErr = document.getElementById('inf-resolve-error');
const resolveState = document.getElementById('inf-resolve-state');
let resolveDirty = false;
const setResolveDirty = v => { resolveDirty = v; resolveState.textContent = v ? 'Unsaved changes' : ''; };
async function loadResolve() {
  try {
    const stored = (await chrome.storage.local.get(INF_RESOLVE_KEY))[INF_RESOLVE_KEY];
    const n = normalizeResolve(stored);
    resolveBox.checked = n.enabled;
    resolveNotes.value = n.notes || (stored && typeof stored.notes === 'string' ? stored.notes : '');
    resolveErr.hidden = true;
    setResolveDirty(false);
  } catch (error) { resolveErr.textContent = `Could not load: ${error.message}`; resolveErr.hidden = false; }
}
resolveBox.addEventListener('change', () => setResolveDirty(true));
resolveNotes.addEventListener('input', () => setResolveDirty(true));
document.getElementById('inf-resolve-save').addEventListener('click', async () => {
  const enabled = resolveBox.checked;
  const v = validateResolveNotes(resolveNotes.value);
  if (enabled && !v.ok) { resolveErr.textContent = v.error; resolveErr.hidden = false; return; }
  try {
    await chrome.storage.local.set({[INF_RESOLVE_KEY]: {schema: 1, enabled, notes: v.ok ? v.notes : ''}});
    resolveErr.hidden = true;
    setResolveDirty(false);
    resolveState.textContent = enabled ? 'Saved: resolving is ON — applies from the next use' : 'Saved: resolving is off';
  } catch (error) { resolveErr.textContent = `Could not save: ${error.message}`; resolveErr.hidden = false; }
});
loadResolve();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (INF_RESOLVE_KEY in changes && !resolveDirty) loadResolve();
  for (const ed of listEditors) if (ed.key in changes && !ed.dirty) ed.load();
  if (Object.keys(changes).some(k => WATCHED.has(k)) && !busy) refresh();
  if (RULES_KEY in changes && !dirty) loadRules();
});
// The timecard status line reflects open forms in other tabs: re-read when the user comes back to this page.
window.addEventListener('focus', () => { if (!busy) refresh(); });
refresh();
loadRules();
