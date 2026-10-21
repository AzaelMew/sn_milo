// sn_milo ISOLATED-world settings controller (classic content script, IIFE: no global lexical declarations).
// Loaded statically on the configured production and test origins, document_start, all frames. It stays alive
// while features are off, owns no feature behaviour, and:
//   - receives EFFECTIVE state (never raw preferences) only from the service worker: a {feature:'milo',
//     type:'get-effective'} request (which also wakes/readies the worker) at start, on visibilitychange→visible
//     and every 30 s while the document is visible (backstop; skipped while hidden), plus worker pushes {feature:'milo', type:'effective', effective} sent with
//     chrome.tabs.sendMessage to all frames of production/test tabs whenever a new record is persisted. Pushes are
//     accepted only from this extension's worker (sender.id === chrome.runtime.id, no sender.tab). It never
//     touches chrome.storage: the worker restricts storage.local to trusted contexts (setAccessLevel), so content
//     scripts cannot read or write settings;
//   - accepts a record only when it is newer (same epoch and higher rev, or a different epoch), so a stale async
//     result can never re-enable a feature that a later record disabled. Epochs are random (crypto.randomUUID in
//     the worker) and NOT orderable: a new one is minted only when no valid record is persisted (fresh profile,
//     cleared/corrupted storage), so any different epoch is accepted. Accepted risk: a get-effective response
//     carrying the OLD epoch that arrives after a new-epoch push would be taken; it self-heals on the next push,
//     visibilitychange or 30 s backstop (the worker always answers with its current record);
//   - scopes features to this frame's origin (record.origins[location.origin]); everything else is off;
//   - runs ISOLATED feature subscribers via an idempotent start/stop API (globalThis.__snMiloController);
//     subscribers may also pass update(state), called whenever their known state first becomes known or changes
//     (including unknown → disabled and after a same-world handoff), never while unknown;
//     controller.ready resolves true once a record was accepted, follows the successor's ready on a same-world
//     handoff, or resolves false if the controller retires otherwise first;
//   - relays effective state to MAIN-world scripts with a versioned window.postMessage protocol:
//       controller → MAIN {source:'sn-milo-controller', protocol:'sn-milo-settings', version:1, type:'settings',
//                          controllerId, seq, epoch, rev, features:{<feature>:{enabled, seedOnly}}}
//       (epoch/rev of the accepted miloEffectiveV1 record, so MAIN can refuse an older record from another controller)
//       MAIN → controller {source:'sn-milo-main', protocol:'sn-milo-settings', version:1, type:'request'}
//     Ready/request handshake: the controller broadcasts as soon as it knows the state (ready) and again on every
//     change; MAIN scripts that start later send `request` and get a fresh broadcast. Both directions check
//     event.source === window and event.origin === location.origin, and target the exact origin.
//     ponytail: accepted risk — same-origin MAIN scripts (the page itself) share window and can observe or forge
//     these messages. This is a settings relay, not an authentication boundary; privileged enforcement (origins,
//     enabled state, side effects) lives in the service worker.
// Takeover / retirement:
//   - same extension instance (watchdog reinjection): the new controller sees globalThis.__snMiloController in
//     the shared isolated world, replaces it and retires the previous one ('superseded') WITHOUT stopping its
//     subscribers. Subscriptions live in a world-level registry (globalThis.__snMiloWorld.subscriptions, one per
//     isolated world) together with the last accepted record; each new controller adopts both and drives every
//     subscriber per its own effective state, so features that captured the old controller object and subscribed
//     once keep working (no stop/start on handoff, no resubscription, no duplicates). A superseded controller's
//     effective()/subscribe() delegate to the live successor in the same world;
//   - after an extension reload/update the new instance's scripts run in a NEW isolated world (observed in
//     Vivaldi 8.2 / Chromium) and cannot see the old controller. The old one retires itself: a liveness check every
//     5 s and on visibilitychange (chrome.runtime.id gone ⇒ context invalidated), and at every other entry point
//     (window message, subscribe, effective, push). Retirement always removes the controller's own listeners and
//     timers and never relays stale state; it calls stop(reason) on every running subscriber (and clears the world
//     registry) unless it is a same-world supersede with a live successor (handoff above). Invalidation therefore
//     still stops every feature in the dead world.
(() => {
  'use strict';
  const LIVENESS_MS = 5000;
  const BACKSTOP_TICKS = 6; // re-request get-effective every 6 liveness ticks (30 s)
  const PROTOCOL = 'sn-milo-settings';
  const VERSION = 1;
  const ORIGIN = location.origin;
  if (typeof ORIGIN !== 'string' || !/^https:\/\/[^/]+$/.test(ORIGIN)) return; // opaque ('null') or odd frames

  const previous = globalThis.__snMiloController;
  // World-level state shared by every controller instance evaluated in THIS isolated world (same extension
  // instance). A new extension instance gets a new world, hence a fresh registry.
  const worldState = (() => {
    const s = globalThis.__snMiloWorld;
    if (s && typeof s === 'object' && s.subscriptions instanceof Set) return s;
    const fresh = {subscriptions: new Set(), record: null};
    globalThis.__snMiloWorld = fresh;
    return fresh;
  })();
  const subscribers = worldState.subscriptions;
  let current = null; // last accepted record (adopted from the world state below once this controller is live)
  let retired = false;
  let retiredReason = null;
  let seq = 0;
  let ticks = 0;
  let timer = null;
  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });
  const controller = {
    version: VERSION,
    id: (() => { try { return crypto.randomUUID(); } catch { return `c${Date.now()}${Math.random()}`; } })(),
    ready,
    stop: retire,
    effective: name => {
      if (checkAlive()) return effective(name);
      const next = successor();
      return next ? next.effective(name) : null;
    },
    subscribe: (feature, handlers, options) => {
      if (checkAlive()) return subscribe(feature, handlers, options);
      const next = successor();
      return next ? next.subscribe(feature, handlers, options) : () => {};
    },
    get subscriptions() { return subscribers.size; },
    get retired() { return retired; }
  };
  globalThis.__snMiloController = controller;

  function owns() { return globalThis.__snMiloController === controller; }
  /** The live controller that replaced this one in the same isolated world, if any. */
  function successor() {
    if (retiredReason !== 'superseded') return null;
    const next = globalThis.__snMiloController;
    return next && next !== controller && next.retired === false ? next : null;
  }
  function alive() {
    try { return !retired && owns() && Boolean(chrome?.runtime?.id); } catch { return false; }
  }
  /** Every entry point: a controller whose extension context died (or that was replaced) retires before doing
   *  anything, so an orphan never answers or starts work with stale state. */
  function checkAlive() {
    if (alive()) return true;
    retire(owns() ? 'invalidated' : 'superseded');
    return false;
  }

  function validRecord(r) {
    return Boolean(r) && typeof r === 'object' && r.schema === 1 && typeof r.epoch === 'string' &&
      Number.isSafeInteger(r.rev) && r.features && typeof r.features === 'object' && r.origins && typeof r.origins === 'object';
  }
  function scopedState(record, name) {
    if (!record) return null;
    const scope = record.origins[ORIGIN];
    if (!Array.isArray(scope) || !scope.includes(name)) return {enabled: false, seedOnly: false};
    const f = record.features[name];
    return {enabled: f?.enabled === true, seedOnly: f?.seedOnly === true};
  }
  function effective(name) { return scopedState(current, name); }
  function scopedFeatures() {
    const out = {};
    const scope = current && Array.isArray(current.origins[ORIGIN]) ? current.origins[ORIGIN] : [];
    for (const name of scope) out[name] = scopedState(current, name);
    return out;
  }

  function modeFor(sub) {
    const s = effective(sub.feature);
    if (!s) return null;
    if (s.enabled) return 'enabled';
    if (s.seedOnly && sub.allowSeedOnly) return 'seed';
    return null;
  }
  function runStop(sub, reason) {
    if (!sub.mode) return;
    sub.mode = null;
    try { sub.handlers.stop?.(reason); } catch (error) { console.warn('[SN-MILO] subscriber stop failed', sub.feature, error); }
  }
  /** update(state): reports the subscriber's KNOWN state ({enabled, seedOnly}) whenever it first becomes known or
   *  changes by value — including unknown → disabled, which start/stop never report, and after a same-world
   *  handoff (the last reported key lives on the shared subscription object, so adoption alone does not re-fire). */
  function runUpdate(sub) {
    if (typeof sub.handlers.update !== 'function') return;
    const s = effective(sub.feature);
    if (!s) return; // unknown is never reported
    const key = `${s.enabled}|${s.seedOnly}`;
    if (key === sub.known) return;
    sub.known = key;
    try { sub.handlers.update({...s}); } catch (error) { console.warn('[SN-MILO] subscriber update failed', sub.feature, error); }
  }
  function reconcileSubscriber(sub) {
    if (retired || !sub.active) return;
    runUpdate(sub);
    if (retired || !sub.active) return;
    const want = modeFor(sub);
    if (want === sub.mode) return;
    if (sub.mode) runStop(sub, want ? 'mode-change' : 'disabled');
    if (!want || retired || !sub.active) return;
    sub.mode = want;
    try { sub.handlers.start?.({...effective(sub.feature), mode: want}); } catch (error) {
      console.warn('[SN-MILO] subscriber start failed', sub.feature, error);
    }
  }

  /** ISOLATED features: subscribe(feature, {start(state), stop(reason), update(state)}, {allowSeedOnly}) → unsubscribe().
   *  start/stop follow the running mode; update (optional) follows the known state (see runUpdate). */
  function subscribe(feature, handlers, options = {}) {
    const sub = {feature: String(feature), handlers: handlers || {}, allowSeedOnly: options.allowSeedOnly === true, mode: null, known: null, active: true};
    subscribers.add(sub);
    reconcileSubscriber(sub);
    return () => { if (!sub.active) return; runStop(sub, 'unsubscribed'); sub.active = false; subscribers.delete(sub); };
  }

  function postToMain() {
    if (!checkAlive() || !current) return;
    try {
      window.postMessage({source: 'sn-milo-controller', protocol: PROTOCOL, version: VERSION, type: 'settings',
        controllerId: controller.id, seq: ++seq, epoch: current.epoch, rev: current.rev, features: scopedFeatures()}, ORIGIN);
    } catch (error) { console.warn('[SN-MILO] settings relay failed', error); }
  }

  function accept(record) {
    if (retired || !validRecord(record)) return false;
    if (current && record.epoch === current.epoch && record.rev <= current.rev) return false; // stale
    current = record;
    worldState.record = record;
    for (const sub of [...subscribers]) reconcileSubscriber(sub);
    postToMain();
    resolveReady(true);
    return true;
  }

  function onWindowMessage(event) {
    if (retired || event.source !== window || event.origin !== ORIGIN) return;
    const d = event.data;
    if (!d || typeof d !== 'object' || d.source !== 'sn-milo-main' || d.protocol !== PROTOCOL || d.version !== VERSION || d.type !== 'request') return;
    postToMain(); // checks liveness first: an orphan retires instead of answering
  }

  function requestEffective() {
    if (!checkAlive()) return;
    try {
      chrome.runtime.sendMessage({feature: 'milo', type: 'get-effective'}).then(response => {
        if (alive() && response?.ok) accept(response.effective);
      }, () => { if (!alive()) retire('invalidated'); });
    } catch {
      retire('invalidated');
    }
  }

  /** Worker push (chrome.tabs.sendMessage). Never answered: returns undefined so no channel stays open. */
  function onPush(message, sender) {
    if (!checkAlive()) return;
    if (!sender || sender.id !== chrome.runtime.id || sender.tab) return; // only this extension's worker
    if (!message || message.feature !== 'milo' || message.type !== 'effective') return;
    accept(message.effective);
  }

  function onTick() {
    if (!checkAlive()) return;
    if (++ticks % BACKSTOP_TICKS !== 0) return;
    let hidden = false;
    try { hidden = document.hidden === true; } catch {}
    if (!hidden) requestEffective(); // hidden tabs skip the backstop; visibilitychange→visible re-requests
  }
  function onVisibility() {
    if (!checkAlive()) return;
    if (document.visibilityState === 'visible') { ticks = 0; requestEffective(); }
  }

  function retire(reason = 'invalidated') {
    if (retired) return;
    retired = true;
    retiredReason = reason;
    window.removeEventListener('message', onWindowMessage);
    if (timer !== null) { clearInterval(timer); timer = null; }
    try { document.removeEventListener('visibilitychange', onVisibility); } catch {}
    try { chrome.runtime.onMessage.removeListener(onPush); } catch {}
    const next = reason === 'superseded' ? successor() : null;
    if (next) {
      // handoff: the live successor in this world already adopted the registry; subscribers keep running, and
      // awaiters of this controller's ready follow the successor's (no-op if a state was already accepted)
      resolveReady(next.ready);
    } else {
      for (const sub of [...subscribers]) { runStop(sub, reason); sub.active = false; }
      subscribers.clear();
      worldState.record = null;
    }
    resolveReady(false); // no-op if a state was already accepted (ready → true); never leaves awaiters hanging
    if (reason !== 'superseded') console.warn('[SN-MILO] settings controller retired:', reason);
  }

  // Register first, then retire the previous instance (takeover without page reload).
  window.addEventListener('message', onWindowMessage);
  if (typeof previous?.stop === 'function' && previous !== controller) {
    try { previous.stop('superseded'); } catch {}
  }
  if (!alive()) { retire('invalidated'); return; }
  try {
    chrome.runtime.onMessage.addListener(onPush);
  } catch {
    retire('invalidated');
    return;
  }
  timer = setInterval(onTick, LIVENESS_MS);
  document.addEventListener('visibilitychange', onVisibility);
  // Adopt the previous controller's record (same world ⇒ same extension instance ⇒ still valid): adopted
  // subscribers keep their mode until a newer record arrives.
  if (validRecord(worldState.record)) {
    current = worldState.record;
    for (const sub of [...subscribers]) reconcileSubscriber(sub);
    postToMain();
    resolveReady(true);
  }
  requestEffective();
})();
