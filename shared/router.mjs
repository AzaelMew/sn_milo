// sn_milo service-worker application: ONE serialized readiness/reconciliation path, central message router,
// alarm / notification-click ownership and feature lifecycle hooks. Pure module: creating an app has no side
// effects; background.js registers the listeners synchronously at module evaluation via app.install().
//
// Runtime message protocol (chrome.runtime.sendMessage → this router):
//   {feature: <known feature>, type: <handler name>, ...payload}  feature message → registered feature handler
//   {feature: 'milo', type: 'get-effective'}                       content controllers (production/test origins)
//   {feature: 'milo', type: 'get-status'|'set-preference'|'import-dedupe'|'choose-fallback', ...}  options page only
// Responses: whatever the handler returns, or {ok:false, error: 'invalid-message'|'unknown-message'|
//   'foreign-sender'|'wrong-origin'|'inactive-document'|'settings-unavailable'|'feature-disabled'|<handler error>}.
// Every accepted message is answered asynchronously after the readiness gate (listener returns true).
// Sender policy: sender.id must be this extension; content senders need an allowed frame origin AND, when
// sender.tab is present, an allowed tab url (a tab without a url fails closed). Feature messages additionally
// require sender.documentLifecycle === 'active' when the field is present (prerendered / bfcached / unloading
// documents are refused); when it is absent (browsers before Chrome 106) the message is allowed. get-effective is
// read-only and stays available to prerendering documents.
//
// Feature module API (each features/<name>/background.mjs exports one; no top-level listeners or injection):
//   {name, messages: {type: fn(msg, sender, ctx) | {handle, allowSeedOnly}}, alarms: [exact names],
//    notificationPrefixes: [id prefixes], onEffectiveChange(next, prev|undefined, ctx), onAlarm(alarm, ctx),
//    onNotificationClicked(id, ctx), onInstalled(details, ctx), onStartup(ctx)}
//   ctx = {feature, chrome, origins, log, isEnabled(name), effective(name), store: {serialize, completeSeed},
//          signal: AbortSignal, isCurrent(): boolean}.
//   onEffectiveChange runs inside the serialized reconciliation queue on EVERY worker wake (prev === undefined:
//   the worker has no memory of what ran before it was stopped) and on every enabled/seedOnly transition, so it
//   must be idempotent (e.g. "ensure alarm exists" / "clear alarm", never "toggle"). Every hook must be bounded:
//   each call is cut off after hookTimeoutMs (default 5 s), recorded in status().hookErrors, and the queue moves
//   on — but JavaScript cannot stop the abandoned promise, which keeps running alongside later hook runs.
//   Transition generations: each onEffectiveChange call starts a new per-feature generation. Every ctx handed to a
//   hook or message handler belongs to the generation current when it was created; its ctx.signal is aborted (and
//   ctx.isCurrent() turns false) when that call times out OR when the next transition of the same feature begins.
//   RULE: after every await, a hook/handler MUST check `ctx.isCurrent()` (or `ctx.signal.aborted`) before any
//   side effect and return if it is no longer current — ctx.isEnabled alone cannot tell an abandoned 'disable'
//   run (e.g. a late alarms.clear) from the current state, so it could undo a later 'enable'. Pass ctx.signal to
//   abortable APIs (fetch). Hooks must not await app readiness (deadlock).
//   onInstalled / onStartup are best-effort conveniences: Chrome does not deliver them on every worker start
//   (and not at all to a worker that wakes for a message/alarm), so no feature may DEPEND on them — put
//   required setup in onEffectiveChange. Notification clicks reach the owner only while it is enabled; a stale
//   click for a disabled/pending owner just clears that notification. Alarms likewise reach only enabled owners.
import {
  FEATURES, FEATURE_NAMES, ALERT_FEATURES, EFFECTIVE_KEY, EFFECTIVE_SCHEMA, PREFERENCES_KEY,
  buildEffectiveRecord, createSettingsStore, isKnownFeature, sameEffective
} from './features.mjs';

import {createInformaticaGate} from './informatica-gate.mjs';
import {INF_RECIPIENTS_KEY, INF_RESOLVE_KEY, normalizeRecipients, normalizeResolve} from './user-lists.mjs';
export const MILO = 'milo';
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const SETTINGS_KEYS = new Set([PREFERENCES_KEY, ...ALERT_FEATURES.map(n => FEATURES[n].alert.migrationKey)]);

export function validateRegistry(modules) {
  const problems = [];
  const byName = new Map();
  const alarmOwner = new Map();
  const prefixes = [];
  for (const m of modules) {
    if (!m || !isKnownFeature(m.name)) { problems.push(`unknown feature module ${JSON.stringify(m?.name)}`); continue; }
    if (byName.has(m.name)) { problems.push(`duplicate feature module ${m.name}`); continue; }
    byName.set(m.name, m);
    for (const [type, h] of Object.entries(m.messages || {})) {
      if (typeof h !== 'function' && typeof h?.handle !== 'function') problems.push(`${m.name}: message handler ${type} is not a function`);
    }
    for (const a of m.alarms || []) {
      if (typeof a !== 'string' || !a) problems.push(`${m.name}: invalid alarm name`);
      else if (alarmOwner.has(a)) problems.push(`alarm ${a} owned by both ${alarmOwner.get(a)} and ${m.name}`);
      else alarmOwner.set(a, m.name);
    }
    for (const p of m.notificationPrefixes || []) {
      if (typeof p !== 'string' || !p) { problems.push(`${m.name}: invalid notification prefix`); continue; }
      for (const [q, owner] of prefixes) if (p.startsWith(q) || q.startsWith(p)) problems.push(`notification prefix ${p} (${m.name}) overlaps ${q} (${owner})`);
      prefixes.push([p, m.name]);
    }
  }
  if (problems.length) throw new Error(`sn_milo feature registry invalid:\n  - ${problems.join('\n  - ')}`);
  return {byName, alarmOwner, prefixes};
}

function originOf(url) { try { return new URL(url).origin; } catch { return 'null'; } }

export function createMiloBackground({chrome, origins, features = [], now = () => Date.now(), log = console, hookTimeoutMs = 5000}) {
  const informaticaGate = createInformaticaGate(chrome.storage.local);
  const registry = validateRegistry(features);
  const store = createSettingsStore({storage: chrome.storage.local, now});
  const featureStore = Object.freeze({serialize: store.serialize, completeSeed: store.completeSeed});
  // state.effective is the TRUE effective state (enforced by the worker); state.record is the last PERSISTED
  // miloEffectiveV1 record — the only thing ever handed to content. While a write is failing they may differ.
  let state = null;          // last successfully read {preferences, problems, migrations, effective, record|null}
  let maxRev = 0;            // highest rev ever persisted or attempted in this epoch (never reused)
  let maxRevEpoch = null;
  let writePending = false;  // the last effective write failed; rewrite (with a new rev) on the next reconcile
  let lastError = null;      // {message, at}
  let needsRetry = true;
  let entry = null;
  let retrying = null;
  let queue = Promise.resolve();
  const hookErrors = [];
  const serial = fn => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };

  const roleOf = origin => (origin === origins.production ? 'production' : origin === origins.test ? 'test' : null);
  const isEnabled = name => state?.effective?.[name]?.enabled === true;
  const effective = name => (state?.effective?.[name] ? {...state.effective[name]} : null);
  // Per-feature transition generations (see the feature API comment): one AbortController per generation; each
  // ctx gets its own controller that is aborted on its own timeout or when its generation ends.
  const generations = new Map(); // feature -> {gen, controller}
  const aborters = new WeakMap(); // ctx -> abort(reason)
  const generationOf = name => {
    if (!generations.has(name)) generations.set(name, {gen: 0, controller: new AbortController()});
    return generations.get(name);
  };
  function beginTransition(name) {
    const g = generationOf(name);
    g.controller.abort(new Error(`${name}: superseded by a newer transition`));
    generations.set(name, {gen: g.gen + 1, controller: new AbortController()});
  }
  function ctxFor(name) {
    const g = generationOf(name);
    const own = new AbortController();
    const abort = reason => { if (!own.signal.aborted) own.abort(reason); };
    if (g.controller.signal.aborted) abort(g.controller.signal.reason);
    else g.controller.signal.addEventListener('abort', () => abort(g.controller.signal.reason), {once: true});
    const ctx = {feature: name, chrome, origins, store: featureStore, log, isEnabled, effective, signal: own.signal,
      isCurrent: () => !own.signal.aborted && generationOf(name).gen === g.gen};
    aborters.set(ctx, abort);
    return ctx;
  }

  function recordHookError(feature, hook, error) {
    hookErrors.push({feature, hook, message: String(error?.message || error), at: now()});
    if (hookErrors.length > 20) hookErrors.shift();
    log.warn?.(`[SN-MILO] ${feature}.${hook} failed:`, error);
  }
  async function callHook(module, hook, ...args) {
    if (typeof module[hook] !== 'function') return;
    const ctx = args[args.length - 1];
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`timed out after ${hookTimeoutMs}ms`);
        aborters.get(ctx)?.(error); // the abandoned call keeps running: make it non-current
        reject(error);
      }, hookTimeoutMs);
    });
    try { await Promise.race([Promise.resolve().then(() => module[hook](...args)), timeout]); } catch (error) {
      recordHookError(module.name, hook, error);
    } finally { clearTimeout(timer); }
  }

  function validRecord(r) {
    return r && typeof r === 'object' && r.schema === EFFECTIVE_SCHEMA && typeof r.epoch === 'string' && r.epoch &&
      Number.isSafeInteger(r.rev) && r.rev > 0;
  }

  function reconcile(reason) {
    return serial(async () => {
      try { await restrictStorage(); } catch (error) {
        lastError = {message: `could not restrict storage to trusted contexts: ${error?.message || error}`, at: now()};
        needsRetry = true;
        log.warn?.('[SN-MILO]', lastError.message, state ? '- retaining last known state' : '- activation deferred');
        return state;
      }
      let snap;
      try { snap = await store.readState(); } catch (error) {
        lastError = {message: `settings read failed (${reason}): ${error?.message || error}`, at: now()};
        needsRetry = true;
        log.warn?.('[SN-MILO]', lastError.message, state ? '- retaining last known state' : '- activation deferred');
        return state;
      }
      const prev = state;
      const stored = validRecord(snap.storedRecord) ? snap.storedRecord : null;
      const persisted = stored || prev?.record || null;
      // Epochs are random, not ordered: a new one is minted only when nothing valid is persisted and this worker has
      // none (fresh profile / cleared or corrupted record); content accepts any different epoch (see controller.js).
      const epoch = persisted?.epoch || maxRevEpoch || crypto.randomUUID();
      if (maxRevEpoch !== epoch) { maxRevEpoch = epoch; maxRev = 0; }
      for (const r of [stored, prev?.record]) if (r?.epoch === epoch) maxRev = Math.max(maxRev, r.rev);
      let record = stored;
      let writeError = null;
      const desired = buildEffectiveRecord({effective: snap.effective, origins, epoch, rev: maxRev + 1, at: now()});
      // After a failed write, rewrite with a fresh rev even when the stored record already matches: content never
      // saw an unpersisted record, but a newer rev makes convergence unconditional.
      if (!stored || writePending || !sameEffective(stored, desired)) {
        maxRev = desired.rev; // reserve the rev even if the write fails (never reuse it for other content)
        try {
          await chrome.storage.local.set({[EFFECTIVE_KEY]: desired});
          record = desired;
          writePending = false;
          broadcast(record);
        } catch (error) {
          writePending = true;
          record = stored || prev?.record || null; // keep handing out the last PERSISTED record only
          writeError = {message: `could not persist effective state: ${error?.message || error}`, at: now()};
        }
      }
      state = {...snap, record};
      needsRetry = Boolean(writeError);
      lastError = writeError;
      for (const module of registry.byName.values()) {
        const next = state.effective[module.name];
        const before = prev?.effective?.[module.name];
        if (!before || before.enabled !== next.enabled || before.seedOnly !== next.seedOnly) {
          beginTransition(module.name);
          await callHook(module, 'onEffectiveChange', {...next}, before ? {...before} : undefined, ctxFor(module.name));
        }
      }
      return state;
    });
  }

  /** Push a newly PERSISTED record to every frame of every production/test tab (controller.js runtime.onMessage).
   *  Fire-and-forget: tabs without a receiver reject (ignored); content also re-requests as a backstop. */
  function broadcast(record) {
    const url = [origins.production, origins.test].filter(Boolean).map(o => `${o}/*`);
    const message = {feature: MILO, type: 'effective', effective: record};
    (async () => {
      const tabs = await chrome.tabs.query({url});
      await Promise.all(tabs.map(t => Promise.resolve().then(() => chrome.tabs.sendMessage(t.id, message)).catch(() => {})));
    })().catch(() => {});
  }

  // chrome.storage.local is restricted to trusted extension contexts (worker, options page): content scripts can
  // neither read nor write it (verified in Vivaldi 8.2: "Access to storage is not allowed from this context.").
  // Kicked off synchronously by install() at worker evaluation; every reconciliation awaits it before reading
  // settings, and a failure fails closed (fresh worker: settings-unavailable) and is retried on the next entry.
  let access = null;
  let accessRestricted = false;
  function restrictStorage() {
    if (accessRestricted) return Promise.resolve();
    if (!access) {
      let p;
      try { p = Promise.resolve(chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'})); } catch (error) { p = Promise.reject(error); }
      access = p.then(() => { accessRestricted = true; }, error => { access = null; throw error; });
      access.catch(() => {});
    }
    return access;
  }

  /** The single readiness gate every entry point awaits. Never rejects; resolves to state or null. */
  function ensureReady() {
    if (state && !needsRetry) return Promise.resolve(state);
    if (state) {
      if (!retrying) retrying = reconcile('retry').finally(() => { retrying = null; });
      // A warm worker answers from its last known state while the retry runs — unless nothing was ever persisted
      // (no record to hand out yet): then wait for this one bounded retry.
      return state.record ? Promise.resolve(state) : retrying;
    }
    if (!entry) entry = reconcile('entry').finally(() => { entry = null; });
    return entry;
  }

  async function idle() { let q; do { q = queue; await q; } while (q !== queue); }

  function status() {
    const features = {};
    for (const name of FEATURE_NAMES) {
      const f = {label: FEATURES[name].label, origins: [...FEATURES[name].origins], registered: registry.byName.has(name),
        preference: state ? state.preferences[name] : null, enabled: isEnabled(name),
        seedOnly: state?.effective?.[name]?.seedOnly === true, reason: state ? state.effective[name].reason : 'settings not loaded yet'};
      if (FEATURES[name].alert) f.migration = state ? {...state.migrations[name]} : null;
      features[name] = f;
    }
    return {ready: Boolean(state), error: lastError ? {...lastError} : null, warnings: state ? [...state.problems] : [],
      hookErrors: hookErrors.map(e => ({...e})), record: state?.record ? {epoch: state.record.epoch, rev: state.record.rev} : null, features};
  }

  /** status() plus per-feature `statusLine` strings from modules exposing `describeStatus(ctx)` (async, bounded by
   *  hookTimeoutMs, failures recorded like hook errors and never fatal): the options page shows them verbatim. */
  async function statusWithDetail() {
    const st = status();
    await Promise.all([...registry.byName.values()].filter(m => typeof m.describeStatus === 'function').map(async module => {
      const ctx = ctxFor(module.name);
      let timer;
      try {
        const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${hookTimeoutMs}ms`)), hookTimeoutMs); });
        const line = await Promise.race([Promise.resolve().then(() => module.describeStatus(ctx)), timeout]);
        if (typeof line === 'string' && line && st.features[module.name]) st.features[module.name].statusLine = line.slice(0, 200);
      } catch (error) { recordHookError(module.name, 'describeStatus', error); } finally { clearTimeout(timer); }
    }));
    st.hookErrors = hookErrors.map(e => ({...e}));
    return st;
  }

  // ---- milo control handlers ------------------------------------------------------------------------------
  const afterChange = async result => { await reconcile('control'); return {...result, status: await statusWithDetail()}; };
  const documentKey = sender => Number.isInteger(sender.tab?.id) && sender.frameId === 0 && typeof sender.documentId === 'string' ? `${sender.tab.id}:${sender.documentId}` : null;
  const MILO_HANDLERS = {
    'informatica-run-start': {senders: 'content', async handle(msg, sender) {
      if (!isEnabled('informatica-button')) return {ok:false, error:'feature-disabled'};
      // The people to add are user data (options page); refuse BEFORE taking the run lease when none are configured.
      const {emails} = normalizeRecipients((await chrome.storage.local.get(INF_RECIPIENTS_KEY))[INF_RECIPIENTS_KEY]);
      if (!emails.length) return {ok:false, error:'informatica-no-recipients: add them on the options page'};
      const resolved = normalizeResolve((await chrome.storage.local.get(INF_RESOLVE_KEY))[INF_RESOLVE_KEY]);
      const started = await informaticaGate.start(msg.lease, documentKey(sender));
      return started.ok ? {...started, emails, resolve: resolved.enabled ? {notes: resolved.notes} : null} : started;
    }},
    'informatica-run-end': {senders: 'content', handle: (msg, sender) => informaticaGate.end(msg.lease, documentKey(sender))},
    'get-effective': {senders: 'content', async handle() {
      const s = await ensureReady();
      return s?.record ? {ok: true, effective: s.record} : {ok: false, error: 'settings-unavailable'};
    }},
    'get-status': {senders: 'options', async handle() { await ensureReady(); return {ok: true, status: await statusWithDetail()}; }},
    'set-preference': {senders: 'options', async handle(msg) {
      await store.setPreference(msg.name, msg.enabled);
      return afterChange({ok: true});
    }},
    'import-dedupe': {senders: 'options', async handle(msg) {
      const r = await store.importDedupe(msg.target, msg.snapshots);
      return r.ok ? afterChange(r) : r;
    }},
    'choose-fallback': {senders: 'options', async handle(msg) {
      const r = await store.chooseFallback(msg.target, msg.choice);
      return r.ok ? afterChange(r) : r;
    }}
  };

  function senderRoles(sender) {
    const list = [];
    if (typeof sender.origin === 'string') list.push(sender.origin);
    if (typeof sender.url === 'string') list.push(originOf(sender.url));
    if (!list.length) return null;
    if (sender.tab) {
      if (typeof sender.tab.url !== 'string') return null; // tab present but url hidden/missing: fail closed
      list.push(originOf(sender.tab.url));
    }
    const roles = new Set(list.map(roleOf));
    return roles.has(null) ? null : roles;
  }
  const isOptionsSender = sender => typeof sender.url === 'string' &&
    sender.url.replace(/[?#].*$/, '') === chrome.runtime.getURL('options.html');

  function route(message, sender) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.feature !== 'string' || typeof message.type !== 'string') return {reject: 'invalid-message'};
    let handler;
    let feature = null;
    if (message.feature === MILO) {
      if (!has(MILO_HANDLERS, message.type)) return {reject: 'unknown-message'};
      handler = MILO_HANDLERS[message.type];
    } else {
      const module = registry.byName.get(message.feature);
      if (!module || !has(module.messages, message.type)) return {reject: 'unknown-message'};
      feature = module.name;
      const h = module.messages[message.type];
      handler = typeof h === 'function' ? {handle: h} : h;
    }
    if (!sender || sender.id !== chrome.runtime.id) return {reject: 'foreign-sender'};
    if (handler.senders === 'options') {
      if (!isOptionsSender(sender)) return {reject: 'wrong-origin'};
    } else {
      const roles = senderRoles(sender);
      const infRun = message.feature === MILO && message.type.startsWith('informatica-run-');
      const allowed = infRun ? FEATURES['informatica-button'].origins : feature ? FEATURES[feature].origins : ['production', 'test'];
      if (infRun && sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active') return {reject:'inactive-document'};
      if (!roles || [...roles].some(r => !allowed.includes(r))) return {reject: 'wrong-origin'};
      if (feature && sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active') return {reject: 'inactive-document'};
    }
    return {handler, feature};
  }

  function onMessage(message, sender, sendResponse) {
    const r = route(message, sender);
    const respond = value => { try { sendResponse(value); } catch {} };
    if (r.reject) { respond({ok: false, error: r.reject}); return false; }
    (async () => {
      const s = await ensureReady();
      if (r.feature) {
        if (!s) return {ok: false, error: 'settings-unavailable'};
        const eff = s.effective[r.feature];
        if (!eff.enabled && !(r.handler.allowSeedOnly && eff.seedOnly)) return {ok: false, error: 'feature-disabled'};
        return r.handler.handle(message, sender, ctxFor(r.feature));
      }
      return r.handler.handle(message, sender);
    })().then(respond, error => respond({ok: false, error: String(error?.message || error)}));
    return true;
  }

  async function onAlarm(alarm) {
    const owner = registry.alarmOwner.get(alarm?.name);
    if (!owner) return;
    await ensureReady();
    if (!isEnabled(owner)) return;
    await callHook(registry.byName.get(owner), 'onAlarm', alarm, ctxFor(owner));
  }

  async function onNotificationClicked(id) {
    if (typeof id !== 'string') return;
    const hit = registry.prefixes.find(([p]) => id.startsWith(p));
    if (!hit) return;
    await ensureReady();
    if (!isEnabled(hit[1])) { try { await chrome.notifications.clear(id); } catch {} return; }
    await callHook(registry.byName.get(hit[1]), 'onNotificationClicked', id, ctxFor(hit[1]));
  }

  async function dispatchLifecycle(hook, ...args) {
    await ensureReady();
    await serial(async () => {
      for (const module of registry.byName.values()) if (isEnabled(module.name)) await callHook(module, hook, ...args, ctxFor(module.name));
    });
  }
  const onInstalled = details => dispatchLifecycle('onInstalled', details || {});
  const onStartup = () => dispatchLifecycle('onStartup');

  function onStorageChanged(changes, area) {
    if (area !== 'local' || !changes) return;
    if (!Object.keys(changes).some(k => SETTINGS_KEYS.has(k))) return;
    reconcile('storage-change').catch(() => {});
  }

  /** Register every listener synchronously. Call exactly once, at worker module evaluation. */
  function install() {
    restrictStorage().catch(() => {});
    chrome.runtime.onMessage.addListener(onMessage);
    chrome.runtime.onInstalled.addListener(details => { onInstalled(details).catch(() => {}); });
    chrome.runtime.onStartup.addListener(() => { onStartup().catch(() => {}); });
    chrome.alarms?.onAlarm.addListener(alarm => { onAlarm(alarm).catch(() => {}); });
    chrome.notifications?.onClicked.addListener(id => { onNotificationClicked(id).catch(() => {}); });
    chrome.storage.onChanged.addListener(onStorageChanged);
  }

  return {informaticaGate, install, ensureReady, idle, status, isEnabled, effective, store, onMessage, onAlarm, onNotificationClicked,
    onInstalled, onStartup, onStorageChanged,
    importDedupe: async (feature, snapshots) => { const r = await store.importDedupe(feature, snapshots); if (r.ok) await reconcile('control'); return r; },
    chooseFallback: async (feature, choice) => { const r = await store.chooseFallback(feature, choice); if (r.ok) await reconcile('control'); return r; }};
}
