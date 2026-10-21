// sn_milo service worker (ES module). The ONLY module with top-level runtime side effects: it registers every
// chrome.* listener synchronously at evaluation (so events that woke the worker are never missed), then starts
// the shared readiness/reconciliation path. Feature modules export handlers (see shared/router.mjs) and are
// listed in FEATURE_MODULES; they never register listeners or inject scripts at top level themselves.
import {PRODUCTION_ORIGIN, TEST_ORIGIN} from './shared/origins.generated.mjs';
import {createMiloBackground} from './shared/router.mjs';
import {reinjectOpenTabs, createReinjectionRunner} from './shared/reinject.mjs';
import {createCriticalAlert} from './features/critical-alert/background.mjs';
import {createInteractionAlert} from './features/interaction-alert/background.mjs';
import {createTimecard} from './features/timecard/background.mjs';

// Worker feature modules (Informatica and KB dark mode are content-only and have none; the timecard module only
// provides the options status line).
const critical = createCriticalAlert();
const interaction = createInteractionAlert();
const FEATURE_MODULES = [critical, interaction, createTimecard()];

const app = createMiloBackground({chrome, origins: {production: PRODUCTION_ORIGIN, test: TEST_ORIGIN}, features: FEATURE_MODULES});
app.install();
// Toolbar button opens the options page directly (no popup; listener registered synchronously for worker wake-ups).
chrome.action?.onClicked.addListener(() => { chrome.runtime.openOptionsPage().catch(error => console.warn('[sn_milo] could not open options:', error?.message || error)); });
app.ensureReady();

// Console/CDP helpers (service-worker global scope only; not reachable from pages or content scripts).
const reinject = createReinjectionRunner({
  ensureReady: () => app.ensureReady(),
  reinject: () => reinjectOpenTabs({chrome, origins: {production: PRODUCTION_ORIGIN, test: TEST_ORIGIN}, isEnabled: name => app.isEnabled(name)})
});
globalThis.snMilo = Object.freeze({
  informaticaMaintenance: app.informaticaGate,
  status: async () => { await app.ensureReady(); return app.status(); },
  importDedupe: (feature, snapshots) => app.importDedupe(feature, snapshots),
  chooseFallback: (feature, choice) => app.chooseFallback(feature, choice),
  // Dispatch an owned alarm now (same routing as chrome.alarms.onAlarm: unknown names / disabled owners ignored);
  // lets a developer or the disposable-browser test drive the health check without waiting for the 1-min period.
  runAlarm: name => app.onAlarm({name: String(name)}),
  // Developer update path (scripts/apply-update.mjs): reinject scripts into already-open tabs per script-policy.mjs
  // (exact origins/paths/worlds/frames, no reload, no navigation). Reachable only from the worker's own scope.
  reinjectOpenTabs: reinject
});
// Original per-extension console helper names (service-worker console / CDP only).
globalThis.snTkStatus = () => critical.status(chrome, {production: PRODUCTION_ORIGIN, test: TEST_ORIGIN});
globalThis.snIxStatus = () => interaction.status(chrome, {production: PRODUCTION_ORIGIN, test: TEST_ORIGIN});
