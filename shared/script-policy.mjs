// Declarative content-script policy: the ONLY source of manifest `content_scripts`. scripts/generate-config.mjs
// emits them from this list (resolving origin roles from config.json) and tests/manifest-policy.test.mjs asserts
// exact agreement. Entry order is manifest order (Chromium injects same-timing entries in manifest order).
// Rules enforced by validatePolicy():
//   - feature is a known feature or 'shared' (settings infrastructure with no feature behaviour);
//   - origins ⊆ the feature's allowed roles (FEATURES[*].origins): timecard, informatica-button, monitoring-routing, inbox-overlay (and shared) may use 'test';
//   - kb-dark paths are exactly KB_PATHS: ['/kb', '/kb?*', '/tcp', '/tcp?*'] (never '/kb*' or '/tcp*', which would also
//     match /kb-other, /kb_view.do and any future /tcp-prefixed route);
//   - world ISOLATED|MAIN, run_at document_start|document_end|document_idle, boolean all_frames;
//   - js/css are repo-relative extension files; MAIN entries carry no css;
//   - optional `reinject: false` keeps an entry out of the developer update's open-tab reinjection (shared/reinject.mjs;
//     manifest generation ignores it). Default is true.
// Feature entries are added by their migration tasks; keep the MAIN helper before any MAIN feature entry.
// about:blank / srcdoc / blob: frames: no entry sets match_about_blank or match_origin_as_fallback, so Chromium
// injects nothing into such frames (even same-origin ones) and features never run there. A later task that needs
// them must (1) add `match_origin_as_fallback: true` here + in buildContentScripts/validatePolicy, and (2) adapt
// router senderRoles(): such frames send sender.url 'about:blank'/'about:srcdoc' (origin 'null'), so today their
// messages are refused as wrong-origin; use sender.origin (Chrome 112+) for those URL schemes only.
import {FEATURES, isKnownFeature} from './features.mjs';

// KB pages (/kb, /kb?*) plus the timesheet page (/tcp, /tcp?*), which the user also wants dark.
export const KB_PATHS = Object.freeze(['/kb', '/kb?*', '/tcp', '/tcp?*']);
const WORLDS = ['ISOLATED', 'MAIN'];
const RUN_AT = ['document_start', 'document_end', 'document_idle'];
const ROLES = ['production', 'test'];
const freezeEntry = e => Object.freeze(Object.fromEntries(Object.entries(e).map(([k, v]) => [k, Array.isArray(v) ? Object.freeze([...v]) : v])));

export const SCRIPT_POLICY = Object.freeze([
  // Settings bridge: effective state from storage/worker → ISOLATED subscribers + MAIN relay. Always loaded.
  {id: 'settings-controller', feature: 'shared', origins: ['production', 'test'], paths: ['/*'], world: 'ISOLATED',
    run_at: 'document_start', all_frames: true, js: ['shared/controller.js']},
  // MAIN-side receiver of the relay (window.__snMiloMainSettings) for MAIN-world features.
  {id: 'main-settings', feature: 'shared', origins: ['production', 'test'], paths: ['/*'], world: 'MAIN',
    run_at: 'document_start', all_frames: true, js: ['shared/main-settings.js']},
  // Informatica button: exactly the original manifest's two entries (production only, top frame only).
  {id: 'informatica-bridge', feature: 'informatica-button', origins: ['production', 'test'], paths: ['/*'], world: 'MAIN',
    run_at: 'document_start', all_frames: false, js: ['features/informatica-button/page.js']},
  {id: 'informatica-button', feature: 'informatica-button', origins: ['production', 'test'], paths: ['/*'], world: 'ISOLATED',
    run_at: 'document_idle', all_frames: false, js: ['features/informatica-button/content.js']},
  // Monitoring routing buttons: MAIN world, case form frame only (gsft_main loads /sn_customerservice_case.do), every
  // frame so the nested form document is covered; inert until the relayed effective state enables it.
  {id: 'monitoring-routing', feature: 'monitoring-routing', origins: ['production', 'test'], paths: ['/sn_customerservice_case.do*'], world: 'MAIN',
    run_at: 'document_idle', all_frames: true, js: ['features/monitoring-routing/content.js']},
  // Native Inbox is owned by the top document; its lazy same-origin frame must never launch another overlay.
  {id: 'inbox-overlay', feature: 'inbox-overlay', origins: ['production', 'test'], paths: ['/*'], world: 'ISOLATED',
    run_at: 'document_idle', all_frames: false, js: ['features/inbox-overlay/content.js']},
  // KB dark mode: the original's single declarative CSS entry (exact /kb + /kb?*, document_start, top frame), now
  // attribute-gated, plus the ISOLATED toggle that owns the off attribute (after the controller: same world/timing ⇒
  // manifest order). The same pair also covers the Service Portal Time Sheet page (/tcp + /tcp?*), which the user wants
  // dark too: it is a Service Portal page rendering in the top document, so the top-frame scope of /kb still applies.
  {id: 'kb-dark-css', feature: 'kb-dark', origins: ['production'], paths: [...KB_PATHS], world: 'ISOLATED',
    run_at: 'document_start', all_frames: false, css: ['features/kb-dark/dark.css', 'features/kb-dark/dark-tcp.css']},
  {id: 'kb-dark-toggle', feature: 'kb-dark', origins: ['production'], paths: [...KB_PATHS], world: 'ISOLATED',
    run_at: 'document_start', all_frames: false, js: ['features/kb-dark/content.js']},
  // Critical alert: exactly the original manifest's two entries (production only, top frame only). The MAIN bridge
  // stays inert (no listener ⇒ no fetch) until the relayed effective state enables it; the poller is driven by the
  // settings controller. Recovery injection into already-open tabs is the worker's job (background.mjs).
  {id: 'critical-alert-bridge', feature: 'critical-alert', origins: ['production'], paths: ['/*'], world: 'MAIN',
    run_at: 'document_start', all_frames: false, js: ['features/critical-alert/page.js']},
  {id: 'critical-alert-poller', feature: 'critical-alert', origins: ['production'], paths: ['/*'], world: 'ISOLATED',
    run_at: 'document_idle', all_frames: false, js: ['features/critical-alert/content.js']},
  // Interaction alert: same shape as the critical alert (the original manifests are structurally identical).
  {id: 'interaction-alert-bridge', feature: 'interaction-alert', origins: ['production'], paths: ['/*'], world: 'MAIN',
    run_at: 'document_start', all_frames: false, js: ['features/interaction-alert/page.js']},
  {id: 'interaction-alert-poller', feature: 'interaction-alert', origins: ['production'], paths: ['/*'], world: 'ISOLATED',
    run_at: 'document_idle', all_frames: false, js: ['features/interaction-alert/content.js']},
  // Timecard: exactly the original manifest's two entries (test AND production origins, original match order).
  // [1] overlay/launch UI: top frame only, driven by the relayed effective state (inert until enabled; disable keeps
  //     an open form). Needs main-settings (earlier shared entry, same world, document_start ⇒ ready first).
  // [2] native Time Worked form compatibility: static, ALWAYS ON in every frame, independent of the toggle and of
  //     settings (no main-settings dependency by design), so directly opened native forms and reloads/updates keep
  //     the early document_start behaviour without any dynamic re-registration.
  {id: 'timecard-overlay', feature: 'timecard', origins: ['test', 'production'], paths: ['/*'], world: 'MAIN',
    run_at: 'document_idle', all_frames: false, js: ['features/timecard/config.js', 'features/timecard/core.js', 'features/timecard/quick-actions.js', 'features/timecard/content.js']},
  {id: 'timecard-native', feature: 'timecard', origins: ['test', 'production'], paths: ['/task_time_worked.do*'], world: 'MAIN',
    run_at: 'document_start', all_frames: true, reinject: false, js: ['features/timecard/config.js', 'features/timecard/core.js', 'features/timecard/quick-actions.js', 'features/timecard/native-compat.js', 'features/timecard/native-actions.js']}
].map(freezeEntry));

const validFile = f => typeof f === 'string' && /^[a-z0-9][a-z0-9._/-]*\.(js|css)$/i.test(f) && !f.split('/').includes('..');

export function validatePolicy(policy = SCRIPT_POLICY) {
  const problems = [];
  if (!Array.isArray(policy)) return ['policy must be an array'];
  const ids = new Set();
  policy.forEach((e, i) => {
    const at = `script policy [${i}] ${e?.id ?? ''}`.trim();
    if (!e || typeof e !== 'object') { problems.push(`${at}: not an object`); return; }
    if (typeof e.id !== 'string' || !e.id) problems.push(`${at}: id required`);
    else if (ids.has(e.id)) problems.push(`${at}: duplicate id ${e.id}`);
    else ids.add(e.id);
    const shared = e.feature === 'shared';
    if (!shared && !isKnownFeature(e.feature)) { problems.push(`${at}: unknown feature ${JSON.stringify(e.feature)}`); return; }
    const allowed = shared ? ROLES : FEATURES[e.feature].origins;
    if (!Array.isArray(e.origins) || !e.origins.length) problems.push(`${at}: origins must be a non-empty array`);
    else for (const r of e.origins) {
      if (!ROLES.includes(r)) problems.push(`${at}: unknown origin role ${JSON.stringify(r)}`);
      else if (!allowed.includes(r)) problems.push(`${at}: ${e.feature} may not run on the ${r} origin`);
    }
    if (!Array.isArray(e.paths) || !e.paths.length || e.paths.some(p => typeof p !== 'string' || !p.startsWith('/'))) problems.push(`${at}: paths must be non-empty absolute match paths`);
    if (e.feature === 'kb-dark' && JSON.stringify(e.paths) !== JSON.stringify(KB_PATHS)) problems.push(`${at}: kb-dark paths must be exactly ${JSON.stringify(KB_PATHS)}`);
    if (!WORLDS.includes(e.world)) problems.push(`${at}: world must be ${WORLDS.join('|')}`);
    if (!RUN_AT.includes(e.run_at)) problems.push(`${at}: run_at must be ${RUN_AT.join('|')}`);
    if (typeof e.all_frames !== 'boolean') problems.push(`${at}: all_frames must be boolean`);
    if (e.reinject !== undefined && typeof e.reinject !== 'boolean') problems.push(`${at}: reinject must be boolean`);
    const js = e.js ?? [];
    const css = e.css ?? [];
    if (!Array.isArray(js) || !Array.isArray(css) || !(js.length + css.length)) problems.push(`${at}: needs js and/or css files`);
    else {
      for (const f of [...js, ...css]) if (!validFile(f)) problems.push(`${at}: invalid file ${JSON.stringify(f)}`);
      if (js.some(f => !f.endsWith('.js')) || css.some(f => !f.endsWith('.css'))) problems.push(`${at}: js/css file type mismatch`);
      if (e.world === 'MAIN' && css.length) problems.push(`${at}: MAIN entries cannot carry css`);
    }
  });
  return problems;
}

/** Manifest content_scripts for concrete origins ({production, test}); deterministic key order. */
export function buildContentScripts(origins, policy = SCRIPT_POLICY) {
  return policy.map(e => {
    const out = {matches: e.origins.flatMap(role => e.paths.map(p => `${origins[role]}${p}`))};
    if (e.js?.length) out.js = [...e.js];
    if (e.css?.length) out.css = [...e.css];
    out.run_at = e.run_at;
    out.world = e.world;
    out.all_frames = e.all_frames;
    return out;
  });
}
