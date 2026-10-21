// sn_milo options-page logic, kept free of DOM and chrome.* so it is unit-testable (tests/options.test.mjs).
// options.js renders viewModel(status) and sends the control messages built here.
//
// Dedupe snapshot JSON (one object, or an array of them, per file/paste; several files are unioned):
//   {"schema": 1, "feature": "critical-alert" | "interaction-alert",
//    "key": "seenMatchesV4" | "seenInteractionsV1",      exact dedupe key of the source extension
//    "entries": ["…", …],                               the source extension's stored array, unchanged
//    "exportedAt": "2026-10-20T10:00:00.000Z"}           optional (string or epoch ms)
import {FEATURES, FEATURE_NAMES, FALLBACK_CHOICES, isAlertFeature, validateSnapshots} from './features.mjs';

export const FALLBACK_OPTIONS = Object.freeze([
  Object.freeze({choice: 'notify-current', label: 'Notify for currently matching items',
    consequence: 'Every item that matches right now is notified on the first poll — possible duplicate alerts for items the old extension already notified.'}),
  Object.freeze({choice: 'seed-silently', label: 'Seed the first successful poll silently',
    consequence: 'Everything matching on the first successful poll is recorded as already seen without a notification — this can permanently suppress items never previously notified.'})
]);

export function fallbackConfirmText(feature, choice, label = feature) {
  const option = FALLBACK_OPTIONS.find(o => o.choice === choice);
  if (!option) throw new Error('choose one of the fallback options first');
  return `${label}: ${option.label.toLowerCase()}?\n\n${option.consequence}\n\n` +
    'This completes the migration without importing the old extension\'s dedupe set and cannot be undone from this page.';
}

/** Parse + validate one or more pasted/loaded JSON texts for `feature`. Returns {ok, snapshots, entries, distinct}
 *  or {ok:false, error}. Blank texts are skipped; every snapshot must validate; the union must be non-empty. */
export function parseSnapshotTexts(feature, texts) {
  if (!isAlertFeature(feature)) return {ok: false, error: `unknown alert feature ${JSON.stringify(feature)}`};
  const snapshots = [];
  let index = 0;
  for (const text of texts || []) {
    index++;
    if (typeof text !== 'string' || !text.trim()) continue;
    let value;
    try { value = JSON.parse(text); } catch (error) { return {ok: false, error: `input ${index} is not valid JSON (${error.message})`}; }
    const list = Array.isArray(value) ? value : [value];
    if (!list.length) return {ok: false, error: `input ${index} is an empty array`};
    if (list.some(s => s === null || typeof s !== 'object' || Array.isArray(s))) return {ok: false, error: `input ${index} must be a snapshot object or an array of snapshot objects`};
    const problem = validateSnapshots(feature, list);
    if (problem) return {ok: false, error: `input ${index}: ${problem}`};
    for (const s of list) {
      if (s.exportedAt !== undefined && typeof s.exportedAt !== 'string' && !Number.isFinite(s.exportedAt)) {
        return {ok: false, error: `input ${index}: exportedAt must be a string or a number`};
      }
    }
    snapshots.push(...list);
  }
  if (!snapshots.length) return {ok: false, error: 'no snapshot provided (choose a file or paste the exported JSON)'};
  const entries = snapshots.reduce((n, s) => n + s.entries.length, 0);
  const distinct = new Set(snapshots.flatMap(s => s.entries)).size;
  if (!distinct) return {ok: false, error: 'the snapshot contains no entries; nothing to import — use a fallback choice instead'};
  return {ok: true, snapshots, entries, distinct};
}

export function buildImportMessage(feature, snapshots) {
  if (!isAlertFeature(feature)) throw new Error(`${feature} is not an alert feature`);
  return {feature: 'milo', type: 'import-dedupe', target: feature, snapshots};
}

export function buildFallbackMessage(feature, choice) {
  if (!isAlertFeature(feature)) throw new Error(`${feature} is not an alert feature`);
  if (!FALLBACK_CHOICES.includes(choice)) throw new Error('choose one of the fallback options first');
  return {feature: 'milo', type: 'choose-fallback', target: feature, choice};
}

/** Everything the page shows, derived from the worker status ({feature:'milo', type:'get-status'}). */
export function viewModel(status, {busy = false} = {}) {
  const error = status.error
    ? `Settings storage problem: ${status.error.message}. ${status.ready ? 'Showing the last known state; nothing was reset.' : 'Features stay inactive until settings can be read.'}`
    : '';
  const warnings = (status.warnings || []).join(' · ');
  const features = FEATURE_NAMES.filter(n => status.features?.[n]).map(name => {
    const f = status.features[name];
    const m = f.migration;
    const actions = Boolean(FEATURES[name].alert && m && m.state !== 'ready');
    return {
      name, label: f.label,
      checkbox: {checked: f.preference === true, disabled: busy || f.preference === null},
      enabled: f.enabled === true,
      statusLine: typeof f.statusLine === 'string' ? f.statusLine : '',
      effectiveText: f.enabled ? 'Active' : f.seedOnly ? `Seeding (${f.reason})` : `Inactive — ${f.reason}`,
      pendingText: actions ? `${m.state === 'seeding' ? 'Seeding' : 'Pending migration'}: ${m.reason}. ` +
        'The checkbox alone never activates this alert; complete the migration below.' : null,
      actions, actionsDisabled: busy,
      disabledChoices: actions && m.state === 'seeding' ? ['seed-silently'] : [],
      dedupeKey: FEATURES[name].alert?.dedupeKey ?? null
    };
  });
  return {banner: {hidden: !error, text: error}, warnings: {hidden: !warnings, text: warnings}, features};
}
