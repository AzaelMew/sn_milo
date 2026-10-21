// Critical alert — service-worker feature module. Migrated from the original standalone critical alert extension 3.3 background.js
//. Matching, dedupe key format/retention, notification
// texts/ids/click action, diagnostic log key + ring size, health timing and the row queue are unchanged.
// Milo changes (see README "Alerts"):
//   - no top-level side effects: createCriticalAlert() returns a router feature module (shared/router.mjs). The
//     original top-level listener registration, startup injection and `alarms.create` moved into hooks that run
//     under the router's readiness gate and only while the feature is effectively enabled (or seeding);
//   - namespaced worker state (collision inventory): crit.healthStateV1, crit.lastSuccessfulPollAt,
//     crit.lastPollAt (the content heartbeat, now owned by the worker), health notification snCritHealth;
//     unchanged: seenMatchesV4, diagnosticLogsV1, alarm snTkHealthCheck, row notifications snTk-<sys_id>;
//   - content scripts cannot use chrome.storage any more (TRUSTED_CONTEXTS), so the multi-tab single-poller
//     heartbeat election moved here: `claim-poll` → {granted} with the original threshold (POLL_MS - 15 s) and
//     clock-jump tolerance (a future stamp is stale); `release-poll` resets it (every content failure path);
//     claims are serialized in this worker, which also closes the original's simultaneous-claim race;
//   - every side effect re-checks ctx.isCurrent() + enabled state after each await, so queued or late work never
//     notifies after a disable; disable clears the health alarm + owned health notification and resets the health
//     grace (dedupe history is never cleared);
//   - seed-silently migration: while the feature is `seedOnly`, a validated, complete (no partial-table warning)
//     successful poll is committed through ctx.store.completeSeed() (dedupe set + ready marker in one write,
//     serialized with the row queue); nothing is notified; never reseeds once ready;
//   - recovery injection ("watchdog"): into open production tabs only, only when this extension instance has no live
//     poller in the tab's isolated world (probe), injecting shared/controller.js, shared/main-settings.js and the
//     feature scripts by their feature-relative paths. Never the test host.
import {RULES_KEY, normalizeRules, enabledRules, queryRules, matchingRules} from '../../shared/rules.mjs';

const FEATURE = 'critical-alert';
const DIR = 'features/critical-alert';
const ICON = `${DIR}/icons/alert.png`;
const SEEN_KEY = 'seenMatchesV4';
const LOG_KEY = 'diagnosticLogsV1';
const LOG_LIMIT = 200;
const TEST_MODE = false;
const LAST_SUCCESS_KEY = 'crit.lastSuccessfulPollAt';
const SEED_ATTEMPT_KEY = 'crit.lastSeedAttempt';
const HEARTBEAT_KEY = 'crit.lastPollAt';
const HEALTH_ALARM = 'snTkHealthCheck';
const HEALTH_KEY = 'crit.healthStateV1';
const HEALTH_NOTIFICATION_ID = 'snCritHealth';
const ROW_PREFIX = 'snTk-';
const HEALTH_STALE_MS = 360000;
const POLL_MS = 120000; // content poll interval; heartbeat window = POLL_MS - 15 s (original)
const HEARTBEAT_WINDOW_MS = POLL_MS - 15000;
const HEALTH_FAILURE_EVENTS = new Set(['poll-failed', 'poll-timeout', 'poll-start-failed', 'background-failed']);
const PROBE_GLOBAL = '__snTkController';
const INJECT = [
  {files: ['shared/controller.js'], world: 'ISOLATED'},
  {files: ['shared/main-settings.js'], world: 'MAIN'},
  {files: [`${DIR}/page.js`], world: 'MAIN'},
  {files: [`${DIR}/content.js`], world: 'ISOLATED'}
];

export const CRITICAL_ALERT = Object.freeze({FEATURE, SEEN_KEY, LOG_KEY, LAST_SUCCESS_KEY, HEARTBEAT_KEY, HEALTH_ALARM,
  HEALTH_KEY, HEALTH_NOTIFICATION_ID, ROW_PREFIX, HEALTH_STALE_MS, POLL_MS, HEARTBEAT_WINDOW_MS, ICON, INJECT});

/** "ServiceNow Critical Alert (<Instance>)": the original title named the instance; derived from the configured
 *  production origin so no host name is committed. */
function productLabel(origin) {
  let label = '';
  try { label = new URL(origin).hostname.split('.')[0]; } catch {}
  return `ServiceNow Critical Alert${label ? ` (${label[0].toUpperCase()}${label.slice(1)})` : ''}`;
}

export function createCriticalAlert({now = () => Date.now(), console = globalThis.console} = {}) {
  let healthWrites = Promise.resolve();
  let logWrites = Promise.resolve();
  let heartbeat = Promise.resolve();
  let injecting = null;

  function log(chrome, level, event, details = {}) {
    console[level]?.(`[SN-TK] ${event}`, details);
    logWrites = logWrites.then(async () => {
      const data = await chrome.storage.local.get(LOG_KEY);
      const logs = Array.isArray(data[LOG_KEY]) ? data[LOG_KEY] : [];
      await chrome.storage.local.set({
        [LOG_KEY]: [...logs, {at: new Date(now()).toISOString(), level, event, ...details}].slice(-LOG_LIMIT)
      });
    }).catch(error => console.error('[SN-TK] could not persist diagnostic log:', error));
    return logWrites;
  }

  const base = ctx => ctx.origins.production;
  const validSender = (sender, ctx) => Boolean(base(ctx)) && sender?.tab?.url?.startsWith(`${base(ctx)}/`) === true;
  /** Rules are user data (options page → chrome.storage.local); read fresh on every use so edits apply at once. */
  async function loadRules(chrome) {
    return normalizeRules((await chrome.storage.local.get(RULES_KEY))[RULES_KEY]);
  }
  const matchKey = row => `${row.sys_id}|${row.priority}|${row.state}|${row.account}`;
  const live = ctx => ctx.isCurrent() && ctx.isEnabled(FEATURE);
  const seeding = ctx => ctx.isCurrent() && ctx.effective(FEATURE)?.seedOnly === true;

  async function getSeen(chrome) {
    const data = await chrome.storage.local.get(SEEN_KEY);
    return new Set(Array.isArray(data[SEEN_KEY]) ? data[SEEN_KEY] : []);
  }

  /** Original handleRows, inside the feature's serialized queue (ctx.store.serialize). Incremental save: the seen
   *  set is written after EVERY notification, so a mid-batch failure or disable never loses earlier successes. */
  async function handleRows(rows, sender, ctx) {
    const {chrome} = ctx;
    if (!live(ctx)) return {ok: false, error: 'feature-disabled'};
    if (!validSender(sender, ctx) || !Array.isArray(rows)) {
      await log(chrome, 'warn', 'rows-rejected', {
        sender: sender?.tab?.url || 'unknown',
        reason: Array.isArray(rows) ? 'unexpected sender' : 'rows is not an array'
      });
      return {ok: true};
    }
    const seen = await getSeen(chrome);
    if (!live(ctx)) return {ok: false, error: 'feature-disabled'};
    const {rules} = await loadRules(chrome);
    if (!live(ctx)) return {ok: false, error: 'feature-disabled'};
    const ruleNames = new Map();
    const matches = rows.filter(row => { const hit = matchingRules(row, rules); if (hit.length) ruleNames.set(row.sys_id, hit.map(x => x.name)); return hit.length > 0; });
    const fresh = matches.filter(row => !seen.has(matchKey(row)));
    await log(chrome, 'info', 'poll-result', {
      rowCount: rows.length,
      matches: matches.map(row => ({number: row.number, sysId: row.sys_id, account: row.account,
        status: seen.has(matchKey(row)) ? 'already-seen' : 'new'}))
    });
    for (const row of fresh) {
      if (!live(ctx)) { await log(chrome, 'info', 'notifications-held', {reason: 'disabled during row handling'}); return {ok: false, error: 'feature-disabled'}; }
      const notificationId = await chrome.notifications.create(`${ROW_PREFIX}${row.sys_id}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL(ICON),
        title: `SOC Jono Alert${TEST_MODE ? ' (TEST MODE)' : ''}`,
        message: `${row.number} - ${row.priority}, ${row.state}` +
          (row.account ? `\nAccount: ${row.account}` : '') +
          `\nRule: ${ruleNames.get(row.sys_id).join(', ')}` +
          (row.short_description ? `\n${row.short_description.slice(0, 120)}` : ''),
        requireInteraction: true,
        priority: 2
      });
      seen.add(matchKey(row));
      await chrome.storage.local.set({[SEEN_KEY]: [...seen]}); // uncapped, never pruned (original retention)
      await log(chrome, 'info', 'notification-created', {number: row.number, sysId: row.sys_id, account: row.account, notificationId});
    }
    if (!live(ctx)) return {ok: false, error: 'feature-disabled'};
    await chrome.storage.local.set({[LAST_SUCCESS_KEY]: now()});
    return {ok: true};
  }

  /** Last seed attempt (status / options diagnostics): {at, ok, reason?}. Best effort. */
  async function noteSeedAttempt(chrome, result) {
    try { await chrome.storage.local.set({[SEED_ATTEMPT_KEY]: {at: now(), ...result}}); } catch {}
  }

  /** seed-silently: commit the matches of ONE validated, complete, successful poll without notifying. */
  async function seedRows(msg, sender, ctx) {
    const {chrome} = ctx;
    if (!seeding(ctx)) return {ok: false, error: 'feature-disabled'};
    if (!validSender(sender, ctx) || !Array.isArray(msg.rows)) {
      await log(chrome, 'warn', 'rows-rejected', {sender: sender?.tab?.url || 'unknown', reason: Array.isArray(msg.rows) ? 'unexpected sender' : 'rows is not an array', seeding: true});
      return {ok: true};
    }
    if (msg.complete !== true) {
      await log(chrome, 'warn', 'seed-skipped', {reason: 'partial poll result (a table query failed); waiting for a complete poll'});
      await noteSeedAttempt(chrome, {ok: false, reason: 'partial-result'});
      // Answer ok: a partial result is not a worker failure — the content script keeps its normal poll interval
      // (no heartbeat release, no 10 s retry storm, no health failure); the seed simply waits for a complete poll.
      return {ok: true, seeded: 0, reason: 'partial-result'};
    }
    const {rules} = await loadRules(chrome);
    const keys = [...new Set(msg.rows.filter(row => matchingRules(row, rules).length).map(matchKey))];
    if (!seeding(ctx)) return {ok: false, error: 'feature-disabled'};
    const r = await ctx.store.completeSeed(FEATURE, keys); // serialized on the feature queue with handleRows
    if (!r.ok) { await log(chrome, 'warn', 'seed-failed', {error: r.error}); await noteSeedAttempt(chrome, {ok: false, reason: String(r.error || 'seed-failed')}); return {ok: false, error: r.error}; }
    await log(chrome, 'info', 'seed-completed', {rowCount: msg.rows.length, seeded: keys.length, changed: r.changed === true});
    await chrome.storage.local.set({[LAST_SUCCESS_KEY]: now()});
    await noteSeedAttempt(chrome, {ok: true});
    void updateHealth(chrome, state => { if (!state.failure) return null; const {failure, ...rest} = state; return rest; }); // stale seeding failure text
    return {ok: true, seeded: r.changed === true ? keys.length : 0};
  }

  // ---- heartbeat leader election (moved from content.js) ----------------------------------------------------
  function serialHeartbeat(fn) { const run = heartbeat.then(fn); heartbeat = run.catch(() => {}); return run; }
  const claimable = ctx => ctx.isCurrent() && (ctx.isEnabled(FEATURE) || ctx.effective(FEATURE)?.seedOnly === true);
  function claimPoll(msg, sender, ctx) {
    return serialHeartbeat(async () => {
      if (!claimable(ctx)) return {ok: false, error: 'feature-disabled'};
      // ponytail: worker-side heartbeat leader election (original semantics; claims serialized here).
      const {[HEARTBEAT_KEY]: lastPollAt = 0} = await ctx.chrome.storage.local.get(HEARTBEAT_KEY);
      const age = now() - (Number(lastPollAt) || 0);
      if (age >= 0 && age < HEARTBEAT_WINDOW_MS) return {ok: true, granted: false};
      if (!claimable(ctx)) return {ok: false, error: 'feature-disabled'};
      await ctx.chrome.storage.local.set({[HEARTBEAT_KEY]: now()});
      void ensureAlarm(ctx);
      return {ok: true, granted: true};
    });
  }
  function releasePoll(msg, sender, ctx) {
    return serialHeartbeat(async () => {
      await ctx.chrome.storage.local.set({[HEARTBEAT_KEY]: 0});
      return {ok: true};
    });
  }

  // ---- health monitor (original logic, namespaced keys) ------------------------------------------------------
  function updateHealth(chrome, change) {
    healthWrites = healthWrites.then(async () => {
      const state = (await chrome.storage.local.get(HEALTH_KEY))[HEALTH_KEY] || {};
      const next = await change({...state});
      if (next) await chrome.storage.local.set({[HEALTH_KEY]: next});
    }).catch(error => console.warn('[SN-TK] health update failed:', error?.message || error));
    return healthWrites;
  }
  const noteHealthFailure = (chrome, event, detail) => updateHealth(chrome, state => ({...state, failure: {at: now(), event, detail}}));
  const markBrowserStart = (chrome, ctx, clearFailure = false) => updateHealth(chrome, state => {
    if (ctx && !ctx.isCurrent()) return null;
    const next = {...state, startedAt: now(), alerted: false};
    if (clearFailure) delete next.failure; // becoming ready: seeding-time failure text is stale
    return next;
  });
  function describeOutage(state) {
    if (state.failure) return `Last error (${new Date(state.failure.at).toLocaleTimeString()}): ${state.failure.event} ${state.failure.detail}`.slice(0, 200);
    return 'No poll has completed. Check that you are logged in to ServiceNow.';
  }
  function checkHealth(ctx) {
    const {chrome} = ctx;
    return updateHealth(chrome, async state => {
      const last = Number((await chrome.storage.local.get(LAST_SUCCESS_KEY))[LAST_SUCCESS_KEY]) || 0;
      const t = now();
      const tabCount = (await chrome.tabs.query({url: `${base(ctx)}/*`})).length;
      if (!live(ctx)) return null; // disabled meanwhile: no notification, no state change
      // Only watch while a ServiceNow tab is open; the grace period restarts when one opens.
      if (!tabCount) return {...state, startedAt: t, alerted: false};
      if (!state.startedAt) state.startedAt = t;
      const reference = Math.max(last, state.startedAt);
      const stale = t - reference > HEALTH_STALE_MS;
      const label = productLabel(base(ctx));
      if (stale && !state.alerted) {
        await chrome.notifications.create(HEALTH_NOTIFICATION_ID, {
          type: 'basic', iconUrl: chrome.runtime.getURL(ICON), title: `${label} stopped working`,
          message: `No successful poll for ${Math.round((t - reference) / 60000)} min. ${describeOutage(state)}`,
          requireInteraction: true, priority: 2
        });
        await log(chrome, 'error', 'health-alert', {lastSuccessAt: last, tabCount});
        state.alerted = true;
      } else if (!stale && state.alerted) {
        await chrome.notifications.create(HEALTH_NOTIFICATION_ID, {
          type: 'basic', iconUrl: chrome.runtime.getURL(ICON), title: `${label} is working again`,
          message: 'Polling has resumed.', priority: 0
        });
        await log(chrome, 'info', 'health-recovered', {lastSuccessAt: last});
        state.alerted = false;
        delete state.failure;
      }
      return state;
    });
  }

  // ---- recovery injection ------------------------------------------------------------------------------------
  async function hasLivePoller(chrome, tabId) {
    try {
      const results = await chrome.scripting.executeScript({target: {tabId}, world: 'ISOLATED',
        func: name => { const c = globalThis[name]; return Boolean(c && c.retired === false); }, args: [PROBE_GLOBAL]});
      return results?.[0]?.result === true;
    } catch { return false; }
  }
  async function injectIntoOpenTabs(ctx, reason) {
    const {chrome} = ctx;
    const active = () => ctx.isCurrent() && (ctx.isEnabled(FEATURE) || ctx.effective(FEATURE)?.seedOnly === true);
    if (!active() || !base(ctx)) return {injected: 0};
    const tabs = await chrome.tabs.query({url: `${base(ctx)}/*`});
    let injected = 0;
    for (const tab of tabs) {
      if (!tab.id || !active()) continue;
      let origin = null;
      try { origin = new URL(tab.url).origin; } catch {}
      if (origin !== base(ctx)) continue; // never the test host / any other origin
      if (await hasLivePoller(chrome, tab.id)) continue;
      try {
        for (const step of INJECT) {
          if (!active()) return {injected};
          await chrome.scripting.executeScript({target: {tabId: tab.id}, files: step.files, world: step.world});
        }
        injected++;
        await log(chrome, 'info', 'dashboard-attached', {tabId: tab.id, reason});
      } catch (error) {
        await log(chrome, 'warn', 'dashboard-attach-failed', {tabId: tab.id, error: error?.message || String(error)});
      }
    }
    if (tabs.length) await log(chrome, 'info', 'dashboard-scan', {tabCount: tabs.length, injected, reason});
    return {injected};
  }
  /** Never awaited by hooks (bounded hook time); one scan at a time; failures logged, never unhandled. */
  let injectingCtx = null;
  function safeInject(ctx, reason) {
    if (injecting && injectingCtx?.isCurrent()) return injecting; // a current scan is already running
    const run = (injecting || Promise.resolve()).then(() => injectIntoOpenTabs(ctx, reason)).catch(error => {
      console.warn('[SN-TK] recovery injection failed:', error?.message || error);
      return {injected: 0, error: String(error?.message || error)};
    });
    injecting = run;
    injectingCtx = ctx;
    run.finally(() => { if (injecting === run) { injecting = null; injectingCtx = null; } });
    return run;
  }

  // ---- lifecycle hooks -----------------------------------------------------------------------------------------
  /** Self-healing: a timed-out enable hook may never have reached alarms.create. Cheap; called on claims/startup. */
  async function ensureAlarm(ctx) {
    try {
      if (!live(ctx) || !ctx.chrome.alarms) return;
      const existing = await ctx.chrome.alarms.get(HEALTH_ALARM);
      if (!existing && live(ctx)) await ctx.chrome.alarms.create(HEALTH_ALARM, {periodInMinutes: 1});
    } catch (error) { console.warn('[SN-TK] could not ensure the health alarm:', error?.message || error); }
  }

  async function onEffectiveChange(next, prev, ctx) {
    const {chrome} = ctx;
    if (next.enabled) {
      // re-enable (a real transition, not a worker wake): fresh health grace; dedupe untouched
      if (prev && !prev.enabled) await markBrowserStart(chrome, ctx, true);
      if (!ctx.isCurrent()) return;
      const existing = await chrome.alarms?.get?.(HEALTH_ALARM);
      if (!ctx.isCurrent()) return;
      if (!existing) await chrome.alarms?.create(HEALTH_ALARM, {periodInMinutes: 1});
      if (!ctx.isCurrent()) return;
      safeInject(ctx, prev ? 'enabled' : 'worker-start');
      return;
    }
    // disabled / pending-migration / seeding: no health monitoring, no owned health notification
    await chrome.alarms?.clear(HEALTH_ALARM);
    if (!ctx.isCurrent()) return;
    try { await chrome.notifications.clear(HEALTH_NOTIFICATION_ID); } catch {}
    if (!ctx.isCurrent()) return;
    const data = await chrome.storage.local.get([HEALTH_KEY, HEARTBEAT_KEY]);
    if (!ctx.isCurrent()) return;
    const reset = {};
    if (data[HEALTH_KEY] !== undefined && JSON.stringify(data[HEALTH_KEY]) !== '{}') reset[HEALTH_KEY] = {}; // grace restarts at the next enabled check
    if (!next.seedOnly && Number(data[HEARTBEAT_KEY])) reset[HEARTBEAT_KEY] = 0; // nobody polls while off
    if (Object.keys(reset).length) await chrome.storage.local.set(reset);
    if (next.seedOnly && ctx.isCurrent()) safeInject(ctx, 'seeding');
  }

  async function onAlarm(alarm, ctx) {
    if (alarm?.name !== HEALTH_ALARM) return;
    await checkHealth(ctx);
  }

  async function onNotificationClicked(id, ctx) {
    const match = /^snTk-([0-9a-f]{32})$/i.exec(id);
    if (match && ctx.isCurrent()) await ctx.chrome.tabs.create({url: `${base(ctx)}/task.do?sys_id=${match[1]}`});
  }

  async function status(chrome, origins) {
    return {
      rules: (({rules, error}) => ({error: error || null, enabled: enabledRules(rules).map(x => ({name: x.name, priority: x.priority, hasAccount: Boolean(x.account)}))}))(await loadRules(chrome)),
      dashboardTabs: (await chrome.tabs.query({url: `${origins.production}/*`})).length,
      seenMatches: (await getSeen(chrome)).size,
      health: (await chrome.storage.local.get(HEALTH_KEY))[HEALTH_KEY] || null,
      lastSeedAttempt: (await chrome.storage.local.get(SEED_ATTEMPT_KEY))[SEED_ATTEMPT_KEY] || null,
      lastSuccessfulPollAt: (await chrome.storage.local.get(LAST_SUCCESS_KEY))[LAST_SUCCESS_KEY] || null,
      recentLogs: (await chrome.storage.local.get(LOG_KEY))[LOG_KEY]?.slice(-20) || []
    };
  }

  return {
    name: FEATURE,
    alarms: [HEALTH_ALARM],
    notificationPrefixes: [ROW_PREFIX, HEALTH_NOTIFICATION_ID],
    messages: {
      // original snTkLog: content diagnostics; health-failure events feed the outage text
      log: {allowSeedOnly: true, async handle(msg, sender, ctx) {
        if (!validSender(sender, ctx)) return {ok: false, error: 'unexpected sender'};
        const event = typeof msg.event === 'string' && /^[a-z-]{1,40}$/.test(msg.event) ? msg.event : 'invalid-content-log';
        const detail = typeof msg.detail === 'string' ? msg.detail.slice(0, 500) : '';
        if (HEALTH_FAILURE_EVENTS.has(event) && ctx.isCurrent()) void noteHealthFailure(ctx.chrome, event, detail);
        await log(ctx.chrome, msg.level === 'warn' ? 'warn' : 'info', `content-${event}`, {detail});
        return {ok: true};
      }},
      // original snTkRows: serialized per feature (shared with dedupe import / completeSeed)
      rows: {allowSeedOnly: true, async handle(msg, sender, ctx) {
        if (!ctx.isEnabled(FEATURE)) return seedRows(msg, sender, ctx);
        try {
          return await ctx.store.serialize(FEATURE, () => handleRows(msg.rows, sender, ctx));
        } catch (error) {
          await log(ctx.chrome, 'error', 'row-handling-failed', {error: error?.message || String(error)});
          return {ok: false, error: error?.message || String(error)};
        }
      }},
      // the poller asks for the conditions before every poll (content scripts cannot read chrome.storage)
      'get-rules': {allowSeedOnly: true, async handle(msg, sender, ctx) {
        if (!validSender(sender, ctx)) return {ok: false, error: 'unexpected sender'};
        return {ok: true, rules: queryRules((await loadRules(ctx.chrome)).rules)};
      }},
      'claim-poll': {allowSeedOnly: true, handle: claimPoll},
      'release-poll': {allowSeedOnly: true, handle: releasePoll}
    },
    onEffectiveChange,
    onAlarm,
    onNotificationClicked,
    onStartup: async ctx => { await markBrowserStart(ctx.chrome, ctx); await ensureAlarm(ctx); },
    onInstalled: (details, ctx) => { safeInject(ctx, `installed:${details?.reason || ''}`); },
    // test / status helpers (not part of the router API)
    status,
    injectNow: (ctx, reason = 'manual') => safeInject(ctx, reason),
    idle: async () => { await injecting; await healthWrites; await logWrites; await heartbeat; }
  };
}
