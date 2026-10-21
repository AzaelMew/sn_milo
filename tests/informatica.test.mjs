// Informatica button (features/informatica-button/*) — Milo lifecycle and mocked workflow tests.
// Part A drives the REAL router + settings controller + MAIN helper (page-sim) with both feature scripts on a mocked
// DOM: mount when enabled, removal on disable, exactly one button after re-enable, origin scoping, takeover.
// Part B runs the full workflow on a mocked AMS Informatica record (tests/helpers/informatica-sim.mjs, fake clock):
// ordering, dry run, duplicate injection, disabled clicks and cancellation checkpoints. Every "write" (Save,
// picking people, pasting) is a local fake; nothing reaches a network.
import './informatica-maintenance.test.mjs'; // Included by the explicit npm test:unit entrypoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMiloBackground} from '../shared/router.mjs';
import {createFakeChrome, createFakeStorage, deliver, contentSender, optionsSender, ORIGINS, PROD, TEST, sleep} from './helpers/fake-chrome.mjs';
import {createFrame, contentChrome} from './helpers/page-sim.mjs';
import {createInformaticaPage, createDocument, createWorkspace, domMixin, EMAILS, CONTENT, PAGE, SYS_ID} from './helpers/informatica-sim.mjs';

const plain = v => JSON.parse(JSON.stringify(v)); // vm-realm arrays → this realm (deepStrictEqual checks prototypes)
const settle = async (ms = 15) => { for (let i = 0; i < 4; i++) await sleep(ms / 4); };

// ---- Part A: real settings path -----------------------------------------------------------------------------------
function world(initial = {}) {
  const {chrome} = createFakeChrome({storage: createFakeStorage(initial)});
  const app = createMiloBackground({chrome, origins: ORIGINS, features: []});
  app.install();
  const setPref = (name, enabled) => deliver(chrome, {feature: 'milo', type: 'set-preference', name, enabled}, optionsSender());
  function frame(origin = PROD, {path = `/now/sow/record/incident/${SYS_ID}`, tabUrl} = {}) {
    const doc = createDocument();
    const f = createFrame({origin, url: `${origin}${path}`, document: domMixin(doc)});
    f.doc = doc;
    f.chrome = contentChrome({backgroundChrome: chrome, deliver, sender: contentSender(origin, {path, tabUrl})});
    f.setChrome(f.chrome);
    return f;
  }
  return {chrome, app, setPref, frame};
}
/** Load in manifest-policy order: controller (ISOLATED, start), MAIN helper (start), bridge (MAIN, start), button (ISOLATED, idle). */
function loadAll(f) {
  f.run('isolated', 'shared/controller.js');
  f.run('main', 'shared/main-settings.js');
  f.run('main', PAGE);
  f.run('isolated', CONTENT);
}
const buttons = f => f.doc.querySelectorAll('button').filter(b => b.id === 'sn-inf-button');

test('real settings path: mounts when enabled, disappears on disable, re-enable mounts exactly one (no reload)', async () => {
  const w = world();
  const f = w.frame();
  createWorkspace({clock: {setTimeout, clearTimeout}, doc: f.doc});
  loadAll(f);
  await settle();
  assert.equal(buttons(f).length, 1, 'mounted');
  assert.equal(buttons(f)[0].style.display, 'block', 'placed on the AMS Informatica record');
  assert.equal(f.eval('main', 'window.__snInfBridge.active'), true);
  const mainListeners = f.count('main');
  for (const enabled of [false, true, false, true]) {
    await w.setPref('informatica-button', enabled);
    await settle();
    assert.equal(buttons(f).length, enabled ? 1 : 0, `enabled=${enabled}`);
    assert.equal(f.eval('main', 'window.__snInfBridge.active'), enabled);
    assert.equal(f.count('main'), enabled ? mainListeners : mainListeners - 1, 'bridge listener added/removed');
    assert.equal(f.intervals('isolated'), enabled ? 2 : 1, 'controller liveness timer + button placement timer only while enabled');
  }
  f.advance(6000); // placement ticks + liveness ticks
  assert.equal(buttons(f).length, 1, 'still exactly one');
});

test('real settings path: disabled at load → nothing mounts, bridge inert; non-record pages hide the button', async () => {
  const w = world({features: {'informatica-button': false}});
  const f = w.frame();
  createWorkspace({clock: {setTimeout, clearTimeout}, doc: f.doc});
  loadAll(f);
  await settle();
  assert.equal(buttons(f).length, 0);
  assert.equal(f.eval('main', 'window.__snInfBridge.active'), false);
  const w2 = world();
  const g = w2.frame(PROD, {path: '/now/nav/ui/home'});
  loadAll(g);
  await settle();
  assert.equal(buttons(g).length, 1);
  assert.equal(buttons(g)[0].style.display, 'none', 'no AMS Informatica record → hidden (original behaviour)');
});

test('origin policy: the test host mounts the button and arms the bridge; opaque origins stay inert', async () => {
  const w = world();
  const f = w.frame(TEST);
  createWorkspace({clock: {setTimeout, clearTimeout}, doc: f.doc});
  loadAll(f);
  await settle();
  assert.equal(buttons(f).length, 1);
  assert.equal(f.eval('main', 'window.__snInfBridge.active'), true);
  const opaque = createFrame({origin: 'null', document: domMixin(createDocument())});
  opaque.setChrome({runtime: {id: undefined}});
  opaque.run('main', PAGE);
  opaque.run('isolated', CONTENT);
  assert.equal(opaque.eval('main', 'typeof window.__snInfBridge'), 'undefined');
  assert.equal(opaque.eval('isolated', 'typeof globalThis.__snInfController'), 'undefined');
});

test('extension reload: the orphaned instance retires without touching the new button; exactly one remains', async () => {
  const w = world();
  const f = w.frame();
  createWorkspace({clock: {setTimeout, clearTimeout}, doc: f.doc});
  loadAll(f);
  await settle();
  const oldButton = buttons(f)[0];
  f.chrome.invalidate();
  // new instance: new isolated world (static scripts are not re-injected into old documents; a reinjection would be)
  const fresh = contentChrome({backgroundChrome: w.chrome, deliver, sender: contentSender(PROD, {path: `/now/sow/record/incident/${SYS_ID}`})});
  f.newExtensionInstance(fresh);
  f.run('isolated', 'shared/controller.js');
  f.run('isolated', CONTENT);
  await settle();
  for (let i = 0; i < 6; i++) { f.advance(1000); await settle(); }
  assert.equal(buttons(f).length, 1, 'exactly one button');
  assert.notEqual(buttons(f)[0], oldButton, 'the new instance owns it');
  assert.equal(oldButton.isConnected, false);
  f.advance(3000);
  assert.equal(buttons(f).length, 1);
});

test('same-world controller reinjection (watchdog): the button keeps following the effective state, exactly one, one subscription', async () => {
  const w = world();
  const f = w.frame();
  createWorkspace({clock: {setTimeout, clearTimeout}, doc: f.doc});
  loadAll(f);
  await settle();
  assert.equal(buttons(f).length, 1);
  const first = buttons(f)[0];
  f.run('isolated', 'shared/controller.js'); // shared/controller.js re-injected into the SAME isolated world
  await settle();
  for (let i = 0; i < 4; i++) { f.advance(1500); await settle(); }
  assert.equal(buttons(f).length, 1, 'still mounted after supersede');
  assert.equal(buttons(f)[0], first, 'not torn down and re-created');
  assert.equal(buttons(f)[0].style.display, 'block');
  assert.equal(f.eval('isolated', '__snMiloController.subscriptions'), 1, 'no duplicate subscription');
  for (const enabled of [false, true, false, true]) {
    await w.setPref('informatica-button', enabled);
    await settle();
    f.advance(1500); await settle();
    assert.equal(buttons(f).length, enabled ? 1 : 0, `after supersede, enabled=${enabled}`);
  }
  assert.equal(f.intervals('isolated'), 2, 'one liveness timer + one placement timer');
  assert.equal(f.eval('isolated', '__snMiloController.subscriptions'), 1);
});

// ---- Part B: mocked workflow --------------------------------------------------------------------------------------
const peopleSteps = EMAILS.flatMap(e => [`pick:${e}`, `chip:${e}`]);
const events = p => p.ws.log.filter(e => !e.startsWith('type:'));
const click = p => p.button().click();
async function runToEnd(p, max = 90000) {
  await p.clock.until(() => p.controller().lastRun?.status && p.controller().lastRun.status !== 'running', {max});
  return p.controller().lastRun;
}

test('workflow order on a mocked record: people → verify (GET) → Save → verify persisted → tab → paste → Post (submits the note)', async () => {
  const p = createInformaticaPage().load();
  await p.clock.advance(10);
  assert.equal(p.buttons().length, 1);
  click(p);
  const result = await runToEnd(p);
  assert.equal(result.status, 'posted');
  assert.deepEqual(events(p), [...peopleSteps, 'save', 'tab', 'paste', 'post']);
  assert.equal(p.ws.log.filter(e => e === 'post').length, 1, 'Post clicked exactly once');
  assert.deepEqual(p.ws.chips(), EMAILS);
  assert.equal(p.ws.server.list, EMAILS.join(','));
  assert.deepEqual(p.ws.server.posts, [p.ws.desc.value]);
  assert.ok(p.fetches.length >= 2, 'list verified before and after Save');
  for (const f of p.fetches) {
    assert.equal(f.method, 'GET');
    assert.equal(f.url, `/api/now/table/incident/${SYS_ID}?sysparm_fields=u_external_work_notes_list`);
    assert.equal(f.opts.headers['X-UserToken'], 'tok');
  }
  assert.equal(p.button().textContent, 'Posted ✓');
  await p.clock.advance(7000);
  assert.equal(p.button().textContent, 'Informatica', 'label restored');
  assert.equal(p.button().disabled, false);
});

test('already-persisted list: no people typed, no list Save click; Post still submits the note', async () => {
  const p = createInformaticaPage({workspace: {savedList: EMAILS.join(', '), presetChips: EMAILS}}).load();
  await p.clock.advance(10);
  click(p);
  const result = await runToEnd(p);
  assert.equal(result.status, 'posted');
  assert.deepEqual(events(p), ['tab', 'paste', 'post']);
  assert.deepEqual(p.ws.server.posts, [p.ws.desc.value]);
});

test('dry run stops right before the Post click — but AFTER the list Save (dry run is not write-free)', async () => {
  const p = createInformaticaPage({dryRun: true}).load();
  await p.clock.advance(10);
  click(p);
  const result = await runToEnd(p);
  assert.equal(result.status, 'dry-run');
  assert.deepEqual(events(p), [...peopleSteps, 'save', 'tab', 'paste']);
  assert.ok(!p.ws.log.includes('post'));
  assert.equal(p.button().textContent, 'Dry run: ready to post');
});

test('original failure handling preserved: missing Save button → "Failed: Save button not found", nothing posted', async () => {
  const p = createInformaticaPage({workspace: {saveButton: false}}).load();
  await p.clock.advance(10);
  click(p);
  const result = await runToEnd(p);
  assert.equal(result.status, 'failed');
  assert.equal(p.button().textContent, 'Failed: Save button not found');
  assert.deepEqual(p.ws.writes(), []);
  assert.equal(p.button().disabled, false);
});

test('duplicate injection in one isolated world: one button, the previous controller stopped and unsubscribed', async () => {
  const p = createInformaticaPage().load();
  await p.clock.advance(10);
  const first = p.controller();
  const firstButton = p.button();
  p.run('isolated', CONTENT);
  await p.clock.advance(10);
  assert.notEqual(p.controller(), first);
  assert.equal(first.active, false);
  assert.equal(p.buttons().length, 1);
  assert.notEqual(p.button(), firstButton);
  assert.equal(p.milo.subs.size, 1, 'one settings subscription');
  assert.equal(p.clock.intervals(), 1, 'one placement interval');
  p.setEnabled(false); p.setEnabled(true);
  await p.clock.advance(3100);
  assert.equal(p.buttons().length, 1, 'the old controller does not come back on re-enable');
  firstButton.click();
  await p.clock.advance(1000);
  assert.deepEqual(p.ws.log, [], 'the superseded button cannot start a run');
});

test('clicks never run while disabled: before enable, after disable, on a stale button reference', async () => {
  const p = createInformaticaPage({enabled: false}).load();
  await p.clock.advance(3100);
  assert.equal(p.buttons().length, 0, 'nothing mounted while disabled');
  p.setEnabled(true);
  await p.clock.advance(10);
  const stale = p.button();
  p.setEnabled(false);
  assert.equal(p.buttons().length, 0, 'disable removes the button');
  assert.equal(p.clock.intervals(), 0, 'placement timer cleared');
  stale.click();
  await p.clock.advance(5000);
  assert.deepEqual(p.ws.log, []);
  assert.equal(p.fetches.length, 0);
  assert.equal(p.buttons().length, 0, 'not re-created by a late label/placement timer');
  p.setEnabled(true);
  await p.clock.advance(10);
  const live = p.button();
  p.milo.api.effective = () => ({enabled: false, seedOnly: false}); // settings say off, stop not yet delivered
  live.click();
  await p.clock.advance(1000);
  assert.deepEqual(p.ws.log, [], 'click re-checks the effective state');
});

function cancelAt(hookName, {after = 1, workspace = {}, dryRun = false} = {}) {
  let p;
  let n = 0;
  const hooks = {[hookName]: () => { if (++n === after) p.setEnabled(false); }};
  p = createInformaticaPage({workspace: {...workspace, hooks}, dryRun}).load();
  return p;
}

test('cancellation after the first person is added: no further people, no Save; partial work reported', async () => {
  const p = cancelAt('onChip');
  await p.clock.advance(10);
  click(p);
  await p.clock.until(() => p.controller().lastRun?.status === 'cancelled');
  const r = p.controller().lastRun;
  assert.equal(r.reason, 'disabled');
  assert.deepEqual(plain(r.completed), ['added 1 of 3 people to "External work notes list" (not saved)']);
  assert.match(r.message, /Nothing was undone/);
  assert.equal(p.notice()?.textContent, r.message, 'reported on the page');
  assert.ok(p.warnings().some(w => w.includes(r.message)), 'and in the console');
  await p.clock.advance(60000);
  assert.deepEqual(events(p), [`pick:${EMAILS[0]}`, `chip:${EMAILS[0]}`]);
  assert.deepEqual(p.ws.writes(), [], 'no server write after disable');
  assert.equal(p.buttons().length, 0);
  assert.equal(p.notice(), null, 'notice removed after a while');
});

test('cancellation while a person is being picked (click in flight): no more typing; reported as picked', async () => {
  const p = cancelAt('onPick', {after: 2});
  await p.clock.advance(10);
  click(p);
  await p.clock.advance(60000);
  assert.deepEqual(events(p), [...peopleSteps.slice(0, 3), `chip:${EMAILS[1]}`], 'in-flight pick may complete; nothing new starts');
  assert.ok(!p.ws.log.some(e => e === `type:${EMAILS[2]}`), 'third person never typed');
  assert.deepEqual(plain(p.controller().lastRun.completed), ['added 2 of 3 people to "External work notes list" (not saved)']);
});

test('cancellation after the Save click, while waiting for persistence: the note is never saved; Save reported, not undone', async () => {
  const p = cancelAt('onSave', {workspace: {saveDelay: 3000}});
  await p.clock.advance(10);
  click(p);
  await p.clock.advance(60000);
  assert.deepEqual(events(p), [...peopleSteps, 'save']);
  assert.ok(!p.ws.log.includes('tab'));
  const r = p.controller().lastRun;
  assert.equal(r.status, 'cancelled');
  assert.deepEqual(plain(r.completed), ['added 3 of 3 people to "External work notes list"', 'Save clicked (the record may have been saved)']);
  assert.match(r.message, /Nothing was undone/);
  assert.equal(p.ws.server.list, EMAILS.join(','), 'the in-flight save is not reverted by Milo');
  const fetchesAtEnd = p.fetches.length;
  await p.clock.advance(30000);
  assert.equal(p.fetches.length, fetchesAtEnd, 'verification polling stopped');
});

test('cancellation during the Post readiness wait: never clicked; pasted text reported (not posted)', async () => {
  let p;
  p = createInformaticaPage().load();
  await p.clock.advance(10);
  click(p);
  await p.clock.until(() => p.ws.log.includes('paste'));
  p.setEnabled(false);
  await p.clock.advance(60000);
  assert.deepEqual(events(p), [...peopleSteps, 'save', 'tab', 'paste']);
  const r = p.controller().lastRun;
  assert.deepEqual(plain(r.completed), ['added 3 of 3 people to "External work notes list"', 'Save confirmed',
    'opened the External work notes tab', 'pasted the Description into the External work notes editor (not posted)']);
});

test('cancellation right after the Post click: reported as possibly posted, nothing further runs', async () => {
  const p = cancelAt('onPost', {workspace: {postWorks: false}});
  await p.clock.advance(10);
  click(p);
  await p.clock.advance(60000);
  assert.equal(p.ws.log.filter(e => e === 'post').length, 1);
  const r = p.controller().lastRun;
  assert.equal(r.status, 'cancelled');
  assert.equal(r.completed.at(-1), 'Post clicked for the note (it may have been posted)');
});

test('a swallowed Post click is NOT retried (Post is not idempotent): the run fails, the note stays in the editor', async () => {
  const p = createInformaticaPage({workspace: {postWorks: false}}).load();
  await p.clock.advance(10);
  click(p);
  const r = await runToEnd(p);
  assert.equal(r.status, 'failed');
  assert.equal(p.ws.log.filter(e => e === 'post').length, 1, 'exactly one Post click');
  assert.equal(p.ws.server.posts.length, 0);
  assert.match(p.ws.editor.body.innerText, /Nightly Informatica/, 'the pasted note is left in the editor');
  assert.match(p.button().textContent, /^Failed: Post did not submit the note/);
});

test('the record Save never substitutes for Post: only the list Save is clicked', async () => {
  const p = createInformaticaPage({workspace: {postWorks: false, saveSubmitsNote: true}}).load();
  await p.clock.advance(10);
  click(p);
  const r = await runToEnd(p);
  assert.equal(p.ws.log.filter(e => e === 'save').length, 1, 'only the list Save');
  assert.equal(r.status, 'failed');
});

test('Post never enabled after pasting: the run fails, nothing is submitted, the pasted note stays in the editor', async () => {
  const p = createInformaticaPage({workspace: {savedList: EMAILS.join(', '), presetChips: EMAILS}}).load();
  await p.clock.advance(10);
  p.ws.editor.body.addEventListener('keyup', () => { p.ws.post.disabled = true; }); // the editor never enables Post
  click(p);
  const r = await runToEnd(p);
  assert.equal(r.status, 'failed');
  assert.deepEqual(events(p), ['tab', 'paste']);
  assert.equal(p.ws.server.posts.length, 0);
  assert.equal(p.button().textContent, 'Failed: Post button never became ready; nothing was posted');
  assert.ok(!p.ws.log.includes('post') && !p.ws.log.includes('save'));
});

test('re-enable after a cancelled run: exactly one fresh button; the old run stays dead; a new run completes', async () => {
  const p = cancelAt('onChip');
  await p.clock.advance(10);
  click(p);
  await p.clock.until(() => p.controller().lastRun?.status === 'cancelled');
  p.setEnabled(true);
  await p.clock.advance(10);
  assert.equal(p.buttons().length, 1);
  await p.clock.advance(20000);
  assert.deepEqual(events(p), [`pick:${EMAILS[0]}`, `chip:${EMAILS[0]}`], 'the cancelled run did not resume');
  click(p);
  const r = await runToEnd(p);
  assert.equal(r.status, 'posted');
  assert.deepEqual(events(p).slice(2), [...peopleSteps.slice(2), 'save', 'tab', 'paste', 'post'], 'new run picks up the remaining people');
  assert.equal(p.buttons().length, 1);
});

test('extension context invalidated mid-run (controller retires): button removed, run cancelled with reason', async () => {
  const p = createInformaticaPage({workspace: {hooks: {}}}).load();
  await p.clock.advance(10);
  click(p);
  await p.clock.until(() => p.ws.log.includes(`chip:${EMAILS[0]}`));
  p.retire();
  await p.clock.advance(60000);
  assert.equal(p.buttons().length, 0);
  assert.deepEqual(p.ws.writes(), []);
  assert.equal(p.controller().lastRun.reason, 'invalidated');
  assert.equal(p.messageListeners('isolated'), 0, 'pending bridge request listeners removed');
});

// ---- guarded resolve (opt-in): State Resolved + Resolution code + user-supplied notes after the note is posted ----
const NOTES = 'Escalated (example notes)';
const patches = p => p.fetches.filter(f => f.method === 'PATCH');

test('resolve off (default): the note is posted and the ticket is never written to', async () => {
  const p = createInformaticaPage().load();
  await p.clock.advance(10);
  click(p);
  const result = await runToEnd(p);
  assert.equal(result.status, 'posted');
  assert.equal(patches(p).length, 0);
  assert.equal(p.record.state, '1');
});

test('resolve on: after the confirmed note Save, ONE PATCH with the fixed state/code and the user notes, verified by read-back', async () => {
  const p = createInformaticaPage({resolve: {notes: NOTES}}).load();
  await p.clock.advance(10);
  click(p);
  const result = await runToEnd(p);
  assert.equal(result.status, 'resolved');
  assert.ok(result.completed.includes('ticket resolved (verified)'), JSON.stringify(result.completed));
  assert.deepEqual(p.ws.server.posts, [p.ws.desc.value], 'note posted first');
  assert.equal(patches(p).length, 1, 'exactly one write, no retry');
  const [patch] = patches(p);
  assert.equal(patch.url, `/api/now/table/incident/${SYS_ID}?sysparm_fields=number,short_description,state,close_code,close_notes`);
  assert.equal(patch.opts.headers['X-UserToken'], 'tok');
  assert.deepEqual(JSON.parse(patch.opts.body), {state: '6', close_code: 'Solution provided', close_notes: NOTES});
  assert.deepEqual([p.record.state, p.record.close_code, p.record.close_notes], ['6', 'Solution provided', NOTES]);
  assert.equal(p.button().textContent, 'Posted + resolved ✓');
});

test('resolve on + dry run: nothing is resolved (the run stops before the note Save)', async () => {
  const p = createInformaticaPage({dryRun: true, resolve: {notes: NOTES}}).load();
  await p.clock.advance(10);
  click(p);
  const result = await runToEnd(p);
  assert.equal(result.status, 'dry-run');
  assert.equal(patches(p).length, 0);
  assert.equal(p.record.state, '1');
});

test('resolve on but the note never posts: the run fails and the ticket is NOT touched', async () => {
  const p = createInformaticaPage({resolve: {notes: NOTES}, workspace: {postWorks: false}}).load();
  await p.clock.advance(10);
  click(p);
  const result = await runToEnd(p);
  assert.equal(result.status, 'failed');
  assert.equal(patches(p).length, 0);
  assert.equal(p.record.state, '1');
});

test('resolve refuses a ticket that is not open or not an Informatica ticket (note stays posted, no PATCH)', async () => {
  for (const [incident, pattern] of [[{state: '6'}, /not open/], [{short_description: 'Printer is broken'}, /not an Informatica ticket/]]) {
    const p = createInformaticaPage({resolve: {notes: NOTES}, incident}).load();
    await p.clock.advance(10);
    click(p);
    const result = await runToEnd(p);
    assert.equal(result.status, 'failed');
    assert.match(result.error, pattern);
    assert.equal(patches(p).length, 0);
    assert.deepEqual(p.ws.server.posts, [p.ws.desc.value]);
  }
});

test('resolve whose PATCH is silently ignored: read-back mismatch is reported, still a single PATCH', async () => {
  const p = createInformaticaPage({resolve: {notes: NOTES}, patchWorks: false}).load();
  await p.clock.advance(10);
  click(p);
  const result = await runToEnd(p);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /read-back does not match/);
  assert.equal(patches(p).length, 1);
  assert.ok(result.completed.some(c => /resolve was requested/.test(c)), JSON.stringify(result.completed));
});
