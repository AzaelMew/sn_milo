// KB dark mode — ISOLATED-world toggle (classic content script, IIFE: no global lexical declarations).
// Injected with the declarative features/kb-dark/dark.css on the production origin's exact /kb and /kb?* routes (plus
// the Time Sheet page /tcp and /tcp?*, which the dark styling covers too), document_start, top frame only (same scope as
// servicenow-kb-dark 1.0.1). The CSS is static and always present;
// every selector is gated by :where(:root:not([data-milo-kb-off])) (scripts/gate-kb-css.mjs). This script owns that
// attribute on <html>:
//   - default (attribute absent) = dark, until the effective state from shared/controller.js says otherwise;
//   - effective state known and enabled  → attribute removed;  known and not enabled → attribute set;
//   - unknown state (controller not ready, no controller, retired) → left as it is. Hence the documented flash: a
//     page whose saved state is off renders dark until the asynchronous settings answer arrives;
//   - live: the controller subscription's update(state) re-applies whenever the known state first becomes known or
//     changes — including unknown → disabled and after a same-world controller handoff — no reload, no reliance on
//     controller.ready;
//   - extension invalidated (reloaded/removed) or unsubscribed (this script re-injected): no further update, so the
//     attribute stays untouched — the page keeps its last known state; a fresh document or reinjection re-applies.
// It never reads document.styleSheets and never calls removeCSS (declarative CSS cannot be removed that way).
// globalThis.__snMiloKbDark is a replaceable controller: a re-injected copy stops (unsubscribes) the previous one.
(() => {
  'use strict';
  const FEATURE = 'kb-dark';
  const ATTR = 'data-milo-kb-off';
  const ORIGIN = location.origin;
  if (typeof ORIGIN !== 'string' || !/^https:\/\/[^/]+$/.test(ORIGIN)) return; // opaque/odd frames

  const milo = globalThis.__snMiloController;
  const previous = globalThis.__snMiloKbDark;
  let unsubscribe = null;
  let disposed = false;

  function apply() {
    if (disposed) return;
    let state = null;
    try { state = milo?.effective?.(FEATURE) ?? null; } catch { state = null; }
    if (!state) return; // unknown: keep the current attribute (default dark)
    let root = null;
    try { root = document.documentElement; } catch {}
    if (!root) return;
    if (state.enabled === true) { if (root.hasAttribute(ATTR)) root.removeAttribute(ATTR); }
    else if (!root.hasAttribute(ATTR)) root.setAttribute(ATTR, '');
  }

  const controller = {
    version: 1,
    apply,
    stop() {
      if (disposed) return;
      disposed = true;
      if (unsubscribe) { const u = unsubscribe; unsubscribe = null; try { u(); } catch {} }
    }
  };
  globalThis.__snMiloKbDark = controller;
  if (typeof previous?.stop === 'function' && previous !== controller) {
    try { previous.stop('superseded'); } catch {}
  }
  if (!milo || typeof milo.subscribe !== 'function') return; // no settings controller ⇒ inert

  // update() fires synchronously here when the state is already known, otherwise once it becomes known.
  unsubscribe = milo.subscribe(FEATURE, {update: () => apply()});
})();
