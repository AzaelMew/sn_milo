// Runs the REAL scripts/apply-update.mjs against a DISPOSABLE browser (fresh profile, notifications disabled by the
// launcher, every *.service-now.com request intercepted: three fixture documents + mocked alert Table API GETs, the
// rest failed; any non-GET fails the test). Never touches an existing browser: the endpoint is the launcher's own port.
// Scenario: Milo is loaded, fixture tabs are open (production case page carrying the alert bridge + Informatica
// fixture + timecard button, a production /kb page, a test-host case page), a timecard overlay with a DIRTY draft is
// open on the production tab. Then apply-update runs twice (reload of the extension + worker-side reinjection) and
// we assert, without any tab reload or navigation: alerts recovered with exactly one poller (one GET per table per
// forced poll, one notification per new row), Informatica has exactly one button, the KB attribute follows the
// preference, the dirty overlay (same node, draft, no confirm) survived, the test host got only shared + timecard
// steps, and no non-GET request left a page. `--yes` is passed explicitly; a run without it is checked to do nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {withGeneratedArtifacts} from '../../scripts/generate-config.mjs';
import {launchDisposableBrowser, resolvePort} from './lib/disposable-browser.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, {timeoutMs = 20000, intervalMs = 150, what = 'condition'} = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error; }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}
const hex = c => String(c).repeat(32).slice(0, 32);
const SYS_ID = hex('0123456789abcdef'.slice(0, 1) + 'a');
const CASE_PATH = `/now/cwf/agent/record/sn_customerservice_case/${hex('a')}`;
const FORM_PATH = '/task_time_worked.do';
const KB_PATH = '/kb';
const ROW_TABLES = ['sn_customerservice_case', 'sn_customerservice_task'];
const CASE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>case fixture</title>
<script>window.g_ck = 'fixture-token';</script></head><body>
<macroponent-fixture0001></macroponent-fixture0001>
<div id="bar"><button type="button" id="native-record-time">Record Time</button></div>
<script>
  window.NOW = {user: {userID: '${hex('f')}'}};
  window.__confirms = 0; window.confirm = () => { window.__confirms++; return false; };
  const root = document.querySelector('macroponent-fixture0001').attachShadow({mode: 'open'});
  root.innerHTML = '<h1>AMS Informatica: fixture record (inert)</h1><now-record-common-uiactionbar></now-record-common-uiactionbar><input aria-label="External work notes list"><li role="option" aria-selected="true" id="alice@example.com"></li><li role="option" aria-selected="true" id="bob@example.com"></li><li role="option" aria-selected="true" id="team-list@example.com"></li>';
  const nativeFetch = window.fetch;
  window.fetch = (url, options) => String(url).includes('u_external_work_notes_list') ? new Promise(resolve => { window.__releaseRead = () => resolve({ok:false,status:503}); }) : nativeFetch(url, options);
  root.querySelector('now-record-common-uiactionbar').attachShadow({mode: 'open'}).innerHTML = '<button type="button" disabled style="margin-left:900px">Save</button>';
</script></body></html>`;
const FORM_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>native form fixture</title></head><body>
<div class="form_action_button_container"><button type="button" id="sysverb_insert_bottom">Submit</button></div>
<input id="draft" type="text">
<script>
  window.g_form = {modified: false, getControl: id => document.getElementById(id), setValue() {}};
  document.addEventListener('input', () => { window.g_form.modified = true; });
</script></body></html>`;
const KB_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>kb fixture</title></head><body><p>KB fixture</p></body></html>`;

const runApplyUpdate = (args, env) => new Promise(resolve => {
  const child = spawn(process.execPath, [path.join(repo, 'scripts', 'apply-update.mjs'), ...args], {env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = ''; let stderr = '';
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  child.on('close', code => resolve({code, stdout, stderr}));
});

test('apply-update.mjs against a disposable browser: reinjection without reload/navigation/writes, exact scopes, no duplicates', async () => {
  await withGeneratedArtifacts({root: repo}, async generated => {
    const P = generated.origins.production;
    const T = generated.origins.test;
    const server = {rows: [], gets: 0};
    const fixtures = ({url, method, resourceType}) => {
      const u = new URL(url);
      if (method !== 'GET') return null;
      if (resourceType === 'Document' && (u.origin === P || u.origin === T)) {
        if (u.pathname === CASE_PATH) return {body: CASE_HTML};
        if (u.pathname === FORM_PATH) return {body: FORM_HTML};
        if (u.pathname === KB_PATH && u.origin === P) return {body: KB_HTML};
      }
      const m = /^\/api\/now\/table\/([a-z_]+)$/.exec(u.pathname);
      if (m && u.origin === P && ROW_TABLES.includes(m[1])) {
        server.gets++;
        const result = server.rows.filter(r => r.__table === m[1]).map(({__table, ...r}) => r);
        return {headers: {'Content-Type': 'application/json'}, body: JSON.stringify({result})};
      }
      return null;
    };
    const row = (c, table = ROW_TABLES[0]) => ({sys_id: hex(c), number: `CS${c}`, priority: '1 - Critical', state: 'New', short_description: `fixture ${c}`,
      account: {display_value: 'Acme Oy', link: 'https://invalid.invalid/x'}, __table: table});
    const browser = await launchDisposableBrowser({port: resolvePort(process.env.SN_MILO_APPLY_UPDATE_PORT, 9479), fixtures});
    const endpoint = `http://127.0.0.1:${browser.port}`;
    const sessionFor = pred => waitFor(() => [...browser.sessions.entries()].find(([, t]) => pred(t))?.[0], {what: 'target session'});
    const evaluate = async (sessionId, expression, timeoutMs = 8000) => {
      const r = await browser.call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, sessionId, timeoutMs);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    try {
      // Pre-install KB document also exercises takeover without declarative CSS.
      const oldKb = await browser.openPage(`${P}/kb?preexisting=1`);
      const {id} = await browser.call('Extensions.loadUnpacked', {path: repo});
      const workerSession = async () => sessionFor(t => t.type === 'service_worker' && t.url === `chrome-extension://${id}/background.js`);
      let sw = await workerSession();
      await waitFor(async () => (await evaluate(sw, 'snMilo.status()'))?.ready, {what: 'worker ready'});
      const recordNotifications = session => evaluate(session, `(() => {
        const n = chrome.notifications; globalThis.__notif = {created: []};
        const create = async id => { __notif.created.push(id); return id; };
        create.__miloRecorder = true; n.create = create; n.clear = async () => true; return true;
      })()`);
      await evaluate(sw, `chrome.storage.local.set({'inf.recipientsV1': {schema: 1, emails: ['alice@example.com', 'bob@example.com', 'team-list@example.com']}}).then(() => true)`); // the Informatica run needs recipients to start (and hold its lease)
      await recordNotifications(sw); // BEFORE migration enables any alert.

      // ---- critical alert: migrate through the options page (snapshot with the already-notified row 0) ----
      server.rows.push(row('0'));
      const {targetId: optTarget} = await browser.call('Target.createTarget', {url: `chrome-extension://${id}/options.html`});
      const opt = await sessionFor(t => t.targetId === optTarget);
      await waitFor(() => evaluate(opt, `document.readyState === 'complete' && Number(document.documentElement.dataset.rendered || 0) >= 1`), {what: 'options rendered'});
      const snapshot = {schema: 1, feature: 'critical-alert', key: 'seenMatchesV4', entries: [`${hex('0')}|1 - Critical|New|Acme Oy`]};
      await waitFor(() => evaluate(opt, `Boolean(document.querySelector('#features li[data-feature="critical-alert"] .migration textarea'))`), {what: 'migration section'});
      await evaluate(opt, `(() => { const m = document.querySelector('#features li[data-feature="critical-alert"] .migration'); m.querySelector('textarea').value = ${JSON.stringify(JSON.stringify(snapshot))}; m.querySelector('button[data-action=import]').click(); return true; })()`);
      await waitFor(async () => (await evaluate(sw, 'snMilo.status()')).features['critical-alert'].enabled === true, {what: 'critical alert enabled'});

      // ---- open fixture tabs (interception armed before navigation) ----
      const open = async url => { const s = await browser.openPage(url); await browser.call('Runtime.enable', {}, s); return s; };
      const pages = {prod: await open(`${P}${CASE_PATH}`), test: await open(`${T}${CASE_PATH}`), kb: await open(`${P}${KB_PATH}`)};
      const snap = s => evaluate(s, `(() => { const o = document.getElementById('sn-timecard-overlay'); const f = o?.shadowRoot?.querySelector('iframe');
        return {timeOrigin: performance.timeOrigin, href: location.href, confirms: window.__confirms ?? 0,
          tcButtons: document.querySelectorAll('#sn-timecard-add').length, infButtons: document.querySelectorAll('#sn-inf-button').length,
          tkBridge: typeof window.__snTkBridge, tkBridgeActive: window.__snTkBridge?.active ?? null, inf: typeof window.__snInfBridge, ixBridge: typeof window.__snIxBridge,
          kbAttr: document.documentElement.hasAttribute('data-milo-kb-off'), kbDark: getComputedStyle(document.documentElement).colorScheme,
          overlays: document.querySelectorAll('#sn-timecard-overlay').length, sameOverlay: Boolean(o && o.__marker === 'm1'),
          draft: f ? (f.contentDocument?.getElementById('draft')?.value ?? null) : null, modified: f ? (f.contentWindow?.g_form?.modified ?? null) : null,
          setting: window.__snMiloMainSettings?.get('timecard')?.enabled ?? null}; })()`);
      await waitFor(async () => { const s = await snap(pages.prod); return s.tcButtons === 1 && s.infButtons === 1 && s.tkBridgeActive === true && s; }, {what: 'prod page: timecard button, informatica button, alert bridge'});
      await waitFor(async () => (await snap(pages.test)).tcButtons === 1, {what: 'test page: timecard button'});
      await waitFor(async () => (await snap(pages.kb)).kbDark === 'dark', {what: 'kb page dark'});
      const before = {};
      for (const [k, s] of Object.entries(pages)) before[k] = await snap(s);
      assert.equal(before.test.inf, 'undefined', 'test host: no informatica bridge');
      assert.equal(before.test.tkBridge, 'undefined', 'test host: no alert bridge');

      // timecard overlay with a dirty draft on production, a clean overlay on the test host
      for (const k of ['prod', 'test']) await evaluate(pages[k], `document.getElementById('sn-timecard-add').click(), true`);
      for (const k of ['prod', 'test']) await waitFor(async () => { const s = await snap(pages[k]); return s.overlays === 1 && s.draft !== null && s; }, {what: `${k}: overlay form`});
      for (const k of ['prod', 'test']) await evaluate(pages[k], `document.getElementById('sn-timecard-overlay').__marker = 'm1', true`);
      await evaluate(pages.prod, `(() => { const i = document.getElementById('sn-timecard-overlay').shadowRoot.querySelector('iframe').contentDocument.getElementById('draft'); i.value = 'draft-12345'; i.dispatchEvent(new Event('input', {bubbles: true})); return true; })()`);
      assert.equal((await snap(pages.prod)).modified, true);
      const preUpdate = {prod: await snap(pages.prod), test: await snap(pages.test), kb: await snap(pages.kb)};
      const preNonGets = browser.intercepted.filter(r => r.method !== 'GET').length;

      // ---- refusal paths of the REAL script: no --yes ⇒ nothing happens; unreachable/missing endpoint ----
      const noYes = await runApplyUpdate(['--cdp', endpoint], {});
      assert.equal(noYes.code, 2, noYes.stderr);
      assert.match(noYes.stdout, new RegExp(String(browser.version.Browser).split('/')[0]));
      assert.match(noYes.stderr, /without --yes/);
      assert.equal((await snap(pages.prod)).timeOrigin, preUpdate.prod.timeOrigin);
      assert.equal(await evaluate(sw, 'snMilo.status().then(s => s.ready)'), true, 'same worker still alive: nothing was reloaded');

      const infStatus = () => evaluate(sw, `(async () => { const [tab] = await chrome.tabs.query({url:${JSON.stringify(P + CASE_PATH)}}); const [r] = await chrome.scripting.executeScript({target:{tabId:tab.id},world:'ISOLATED',func:() => ({status:globalThis.__snInfController?.lastRun?.status ?? null, locked:Boolean(globalThis.__snInfMaintenance?.owner)})}); return r.result; })()`);
      const startReadOnlyRun = async () => {
        await evaluate(pages.prod, `document.getElementById('sn-inf-button').click(), true`);
        await waitFor(async () => (await infStatus()).status === 'running', {what:'real isolated Informatica workflow awaiting fixture read'});
        assert.equal(await evaluate(pages.prod, `typeof window.__snInfController`), 'undefined', 'MAIN cannot see actual controller');
      };
      const finishReadOnlyRun = async () => {
        await waitFor(() => evaluate(pages.prod, `typeof window.__releaseRead === 'function'`), {what:'pending fixture read'});
        await evaluate(pages.prod, `window.__releaseRead(), true`);
        await waitFor(async () => (await infStatus()).status === 'failed', {what:'read-only fixture failure finishes naturally'});
      };
      await startReadOnlyRun();
      const refused = await runApplyUpdate(['--yes'], {SN_MILO_CDP: endpoint});
      assert.equal(refused.code, 1, refused.stdout + refused.stderr);
      assert.match(refused.stderr, /informatica-in-progress/);
      assert.equal((await infStatus()).status, 'running', 'pre-load refusal did not invalidate old controller or cancel workflow');
      await finishReadOnlyRun();

      // ---- the real update, twice (idempotent) ----
      const runs = [];
      for (let i = 0; i < 2; i++) {
        const r = await runApplyUpdate(['--yes'], {SN_MILO_CDP: endpoint});
        assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
        assert.match(r.stdout, new RegExp(`browser at ${endpoint.replace(/\./g, '\\.')}: `));
        const loaded = JSON.parse(r.stdout.split('\n').find(l => l.startsWith('{"loaded"')));
        assert.equal(loaded.loaded.id, id);
        assert.equal(loaded.loaded.version, generated.version);
        const summary = JSON.parse(r.stdout.slice(r.stdout.indexOf('{\n')));
        assert.equal(summary.navigations, 0);
        assert.equal(summary.submissionsAttempted, 0);
        runs.push(summary.reinjected);
        sw = await workerSession();
        await waitFor(async () => (await evaluate(sw, 'snMilo.status()'))?.ready, {what: `worker ready after update ${i + 1}`});
        await recordNotifications(sw); // no new rows exist during install recovery
      }
      for (const reinjected of runs) {
        assert.equal(reinjected.failed, 0, JSON.stringify(reinjected));
        const stepsByUrl = new Map(reinjected.tabs.map(t => [t.tabId, t]));
        assert.equal(reinjected.tabs.length, 4, 'prod case, test case, kb, pre-install kb');
        assert.equal(reinjected.tabs.filter(t => t.skipped === 'informatica-in-progress').length, 0, 'idle workflows allow update');
        const byRole = reinjected.tabs.filter(t => !t.skipped).reduce((m, t) => { (m[t.role] ||= []).push(t.steps); return m; }, {});
        assert.deepEqual(byRole.test, [['settings-controller', 'main-settings', 'timecard-overlay']], 'test host: shared + timecard overlay only');
        const prodSteps = byRole.production.map(s => s.join(','));
        assert.ok(prodSteps.includes('settings-controller,main-settings,informatica-bridge,informatica-button,critical-alert-bridge,critical-alert-poller,interaction-alert-bridge,interaction-alert-poller,timecard-overlay'), prodSteps.join(' | '));
        assert.ok(prodSteps.some(s => s.includes('kb-dark-toggle') && !s.includes('informatica')) || prodSteps.some(s => s.includes('kb-dark-toggle')), 'kb toggle on /kb');
        assert.equal(stepsByUrl.size, 4);
        for (const t of reinjected.tabs) assert.ok(!t.steps.includes('timecard-native'));
      }

      // ---- assertions on the live pages ----
      const after = {prod: await snap(pages.prod), test: await snap(pages.test), kb: await snap(pages.kb)};
      for (const k of Object.keys(after)) {
        assert.equal(after[k].timeOrigin, preUpdate[k].timeOrigin, `${k}: no navigation/reload`);
        assert.equal(after[k].href, preUpdate[k].href);
      }
      // dirty overlay preserved (same node, typed draft, never asked/discarded), exactly one launch button
      assert.deepEqual([after.prod.overlays, after.prod.sameOverlay, after.prod.draft, after.prod.modified, after.prod.confirms], [1, true, 'draft-12345', true, 0]);
      assert.deepEqual([after.test.overlays, after.test.sameOverlay], [1, true]);
      // the launch buttons: one each (the UI is re-evaluated from effective state)
      for (const k of ['prod', 'test']) await waitFor(async () => (await snap(pages[k])).tcButtons === 1 && (await snap(pages[k])).setting === true, {what: `${k}: timecard button after update`});
      // Informatica: exactly one button, bridge armed; KB toggle: enabled ⇒ attribute absent + dark CSS
      await waitFor(async () => { const s = await snap(pages.prod); return s.infButtons === 1 && s.tkBridgeActive === true; }, {what: 'informatica button + bridge after update'});
      await sleep(3500);
      assert.equal((await snap(pages.prod)).infButtons, 1, 'informatica: exactly one button');
      assert.deepEqual([after.kb.kbAttr, after.kb.kbDark], [false, 'dark']);
      // test host: nothing but shared + timecard
      assert.deepEqual([after.test.inf, after.test.tkBridge, after.test.ixBridge, after.test.infButtons, after.test.kbAttr], ['undefined', 'undefined', 'undefined', 0, false]);

      // alerts recovered with exactly one poller: one forced poll ⇒ one GET per table, one notification per new row
      const store = keys => evaluate(sw, `chrome.storage.local.get(${JSON.stringify(keys)})`);
      const created = async () => ((await store('diagnosticLogsV1')).diagnosticLogsV1 || []).filter(e => e.event === 'notification-created').map(e => e.sysId);
      assert.equal(await evaluate(sw, `(() => { const n = chrome.notifications; if (n.create.__miloRecorder) return true;
        globalThis.__notif = {created: []}; const create = async id => { __notif.created.push(id); return id; }; create.__miloRecorder = true; n.create = create; n.clear = async () => true; return true; })()`), true, 'recorder (no real notification)');
      const probe = () => evaluate(sw, `(async () => { const tabs = await chrome.tabs.query({url: ${JSON.stringify(`${P}/*`)}}); const out = [];
        for (const t of tabs) { const [r] = await chrome.scripting.executeScript({target: {tabId: t.id}, world: 'ISOLATED', func: () => ({live: Boolean(globalThis.__snTkController && globalThis.__snTkController.retired === false), poll: typeof window.snTkPollNow, milo: Boolean(globalThis.__snMiloController)})}); out.push(r.result); }
        return out; })()`);
      const live = await waitFor(async () => { const p = await probe(); return p.filter(x => x.live).length === 3 && p; }, {what: 'install/watchdog recovery settled on production tabs'});
      assert.deepEqual(live.map(x => x.milo), [true, true, true]);
      // Isolate developer reinjection from install/watchdog recovery: after all initial
      // recovery settled, stop every current poller and clear alarms. No reload follows.
      await evaluate(sw, `(async () => {
        await chrome.alarms.clearAll();
        const tabs = await chrome.tabs.query({url: ${JSON.stringify(`${P}/*`)}});
        for (const t of tabs) await chrome.scripting.executeScript({target: {tabId: t.id}, world: 'ISOLATED', func: () => globalThis.__snTkController?.stop('test')});
        return true;
      })()`);
      assert.equal((await probe()).filter(x => x.live).length, 0, 'no poller can satisfy recovery assertion vacuously');
      await startReadOnlyRun();
      const ownPass = await evaluate(sw, 'snMilo.reinjectOpenTabs()', 30000);
      assert.equal(ownPass.failed, 0, JSON.stringify(ownPass));
      assert.equal(ownPass.tabs.filter(t => t.skipped === 'informatica-in-progress').length, 1);
      assert.equal((await probe()).filter(x => x.live).length, 2, 'developer pass alone recovers non-skipped tabs');
      assert.equal((await infStatus()).status, 'running', 'actual in-flight workflow untouched');
      await finishReadOnlyRun();
      assert.equal((await evaluate(sw, 'snMilo.reinjectOpenTabs()', 30000)).failed, 0);
      assert.equal((await probe()).filter(x => x.live).length, 3, 'explicit later pass recovers completed tab');
      server.rows.push(row('1'));
      const gets = server.gets;
      const pollOnce = () => evaluate(sw, `(async () => { await chrome.storage.local.set({'crit.lastPollAt': 0});
        const tabs = await chrome.tabs.query({url: ${JSON.stringify(`${P}${CASE_PATH}`)}}); let n = 0;
        for (const t of tabs) { const [r] = await chrome.scripting.executeScript({target: {tabId: t.id}, world: 'ISOLATED', func: () => { if (typeof window.snTkPollNow === 'function') { window.snTkPollNow(); return true; } return false; }}); if (r.result) n++; }
        return n; })()`, 30000);
      assert.equal(await pollOnce(), 1);
      await waitFor(async () => (await created()).includes(hex('1')), {timeoutMs: 30000, what: 'new row notified once after update'});
      await sleep(2500);
      assert.equal((await created()).filter(s => s === hex('1')).length, 1, 'exactly one notification for the new row');
      assert.equal(server.gets - gets, ROW_TABLES.length, 'one poller ⇒ one GET per table for one forced poll');

      // KB follows the preference after reinjection: disable ⇒ attribute set (live), enable ⇒ removed
      const clickOption = async (f, want) => {
        await waitFor(() => evaluate(opt2, `(() => { const b = document.querySelector('input[data-feature="${f}"]'); return b && !b.disabled && b.checked !== ${want}; })()`), {what: `${f} checkbox ready`});
        await evaluate(opt2, `document.querySelector('input[data-feature="${f}"]').click(), true`);
      };
      const {targetId: optTarget2} = await browser.call('Target.createTarget', {url: `chrome-extension://${id}/options.html`});
      const opt2 = await sessionFor(t => t.targetId === optTarget2);
      await waitFor(() => evaluate(opt2, `document.readyState === 'complete' && Number(document.documentElement.dataset.rendered || 0) >= 1`), {what: 'options (new worker) rendered'});
      await clickOption('kb-dark', false);
      await waitFor(async () => (await snap(pages.kb)).kbAttr === true, {what: 'kb attribute set after disable'});
      await clickOption('kb-dark', true);
      await waitFor(async () => (await snap(pages.kb)).kbAttr === false, {what: 'kb attribute removed after enable'});
      // a disabled-KB update must not darken the page: disable, update, attribute stays set
      await clickOption('kb-dark', false);
      await waitFor(async () => (await snap(pages.kb)).kbAttr === true, {what: 'kb off again'});
      assert.notEqual((await snap(oldKb)).kbDark, 'dark', 'pre-install document follows disable after takeover');
      const r3 = await runApplyUpdate(['--yes'], {SN_MILO_CDP: endpoint});
      assert.equal(r3.code, 0, `${r3.stdout}\n${r3.stderr}`);
      await waitFor(async () => (await snap(pages.kb)).kbAttr === true && (await snap(pages.kb)).kbDark !== 'dark', {what: 'kb stays off after update with the feature disabled'});
      assert.equal((await snap(pages.kb)).timeOrigin, preUpdate.kb.timeOrigin);
      sw = await workerSession();
      await recordNotifications(sw);
      await waitFor(async () => (await snap(oldKb)).kbAttr === true, {what: 'pre-install KB gated off'});
      const {targetId: optTarget3} = await browser.call('Target.createTarget', {url: `chrome-extension://${id}/options.html`});
      const opt3 = await sessionFor(t => t.targetId === optTarget3);
      await waitFor(() => evaluate(opt3, `Boolean(document.querySelector('input[data-feature="kb-dark"]:not(:disabled)'))`), {what: 'post-disabled-update options'});
      await evaluate(opt3, `document.querySelector('input[data-feature="kb-dark"]').click(), true`);
      await waitFor(async () => (await snap(oldKb)).kbAttr === false && (await snap(oldKb)).kbDark === 'dark', {what: 'disabled-update KB enables without reload or prior declarative CSS'});

      // ---- no write ever left a page; nothing but fixtures/API GETs ----
      assert.deepEqual(browser.interceptionErrors, []);
      assert.equal(preNonGets, 0);
      for (const r of browser.intercepted) assert.equal(r.method, 'GET', `no write request: ${r.method} ${r.url}`);
      console.log(`# apply-update verified in disposable pid ${browser.pid} port ${browser.port}; ${browser.intercepted.length} intercepted service-now requests, all GET`);
    } finally {
      const closed = await browser.close();
      console.log(`# closed disposable browser pid ${closed.pid} (stragglers killed: ${closed.stragglersKilled})`);
    }
  });
});
