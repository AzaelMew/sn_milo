// Real-browser checks for content isolation and controller retirement (disposable Vivaldi, fixtures only):
//   1. after the worker starts, content scripts can neither read nor write chrome.storage.local
//      (storage.local.setAccessLevel TRUSTED_CONTEXTS) and effective state still reaches the page (worker push);
//   2. after an extension reload, scripts reinjected with chrome.scripting.executeScript run in a NEW isolated world
//      (they cannot see the old controller's globals), and the old controller retires on its own liveness check,
//      calling stop() on its subscribers.
// Run via `npm run test:browser` only.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {withGeneratedArtifacts} from '../../scripts/generate-config.mjs';
import {launchDisposableBrowser, resolvePort} from './lib/disposable-browser.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, {timeoutMs = 10000, intervalMs = 100, what = 'condition'} = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error; }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

test('content isolation: storage denied to content scripts; reload → new isolated world, old controller retires', async () => {
  await withGeneratedArtifacts({root: repo}, async generated => {
    const P = generated.origins.production;
    const fixtures = ({url, resourceType}) => {
      const u = new URL(url);
      return resourceType === 'Document' && u.origin === P && u.pathname === '/milo-fixture'
        ? {body: '<!doctype html><html><head><meta charset="utf-8"><title>milo isolation</title></head><body><p>fixture</p></body></html>'} : null;
    };
    const browser = await launchDisposableBrowser({port: resolvePort(process.env.SN_MILO_ISOLATION_PORT, 9465), fixtures});
    const contexts = []; // {sessionId, id, name, type}
    const stop = browser.onEvent(msg => {
      if (msg.method === 'Runtime.executionContextCreated') {
        const c = msg.params.context;
        contexts.push({sessionId: msg.sessionId, id: c.id, name: c.name, type: c.auxData?.type, isDefault: c.auxData?.isDefault});
      }
    });
    const sessionFor = pred => waitFor(() => [...browser.sessions.entries()].find(([sid, t]) => pred(t, sid))?.[0], {what: 'target session'});
    const evaluate = async (sessionId, expression, contextId) => {
      const r = await browser.call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, ...(contextId ? {contextId} : {})}, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    try {
      const {id} = await browser.call('Extensions.loadUnpacked', {path: repo});
      const swUrl = `chrome-extension://${id}/background.js`;
      const sw1 = await sessionFor(t => t.type === 'service_worker' && t.url === swUrl);
      await waitFor(async () => (await evaluate(sw1, 'snMilo.status()'))?.ready, {what: 'worker ready'});

      // interception armed before navigating; waits for THIS url (readyState alone also matches the initial about:blank)
      const page = await browser.openPage(`${P}/milo-fixture`);
      await browser.call('Runtime.enable', {}, page); // reports every existing context, incl. our isolated world
      const iso1 = await waitFor(() => contexts.find(c => c.sessionId === page && c.type === 'isolated' && c.name === 'ServiceNow Milo'), {what: 'isolated world'});
      const mainState = () => evaluate(page, `(() => { const a = window.__snMiloMainSettings; return a ? {kb: a.get('kb-dark')?.enabled ?? null, tc: a.get('timecard')?.enabled ?? null} : null; })()`);
      await waitFor(async () => JSON.stringify(await mainState()) === '{"kb":true,"tc":true}', {what: 'initial handshake'});

      // 1. content scripts cannot touch storage
      const denied = await evaluate(page, `(async () => {
        const out = {};
        for (const [k, op] of [['setMigration', () => chrome.storage.local.set({'crit.migrationV1': {schema: 1, state: 'ready', method: 'import', decidedAt: 1}})],
          ['setFeatures', () => chrome.storage.local.set({features: {'kb-dark': false}})], ['get', () => chrome.storage.local.get(null)]]) {
          try { await op(); out[k] = 'ALLOWED'; } catch (e) { out[k] = e.message; }
        }
        return out; })()`, iso1.id);
      for (const [k, v] of Object.entries(denied)) assert.match(v, /Access to storage is not allowed from this context/, k);
      const stored = await evaluate(sw1, `chrome.storage.local.get(null)`);
      assert.equal(stored['crit.migrationV1'], undefined);
      assert.equal(stored.features, undefined);
      // state still reaches the page without storage access (worker push)
      await evaluate(sw1, `chrome.storage.local.set({features: {'kb-dark': false}}).then(() => true)`);
      await waitFor(async () => JSON.stringify(await mainState()) === '{"kb":false,"tc":true}', {what: 'push delivers disable'});

      // 2. extension reload → new isolated world; old controller retires by liveness
      await evaluate(page, `globalThis.__probeMark = 'old-instance'; globalThis.__log = [];
        __snMiloController.subscribe('timecard', {start: () => __log.push('start'), stop: r => __log.push('stop:' + r)}); true`, iso1.id);
      assert.deepEqual(await evaluate(page, '__log', iso1.id), ['start']);
      const reloaded = await browser.call('Extensions.loadUnpacked', {path: repo});
      assert.equal(reloaded.id, id);
      const sw2 = await sessionFor((t, sid) => t.type === 'service_worker' && t.url === swUrl && sid !== sw1);
      await waitFor(async () => (await evaluate(sw2, 'snMilo.status()'))?.ready, {what: 'new worker ready'});
      assert.equal(await evaluate(page, 'String(chrome.runtime?.id)', iso1.id), 'undefined', 'old context invalidated');
      const tabId = await evaluate(sw2, `chrome.tabs.query({url: ${JSON.stringify(`${P}/*`)}}).then(t => t[0].id)`);
      const seen = await evaluate(sw2, `(async () => {
        await chrome.scripting.executeScript({target: {tabId: ${tabId}, allFrames: true}, files: ['shared/controller.js']});
        const [r] = await chrome.scripting.executeScript({target: {tabId: ${tabId}}, func: async () => {
          let storage;
          try { await chrome.storage.local.set({probe: 1}); storage = 'ALLOWED'; } catch (e) { storage = e.message; }
          return {mark: globalThis.__probeMark ?? null, controller: Boolean(globalThis.__snMiloController), retired: globalThis.__snMiloController?.retired ?? null, storage};
        }});
        return r.result; })()`);
      console.log(`# observed after extension reload + executeScript: ${JSON.stringify(seen)}`);
      assert.equal(seen.mark, null, 'reinjected scripts run in a NEW isolated world (old globals not visible)');
      assert.equal(seen.controller, true);
      assert.equal(seen.retired, false);
      assert.match(seen.storage, /not allowed/, 'new instance restricted storage again at startup');
      assert.equal(await evaluate(page, 'String(globalThis.__snMiloController.retired)', iso1.id), 'false', 'old world still has its own (orphaned) controller');
      const t0 = Date.now();
      await waitFor(async () => (await evaluate(page, 'globalThis.__snMiloController.retired', iso1.id)) === true, {timeoutMs: 8000, what: 'old controller retired by liveness check'});
      console.log(`# old controller retired ${Date.now() - t0} ms after the check started (liveness interval 5 s)`);
      assert.deepEqual(await evaluate(page, '__log', iso1.id), ['start', 'stop:invalidated']);
      // MAIN helper reinjected only now (its 'request' would otherwise retire the orphan through that entry point)
      await evaluate(sw2, `chrome.scripting.executeScript({target: {tabId: ${tabId}, allFrames: true}, world: 'MAIN', files: ['shared/main-settings.js']}).then(() => true)`);

      // the new controller drives the page
      await evaluate(sw2, `chrome.storage.local.set({features: {'kb-dark': true, timecard: false}}).then(() => true)`);
      await waitFor(async () => JSON.stringify(await mainState()) === '{"kb":true,"tc":false}', {what: 'new controller relays changes'});
      assert.deepEqual(browser.interceptionErrors, []);
      for (const r of browser.intercepted) assert.equal(r.action, r.resourceType === 'Document' && new URL(r.url).pathname === '/milo-fixture' ? 'fulfilled-fixture' : 'failed', r.url);
    } finally {
      stop();
      const closed = await browser.close();
      console.log(`# closed disposable browser pid ${closed.pid} (stragglers killed: ${closed.stragglersKilled})`);
    }
  });
});
