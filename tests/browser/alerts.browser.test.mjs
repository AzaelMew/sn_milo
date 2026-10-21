// Real-browser check for the alert features (disposable Vivaldi, fixtures only; run via `npm run test:browser`).
// A fixture production document (with a fake g_ck) is served for the configured PRODUCTION origin through CDP Fetch,
// and the alert bridges' Table API GETs are answered with mocked JSON from in-test fixture state. Every other
// *.service-now.com request (any resource type) is failed; any non-GET request is failed and makes the test fail.
// Notifications/health transitions are synthetic (fixture rows, fixture HTTP 500) in this throwaway profile only.
// Verifies per alert feature: migration completed through the options page (snapshot import), one notification per
// new row (imported rows stay silent), no duplicate across two tabs, health outage → one sticky notification →
// recovery, disable stops polling / clears the health alarm + notification, re-enable does not re-alert, and the
// test host never receives alert scripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {withGeneratedArtifacts} from '../../scripts/generate-config.mjs';
import {launchDisposableBrowser, resolvePort} from './lib/disposable-browser.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, {timeoutMs = 20000, intervalMs = 200, what = 'condition'} = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error; }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}
const hex = (c, n = 32) => String(c).repeat(n).slice(0, n);
const FIXTURE_PATH = '/milo-alert-fixture';
const FIXTURE = title => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><script>window.g_ck = 'fixture-token';</script></head><body><p>${title}</p></body></html>`;

// Per-feature fixture spec. `tables` = Table API tables the bridge queries; rows are mutable test state.
export const ALERTS = {
  'critical-alert': {
    logKey: 'diagnosticLogsV1', dedupeKey: 'seenMatchesV4', alarm: 'snTkHealthCheck', health: 'snCritHealth', rowPrefix: 'snTk-',
    pollNow: 'snTkPollNow', controller: '__snTkController', bridge: '__snTkBridge', heartbeat: 'crit.lastPollAt',
    lastSuccess: 'crit.lastSuccessfulPollAt', healthKey: 'crit.healthStateV1', staleMs: 360000,
    tables: ['sn_customerservice_case', 'sn_customerservice_task'],
    row: (c, table = 'sn_customerservice_case') => ({sys_id: hex(c), number: `CS${c}`, priority: '1 - Critical', state: 'New', short_description: `fixture ${c}`,
      account: {display_value: 'Acme Oy', link: 'https://invalid.invalid/x'}, __table: table}),
    entry: c => `${hex(c)}|1 - Critical|New|Acme Oy`
  },
  'interaction-alert': {
    logKey: 'diagnosticLogsIxV1', dedupeKey: 'seenInteractionsV1', alarm: 'snIxHealthCheck', health: 'snIxHealth', rowPrefix: 'snIx-',
    pollNow: 'snIxPollNow', controller: '__snIxController', bridge: '__snIxBridge', heartbeat: 'ix.lastPollAt',
    lastSuccess: 'ix.lastSuccessfulPollAt', healthKey: 'ix.healthStateV1', staleMs: 240000,
    tables: ['interaction'],
    row: c => ({sys_id: hex(c), number: `IMS${c}`, state: 'New', type: 'Chat',
      short_description: `fixture ${c}`, account: {display_value: 'Acme Oy', link: 'https://invalid.invalid/x'}, opened_for: 'Fixture User', __table: 'interaction'}),
    entry: c => hex(c)
  }
};

export async function runAlertsBrowserTest({features = Object.keys(ALERTS), port}) {
  await withGeneratedArtifacts({root: repo}, async generated => {
    const P = generated.origins.production;
    const T = generated.origins.test;
    const server = Object.fromEntries(features.map(f => [f, {rows: [], fail: 0, gets: 0}]));
    const nonGet = [];
    const fixtures = ({url, method, resourceType}) => {
      const u = new URL(url);
      if (method !== 'GET') { nonGet.push({url, method}); return null; } // fail anything that is not a GET
      if (resourceType === 'Document' && (u.origin === P || u.origin === T) && u.pathname.startsWith(FIXTURE_PATH)) {
        return {body: FIXTURE(`${u.origin === P ? 'production' : 'test'} alert fixture`)};
      }
      const m = /^\/api\/now\/table\/([a-z_]+)$/.exec(u.pathname);
      if (m && u.origin === P) {
        for (const f of features) {
          if (!ALERTS[f].tables.includes(m[1])) continue;
          const s = server[f];
          s.gets++;
          if (s.fail) return {status: s.fail, headers: {'Content-Type': 'application/json'}, body: JSON.stringify({error: {message: 'fixture failure'}})};
          const result = s.rows.filter(r => (r.__table || ALERTS[f].tables[0]) === m[1]).map(({__table, ...r}) => r);
          return {headers: {'Content-Type': 'application/json'}, body: JSON.stringify({result})};
        }
      }
      return null;
    };
    const browser = await launchDisposableBrowser({port, fixtures});
    const problems = [];
    const stopEvents = browser.onEvent(msg => {
      if (msg.method === 'Runtime.exceptionThrown') problems.push({sessionId: msg.sessionId, text: msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text});
    });
    const sessionFor = pred => waitFor(() => [...browser.sessions.entries()].find(([, t]) => pred(t))?.[0], {what: 'target session'});
    // explicit per-call timeout (default 8 s, polls inside waitFor get retried); multi-tab executeScript gets more
    const evaluate = async (sessionId, expression, timeoutMs = 8000) => {
      const r = await browser.call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, sessionId, timeoutMs);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    try {
      const {id} = await browser.call('Extensions.loadUnpacked', {path: repo});
      const sw = await sessionFor(t => t.type === 'service_worker' && t.url === `chrome-extension://${id}/background.js`);
      await waitFor(async () => (await evaluate(sw, 'snMilo.status()'))?.ready, {what: 'worker ready'});
      await evaluate(sw, `chrome.storage.local.set({'ix.accountsV1': {schema: 1, accounts: ['Acme Oy']}}).then(() => true)`); // the interaction alert polls only configured accounts
      // Record notifications in the worker instead of creating real ones: no create/clear call reaches the OS (the
      // launcher also disables native notifications). Re-asserted before every phase (a restarted worker would lose it).
      const RECORDER = `(() => { const n = chrome.notifications; if (n.create.__miloRecorder) return true;
        globalThis.__notif = globalThis.__notif || {created: [], cleared: []};
        const create = async (id, options) => { __notif.created.push({id, title: options?.title, at: Date.now()}); return id; };
        const clear = async id => { __notif.cleared.push({id, at: Date.now()}); return true; };
        create.__miloRecorder = true;
        n.create = create; n.clear = clear;
        return n.create.__miloRecorder === true; })()`;
      assert.equal(await evaluate(sw, RECORDER), true, 'notification recorder installed in the worker');
      const recorder = async () => { assert.equal(await evaluate(sw, 'chrome.notifications.create.__miloRecorder === true'), true, 'recorder still in place (worker not restarted)'); return evaluate(sw, '__notif'); };
      const shown = async () => { const r = await recorder(); const open = new Map(); for (const e of [...r.created.map(x => ['c', x]), ...r.cleared.map(x => ['x', x])].sort((a, b) => a[1].at - b[1].at)) { if (e[0] === 'c') open.set(e[1].id, e[1]); else open.delete(e[1].id); } return open; };
      const status = () => evaluate(sw, 'snMilo.status()');
      for (const f of features) assert.equal((await status()).features[f].migration.state, 'pending-migration');
      const store = keys => evaluate(sw, `chrome.storage.local.get(${JSON.stringify(keys)})`);
      const created = async f => ((await store(ALERTS[f].logKey))[ALERTS[f].logKey] || []).filter(e => e.event === 'notification-created').map(e => e.sysId);
      const pollAll = (f, {resetHeartbeat = true} = {}) => evaluate(sw, `(async () => {
        ${resetHeartbeat ? `await chrome.storage.local.set({${JSON.stringify(ALERTS[f].heartbeat)}: 0});` : ''}
        const tabs = await chrome.tabs.query({url: ${JSON.stringify(`${P}/*`)}});
        let n = 0;
        const errors = [];
        for (const t of tabs) {
          try { const [r] = await chrome.scripting.executeScript({target: {tabId: t.id}, world: 'ISOLATED', func: k => { const fn = window[k]; if (typeof fn === 'function') { fn(); return true; } return false; }, args: [${JSON.stringify(ALERTS[f].pollNow)}]}); if (r?.result) n++; }
          catch (e) { errors.push({url: t.url, status: t.status, error: String(e?.message || e)}); }
        }
        if (errors.length) throw new Error('pollNow failed in ' + JSON.stringify(errors) + ' of ' + JSON.stringify(tabs.map(t => [t.url, t.status])));
        return n; })()`, 30000);

      // ---- migration via the options page: paste a snapshot (one already-notified row per feature) ----
      const {targetId: optTarget} = await browser.call('Target.createTarget', {url: `chrome-extension://${id}/options.html`});
      const opt = await sessionFor(t => t.targetId === optTarget);
      await waitFor(() => evaluate(opt, `document.readyState === 'complete' && Number(document.documentElement.dataset.rendered || 0) >= 1`), {what: 'options rendered'});
      for (const f of features) {
        const snapshot = {schema: 1, feature: f, key: ALERTS[f].dedupeKey, entries: [ALERTS[f].entry('0')]};
        await waitFor(() => evaluate(opt, `Boolean(document.querySelector('#features li[data-feature="${f}"] .migration textarea'))`), {what: `${f} migration section`});
        await evaluate(opt, `(() => { const m = document.querySelector('#features li[data-feature="${f}"] .migration'); m.querySelector('textarea').value = ${JSON.stringify(JSON.stringify(snapshot))}; m.querySelector('button[data-action=import]').click(); return true; })()`);
        await waitFor(async () => (await status()).features[f].enabled === true, {what: `${f} enabled after import`});
        assert.deepEqual((await store(ALERTS[f].dedupeKey))[ALERTS[f].dedupeKey], [ALERTS[f].entry('0')]);
      }

      // ---- one notification per new row; imported row stays silent ----
      for (const f of features) server[f].rows.push(ALERTS[f].row('0'), ALERTS[f].row('1'), ALERTS[f].row('2', ALERTS[f].tables.at(-1)));
      // interception armed before navigating (a navigation that starts before Fetch.enable bypasses the fixtures and
      // lands on a NOTFOUND error page); fails fast on an error page (see lib openPage)
      const open = url => browser.openPage(url);
      const tabA = await open(`${P}${FIXTURE_PATH}?tab=a`);
      for (const f of features) {
        await waitFor(async () => (await created(f)).length === 2, {timeoutMs: 30000, what: `${f}: first poll notifications`});
        assert.deepEqual((await created(f)).sort(), [hex('1'), hex('2')], `${f}: one per new row, imported row silent`);
      }
      const active = await shown();
      for (const f of features) for (const c of ['1', '2']) assert.ok(active.has(`${ALERTS[f].rowPrefix}${hex(c)}`), `${f} row ${c} notification recorded`);
      for (const f of features) assert.equal((await recorder()).created.filter(x => x.id.startsWith(ALERTS[f].rowPrefix)).length, 2, `${f}: exactly two create calls`);

      // ---- second tab: forced polls in both tabs (heartbeat released) → still one notification per row ----
      const tabB = await open(`${P}${FIXTURE_PATH}?tab=b`);
      for (const f of features) {
        await waitFor(() => evaluate(tabB, `Boolean(window.${ALERTS[f].bridge}?.active)`), {what: `${f} bridge armed in tab B`});
        const gets = server[f].gets;
        for (let i = 0; i < 2; i++) { assert.equal(await pollAll(f), 2, 'both tabs have a live poller'); await sleep(1500); }
        assert.ok(server[f].gets > gets, `${f}: forced polls reached the fixture API`);
        assert.deepEqual((await created(f)).sort(), [hex('1'), hex('2')], `${f}: no duplicate across two tabs`);
        server[f].rows.push(ALERTS[f].row('3'));
        await pollAll(f);
        await waitFor(async () => (await created(f)).length === 3, {what: `${f}: new row notified`});
        await pollAll(f); await sleep(1500);
        assert.equal((await created(f)).filter(s => s === hex('3')).length, 1, `${f}: exactly once`);
      }

      // ---- health: synthetic outage (fixture HTTP 500 + stale timestamps) → one sticky alert → recovery ----
      for (const f of features) {
        const a = ALERTS[f];
        server[f].fail = 500;
        await pollAll(f);
        await waitFor(async () => ((await store(a.logKey))[a.logKey] || []).some(e => e.event === 'content-poll-failed'), {what: `${f}: poll failure logged`});
        const old = Date.now() - a.staleMs - 120000;
        await evaluate(sw, `chrome.storage.local.set(${JSON.stringify({[a.lastSuccess]: old, [a.healthKey]: {startedAt: old, failure: {at: Date.now(), event: 'poll-failed', detail: 'HTTP 500'}}})}).then(() => true)`);
        await evaluate(sw, `snMilo.runAlarm(${JSON.stringify(a.alarm)}).then(() => true)`);
        await evaluate(sw, `snMilo.runAlarm(${JSON.stringify(a.alarm)}).then(() => true)`);
        const logs = (await store(a.logKey))[a.logKey];
        assert.equal(logs.filter(e => e.event === 'health-alert').length, 1, `${f}: one alert per outage`);
        assert.ok((await shown()).has(a.health), `${f}: sticky health notification recorded`);
        assert.equal((await recorder()).created.filter(x => x.id === a.health).length, 1, `${f}: one health create per outage`);
        server[f].fail = 0;
        await pollAll(f);
        await waitFor(async () => ((await store(a.lastSuccess))[a.lastSuccess] || 0) > Date.now() - 30000, {what: `${f}: successful poll`});
        await evaluate(sw, `snMilo.runAlarm(${JSON.stringify(a.alarm)}).then(() => true)`);
        assert.equal(((await store(a.logKey))[a.logKey]).filter(e => e.event === 'health-recovered').length, 1, `${f}: recovery announced`);
      }

      // ---- disable via options: polling stops, health alarm + owned health notification cleared ----
      const clickOption = async (f, want) => {
        await waitFor(() => evaluate(opt, `(() => { const b = document.querySelector('input[data-feature="${f}"]'); return b && !b.disabled && b.checked !== ${want}; })()`), {what: `${f} checkbox ready`});
        await evaluate(opt, `document.querySelector('input[data-feature="${f}"]').click(), true`);
        await waitFor(async () => (await status()).features[f].enabled === want, {what: `${f} enabled=${want}`});
      };
      for (const f of features) {
        const a = ALERTS[f];
        assert.ok((await shown()).has(a.health), `${f}: recovery notice still listed under the owned id`);
        await clickOption(f, false);
        await waitFor(async () => !(await evaluate(sw, `chrome.alarms.get(${JSON.stringify(a.alarm)})`)), {what: `${f} alarm cleared`});
        await waitFor(async () => !(await shown()).has(a.health), {what: `${f} health notification cleared`});
        await waitFor(() => evaluate(tabA, `window.${a.bridge}?.active === false`), {what: `${f} bridge disarmed`});
        const gets = server[f].gets;
        server[f].rows.push(ALERTS[f].row('4'));
        await pollAll(f); await sleep(2000);
        assert.equal(server[f].gets, gets, `${f}: no API request while disabled`);
        assert.equal((await created(f)).length, 3, `${f}: nothing notified while disabled`);
      }
      // ---- re-enable: no re-alert of seen rows; the row added while off is new ⇒ exactly one notification ----
      for (const f of features) {
        await clickOption(f, true);
        assert.ok(await evaluate(sw, `chrome.alarms.get(${JSON.stringify(ALERTS[f].alarm)}).then(a => Boolean(a))`), `${f}: alarm back`);
        await waitFor(() => evaluate(tabA, `window.${ALERTS[f].bridge}?.active === true`), {what: `${f} bridge re-armed`});
        await pollAll(f);
        await waitFor(async () => (await created(f)).length === 4, {what: `${f}: row added while disabled notified once`});
        await pollAll(f); await sleep(1500);
        const c = await created(f);
        assert.deepEqual([...new Set(c)].length, c.length, `${f}: no re-alert after re-enable`);
        assert.equal(c.length, 4);
      }

      // ---- test host: no alert scripts at all (manifest production-only; worker never injects there) ----
      const tst = await open(`${T}${FIXTURE_PATH}`);
      await waitFor(() => evaluate(tst, `window.__snMiloMainSettings?.get('timecard')?.enabled === true`), {what: 'test-host settings handshake'});
      for (const f of features) {
        assert.equal(await evaluate(tst, `typeof window.${ALERTS[f].bridge}`), 'undefined', `${f}: no MAIN bridge on the test host`);
        const iso = await evaluate(sw, `(async () => { const [t] = await chrome.tabs.query({url: ${JSON.stringify(`${T}/*`)}}); const [r] = await chrome.scripting.executeScript({target: {tabId: t.id}, world: 'ISOLATED', func: k => typeof globalThis[k], args: [${JSON.stringify(ALERTS[f].controller)}]}); return r.result; })()`);
        assert.equal(iso, 'undefined', `${f}: no poller on the test host`);
      }

      // every row notification ever created (recorded): exactly once per row id, per feature
      const rec = await recorder();
      for (const f of features) {
        const rows = rec.created.filter(x => x.id.startsWith(ALERTS[f].rowPrefix)).map(x => x.id);
        assert.equal(new Set(rows).size, rows.length, `${f}: no duplicate notification`);
        assert.equal(rows.length, 4, `${f}: rows 1, 2, 3 and the one added while disabled`);
      }
      assert.deepEqual(nonGet, [], 'no non-GET request was attempted');
      assert.deepEqual(browser.interceptionErrors, []);
      for (const r of browser.intercepted) {
        assert.equal(r.method, 'GET', `${r.method} ${r.url}`);
        const u = new URL(r.url);
        if (r.action === 'fulfilled-fixture') assert.ok(u.pathname.startsWith(FIXTURE_PATH) || u.pathname.startsWith('/api/now/table/'), r.url);
        if (u.pathname.startsWith('/api/')) assert.equal(u.origin, P, 'API only on the production fixture origin');
      }
      assert.deepEqual(problems.filter(p => [tabA, tabB, tst, opt].includes(p.sessionId)), [], 'no page/options exceptions');
      const info = await (async () => {
        const {targetId} = await browser.call('Target.createTarget', {url: 'chrome://extensions'});
        const ext = await sessionFor(t => t.targetId === targetId);
        return waitFor(async () => { const v = await evaluate(ext, `typeof chrome?.developerPrivate?.getExtensionInfo !== 'function' ? null : new Promise(r => chrome.developerPrivate.getExtensionInfo(${JSON.stringify(id)}, i => r(JSON.stringify(i))))`); return v ? JSON.parse(v) : null; }, {what: 'developerPrivate info'});
      })();
      assert.deepEqual(info.manifestErrors, []);
      assert.deepEqual(info.runtimeErrors, [], 'no worker runtime errors');
      console.log(`# alerts (${features.join(', ')}) verified in disposable pid ${browser.pid} port ${browser.port}; intercepted ${browser.intercepted.length} service-now requests (${browser.intercepted.filter(r => r.action === 'fulfilled-fixture').length} fixtures, rest failed); API GETs ${features.map(f => `${f}=${server[f].gets}`).join(' ')}`);
    } finally {
      stopEvents();
      const closed = await browser.close();
      console.log(`# closed disposable browser pid ${closed.pid} (stragglers killed: ${closed.stragglersKilled})`);
    }
  });
}

test('alerts: options import → one notification per new row, no duplicate across tabs, health outage/recovery, disable/re-enable, test host clean', {timeout: 300000}, async () => {
  await runAlertsBrowserTest({port: resolvePort(process.env.SN_MILO_ALERTS_PORT, 9475)});
});
