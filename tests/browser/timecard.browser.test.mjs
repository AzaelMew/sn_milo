// Real-browser check for the timecard feature (disposable Vivaldi, fixtures only; run via `npm run test:browser`).
// Every *.service-now.com request is intercepted with CDP Fetch: only the three fixture documents below are served,
// everything else fails, and the test fails on any non-GET request. The fixture "native form" has no <form>, no
// handlers and no submit path — NOTHING is ever submitted.
// Verifies on BOTH the production and the test origin: the Add timecard launch button appears when enabled, is removed
// by disabling (options page checkbox) and returns exactly once on re-enable, without a page reload; an open overlay
// (fixture native form in an iframe, with a typed draft) is RETAINED on disable — draft intact, same overlay node,
// no confirm/discard — and the options status line says 'disabled; current form retained until closed'; reinjecting
// content.js (watchdog-style, from the worker) keeps the dirty overlay; a native form frame opened directly (classic
// gsft_main shell) still gets the early native-compat/native-actions fixes while the overlay toggle is off.
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
const USER_ID = 'fedcba9876543210fedcba9876543210';
const RETAINED = 'disabled; current form retained until closed';
const CASE_PATH = `/now/cwf/agent/record/sn_customerservice_case/${SYS_ID}`;
const FORM_PATH = '/task_time_worked.do';
const SHELL_PATH = '/nav_to.do';
const CASE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>timecard case fixture</title></head><body>
<p>Case fixture (inert)</p><div id="bar"><button type="button" id="native-record-time">Record Time</button></div>
<script>
  window.NOW = {user: {userID: '${USER_ID}'}};
  window.__fixtureAdds = 0; window.__confirms = 0;
  window.confirm = () => { window.__confirms++; return false; };
  new MutationObserver(records => { for (const r of records) for (const n of r.addedNodes) if (n.id === 'sn-timecard-add') window.__fixtureAdds++; })
    .observe(document.getElementById('bar'), {childList: true});
</script></body></html>`;
// Native-form fixture: a g_form object assigned by page script (like ServiceNow's onLoad bootstrap), an action bar
// with the bottom insert button (inert: no handler, no form), and one text field whose input marks the form modified.
const FORM_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>native form fixture</title></head><body>
<div class="form_action_button_container"><button type="button" id="sysverb_insert_bottom">Submit</button></div>
<input id="draft" type="text">
<script>
  window.__nativeWrites = 0; window.__nativeSubmits = 0;
  window.gsftSubmit = () => { window.__nativeSubmits++; throw new Error('native submission forbidden'); };
  window.g_form = {modified: false, getControl: id => document.getElementById(id),
    setValue() { window.__nativeWrites++; throw new Error('native field writes forbidden'); },
    submit() { window.__nativeSubmits++; throw new Error('native submission forbidden'); }};
  document.addEventListener('input', () => { window.g_form.modified = true; });
</script></body></html>`;
const SHELL_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>classic shell fixture</title></head><body>
<iframe id="gsft_main" src="${FORM_PATH}?sys_id=-1&sysparm_view=csm" width="600" height="300"></iframe></body></html>`;

test('timecard: launch button + draft-preserving disable on production and test origins; native compat stays on', async () => {
  await withGeneratedArtifacts({root: repo}, async generated => {
    const P = generated.origins.production;
    const T = generated.origins.test;
    const fixtures = ({url, resourceType}) => {
      const u = new URL(url);
      if (resourceType !== 'Document' || (u.origin !== P && u.origin !== T)) return null;
      if (u.pathname === CASE_PATH) return {body: CASE_HTML};
      if (u.pathname === FORM_PATH) return {body: FORM_HTML};
      if (u.pathname === SHELL_PATH) return {body: SHELL_HTML};
      return null;
    };
    const browser = await launchDisposableBrowser({port: resolvePort(process.env.SN_MILO_TIMECARD_PORT, 9477), fixtures});
    const problems = [];
    const stopEvents = browser.onEvent(msg => {
      if (msg.method === 'Runtime.exceptionThrown') problems.push({sessionId: msg.sessionId, text: msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text});
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(msg.params.type)) problems.push({sessionId: msg.sessionId, text: JSON.stringify(msg.params.args?.map(a => a.value ?? a.description))});
    });
    const sessionFor = pred => waitFor(() => [...browser.sessions.entries()].find(([, t]) => pred(t))?.[0], {what: 'target session'});
    const evaluate = async (sessionId, expression, timeoutMs = 5000) => {
      const r = await browser.call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, sessionId, timeoutMs);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    try {
      const {id} = await browser.call('Extensions.loadUnpacked', {path: repo});
      const sw = await sessionFor(t => t.type === 'service_worker' && t.url === `chrome-extension://${id}/background.js`);
      await waitFor(async () => (await evaluate(sw, 'snMilo.status()'))?.ready, {what: 'worker ready'});
      const open = async url => {
        const s = await browser.openPage(url);
        await browser.call('Runtime.enable', {}, s);
        return s;
      };
      const pages = {production: await open(`${P}${CASE_PATH}`), test: await open(`${T}${CASE_PATH}`)};
      const everyPage = fn => Promise.all(Object.entries(pages).map(([role, s]) => fn(role, s)));
      const state = s => evaluate(s, `(() => { const b = [...document.querySelectorAll('#sn-timecard-add')]; const app = window.__snTimecardApp;
        const o = document.getElementById('sn-timecard-overlay'); const f = o?.shadowRoot?.querySelector('iframe');
        return {buttons: b.length, adds: window.__fixtureAdds, confirms: window.__confirms, timeOrigin: performance.timeOrigin,
          setting: window.__snMiloMainSettings?.get('timecard')?.enabled ?? null,
          app: app ? app.status() : null, overlays: document.querySelectorAll('#sn-timecard-overlay').length,
          sameOverlay: Boolean(o && o.__marker === 'm1'), frame: Boolean(f),
          draft: f ? (f.contentDocument?.getElementById('draft')?.value ?? null) : null,
          modified: f ? (f.contentWindow?.g_form?.modified ?? null) : null}; })()`);

      // ---- options page: toggle through the real router ----
      const {targetId: optTarget} = await browser.call('Target.createTarget', {url: `chrome-extension://${id}/options.html`});
      const opt = await sessionFor(t => t.targetId === optTarget);
      await waitFor(() => evaluate(opt, `document.readyState === 'complete' && Number(document.documentElement.dataset.rendered || 0) >= 1`), {what: 'options rendered'});
      const clickOption = async want => {
        await waitFor(() => evaluate(opt, `(() => { const b = document.querySelector('input[data-feature="timecard"]'); return b && !b.disabled && b.checked !== ${want}; })()`), {what: 'options checkbox ready'});
        await evaluate(opt, `document.querySelector('input[data-feature="timecard"]').click(), true`);
      };
      const statusLine = () => evaluate(opt, `document.getElementById('timecard-status')?.textContent ?? null`);
      const workerLine = async () => (await evaluate(opt, `chrome.runtime.sendMessage({feature: 'milo', type: 'get-status'}).then(r => r.status.features.timecard.statusLine ?? null)`));

      // 1. enabled: one launch button per origin
      let adds = 1;
      const first = {};
      await everyPage(async (role, s) => {
        const st = await waitFor(async () => { const x = await state(s); return x.buttons === 1 && x.setting === true && x; }, {what: `${role}: launch button`});
        assert.equal(st.adds, 1);
        first[role] = st.timeOrigin;
      });

      // 2. disable: gone and stays gone; re-enable: back exactly once (no reload)
      await clickOption(false);
      await everyPage(async (role, s) => {
        await waitFor(async () => { const x = await state(s); return x.buttons === 0 && x.setting === false && x.app.enabled === false && x; }, {what: `${role}: button removed on disable`});
      });
      await sleep(3500); // > two 1.5 s poll ticks: nothing comes back on its own
      await everyPage(async (role, s) => assert.equal((await state(s)).buttons, 0, `${role}: stays removed`));
      await clickOption(true);
      adds++;
      await everyPage(async (role, s) => {
        await waitFor(async () => { const x = await state(s); return x.buttons === 1 && x.setting === true && x; }, {what: `${role}: button back on re-enable`});
      });
      await sleep(3500);
      await everyPage(async (role, s) => {
        const x = await state(s);
        assert.equal(x.buttons, 1, `${role}: exactly one button`);
        assert.equal(x.adds, adds, `${role}: mounted once per enable`);
        assert.equal(x.timeOrigin, first[role], `${role}: no reload`);
      });

      // 3. open the overlay on both pages; production gets a typed (dirty) draft, test stays clean
      await everyPage((role, s) => evaluate(s, `document.getElementById('sn-timecard-add').click(), true`));
      await everyPage(async (role, s) => {
        const x = await waitFor(async () => { const x = await state(s); return x.overlays === 1 && x.frame && x.draft !== null && x; }, {what: `${role}: overlay form loaded`});
        assert.equal(x.modified, false);
        await evaluate(s, `document.getElementById('sn-timecard-overlay').__marker = 'm1', true`);
      });
      await evaluate(pages.production, `(() => { const d = document.getElementById('sn-timecard-overlay').shadowRoot.querySelector('iframe').contentDocument;
        const i = d.getElementById('draft'); i.value = 'draft-12345'; i.dispatchEvent(new Event('input', {bubbles: true})); return true; })()`);
      assert.equal((await state(pages.production)).modified, true, 'fixture draft is dirty');

      // 4. disable with open overlays: retained (clean and dirty), no discard prompt, status line reported
      await clickOption(false);
      await everyPage(async (role, s) => {
        await waitFor(async () => { const x = await state(s); return x.buttons === 0 && x.setting === false && x; }, {what: `${role}: launch UI removed`});
      });
      await sleep(2500);
      await everyPage(async (role, s) => {
        const x = await state(s);
        assert.equal(x.overlays, 1, `${role}: overlay retained`);
        assert.equal(x.sameOverlay, true, `${role}: same overlay node`);
        assert.equal(x.frame, true);
        assert.equal(x.confirms, 0, `${role}: nothing asked/discarded`);
        assert.equal(x.app.retained, true);
        assert.equal(x.app.note, RETAINED);
        assert.equal(x.buttons, 0);
      });
      assert.equal((await state(pages.production)).draft, 'draft-12345', 'typed draft intact');
      assert.equal((await state(pages.production)).modified, true);
      await waitFor(async () => (await statusLine()) === `${RETAINED} (2 tabs)`, {what: 'options status line (2 tabs)'});
      assert.equal(await workerLine(), `${RETAINED} (2 tabs)`);

      // 5. reinjection (watchdog-style) while dirty keeps the controller, overlay and draft
      await evaluate(pages.production, `window.__snTimecardApp.__tag = 'before', true`);
      await evaluate(sw, `(async () => { const tabs = await chrome.tabs.query({url: ['${P}/*']});
        for (const t of tabs) await chrome.scripting.executeScript({target: {tabId: t.id}, world: 'MAIN', files: ['features/timecard/content.js']}); return tabs.length; })()`);
      const re = await state(pages.production);
      assert.equal(await evaluate(pages.production, `window.__snTimecardApp.__tag`), 'before', 'controller instance kept');
      assert.equal(re.overlays, 1);
      assert.equal(re.sameOverlay, true);
      assert.equal(re.draft, 'draft-12345');
      assert.equal(re.buttons, 0, 'still disabled after reinjection');

      // 6. close the clean (test) form with the non-forced close(): status drops to one tab; closing never revives the UI
      assert.equal(await evaluate(pages.test, `window.__snTimecardApp.close()`), true);
      await waitFor(async () => (await workerLine()) === RETAINED, {what: 'worker status line (1 tab)'});
      const t1 = await state(pages.test);
      assert.deepEqual([t1.overlays, t1.buttons, t1.app.retained], [0, 0, false]);

      // 7. re-enable with the dirty draft still open: same overlay, draft intact, launch button back exactly once
      await clickOption(true);
      adds++;
      const back = await waitFor(async () => { const x = await state(pages.production); return x.buttons === 1 && x.setting === true && x; }, {what: 'production: button back'});
      await sleep(3500);
      const again = await state(pages.production);
      assert.deepEqual([again.buttons, again.overlays, again.sameOverlay, again.draft, again.app.retained, again.confirms], [1, 1, true, 'draft-12345', false, 0]);
      assert.equal(again.timeOrigin, first.production);
      assert.equal(back.timeOrigin, first.production);
      await waitFor(async () => (await workerLine()) === null, {what: 'no status line while enabled'});

      // 8. finish the draft handling: discard it the way a user would (non-forced close after the draft is clean)
      await evaluate(pages.production, `(() => { document.getElementById('sn-timecard-overlay').shadowRoot.querySelector('iframe').contentWindow.g_form.modified = false; return window.__snTimecardApp.close(); })()`);
      assert.equal((await state(pages.production)).overlays, 0);

      // 9. native form frames opened directly (classic shell) with the overlay DISABLED: compat + native actions still run
      await clickOption(false);
      await everyPage(async (role, s) => { await waitFor(async () => (await state(s)).setting === false, {what: `${role}: disabled`}); });
      const shells = {production: await open(`${P}${SHELL_PATH}`), test: await open(`${T}${SHELL_PATH}`)};
      for (const [role, s] of Object.entries(shells)) {
        const nat = await waitFor(() => evaluate(s, `(() => { const f = document.getElementById('gsft_main'); const d = f.contentDocument; const w = f.contentWindow;
          if (!d || d.readyState !== 'complete' || !w.g_form) return null;
          const alias = d.getElementById('sysverb_insert');
          return {placeholderApi: typeof w.g_form.setFieldPlaceholder, alias: alias?.getAttribute('data-sn-timecard-native-action') ?? null,
            aliasHidden: alias?.style.display ?? null, aliasStyle: Boolean(d.getElementById('sn-timecard-native-action-style')),
            overlaySetting: w.__snMiloMainSettings?.get('timecard')?.enabled ?? null,
            topButtons: document.querySelectorAll('#sn-timecard-add').length, app: typeof window.__snTimecardApp}; })()`), {what: `${role}: native form frame ready`});
        assert.deepEqual(nat, {placeholderApi: 'function', alias: 'alias', aliasHidden: 'none', aliasStyle: true, overlaySetting: false, topButtons: 0, app: 'object'}, `${role}: compat marker with overlay disabled`);
      }

      // 10. Direct TOP-LEVEL native documents, not just native iframes. Static document_start
      // installation remains on with the overlay disabled, including after a real page reload.
      const nativePages = [];
      for (const [role, origin] of [['production', P], ['test', T]]) {
        const s = await open(`${origin}${FORM_PATH}?sys_id=-1&sysparm_titleless=true`);
        nativePages.push(s);
        const probe = () => evaluate(s, `(() => ({
          top: window === window.top, api: typeof g_form?.setFieldPlaceholder,
          aliases: document.querySelectorAll('#sysverb_insert[data-sn-timecard-native-action="alias"]').length,
          hidden: document.getElementById('sysverb_insert')?.style.display,
          setting: window.__snMiloMainSettings?.get('timecard')?.enabled,
          buttons: document.querySelectorAll('#sn-timecard-add').length,
          timeOrigin: performance.timeOrigin, writes: window.__nativeWrites, submits: window.__nativeSubmits
        }))()`);
        const firstNative = await waitFor(async () => { const n = await probe(); return n.api === 'function' && n.aliases === 1 && n.setting === false && n; }, {what: `${role}: top-level native ready`});
        assert.deepEqual([firstNative.top, firstNative.hidden, firstNative.buttons, firstNative.writes, firstNative.submits], [true, 'none', 0, 0, 0]);
        await browser.call('Page.reload', {}, s);
        const reloaded = await waitFor(async () => { const n = await probe(); return n.timeOrigin !== firstNative.timeOrigin && n.api === 'function' && n.aliases === 1 && n.setting === false && n; }, {what: `${role}: top-level native reloaded`});
        assert.deepEqual([reloaded.top, reloaded.hidden, reloaded.buttons, reloaded.writes, reloaded.submits], [true, 'none', 0, 0, 0]);
      }

      // nothing but the fixture documents was served; no write ever left a page
      assert.deepEqual(browser.interceptionErrors, []);
      for (const r of browser.intercepted) {
        const u = new URL(r.url);
        const fixture = r.resourceType === 'Document' && [CASE_PATH, FORM_PATH, SHELL_PATH].includes(u.pathname);
        assert.equal(r.action, fixture ? 'fulfilled-fixture' : 'failed', r.url);
        assert.equal(r.method, 'GET', `no write request: ${r.method} ${r.url}`);
        assert.ok(!u.pathname.startsWith('/api/'), `no API request: ${r.url}`);
      }
      const watched = new Set([...Object.values(pages), ...Object.values(shells), ...nativePages, opt]);
      assert.deepEqual(problems.filter(p => watched.has(p.sessionId)), [], 'no page/options errors');
      console.log(`# timecard verified in disposable pid ${browser.pid} port ${browser.port}; intercepted ${browser.intercepted.length} service-now requests (${browser.intercepted.filter(r => r.action === 'fulfilled-fixture').length} fixtures, rest failed); nothing submitted`);
    } finally {
      stopEvents();
      const closed = await browser.close();
      console.log(`# closed disposable browser pid ${closed.pid} (stragglers killed: ${closed.stragglersKilled})`);
    }
  });
});
