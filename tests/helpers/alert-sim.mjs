// Integration harness for the alert features: the REAL router (shared/router.mjs), the REAL feature worker modules
// (features/<alert>/background.mjs) and the REAL content scripts (shared/controller.js, shared/main-settings.js,
// features/<alert>/page.js + content.js) evaluated in page-sim frames. Browser API fixtures only:
//   - chrome.* fakes from fake-chrome.mjs; notifications.create records {id, options};
//   - chrome.scripting.executeScript really evaluates the requested files / func in the target tab's simulated world
//     (ISOLATED = the current extension instance's world, MAIN = the page world), so watchdog probes and reinjection
//     behave like Chromium's;
//   - each frame's MAIN world gets a fake same-origin `fetch` answering the Table API from per-frame fixture rows
//     (GET only; anything else throws) and a g_ck token; ISOLATED worlds get fake setTimeout/clearTimeout driven by
//     frame.fire(ms) so poll timing is deterministic (setInterval is page-sim's fake, driven by frame.advance(ms)).
// Nothing here touches a network.
import {createMiloBackground} from '../../shared/router.mjs';
import {createFakeChrome, createFakeStorage, deliver, contentSender, ORIGINS, PROD, TEST, sleep} from './fake-chrome.mjs';
import {createFrame, contentChrome} from './page-sim.mjs';
import {createCriticalAlert} from '../../features/critical-alert/background.mjs';
import {createInteractionAlert} from '../../features/interaction-alert/background.mjs';

export {PROD, TEST, ORIGINS, sleep};
export const quiet = {log() {}, info() {}, warn() {}, error() {}};
export const settle = async (rounds = 8) => { for (let i = 0; i < rounds; i++) await sleep(3); };
export const READY = Object.freeze({schema: 1, state: 'ready', method: 'import', decidedAt: 1, completedAt: 1, importedEntries: 0, lastImportAt: 1});
export const MODULE_FACTORIES = {'critical-alert': createCriticalAlert, 'interaction-alert': createInteractionAlert};
export const SPEC = {
  'critical-alert': {dir: 'features/critical-alert', tag: 'sn-tk', pollNow: 'snTkPollNow', controller: '__snTkController', bridge: '__snTkBridge'},
  'interaction-alert': {dir: 'features/interaction-alert', tag: 'sn-ix', pollNow: 'snIxPollNow', controller: '__snIxController', bridge: '__snIxBridge'}
};
export const id32 = c => String(c).repeat(32).slice(0, 32);
export const ixRow = (c, extra = {}) => ({sys_id: id32(c), number: `IMSTK${c}`, state: 'New', type: 'Phone', short_description: `interaction ${c}`, account: 'Acme Oy', opened_for: 'Matti', ...extra});
export const critRow = (c, extra = {}) => ({sys_id: id32(c), number: `CSTK${c}`, priority: '1 - Critical', state: 'New', short_description: `case ${c}`, account: 'Acme Oy', ...extra});

function installIsolatedTimers(world) {
  const timers = new Map();
  let next = 1;
  world.g.setTimeout = (fn, ms) => { const id = next++; timers.set(id, {fn, ms}); return id; };
  world.g.clearTimeout = id => { timers.delete(id); };
  world.timers = timers;
  return timers;
}

/**
 * @param {{stored?: object, features?: string[], hookTimeoutMs?: number, chrome?: object, storage?: object}} options
 *   `storage` reuses an existing fake storage (worker restart); `features` lists the real alert modules to register.
 */
export function createAlertWorld({stored: storedIn = {}, features = ['critical-alert'], storage, hookTimeoutMs = 5000, now} = {}) {
  const stored = features.includes('interaction-alert') ? {'ix.accountsV1': {schema: 1, accounts: ['Acme Oy']}, ...storedIn} : storedIn;
  storage = storage || createFakeStorage(stored);
  const {chrome, calls} = createFakeChrome({storage});
  const notifications = [];
  const cleared = [];
  chrome.notifications.create = async (id, options) => { calls.push(['notifications.create', id]); notifications.push({id, options: structuredClone(options)}); return id; };
  chrome.notifications.clear = async id => { calls.push(['notifications.clear', id]); cleared.push(id); return true; };
  const frames = new Map(); // tabId -> frame (top frame only, like the original injection target)
  const injections = [];
  chrome.scripting.executeScript = async o => {
    const f = frames.get(o.target?.tabId);
    if (!f) throw new Error(`No tab with id: ${o.target?.tabId}`);
    const world = o.world === 'MAIN' ? 'main' : 'isolated';
    if (typeof o.func === 'function') {
      calls.push(['scripting.probe', o.target.tabId, world]);
      return [{frameId: 0, result: f.eval(world, `(${o.func.toString()})(...${JSON.stringify(o.args || [])})`)}];
    }
    for (const file of o.files) { injections.push({tabId: o.target.tabId, world: o.world, file}); f.run(world, file); }
    calls.push(['scripting.executeScript', o.target.tabId, o.world, [...o.files]]);
    return [{frameId: 0}];
  };
  const modules = Object.fromEntries(features.map(name => [name, MODULE_FACTORIES[name]({console: quiet, ...(now ? {now} : {})})]));
  const app = createMiloBackground({chrome, origins: ORIGINS, features: Object.values(modules), log: quiet, hookTimeoutMs});
  app.install();
  let nextTab = 100;

  /** One top-level document of a tab. `api` = Table API fixture: {rows: {<table>: rows[]}, fail: {<table>: status}, delay}. */
  function frame(origin = PROD, {path = '/now/nav/ui/classic', tabId = nextTab++, api = {}, token = 'tok'} = {}) {
    const url = `${origin}${path}`;
    const f = createFrame({origin, url});
    f.tabId = tabId;
    f.api = {rows: {}, fail: {}, fetches: [], ...api};
    const main = f.worlds.main.g;
    main.g_ck = token;
    main.AbortController = AbortController;
    main.fetch = async (u, opts = {}) => {
      if ((opts.method || 'GET') !== 'GET') throw new Error(`non-GET request refused: ${opts.method}`);
      f.api.fetches.push({url: u, headers: opts.headers});
      if (f.api.delay) await f.api.delay(u, opts);
      if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const table = /^\/api\/now\/table\/([^?/]+)/.exec(u)?.[1] || '';
      if (f.api.fail[table]) return {ok: false, status: f.api.fail[table], json: async () => ({})};
      return {ok: true, status: 200, json: async () => ({result: structuredClone(f.api.rows[table] || [])})};
    };
    f.sender = {...contentSender(origin, {path, id: chrome.runtime.id}), tab: {id: tabId, url}};
    f.chrome = contentChrome({backgroundChrome: chrome, deliver, sender: f.sender});
    f.setChrome(f.chrome);
    installIsolatedTimers(f.worlds.isolated);
    /** Fire (once) every pending ISOLATED timeout whose delay equals `ms`, then let async work settle. */
    f.fire = async ms => {
      const due = [...f.worlds.isolated.timers.entries()].filter(([, t]) => t.ms === ms);
      for (const [timerId, t] of due) { f.worlds.isolated.timers.delete(timerId); t.fn(); }
      await settle();
      return due.length;
    };
    f.pendingTimers = () => [...f.worlds.isolated.timers.values()].map(t => t.ms);
    /** Extension reload/update: new isolated world for the new instance, old world's chrome invalidated. */
    f.reloadExtension = () => {
      f.chrome.invalidate();
      f.chrome = contentChrome({backgroundChrome: chrome, deliver, sender: f.sender});
      const w = f.newExtensionInstance(f.chrome);
      installIsolatedTimers(w);
      return w;
    };
    frames.set(tabId, f);
    return f;
  }

  /** Static manifest injection for one alert feature on a production document (shared entries first). */
  function loadStatic(f, names = features) {
    f.run('isolated', 'shared/controller.js');
    f.run('main', 'shared/main-settings.js');
    for (const n of names) f.run('main', `${SPEC[n].dir}/page.js`);
    for (const n of names) f.run('isolated', `${SPEC[n].dir}/content.js`);
  }

  const setPref = (name, enabled) => deliver(chrome, {feature: 'milo', type: 'set-preference', name, enabled},
    {id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/options.html`, origin: `chrome-extension://${chrome.runtime.id}`});
  const send = (f, feature, message) => deliver(chrome, {feature, ...message}, f.sender).then(r => r.response);
  const polls = (f, tag = 'sn-tk') => f.posted.filter(p => p.from === 'isolated' && p.data?.source === `${tag}-extension` && p.data.type === 'poll');
  return {chrome, calls, storage, app, modules, notifications, cleared, injections, frames, frame, loadStatic, setPref, send, polls};
}
