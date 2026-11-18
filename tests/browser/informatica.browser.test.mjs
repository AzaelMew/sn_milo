// Real-browser check for the Informatica button (disposable Vivaldi, fixtures only; run via `npm run test:browser`).
// A fixture "AMS Informatica" record page is served for the configured PRODUCTION origin through CDP Fetch; every
// other *.service-now.com request (any resource type) is failed, so no request can reach an instance. The button is
// NEVER clicked: the workflow (Save/Post writes) is covered by mocked unit tests (tests/informatica.test.mjs). The
// fixture has no handlers, no g_ck and no form fields, so even an accidental click could not write anything.
// Verifies: the button mounts when enabled, disappears on disable via the options page and via a storage toggle
// without a reload, and reappears exactly once on each re-enable; the MAIN bridge arms/disarms with it; the test
// host never gets the feature.
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

const SYS_ID = '0123456789abcdef0123456789abcdef';
const RECORD_PATH = `/now/sow/record/incident/${SYS_ID}`;
// Workspace-shaped fixture: a macroponent whose shadow root holds the "AMS Informatica" H1 and an action bar with
// inert buttons (placement reference only). No g_ck, no list field, no compose pane, no handlers.
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>AMS Informatica fixture</title></head><body>
<macroponent-fixture0001></macroponent-fixture0001>
<script>
  const host = document.querySelector('macroponent-fixture0001');
  const root = host.attachShadow({mode: 'open'});
  root.innerHTML = '<h1>Monitoring Alarm: acme-dw01.example.local - AMS Informatica error: 2026-11-18 01:25:42.32 [ FAILED ] Session EXAMPLE_Load.wf_Example_Load.s_m_Load</h1><now-record-common-uiactionbar></now-record-common-uiactionbar>';
  const bar = root.querySelector('now-record-common-uiactionbar');
  bar.attachShadow({mode: 'open'}).innerHTML = '<button type="button" disabled style="margin-left:900px">Save</button>';
  window.__fixtureAdds = 0;
  new MutationObserver(records => { for (const r of records) for (const n of r.addedNodes) if (n.id === 'sn-inf-button') window.__fixtureAdds++; })
    .observe(document.body, {childList: true});
</script></body></html>`;

test('informatica button: mounts when enabled, removed on disable (options + storage), exactly one on re-enable, no reload', async () => {
  await withGeneratedArtifacts({root: repo}, async generated => {
    const P = generated.origins.production;
    const T = generated.origins.test;
    const fixtures = ({url, resourceType}) => {
      const u = new URL(url);
      return resourceType === 'Document' && (u.origin === P || u.origin === T) && u.pathname === RECORD_PATH ? {body: FIXTURE} : null;
    };
    const browser = await launchDisposableBrowser({port: resolvePort(process.env.SN_MILO_INFORMATICA_PORT, 9467), fixtures});
    const problems = [];
    const stopEvents = browser.onEvent(msg => {
      if (msg.method === 'Runtime.exceptionThrown') problems.push({sessionId: msg.sessionId, text: msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text});
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(msg.params.type)) problems.push({sessionId: msg.sessionId, text: JSON.stringify(msg.params.args?.map(a => a.value ?? a.description))});
    });
    const sessionFor = pred => waitFor(() => [...browser.sessions.entries()].find(([, t]) => pred(t))?.[0], {what: 'target session'});
    // short per-call timeout: a call that hangs during navigation/worker restart is retried by waitFor instead of
    // eating the whole waitFor budget (15 s default > 10 s waitFor)
    const evaluate = async (sessionId, expression, timeoutMs = 5000) => {
      const r = await browser.call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, sessionId, timeoutMs);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    try {
      const {id} = await browser.call('Extensions.loadUnpacked', {path: repo});
      const sw = await sessionFor(t => t.type === 'service_worker' && t.url === `chrome-extension://${id}/background.js`);
      await waitFor(async () => (await evaluate(sw, 'snMilo.status()'))?.ready, {what: 'worker ready'});
      // interception armed before navigating; fails fast on an error page (see lib openPage)
      const open = async url => {
        const s = await browser.openPage(url);
        await browser.call('Runtime.enable', {}, s);
        return s;
      };
      const page = await open(`${P}${RECORD_PATH}`);
      const state = () => evaluate(page, `(() => { const b = [...document.querySelectorAll('#sn-inf-button')];
        return {count: b.length, display: b[0]?.style.display ?? null, text: b[0]?.textContent ?? null, adds: window.__fixtureAdds,
          bridge: window.__snInfBridge ? window.__snInfBridge.active : null,
          setting: window.__snMiloMainSettings?.get('informatica-button')?.enabled ?? null, timeOrigin: performance.timeOrigin}; })()`);
      const s0 = await waitFor(async () => { const s = await state(); return s.count === 1 && s.display === 'block' && s.bridge === true && s; }, {what: 'button mounted'});
      assert.equal(s0.text, 'Informatica');
      assert.equal(s0.adds, 1);
      const placed = await evaluate(page, `(() => { const r = document.getElementById('sn-inf-button').getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`);
      assert.equal(placed, true, 'rendered with a non-empty box');

      // options page toggle (router set-preference) — disable, then re-enable
      const {targetId: optTarget} = await browser.call('Target.createTarget', {url: `chrome-extension://${id}/options.html`});
      const opt = await sessionFor(t => t.targetId === optTarget);
      await waitFor(() => evaluate(opt, `document.readyState === 'complete' && Number(document.documentElement.dataset.rendered || 0) >= 1`), {what: 'options rendered'});
      const clickOption = async want => {
        await waitFor(() => evaluate(opt, `(() => { const b = document.querySelector('input[data-feature="informatica-button"]'); return b && !b.disabled && b.checked !== ${want}; })()`), {what: 'options checkbox ready'});
        await evaluate(opt, `document.querySelector('input[data-feature="informatica-button"]').click(), true`);
      };
      const expectGone = async what => {
        const s = await waitFor(async () => { const s = await state(); return s.count === 0 && s.bridge === false && s.setting === false && s; }, {what});
        await sleep(3500); // > 2 placement ticks: nothing comes back on its own
        const again = await state();
        assert.equal(again.count, 0, `${what}: stays removed`);
        return s;
      };
      const expectOne = async (what, adds) => {
        const s = await waitFor(async () => { const s = await state(); return s.count === 1 && s.display === 'block' && s.bridge === true && s; }, {what});
        await sleep(3500);
        const again = await state();
        assert.equal(again.count, 1, `${what}: exactly one button`);
        assert.equal(again.adds, adds, `${what}: mounted exactly once`);
        return s;
      };
      await clickOption(false);
      const s1 = await expectGone('disable via options page');
      await clickOption(true);
      const s2 = await expectOne('re-enable via options page', 2);
      // storage toggle (as another trusted context would write it)
      await evaluate(sw, `chrome.storage.local.set({features: {'informatica-button': false}}).then(() => true)`);
      const s3 = await expectGone('disable via storage');
      await evaluate(sw, `chrome.storage.local.set({features: {'informatica-button': true}}).then(() => true)`);
      const s4 = await expectOne('re-enable via storage', 3);
      for (const s of [s1, s2, s3, s4]) assert.equal(s.timeOrigin, s0.timeOrigin, 'no page reload');

      // test host: feature never injected (production-only manifest match) and never enabled there
      const tst = await open(`${T}${RECORD_PATH}`);
      await waitFor(() => evaluate(tst, `window.__snMiloMainSettings?.get('timecard')?.enabled === true`), {what: 'test-host settings handshake'});
      await sleep(2000);
      assert.deepEqual(await evaluate(tst, `({count: document.querySelectorAll('#sn-inf-button').length, bridge: typeof window.__snInfBridge, setting: window.__snMiloMainSettings.get('informatica-button')})`),
        {count: 0, bridge: 'undefined', setting: null});

      // nothing but the fixture documents was served; no API call / write ever left the page
      assert.deepEqual(browser.interceptionErrors, []);
      for (const r of browser.intercepted) {
        const u = new URL(r.url);
        const fixture = r.resourceType === 'Document' && u.pathname === RECORD_PATH;
        assert.equal(r.action, fixture ? 'fulfilled-fixture' : 'failed', r.url);
        assert.equal(r.method, 'GET', `no write request: ${r.method} ${r.url}`);
        assert.ok(!u.pathname.startsWith('/api/'), `no API request: ${r.url}`);
      }
      assert.deepEqual(problems.filter(p => p.sessionId === page || p.sessionId === opt || p.sessionId === tst), [], 'no page/options errors');
      console.log(`# informatica button verified in disposable pid ${browser.pid} port ${browser.port}; intercepted ${browser.intercepted.length} service-now requests (${browser.intercepted.filter(r => r.action === 'fulfilled-fixture').length} fixtures, rest failed); button never clicked`);
    } finally {
      stopEvents();
      const closed = await browser.close();
      console.log(`# closed disposable browser pid ${closed.pid} (stragglers killed: ${closed.stragglersKilled})`);
    }
  });
});
