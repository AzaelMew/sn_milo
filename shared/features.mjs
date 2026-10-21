// sn_milo feature catalog, local preferences, alert migration gates and effective-state computation.
// Pure module: no top-level runtime side effects. Storage is injected (chrome.storage.local in the worker).
//
// Storage keys (chrome.storage.local, per browser profile, never synced):
//   features            {<feature>: boolean} user preferences; missing known keys default ON; malformed => OFF
//   crit.migrationV1    critical-alert migration record   } missing/unrecognized => 'pending-migration'
//   ix.migrationV1      interaction-alert migration record}   (fail closed)
//   crit.rulesV1        critical-alert rules {schema:1, rules:[{id,name,enabled,priority,account}]}; written by the options page
//   seenMatchesV4       critical-alert dedupe   (exact key + format preserved from the source extension)
//   seenInteractionsV1  interaction-alert dedupe (exact key + format preserved from the source extension)
//   miloEffectiveV1     derived, content-facing EFFECTIVE state written only by the service worker
//
// Migration record: {schema: 1, state: 'ready'|'seeding', method: 'import'|'notify-current'|'seed-silently',
//                    decidedAt: ms, completedAt?: ms, importedEntries?: n, lastImportAt?: ms}
//   ready   + import | notify-current | seed-silently  => alert may activate (if its preference is on)
//   seeding + seed-silently                            => only a controlled seed poll (notifications held)

const freezeDeep = o => { for (const v of Object.values(o)) if (v && typeof v === 'object') freezeDeep(v); return Object.freeze(o); };

export const FEATURES = freezeDeep({
  'critical-alert': {
    label: 'Critical alert notifications', origins: ['production'],
    alert: {dedupeKey: 'seenMatchesV4', migrationKey: 'crit.migrationV1',
      // `${sys_id}|${priority}|${state}|${account}` (source matchKey)
      entryPattern: /^[0-9a-f]{32}\|[^\n]*$/i}
  },
  'interaction-alert': {
    label: 'Interaction alert notifications', origins: ['production'],
    alert: {dedupeKey: 'seenInteractionsV1', migrationKey: 'ix.migrationV1',
      // bare sys_id (source matchKey)
      entryPattern: /^[0-9a-f]{32}$/i}
  },
  'informatica-button': {label: 'Informatica button', origins: ['production', 'test']},
  'kb-dark': {label: 'KB dark mode', origins: ['production']},
  timecard: {label: 'Timecard overlay (native-form compatibility always on)', origins: ['production', 'test']}
});
export const FEATURE_NAMES = Object.freeze(Object.keys(FEATURES));
export const ALERT_FEATURES = Object.freeze(FEATURE_NAMES.filter(n => FEATURES[n].alert));
const DEDUPE_KEYS = ALERT_FEATURES.map(n => FEATURES[n].alert.dedupeKey);
export const PREFERENCES_KEY = 'features';
export const EFFECTIVE_KEY = 'miloEffectiveV1';
export const EFFECTIVE_SCHEMA = 1;
export const MIGRATION_SCHEMA = 1;
export const FALLBACK_CHOICES = Object.freeze(['notify-current', 'seed-silently']);
const MIGRATION_METHODS = ['import', 'notify-current', 'seed-silently'];
// Dedupe caps (no unlimitedStorage permission: chrome.storage.local has a 10 MB quota shared by every key).
// Real entries: interaction = 32-hex sys_id (32 chars); critical = `${sys_id}|${priority}|${state}|${account}`
// (~32 + "1 - Critical" + "New" + an account name ≈ 60–150 chars). The source extensions never prune, but only
// ever add items matching one priority/state/account filter, so real sets are far below these limits.
// maxCombinedBytes caps BOTH dedupe sets together (per-set caps alone would allow ≈ 4.2 MB + 1.75 MB), leaving
// ample room under the 10 MB quota for settings and the effective record.
export const DEDUPE_LIMITS = Object.freeze({maxEntries: 50000, maxEntryLength: 512, maxBytes: 4 * 1024 * 1024, maxCombinedBytes: 5 * 1024 * 1024});
const {maxEntries: MAX_ENTRIES, maxEntryLength: MAX_ENTRY_LENGTH, maxBytes: MAX_DEDUPE_BYTES, maxCombinedBytes: MAX_COMBINED_BYTES} = DEDUPE_LIMITS;
const jsonBytes = v => new TextEncoder().encode(JSON.stringify(v)).length;
/** Cap check for a resulting dedupe set (existing ∪ new) plus the other stored dedupe sets (`data` holds every
 *  dedupe key). Returns an error string or null. */
function checkDedupeSize(feature, union, verb, data) {
  const {dedupeKey} = FEATURES[feature].alert;
  if (union.length > MAX_ENTRIES) return `${dedupeKey} would have ${union.length} entries (max ${MAX_ENTRIES}); refusing to ${verb}`;
  const bytes = jsonBytes(union);
  if (bytes > MAX_DEDUPE_BYTES) return `${dedupeKey} would be ${bytes} bytes (max ${MAX_DEDUPE_BYTES}); refusing to ${verb}`;
  let total = 0;
  for (const key of DEDUPE_KEYS) total += key === dedupeKey ? bytes : (data[key] === undefined ? 0 : jsonBytes(data[key]));
  if (total > MAX_COMBINED_BYTES) return `${DEDUPE_KEYS.join(' + ')} would total ${total} bytes (combined max ${MAX_COMBINED_BYTES}; chrome.storage.local quota is 10 MB); refusing to ${verb}`;
  return null;
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export const isKnownFeature = name => typeof name === 'string' && has(FEATURES, name);
export const isAlertFeature = name => isKnownFeature(name) && Boolean(FEATURES[name].alert);

/** Validate raw `features` preferences. Missing => default on; malformed => off; unknown keys ignored. */
export function parsePreferences(raw) {
  const problems = [];
  if (raw === undefined) return {preferences: Object.fromEntries(FEATURE_NAMES.map(n => [n, true])), problems};
  if (!isPlainObject(raw)) {
    problems.push('stored preferences are malformed (expected an object); all features held off until saved again');
    return {preferences: Object.fromEntries(FEATURE_NAMES.map(n => [n, false])), problems};
  }
  const preferences = {};
  for (const name of FEATURE_NAMES) {
    if (!has(raw, name)) preferences[name] = true;
    else if (typeof raw[name] === 'boolean') preferences[name] = raw[name];
    else { preferences[name] = false; problems.push(`preference for ${name} is malformed; held off`); }
  }
  for (const key of Object.keys(raw)) if (!has(FEATURES, key)) problems.push(`ignored unknown preference key ${key}`);
  return {preferences, problems};
}

/** Parse a persisted alert migration record; anything not exactly recognized is pending-migration. */
export function parseMigration(raw) {
  if (raw === undefined || raw === null) return {state: 'pending-migration', reason: 'no migration decision recorded yet (import the old extension\'s dedupe set or choose a first-run fallback)'};
  const bad = detail => ({state: 'pending-migration', reason: `unrecognized migration state (${detail}); held off`});
  if (!isPlainObject(raw)) return bad('not an object');
  if (raw.schema !== MIGRATION_SCHEMA) return bad(`schema ${JSON.stringify(raw.schema)}`);
  if (!MIGRATION_METHODS.includes(raw.method)) return bad(`method ${JSON.stringify(raw.method)}`);
  if (!Number.isFinite(raw.decidedAt)) return bad('decidedAt missing');
  if (raw.state === 'ready') return {state: 'ready', method: raw.method, reason: `migration complete (${raw.method})`};
  if (raw.state === 'seeding' && raw.method === 'seed-silently') return {state: 'seeding', method: raw.method, reason: 'seed-silently chosen; waiting for the first successful poll to be recorded without notifications'};
  return bad(`state ${JSON.stringify(raw.state)} with method ${raw.method}`);
}

/** Effective state per feature: preference AND (for alerts) a completed migration. */
export function computeEffective(preferences, migrations = {}) {
  const out = {};
  for (const name of FEATURE_NAMES) {
    const pref = preferences?.[name] === true;
    if (!FEATURES[name].alert) { out[name] = {enabled: pref, seedOnly: false, reason: pref ? 'enabled' : 'disabled in options'}; continue; }
    const m = migrations[name] || parseMigration(undefined);
    if (!pref) out[name] = {enabled: false, seedOnly: false, reason: m.state === 'ready' ? 'disabled in options' : `disabled in options; pending-migration: ${m.reason}`};
    else if (m.state === 'ready') out[name] = {enabled: true, seedOnly: false, reason: 'enabled'};
    else if (m.state === 'seeding') out[name] = {enabled: false, seedOnly: true, reason: `seeding: ${m.reason}`};
    else out[name] = {enabled: false, seedOnly: false, reason: `pending-migration: ${m.reason}`};
  }
  return out;
}

/** Content-facing record (stored under EFFECTIVE_KEY). Contains effective state only, never raw preferences. */
export function buildEffectiveRecord({effective, origins, epoch, rev, at}) {
  const scope = {};
  if (origins?.production) scope[origins.production] = FEATURE_NAMES.filter(n => FEATURES[n].origins.includes('production'));
  if (origins?.test) scope[origins.test] = FEATURE_NAMES.filter(n => FEATURES[n].origins.includes('test'));
  const features = {};
  for (const name of FEATURE_NAMES) features[name] = {enabled: effective[name].enabled === true, seedOnly: effective[name].seedOnly === true, reason: String(effective[name].reason)};
  return {schema: EFFECTIVE_SCHEMA, epoch: String(epoch), rev, at, features, origins: scope};
}

export const sameEffective = (a, b) => Boolean(a && b) && JSON.stringify([a.features, a.origins]) === JSON.stringify([b.features, b.origins]);

function validateEntries(feature, entries, where) {
  const {entryPattern} = FEATURES[feature].alert;
  if (!Array.isArray(entries)) return `${where}: entries must be an array`;
  if (entries.length > MAX_ENTRIES) return `${where}: too many entries (${entries.length}; max ${MAX_ENTRIES})`;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (typeof e === 'string' && e.length > MAX_ENTRY_LENGTH) return `${where}: entry ${i} is longer than ${MAX_ENTRY_LENGTH} characters`;
    if (typeof e !== 'string' || !e.length || !entryPattern.test(e)) return `${where}: entry ${i} is not a valid ${FEATURES[feature].alert.dedupeKey} entry`;
  }
  return null;
}

/** Validate an import payload: [{schema:1, feature, key:<exact dedupe key>, entries:[...]}, ...]. */
export function validateSnapshots(feature, snapshots) {
  if (!isAlertFeature(feature)) return `unknown alert feature ${JSON.stringify(feature)}`;
  if (!Array.isArray(snapshots) || !snapshots.length) return 'snapshots must be a non-empty array';
  const {dedupeKey} = FEATURES[feature].alert;
  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i];
    const at = `snapshot ${i}`;
    if (!isPlainObject(s)) return `${at} must be an object`;
    if (s.schema !== 1) return `${at}: schema must be 1`;
    if (s.feature !== feature) return `${at}: feature ${JSON.stringify(s.feature)} != ${feature}`;
    if (s.key !== dedupeKey) return `${at}: key ${JSON.stringify(s.key)} != ${dedupeKey}`;
    const problem = validateEntries(feature, s.entries, at);
    if (problem) return problem;
  }
  return null;
}

/** Storage-backed settings/migration API. All writes for one key-set are serialized. */
export function createSettingsStore({storage, now = () => Date.now()}) {
  const queues = new Map();
  const serialize = (name, fn) => {
    const run = (queues.get(name) || Promise.resolve()).then(fn);
    queues.set(name, run.catch(() => {}));
    return run;
  };
  const migrationKeys = ALERT_FEATURES.map(n => FEATURES[n].alert.migrationKey);
  // Dedupe writes take the feature queue AND one shared queue, so the combined-size check cannot race a write to
  // the other set (always acquired in this order: no lock-order inversion).
  const serializeDedupe = (feature, fn) => serialize(feature, () => serialize('dedupe-sets', fn));

  async function readState() {
    const data = await storage.get([PREFERENCES_KEY, ...migrationKeys, EFFECTIVE_KEY]);
    const {preferences, problems} = parsePreferences(data[PREFERENCES_KEY]);
    const migrations = Object.fromEntries(ALERT_FEATURES.map(n => [n, parseMigration(data[FEATURES[n].alert.migrationKey])]));
    return {preferences, problems, migrations, effective: computeEffective(preferences, migrations), storedRecord: data[EFFECTIVE_KEY]};
  }

  function setPreference(name, enabled) {
    if (!isKnownFeature(name)) return Promise.reject(new Error(`unknown feature ${JSON.stringify(name)}`));
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('enabled must be a boolean'));
    return serialize(PREFERENCES_KEY, async () => {
      const data = await storage.get(PREFERENCES_KEY);
      const {preferences} = parsePreferences(data[PREFERENCES_KEY]);
      const next = {...preferences, [name]: enabled};
      await storage.set({[PREFERENCES_KEY]: next});
      return next;
    });
  }

  function importDedupe(feature, snapshots) {
    const problem = validateSnapshots(feature, snapshots);
    if (problem) return Promise.resolve({ok: false, error: problem});
    const {dedupeKey, migrationKey} = FEATURES[feature].alert;
    return serializeDedupe(feature, async () => {
      const data = await storage.get([...DEDUPE_KEYS, migrationKey]);
      const existing = data[dedupeKey];
      if (existing !== undefined && !Array.isArray(existing)) return {ok: false, error: `existing ${dedupeKey} value is not an array; refusing to overwrite it`};
      const current = existing || [];
      const set = new Set(current);
      const union = [...current];
      for (const s of snapshots) for (const e of s.entries) if (!set.has(e)) { set.add(e); union.push(e); }
      if (union.length < current.length) return {ok: false, error: 'internal: union smaller than existing set'};
      const tooBig = checkDedupeSize(feature, union, 'import', data);
      if (tooBig) return {ok: false, error: tooBig};
      const prev = parseMigration(data[migrationKey]);
      const added = union.length - current.length;
      if (!added && prev.state === 'ready' && prev.method === 'import') return {ok: true, changed: false, entries: union.length, added: 0};
      const old = data[migrationKey];
      const t = now();
      const record = {schema: MIGRATION_SCHEMA, state: 'ready', method: 'import',
        decidedAt: prev.state === 'ready' && Number.isFinite(old?.decidedAt) ? old.decidedAt : t,
        completedAt: prev.state === 'ready' && Number.isFinite(old?.completedAt) ? old.completedAt : t,
        importedEntries: union.length, lastImportAt: t};
      await storage.set({[dedupeKey]: union, [migrationKey]: record});
      return {ok: true, changed: true, entries: union.length, added};
    });
  }

  function chooseFallback(feature, choice) {
    if (!isAlertFeature(feature)) return Promise.resolve({ok: false, error: `unknown alert feature ${JSON.stringify(feature)}`});
    if (!FALLBACK_CHOICES.includes(choice)) return Promise.resolve({ok: false, error: `choice must be one of ${FALLBACK_CHOICES.join(', ')}`});
    const {migrationKey} = FEATURES[feature].alert;
    return serialize(feature, async () => {
      const data = await storage.get(migrationKey);
      const prev = parseMigration(data[migrationKey]);
      if (prev.state === 'ready') return {ok: true, changed: false, state: prev.state, method: prev.method};
      if (prev.state === 'seeding' && choice === 'seed-silently') return {ok: true, changed: false, state: prev.state, method: prev.method};
      const t = now();
      const record = choice === 'notify-current'
        ? {schema: MIGRATION_SCHEMA, state: 'ready', method: 'notify-current', decidedAt: t, completedAt: t}
        : {schema: MIGRATION_SCHEMA, state: 'seeding', method: 'seed-silently', decidedAt: t};
      await storage.set({[migrationKey]: record});
      return {ok: true, changed: true, state: record.state, method: record.method};
    });
  }

  /** Controlled silent seed (used by the alert feature after a validated, successful seed poll). */
  function completeSeed(feature, entries) {
    if (!isAlertFeature(feature)) return Promise.resolve({ok: false, error: `unknown alert feature ${JSON.stringify(feature)}`});
    const problem = validateEntries(feature, entries, 'seed');
    if (problem) return Promise.resolve({ok: false, error: problem});
    const {dedupeKey, migrationKey} = FEATURES[feature].alert;
    return serializeDedupe(feature, async () => {
      const data = await storage.get([...DEDUPE_KEYS, migrationKey]);
      const prev = parseMigration(data[migrationKey]);
      if (prev.state === 'ready') return {ok: true, changed: false};
      if (prev.state !== 'seeding') return {ok: false, error: 'no seed-silently decision recorded'};
      const existing = data[dedupeKey];
      if (existing !== undefined && !Array.isArray(existing)) return {ok: false, error: `existing ${dedupeKey} value is not an array; refusing to overwrite it`};
      const union = [...new Set([...(existing || []), ...entries])];
      const tooBig = checkDedupeSize(feature, union, 'complete the seed', data);
      if (tooBig) return {ok: false, error: tooBig};
      const t = now();
      await storage.set({[dedupeKey]: union,
        [migrationKey]: {schema: MIGRATION_SCHEMA, state: 'ready', method: 'seed-silently', decidedAt: data[migrationKey].decidedAt, completedAt: t}});
      return {ok: true, changed: true, entries: union.length};
    });
  }

  return {readState, setPreference, importDedupe, chooseFallback, completeSeed, serialize};
}
