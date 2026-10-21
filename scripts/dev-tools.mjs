// Shared flow of scripts/load-extension.mjs and scripts/apply-update.mjs (developer tools for a Chromium-family
// browser started with --remote-debugging-port and --enable-unsafe-extension-debugging).
//
// Order of operations (the first two never touch a browser):
//   1. generation gate: ensureGenerated() (generate, then --check). Failure ⇒ exit 1, ZERO CDP/network calls.
//   2. endpoint: --cdp URL or SN_MILO_CDP (loopback http only; nothing is assumed, 9333 is not special).
//   3. GET /json/version, print product/version; without --yes stop here (exit 2) — nothing is loaded or injected.
//   4. Inventory installed extensions. Before any reload, acquire Informatica maintenance through the
//      existing extension's still-live worker/ISOLATED worlds; busy or unknown ⇒ refuse load entirely.
//      A confirmed fresh install needs no old worker. Then Extensions.loadUnpacked(<this repo root>) and
//      Extensions.getExtensions: the extension must be enabled and its loaded version must equal
//      manifest.template.json's version (the generator already enforced template == package.json == generated
//      manifest). Equality does NOT prove a version was bumped: semver bumps are made by editing the two committed
//      version fields (manifest.template.json and package.json) by hand.
//   5. (apply-update only) ask the extension's own service worker to reinject into open tabs:
//      `await snMilo.reinjectOpenTabs()` evaluated in the worker's context (shared/reinject.mjs; exact origins, no
//      reload/navigation/click/submit; no page-world evaluation from this script at all).
import path from 'node:path';
import {ensureGenerated, REPO_ROOT} from './generate-config.mjs';
import {resolveEndpoint, browserInfo, connectBrowser} from './cdp.mjs';
import {maintenanceInDocument, reserveInformatica} from '../shared/informatica-maintenance.mjs';

// Inspect the still-live OLD worker before invalidating it. A missing worker or
// unsupported old controller is uncertainty, never evidence that a reload is safe.
export async function loadWithSafety({browser, root, origins}) {
  const inventory = await browser.call('Extensions.getExtensions');
  if (!Array.isArray(inventory.extensions) || inventory.extensions.some(e => typeof e.path !== 'string')) throw new Error('extension inventory unavailable; refusing load');
  const existing = inventory.extensions.find(e => path.resolve(e.path) === path.resolve(root));
  if (!existing) return browser.call('Extensions.loadUnpacked', {path: root});
  if (!existing.enabled) throw new Error('existing extension disabled: Informatica safety unknown; refusing load');
  const {targetInfos} = await browser.call('Target.getTargets');
  const worker = targetInfos.find(t => t.type === 'service_worker' && t.url === `chrome-extension://${existing.id}/background.js`);
  if (!worker) throw new Error('existing worker unavailable: Informatica safety unknown; refusing load');
  const {sessionId} = await browser.call('Target.attachToTarget', {targetId: worker.targetId, flatten: true});
  const owner = `update-${crypto.randomUUID()}`;
  const evaluate = async expression => {
    const r = await browser.call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, sessionId, 15000);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  let loaded = false;
  try {
    // Store attempted reservations in the old worker too, so release works even
    // if CDP loses the acquisition response. No MAIN globals or fabricated flags.
    await evaluate(`(async () => { if (!globalThis.snMilo?.informaticaMaintenance) throw Error('informatica global maintenance unsupported; refusing load'); const locks = globalThis.__miloUpdateLocks ||= {}; const state = locks[${JSON.stringify(owner)}] = {held:[],cancelled:false}; await snMilo.informaticaMaintenance.acquire(${JSON.stringify(owner)}); if (state.cancelled) throw Error('informatica-maintenance-cancelled'); await (${reserveInformatica.toString()})(chrome, ${JSON.stringify(origins)}, ${JSON.stringify(owner)}, (${maintenanceInDocument.toString()}), state); return true; })()`);
    let result;
    try { result = await browser.call('Extensions.loadUnpacked', {path: root}); }
    catch (error) {
      if (/CDP timeout|websocket/i.test(error.message)) {
        loaded = true; // ambiguous invalidation: retain old lock, do not allow a new run
        throw new Error(`${error.message}; Informatica maintenance retained because reload may still complete; inspect tabs before retry`);
      }
      throw error;
    }
    loaded = true;
    return {...result, maintenanceOwner: owner};
  } finally {
    // Reload destroys old bindings, but NOT the persisted worker gate. Old local
    // reservations stay held; all new worlds require a lease and remain blocked
    // until run() confirms reinjection and releases the same transaction owner.
    try {
      if (!loaded) await evaluate(`(async () => { const state = globalThis.__miloUpdateLocks?.[${JSON.stringify(owner)}]; if (!state) { if ((await globalThis.snMilo?.informaticaMaintenance?.status())?.maintenance === ${JSON.stringify(owner)}) await snMilo.informaticaMaintenance.release(${JSON.stringify(owner)}); return; } state.cancelled = true; const errors = []; for (const tabId of state.held) { try { await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',func:(${maintenanceInDocument.toString()}),args:['release',${JSON.stringify(owner)}]}); } catch { errors.push(tabId); } } if (errors.length) throw new Error('Informatica maintenance release unconfirmed; inspect tabs before retry'); delete globalThis.__miloUpdateLocks[${JSON.stringify(owner)}]; if ((await snMilo.informaticaMaintenance.status()).maintenance === ${JSON.stringify(owner)}) await snMilo.informaticaMaintenance.release(${JSON.stringify(owner)}); })()`);
    } catch (error) {
      throw new Error(`Informatica maintenance release unconfirmed: ${error.message}; inspect tabs before retry`);
    } finally { await browser.call('Target.detachFromTarget', {sessionId}).catch(() => {}); }
  }
}

export const USAGE = `usage: <script> --cdp http://127.0.0.1:<port> --yes
  --cdp URL   CDP endpoint (or SN_MILO_CDP); loopback only, never assumed
  --root DIR  advanced/test override: generate and LOAD DIR instead of this repository (same safety gates)
  --yes       confirm acting on that browser (without it the script only prints the browser product/version and stops)`;

export function parseFlags(argv) {
  const flags = {yes: false, help: false, root: REPO_ROOT};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') flags.yes = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--cdp') i++; // consumed by resolveEndpoint
    else if (a.startsWith('--cdp=')) continue;
    else if (a === '--root' && argv[i + 1]) flags.root = path.resolve(argv[++i]); // tests: sanitized temp roots
    else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  return flags;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Returns {exitCode, result?}. `log`/`err` default to console. */
export async function run({argv = process.argv.slice(2), env = process.env, reinject = false, log = console.log, err = console.error} = {}) {
  let flags;
  try { flags = parseFlags(argv); } catch (error) { err(error.message); return {exitCode: 2}; }
  if (flags.help) { log(USAGE); return {exitCode: 0}; }

  let generated;
  try { generated = ensureGenerated({root: flags.root}); } catch (error) {
    err(`${error.message}\nrefusing to touch any browser: fix the generator input first (no CDP calls were made).`);
    return {exitCode: 1};
  }

  let endpoint;
  try { endpoint = resolveEndpoint({argv, env}); } catch (error) { err(error.message); return {exitCode: 2}; }
  let info;
  try { info = await browserInfo(endpoint); } catch (error) { err(`cannot read ${endpoint}/json/version: ${error.message}`); return {exitCode: 1}; }
  log(`browser at ${endpoint}: ${info.Browser} (protocol ${info['Protocol-Version'] ?? '?'})`);
  if (!flags.yes) {
    err(`not acting on this browser without --yes. This would load ${flags.root} (version ${generated.version})${reinject ? ' and reinject scripts into its open ServiceNow tabs' : ''}.`);
    return {exitCode: 2};
  }

  let browser;
  try {
    browser = await connectBrowser(info);
    const installed = await loadWithSafety({browser, root: flags.root, origins: generated.origins});
    const {extensions} = await browser.call('Extensions.getExtensions');
    const extension = extensions.find(item => item.id === installed.id);
    if (!extension?.enabled || extension.version !== generated.version) {
      err(`extension update not confirmed: loaded ${JSON.stringify(extension ? {id: extension.id, enabled: extension.enabled, version: extension.version} : null)}, expected enabled version ${generated.version}`);
      return {exitCode: 1};
    }
    log(JSON.stringify({loaded: {id: extension.id, name: extension.name, version: extension.version, enabled: extension.enabled}}));
    if (!reinject && !installed.maintenanceOwner) return {exitCode: 0, result: {id: extension.id, version: extension.version}};

    const workerUrl = `chrome-extension://${extension.id}/background.js`;
    let sessionId = null;
    for (let i = 0; i < 50 && !sessionId; i++) {
      const {targetInfos} = await browser.call('Target.getTargets');
      const worker = targetInfos.find(t => t.type === 'service_worker' && t.url === workerUrl);
      if (worker) {
        try { ({sessionId} = await browser.call('Target.attachToTarget', {targetId: worker.targetId, flatten: true})); } catch {}
      }
      if (!sessionId) await sleep(200);
    }
    if (!sessionId) { err(`service worker ${workerUrl} not found (is the extension enabled?)`); return {exitCode: 1}; }
    const evaluate = async expression => {
      const r = await browser.call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, sessionId, 60000);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    for (let i = 0; i < 50 && (await evaluate(`typeof globalThis.snMilo?.reinjectOpenTabs`)) !== 'function'; i++) await sleep(200);
    const summary = await evaluate(`snMilo.reinjectOpenTabs()`);
    if (!summary.failed && installed.maintenanceOwner) await evaluate(`snMilo.informaticaMaintenance.release(${JSON.stringify(installed.maintenanceOwner)})`);
    log(JSON.stringify({extensionId: extension.id, version: extension.version, reinjected: summary, navigations: 0, submissionsAttempted: 0}, null, 2));
    await browser.call('Target.detachFromTarget', {sessionId}).catch(() => {});
    return {exitCode: summary.failed ? 1 : 0, result: summary};
  } catch (error) {
    err(`developer update failed: ${error.message}. No automatic retry: pending browser work may still complete; inspect the browser before another explicit pass.`);
    return {exitCode: 1};
  } finally { browser?.close(); }
}

export const isMain = metaUrl => process.argv[1] && metaUrl === new URL(`file://${path.resolve(process.argv[1])}`).href;
