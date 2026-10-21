// Open-tab developer recovery, derived from SCRIPT_POLICY. Never navigates or submits.
// allFrames is used ONLY for a read-only URL/origin inventory. Mutations pin document IDs,
// re-check each document URL, and exclude blank/srcdoc/opaque/foreign documents.
// Running Informatica work is left alone (whole tab skipped). Native patches stay static.
// Timeouts stop the affected tab, not the pass. Chromium cannot cancel a pending script;
// do not retry it automatically. A later explicit pass is possible after inspecting the tab.
import {SCRIPT_POLICY} from './script-policy.mjs';
import {maintenanceInDocument} from './informatica-maintenance.mjs';

const globToRegExp = glob => new RegExp(`^${glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

/** Chrome match-pattern path semantics: pattern path is matched against path + query (no fragment); `*` is a glob. */
export function matchesPath(paths, url) {
  let target;
  try { const u = new URL(url); target = u.pathname + u.search; } catch { return false; }
  return paths.some(p => globToRegExp(p).test(target));
}

function roleOf(url, origins) {
  let origin;
  try { origin = new URL(url).origin; } catch { return null; }
  if (origin === 'null') return null;
  return Object.entries(origins).find(([, o]) => o === origin)?.[0] ?? null;
}

/** Steps (policy order) for one URL; [] when the URL is not on a configured origin. */
export function stepsForUrl(url, {origins, policy = SCRIPT_POLICY, enabled = {}} = {}) {
  const role = roleOf(url, origins);
  if (!role) return [];
  const steps = [];
  for (const e of policy) {
    if (e.reinject === false || !e.origins.includes(role) || !matchesPath(e.paths, url)) continue;
    if (e.js?.length) steps.push({id: e.id, feature: e.feature, world: e.world, allFrames: e.all_frames, files: [...e.js], css: []});
    else if (e.css?.length) steps.push({id: e.id, feature: e.feature, world: e.world, allFrames: e.all_frames, files: [], css: [...e.css]});
  }
  return steps;
}

/** Pure plan: [{tabId, url, role, steps}] for every injectable tab. */
export function planReinjection(tabs, {origins, policy = SCRIPT_POLICY, enabled = {}} = {}) {
  const plan = [];
  for (const tab of tabs || []) {
    if (!Number.isInteger(tab?.id) || tab.discarded || typeof tab.url !== 'string') continue;
    const steps = stepsForUrl(tab.url, {origins, policy, enabled});
    if (steps.length) plan.push({tabId: tab.id, url: tab.url, role: roleOf(tab.url, origins), steps});
  }
  return plan;
}

// Bound every browser operation, including discovery. A timed-out operation is never retried.
function bounded(work, ms, label) {
  const timeout = () => Object.assign(new Error(`${label}: timeout; pending browser work cannot be cancelled and is not retried`), {timedOut: true});
  if (ms <= 0) return Promise.reject(timeout());
  let timer;
  return Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeout()), ms);
  })]).finally(() => clearTimeout(timer));
}
const documentProbe = () => ({href: location.href, origin: self.origin});

// The worker owns one pass at a time. Clear on ALL outcomes, including discovery/readiness
// failures and summaries containing timed-out tabs. Never auto-retry pending Chromium work.
export function createReinjectionRunner({ensureReady, reinject, readyTimeoutMs = 5000}) {
  let pending = null;
  return () => {
    if (pending) return pending;
    const run = bounded(ensureReady, readyTimeoutMs, 'settings readiness').then(reinject);
    pending = run;
    run.then(() => { pending = null; }, () => { pending = null; });
    return run;
  };
}

export async function reinjectOpenTabs({chrome, origins, isEnabled = () => false, policy = SCRIPT_POLICY, stepTimeoutMs = 5000, tabTimeoutMs = 30000}) {
  const tabs = await bounded(() => chrome.tabs.query({url: [...new Set(Object.values(origins))].map(o => `${o}/*`)}), stepTimeoutMs, 'tabs.query');
  const summary = {tabs: [], injectedSteps: 0, failed: 0};
  for (const tab of tabs || []) {
    if (!Number.isInteger(tab?.id) || tab.discarded || !roleOf(tab.url, origins)) continue;
    const out = {tabId: tab.id, origin: new URL(tab.url).origin, role: roleOf(tab.url, origins), steps: [], errors: [], ok: true};
    const deadline = Date.now() + tabTimeoutMs;
    const pendingOperations = new Set();
    const call = (work, label) => {
      if (deadline - Date.now() <= 0) return bounded(work, 0, label);
      const task = Promise.resolve().then(work);
      pendingOperations.add(task);
      task.then(() => pendingOperations.delete(task), () => pendingOperations.delete(task));
      return bounded(() => task, Math.min(stepTimeoutMs, deadline - Date.now()), label);
    };
    const owner = `reinject-${crypto.randomUUID()}`;
    let attempted = false;
    try {
      // Acquire synchronously in the actual controller's ISOLATED world before
      // the first awaited inventory/takeover operation. New controllers inherit it.
      attempted = true;
      const probe = await call(() => chrome.scripting.executeScript({target: {tabId: tab.id, frameIds: [0]}, world: 'ISOLATED',
        func: maintenanceInDocument, args: ['acquire', owner]}), 'Informatica maintenance');
      if (probe.length !== 1 || probe[0]?.result?.ok !== true) {
        const reason = probe[0]?.result?.reason || 'informatica-safety-unknown';
        if (reason === 'informatica-in-progress') { out.skipped = reason; continue; }
        throw new Error(reason);
      }
      const frames = await call(() => chrome.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, world: 'MAIN', func: documentProbe}), 'frame inventory');
      if (!probe[0].documentId || frames.find(f => f.frameId === 0)?.documentId !== probe[0].documentId) {
        out.skipped = 'navigated'; continue;
      }
      for (const e of policy) {
        if (e.reinject === false) continue;
        const eligible = frames.filter(f => f.documentId && (e.all_frames || f.frameId === 0) &&
          f.result?.origin !== 'null' && f.result?.origin === new URL(f.result?.href || 'about:blank').origin &&
          e.origins.includes(roleOf(f.result?.href, origins)) && matchesPath(e.paths, f.result.href));
        let injected = false;
        for (const f of eligible) {
          const now = await call(() => chrome.tabs.get(tab.id), 'tabs.get');
          if (now.url !== tab.url) { out.skipped = 'navigated'; break; }
          const target = {tabId: tab.id, documentIds: [f.documentId]};
          const [fresh] = await call(() => chrome.scripting.executeScript({target, world: 'MAIN', func: documentProbe}), `${e.id} document probe`);
          if (fresh?.result?.href !== f.result.href || fresh?.result?.origin !== f.result.origin) continue;
          try {
            if (e.css?.length) {
              // CSS must be present even when disabled so a later enable works without reload.
              // Set the gate before inserting; removeCSS matches only our programmatic insertion,
              // never the declarative stylesheet. Pairing bounds repeated updates/restarts.
              await call(() => chrome.scripting.executeScript({target, world: 'ISOLATED',
                func: off => document.documentElement.toggleAttribute('data-milo-kb-off', off), args: [!isEnabled(e.feature)]}), `${e.id} gate`);
              const css = {target, files: [...e.css]};
              await call(() => chrome.scripting.removeCSS(css), `${e.id} removeCSS`);
              await call(() => chrome.scripting.insertCSS(css), `${e.id} insertCSS`);
            } else await call(() => chrome.scripting.executeScript({target, world: e.world, files: [...e.js]}), e.id);
            injected = true;
          } catch (error) {
            if (error.timedOut) throw error;
            out.ok = false; out.errors.push(`${e.js?.[0] ?? e.css?.[0]}: ${error.message || error}`);
          }
        }
        if (injected) { out.steps.push(e.id); summary.injectedSteps++; }
        if (out.skipped) break;
      }
    } catch (error) { out.ok = false; out.errors.push(error.message || String(error)); }
    finally {
      if (attempted) {
        const release = () => bounded(() => chrome.scripting.executeScript({target: {tabId: tab.id, frameIds: [0]}, world: 'ISOLATED',
          func: maintenanceInDocument, args: ['release', owner]}), stepTimeoutMs, 'Informatica release');
        if (pendingOperations.size) {
          // Chromium cannot cancel a timed-out injection. Do NOT unlock while it
          // could still supersede a user-started run. Release only when it settles.
          out.errors.push('Informatica maintenance held until pending browser work settles; no new runs meanwhile');
          Promise.allSettled([...pendingOperations]).then(release).catch(error => console.warn('Informatica maintenance release failed; inspect tab', error));
        } else {
          try { await release(); }
          catch (error) { out.ok = false; out.errors.push(`maintenance release: ${error.message}`); }
        }
      }
      if (!out.ok) summary.failed++; summary.tabs.push(out);
    }
  }
  return summary;
}
