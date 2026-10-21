// Real-browser smoke test for the generated skeleton. Run via `npm run test:browser` only.
// Uses a disposable muted Vivaldi (fresh $TMPDIR profile, own port, never 9333/9222), intercepts every
// *.service-now.com request, and loads the repo only after generate + generate:check succeeded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {withGeneratedArtifacts} from '../../scripts/generate-config.mjs';
import {launchDisposableBrowser, resolvePort} from './lib/disposable-browser.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const template = JSON.parse(fs.readFileSync(path.join(repo, 'manifest.template.json'), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('port guard refuses the user browser ports', () => {
  assert.throws(() => resolvePort(9333), /refusing/);
  assert.throws(() => resolvePort(9222), /refusing/);
  assert.equal(resolvePort(undefined, 9461), 9461);
});

test('launcher refuses extraArgs that could override the notification-disable flag (no browser started)', async () => {
  for (const flag of ['--disable-features=Foo', '--enable-features=NativeNotifications', '--ENABLE-FEATURES=SystemNotifications']) {
    await assert.rejects(launchDisposableBrowser({port: 9479, extraArgs: [flag]}), /features/, flag);
  }
});

test('skeleton loads unpacked with the template version, no manifest errors, worker running', async () => {
  await withGeneratedArtifacts({root: repo}, async generated => {
    const browser = await launchDisposableBrowser({port: resolvePort(process.env.SN_MILO_BROWSER_PORT, 9461)});
    try {
      const {id} = await browser.call('Extensions.loadUnpacked', {path: repo});
      assert.match(id, /^[a-p]{32}$/);
      const {extensions} = await browser.call('Extensions.getExtensions', {});
      const ours = extensions.filter(e => e.path === repo);
      assert.equal(ours.length, 1);
      assert.equal(ours[0].id, id);
      assert.equal(ours[0].version, template.version);
      assert.equal(ours[0].version, generated.version);
      assert.equal(ours[0].enabled, true);

      let worker;
      for (let i = 0; i < 50 && !worker; i++) {
        worker = [...browser.sessions.entries()].find(([, t]) => t.type === 'service_worker' && t.url === `chrome-extension://${id}/background.js`);
        if (!worker) await sleep(100);
      }
      assert.ok(worker, 'extension service worker target is running');
      const {result} = await browser.call('Runtime.evaluate', {returnByValue: true,
        expression: 'JSON.stringify({id: chrome.runtime.id, manifest: chrome.runtime.getManifest()})'}, worker[0]);
      const sw = JSON.parse(result.value);
      assert.equal(sw.id, id);
      assert.equal(sw.manifest.version, template.version);
      assert.deepEqual(sw.manifest.permissions, ['alarms', 'notifications', 'scripting', 'storage', 'tabs']);
      assert.deepEqual(sw.manifest.background, {service_worker: 'background.js', type: 'module'});
      assert.deepEqual([...sw.manifest.host_permissions].sort(),
        [generated.origins.production, generated.origins.test].map(o => `${o}/*`).sort());

      const {targetId} = await browser.call('Target.createTarget', {url: 'chrome://extensions'});
      let page;
      for (let i = 0; i < 50 && !page; i++) {
        page = [...browser.sessions.entries()].find(([, t]) => t.targetId === targetId);
        if (!page) await sleep(100);
      }
      assert.ok(page, 'attached to chrome://extensions');
      let info;
      for (let i = 0; i < 30 && !info; i++) {
        const r = await browser.call('Runtime.evaluate', {awaitPromise: true, returnByValue: true, expression:
          `typeof chrome?.developerPrivate?.getExtensionInfo !== 'function' ? null : new Promise(r => chrome.developerPrivate.getExtensionInfo(${JSON.stringify(id)}, i => r(JSON.stringify(i))))`}, page[0]);
        info = r.result.value ? JSON.parse(r.result.value) : null;
        if (!info) await sleep(200);
      }
      assert.ok(info, 'developerPrivate extension info available');
      assert.equal(info.version, template.version);
      assert.equal(info.state, 'ENABLED');
      assert.deepEqual(info.manifestErrors, []);
      assert.deepEqual(info.runtimeErrors, []);
      assert.deepEqual(info.installWarnings, []);
      assert.ok(info.views.some(v => v.type === 'EXTENSION_SERVICE_WORKER_BACKGROUND'), 'service worker view registered');
      assert.deepEqual(browser.interceptionErrors, []);
      assert.ok(browser.intercepted.every(r => r.action === 'failed' || r.action === 'fulfilled-fixture'));
      console.log(`# loaded ${id} v${ours[0].version} in disposable pid ${browser.pid} on port ${browser.port}; intercepted service-now requests: ${browser.intercepted.length}`);
    } finally {
      const closed = await browser.close();
      console.log(`# closed disposable browser pid ${closed.pid} (stragglers killed: ${closed.stragglersKilled})`);
    }
  });
});

// ---- Task 3: settings foundation in a real browser (fixtures only; every service-now request fulfilled/failed) ----
async function waitFor(fn, {timeoutMs = 10000, intervalMs = 100, what = 'condition'} = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error; }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

test('settings foundation: options page, worker status, controller handshake on production + test fixtures, live toggles', async () => {
  await withGeneratedArtifacts({root: repo}, async generated => {
    const P = generated.origins.production;
    const T = generated.origins.test;
    const page = (title, frame) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><p>${title}</p>${frame ? '<iframe src="/milo-fixture-frame"></iframe>' : ''}</body></html>`;
    const fixtures = ({url, resourceType}) => {
      const u = new URL(url);
      if (resourceType !== 'Document' || (u.origin !== P && u.origin !== T)) return null;
      if (u.pathname === '/milo-fixture') return {body: page(`milo fixture ${u.origin === P ? 'production' : 'test'}`, true)};
      if (u.pathname === '/milo-fixture-frame') return {body: page('milo fixture frame', false)};
      return null;
    };
    const browser = await launchDisposableBrowser({port: resolvePort(process.env.SN_MILO_SETTINGS_PORT, 9463), fixtures});
    const problems = [];
    const stopEvents = browser.onEvent(msg => {
      if (msg.method === 'Runtime.exceptionThrown') problems.push({sessionId: msg.sessionId, kind: 'exception', text: msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text});
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(msg.params.type)) problems.push({sessionId: msg.sessionId, kind: 'console', text: JSON.stringify(msg.params.args?.map(a => a.value ?? a.description))});
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') problems.push({sessionId: msg.sessionId, kind: 'log', text: msg.params.entry.text, url: msg.params.entry.url});
    });
    const sessionFor = pred => waitFor(() => [...browser.sessions.entries()].find(([, t]) => pred(t))?.[0], {what: 'target session'});
    const evaluate = async (sessionId, expression) => {
      const r = await browser.call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    try {
      const {id} = await browser.call('Extensions.loadUnpacked', {path: repo});
      const sw = await sessionFor(t => t.type === 'service_worker' && t.url === `chrome-extension://${id}/background.js`);
      const status = await waitFor(async () => { const s = await evaluate(sw, 'snMilo.status()'); return s?.ready ? s : null; }, {what: 'worker ready'});
      assert.equal(status.error, null);
      assert.deepEqual(Object.keys(status.features), ['critical-alert', 'interaction-alert', 'informatica-button', 'kb-dark', 'timecard']);
      assert.equal(status.features['critical-alert'].enabled, false, 'fresh profile: alerts pending migration');
      assert.equal(status.features['critical-alert'].migration.state, 'pending-migration');
      assert.equal(status.features['kb-dark'].enabled, true);
      const stored = await evaluate(sw, 'chrome.storage.local.get(null)');
      assert.deepEqual(Object.keys(stored).sort(), ['miloEffectiveV1'], 'first install writes only the derived effective record');

      // Options page: opens and renders without console errors / exceptions (reloaded after Runtime/Log enable).
      const {targetId: optionsTarget} = await browser.call('Target.createTarget', {url: `chrome-extension://${id}/options.html`});
      const opt = await sessionFor(t => t.targetId === optionsTarget);
      await browser.call('Runtime.enable', {}, opt);
      await browser.call('Log.enable', {}, opt);
      await browser.call('Page.reload', {}, opt);
      await waitFor(() => evaluate(opt, 'document.readyState === "complete" && Number(document.documentElement.dataset.rendered || 0) >= 1'), {what: 'options rendered'});
      const view = await evaluate(opt, `({boxes: [...document.querySelectorAll('#features input[type=checkbox]')].map(b => [b.dataset.feature, b.checked, b.disabled]),
        labels: [...document.querySelectorAll('#features label span')].map(s => s.textContent),
        pending: [...document.querySelectorAll('#features .pending')].map(p => p.closest('li').dataset.feature),
        timecardSlot: Boolean(document.querySelector('#timecard-status[data-status-for=timecard]')),
        errorHidden: document.getElementById('error').hidden, inlineScripts: [...document.scripts].filter(s => !s.src).length})`);
      assert.deepEqual(view.boxes.map(b => b[0]), ['critical-alert', 'interaction-alert', 'informatica-button', 'kb-dark', 'timecard']);
      assert.ok(view.boxes.every(b => b[1] === true && b[2] === false), 'all default-on, editable');
      assert.ok(view.labels.includes('Timecard overlay (native-form compatibility always on)'));
      assert.deepEqual(view.pending, ['critical-alert', 'interaction-alert']);
      assert.equal(view.timecardSlot, true);
      assert.equal(view.errorHidden, true);
      assert.equal(view.inlineScripts, 0);

      // Fixture pages on both configured origins (top frame + same-origin iframe).
      const open = url => browser.openPage(url); // interception armed before navigating
      const prod = await open(`${P}/milo-fixture`);
      const tst = await open(`${T}/milo-fixture`);
      const stateExpr = `(() => { const pick = w => { const a = w.__snMiloMainSettings; return a ? Object.fromEntries(['critical-alert','interaction-alert','informatica-button','kb-dark','timecard'].map(n => [n, a.get(n)?.enabled ?? null])) : null; };
        const f = document.querySelector('iframe'); return {top: pick(window), frame: f && f.contentWindow ? pick(f.contentWindow) : null, timeOrigin: performance.timeOrigin}; })()`;
      const expectState = (s, want) => JSON.stringify(s.top) === JSON.stringify(want) && JSON.stringify(s.frame) === JSON.stringify(want);
      const prodWant = on => ({'critical-alert': false, 'interaction-alert': false, 'informatica-button': true, 'kb-dark': on, timecard: on});
      const testWant = on => ({'critical-alert': null, 'interaction-alert': null, 'informatica-button': null, 'kb-dark': null, timecard: on});
      const prod0 = await waitFor(async () => { const s = await evaluate(prod, stateExpr); return expectState(s, prodWant(true)) && s; }, {what: 'production handshake'});
      const test0 = await waitFor(async () => { const s = await evaluate(tst, stateExpr); return expectState(s, testWant(true)) && s; }, {what: 'test-host handshake (timecard only)'});

      // Live toggle through storage (as the options page / another context would) → page state without reload.
      await evaluate(sw, `chrome.storage.local.set({features: {'kb-dark': false, timecard: false}}).then(() => true)`);
      const prod1 = await waitFor(async () => { const s = await evaluate(prod, stateExpr); return expectState(s, prodWant(false)) && s; }, {what: 'production disable'});
      const test1 = await waitFor(async () => { const s = await evaluate(tst, stateExpr); return expectState(s, testWant(false)) && s; }, {what: 'test-host disable'});
      await waitFor(() => evaluate(opt, `[...document.querySelectorAll('#features input[type=checkbox]')].filter(b => !b.checked).map(b => b.dataset.feature).join() === 'kb-dark,timecard'`), {what: 'options reflects storage change'});
      // Re-enable through the options page UI itself (router set-preference path).
      await evaluate(opt, `(async () => { for (const n of ['kb-dark', 'timecard']) { const b = document.querySelector('input[data-feature="' + n + '"]'); await new Promise(r => { const t = setInterval(() => { if (!b.isConnected || !b.disabled) { clearInterval(t); r(); } }, 20); }); document.querySelector('input[data-feature="' + n + '"]').click(); await new Promise(r => setTimeout(r, 300)); } return true; })()`);
      const prod2 = await waitFor(async () => { const s = await evaluate(prod, stateExpr); return expectState(s, prodWant(true)) && s; }, {what: 'production re-enable'});
      const test2 = await waitFor(async () => { const s = await evaluate(tst, stateExpr); return expectState(s, testWant(true)) && s; }, {what: 'test-host re-enable'});
      for (const [a, b] of [[prod0, prod1], [prod1, prod2], [test0, test1], [test1, test2]]) assert.equal(a.timeOrigin, b.timeOrigin, 'no page reload');
      const after = await evaluate(sw, 'snMilo.status()');
      assert.equal(after.features['kb-dark'].preference, true);
      assert.equal(after.features['critical-alert'].enabled, false, 'checkbox flips never complete alert migration');

      // ---- Explicit completion actions on the options page (separate from the checkbox) ----
      const actionsView = () => evaluate(opt, `[...document.querySelectorAll('#features li')].map(li => {
        const m = li.querySelector('.migration'); return [li.dataset.feature, m ? {
          files: m.querySelectorAll('input[type=file][data-role=snapshot-file][multiple]').length,
          text: m.querySelectorAll('textarea[data-role=snapshot-text]').length,
          importBtn: m.querySelectorAll('button[data-action=import]').length,
          radios: [...m.querySelectorAll('input[type=radio][data-choice]')].map(r => [r.dataset.choice, r.checked]),
          fallbackBtn: m.querySelectorAll('button[data-action=fallback]').length,
          labels: [...m.querySelectorAll('label[data-choice-label]')].map(l => l.textContent)} : null]; })`);
      const initialActions = Object.fromEntries(await actionsView());
      for (const name of ['critical-alert', 'interaction-alert']) {
        const a = initialActions[name];
        assert.ok(a, `${name} shows completion actions while pending`);
        assert.deepEqual([a.files, a.text, a.importBtn, a.fallbackBtn], [1, 1, 1, 1], name);
        assert.deepEqual(a.radios, [['notify-current', false], ['seed-silently', false]], `${name}: no default fallback selection`);
        assert.match(a.labels.join('\n'), /possible duplicate alerts/i);
        assert.match(a.labels.join('\n'), /permanently suppress items never previously notified/i);
      }
      for (const name of ['informatica-button', 'kb-dark', 'timecard']) assert.equal(initialActions[name], null, `${name}: no migration actions`);

      const sel = name => `#features li[data-feature="${name}"] .migration`;
      // in-progress migration inputs survive a re-render caused by an unrelated settings change
      const renderedBefore = await evaluate(opt, 'Number(document.documentElement.dataset.rendered)');
      await evaluate(opt, `(() => { const m = document.querySelector('${sel('critical-alert')}'); m.querySelector('textarea').value = 'draft in progress'; m.querySelector('input[data-choice="seed-silently"]').checked = true; return true; })()`);
      await evaluate(sw, `chrome.storage.local.set({features: {'kb-dark': true, timecard: true, 'informatica-button': false}}).then(() => true)`);
      await waitFor(() => evaluate(opt, `Number(document.documentElement.dataset.rendered) > ${renderedBefore} && !document.querySelector('input[data-feature="informatica-button"]').checked`), {what: 'options re-rendered'});
      assert.deepEqual(await evaluate(opt, `(() => { const m = document.querySelector('${sel('critical-alert')}'); return [m.querySelector('textarea').value, m.querySelector('input[data-choice="seed-silently"]').checked]; })()`),
        ['draft in progress', true], 'draft paste + radio choice preserved');
      await evaluate(opt, `(() => { const m = document.querySelector('${sel('critical-alert')}'); m.querySelector('input[data-choice="seed-silently"]').checked = false; return true; })()`);
      await evaluate(sw, `chrome.storage.local.set({features: {'kb-dark': true, timecard: true, 'informatica-button': true}}).then(() => true)`);
      await waitFor(() => evaluate(opt, `document.querySelector('input[data-feature="informatica-button"]').checked`), {what: 'informatica restored'});

      // invalid paste → validation error, nothing changes
      await evaluate(opt, `(() => { const m = document.querySelector('${sel('critical-alert')}'); m.querySelector('textarea').value = '{"schema":1,"feature":"critical-alert","key":"seenMatchesV4","entries":["nope"]}'; m.querySelector('button[data-action=import]').click(); return true; })()`);
      const importError = await waitFor(() => evaluate(opt, `(() => { const e = document.querySelector('${sel('critical-alert')} [data-role=import-error]'); return e && !e.hidden && e.textContent; })()`), {what: 'import validation error'});
      assert.match(importError, /entry 0 is not a valid seenMatchesV4 entry/);
      assert.equal((await evaluate(sw, 'snMilo.status()')).features['critical-alert'].migration.state, 'pending-migration');

      // two snapshot files (overlapping) via the file input → union import
      const id32 = c => c.repeat(32);
      const snapDir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'sn_milo-snapshots-'));
      const fileA = path.join(snapDir, 'a.json');
      const fileB = path.join(snapDir, 'b.json');
      const entriesA = [`${id32('a')}|1 - Critical|New|Fixture`, `${id32('b')}|1 - Critical|New|Fixture`];
      const entriesB = [`${id32('b')}|1 - Critical|New|Fixture`, `${id32('c')}|2 - High|Open|Fixture`];
      fs.writeFileSync(fileA, JSON.stringify({schema: 1, feature: 'critical-alert', key: 'seenMatchesV4', entries: entriesA, exportedAt: '2026-10-20T10:00:00.000Z'}));
      fs.writeFileSync(fileB, JSON.stringify([{schema: 1, feature: 'critical-alert', key: 'seenMatchesV4', entries: entriesB}]));
      try {
        await browser.call('DOM.enable', {}, opt);
        const {root} = await browser.call('DOM.getDocument', {depth: 0}, opt);
        const {nodeId} = await browser.call('DOM.querySelector', {nodeId: root.nodeId, selector: `${sel('critical-alert')} input[type=file]`}, opt);
        await browser.call('DOM.setFileInputFiles', {nodeId, files: [fileA, fileB]}, opt);
        await evaluate(opt, `(() => { const m = document.querySelector('${sel('critical-alert')}'); m.querySelector('textarea').value = ''; m.querySelector('button[data-action=import]').click(); return true; })()`);
        await waitFor(async () => (await evaluate(sw, 'snMilo.status()')).features['critical-alert'].enabled === true, {what: 'critical-alert effectively enabled after import'});
      } finally {
        fs.rmSync(snapDir, {recursive: true, force: true});
      }
      const imported = await evaluate(sw, `chrome.storage.local.get(['seenMatchesV4', 'crit.migrationV1'])`);
      assert.deepEqual(imported.seenMatchesV4, [...entriesA, entriesB[1]], 'union of both snapshots, order preserved');
      assert.equal(imported['crit.migrationV1'].method, 'import');
      assert.equal(imported['crit.migrationV1'].importedEntries, 3);
      await waitFor(() => evaluate(opt, `!document.querySelector('${sel('critical-alert')}') && /3 entries/.test(document.getElementById('notice').textContent)`), {what: 'import actions hidden + result shown'});
      await waitFor(async () => (await evaluate(prod, stateExpr)).top['critical-alert'] === true, {what: 'production page sees critical-alert enabled'});

      // fallback: no choice → error; confirm() declined → nothing; accepted → completes
      await evaluate(opt, `(() => { window.__confirms = []; window.__confirmAnswer = false; window.confirm = t => { __confirms.push(t); return __confirmAnswer; }; document.querySelector('${sel('interaction-alert')} button[data-action=fallback]').click(); return true; })()`);
      const fbError = await waitFor(() => evaluate(opt, `(() => { const e = document.querySelector('${sel('interaction-alert')} [data-role=fallback-error]'); return e && !e.hidden && e.textContent; })()`), {what: 'fallback needs a choice'});
      assert.match(fbError, /choose one/i);
      assert.deepEqual(await evaluate(opt, '__confirms'), [], 'no confirm without a choice');
      await evaluate(opt, `(() => { document.querySelector('${sel('interaction-alert')} input[data-choice="notify-current"]').click(); document.querySelector('${sel('interaction-alert')} button[data-action=fallback]').click(); return true; })()`);
      await waitFor(async () => (await evaluate(opt, '__confirms')).length === 1, {what: 'confirm shown'});
      await sleep(300);
      assert.equal((await evaluate(sw, 'snMilo.status()')).features['interaction-alert'].migration.state, 'pending-migration', 'declined confirm changes nothing');
      assert.match((await evaluate(opt, '__confirms'))[0], /possible duplicate alerts/i);
      await evaluate(opt, `(() => { window.__confirmAnswer = true; document.querySelector('${sel('interaction-alert')} input[data-choice="notify-current"]').checked = true; document.querySelector('${sel('interaction-alert')} button[data-action=fallback]').click(); return true; })()`);
      await waitFor(async () => (await evaluate(sw, 'snMilo.status()')).features['interaction-alert'].enabled === true, {what: 'interaction-alert enabled after confirmed fallback'});
      const ixRecord = (await evaluate(sw, `chrome.storage.local.get('ix.migrationV1')`))['ix.migrationV1'];
      assert.equal(ixRecord.method, 'notify-current');
      await waitFor(() => evaluate(opt, `document.querySelectorAll('#features .migration').length === 0`), {what: 'all completion actions hidden once ready'});

      // Extension-wide error state and network containment.
      const {targetId: extTarget} = await browser.call('Target.createTarget', {url: 'chrome://extensions'});
      const ext = await sessionFor(t => t.targetId === extTarget);
      const info = await waitFor(async () => {
        const v = await evaluate(ext, `typeof chrome?.developerPrivate?.getExtensionInfo !== 'function' ? null : new Promise(r => chrome.developerPrivate.getExtensionInfo(${JSON.stringify(id)}, i => r(JSON.stringify(i))))`);
        return v ? JSON.parse(v) : null;
      }, {what: 'developerPrivate info'});
      assert.deepEqual(info.manifestErrors, []);
      assert.deepEqual(info.runtimeErrors, []);
      assert.deepEqual(info.installWarnings, []);
      const optionProblems = problems.filter(p => p.sessionId === opt);
      assert.deepEqual(optionProblems, [], 'options page console clean');
      assert.deepEqual(browser.interceptionErrors, []);
      assert.ok(browser.intercepted.length > 0);
      for (const r of browser.intercepted) {
        const u = new URL(r.url);
        const fixture = r.resourceType === 'Document' && ['/milo-fixture', '/milo-fixture-frame'].includes(u.pathname);
        assert.equal(r.action, fixture ? 'fulfilled-fixture' : 'failed', r.url);
      }
      console.log(`# settings foundation verified in disposable pid ${browser.pid} port ${browser.port}; intercepted ${browser.intercepted.length} service-now requests (${browser.intercepted.filter(r => r.action === 'fulfilled-fixture').length} fixtures, rest failed)`);
    } finally {
      stopEvents();
      const closed = await browser.close();
      console.log(`# closed disposable browser pid ${closed.pid} (stragglers killed: ${closed.stragglersKilled})`);
    }
  });
});
