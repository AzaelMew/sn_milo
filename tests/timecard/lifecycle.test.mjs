// Timecard overlay lifecycle (Milo): MAIN settings handshake, inert-until-enabled, draft-preserving disable,
// re-enable and reinjection. Native-form compatibility is covered in native-lifecycle.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './dom-fixture.mjs';

const overlays = f => f.doc.querySelectorAll('*').filter(e => e.id === 'sn-timecard-overlay');
const addButtons = f => f.doc.querySelectorAll('button').filter(b => b.textContent === 'Add timecard');
const frameOf = f => f.doc.querySelector('#sn-timecard-overlay')?.shadowRoot.querySelector('iframe');
const liveObservers = f => f.window.__observers.filter(o => !o.disconnected);
function track(f) { // make MutationObserver.disconnect observable
  for (const o of f.window.__observers) o.disconnect = () => { o.disconnected = true; };
}
const RETAINED = 'disabled; current form retained until closed';

test('disabled startup: no launch UI, timers, observers or overlays; open() is refused', () => {
  const f = fixture('test', {settings: 'disabled'});
  const app = f.load();
  assert.equal(addButtons(f).length, 0);
  assert.equal(f.timers.size, 0, 'no polling timer');
  app.open();
  assert.equal(overlays(f).length, 0);
  assert.deepEqual({enabled: app.status().enabled, mounted: app.status().mounted, overlayOpen: app.status().overlayOpen, retained: app.status().retained},
    {enabled: false, mounted: false, overlayOpen: false, retained: false});
  app.refresh();
  assert.equal(addButtons(f).length, 0, 'refresh() cannot mount while disabled');
});

test('inert until effective settings arrive; a missing settings helper stays inert', () => {
  const unknown = fixture('test', {settings: 'unknown'});
  const app = unknown.load();
  assert.equal(addButtons(unknown).length, 0);
  assert.equal(unknown.timers.size, 0);
  app.open();
  assert.equal(overlays(unknown).length, 0);
  unknown.settings.set(true);
  assert.equal(addButtons(unknown).length, 1, 'mounts once the enabled state arrives');
  assert.equal(unknown.timers.size, 1);

  const none = fixture('test', {settings: false});
  const a = none.load();
  a.open();
  assert.equal(addButtons(none).length, 0);
  assert.equal(overlays(none).length, 0);
  assert.equal(none.timers.size, 0);
});

test('disable removes the launch UI and stops polling/observers; re-enable restores exactly one button', () => {
  const f = fixture();
  const app = f.load();
  track(f);
  assert.equal(addButtons(f).length, 1);
  assert.equal(f.timers.size, 1);
  f.settings.set(false);
  assert.equal(addButtons(f).length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(app.status().mounted, false);
  assert.equal(liveObservers(f).length, 0, 'mutation observer disconnected');
  f.settings.set(false); // duplicate state: still nothing
  f.settings.set(true);
  assert.equal(addButtons(f).length, 1);
  assert.equal(f.timers.size, 1);
  f.settings.set(true);
  assert.equal(addButtons(f).length, 1, 'idempotent');
  assert.equal(f.timers.size, 1);
  assert.equal(f.window.__snTimecardApp, app, 'the same controller serves toggles (no reload needed)');
});

test('a disabled page ignores late DOM changes (observer callback / poll) until re-enabled', () => {
  const f = fixture();
  f.load();
  f.settings.set(false);
  for (const o of f.window.__observers) o.cb([]);
  f.flush();
  assert.equal(addButtons(f).length, 0);
  f.settings.set(true);
  assert.equal(addButtons(f).length, 1);
});

test('disable keeps an open CLEAN form (no force close), removes the button, reports the retained status', () => {
  const f = fixture();
  const app = f.load();
  app.open();
  const overlay = f.doc.querySelector('#sn-timecard-overlay');
  const iframe = frameOf(f);
  iframe.contentWindow = {g_form: {modified: false}, location: {href: 'https://instance.example/task_time_worked.do?sys_id=-1'}};
  f.settings.set(false);
  assert.equal(overlay.isConnected, true);
  assert.equal(frameOf(f), iframe);
  assert.equal(addButtons(f).length, 0);
  assert.equal(f.timers.size, 0);
  const status = app.status();
  assert.equal(status.overlayOpen, true);
  assert.equal(status.retained, true);
  assert.equal(status.note, RETAINED);
  app.open();
  assert.equal(overlays(f).length, 1, 'no second overlay');
  assert.deepEqual(f.window.__confirms, [], 'nothing asked, nothing discarded');
});

test('disable keeps an open DIRTY draft; the user can still close it (with the unsaved-draft confirm)', () => {
  const f = fixture();
  const app = f.load();
  app.open();
  const iframe = frameOf(f);
  iframe.contentWindow = {g_form: {modified: true}, location: {href: 'https://instance.example/task_time_worked.do?sys_id=-1'}};
  f.settings.set(false);
  assert.equal(overlays(f).length, 1);
  assert.equal(app.status().note, RETAINED);
  f.window.__confirmAnswer = false;
  assert.equal(app.close(), false, 'user declines the discard prompt: draft stays');
  assert.equal(overlays(f).length, 1);
  assert.equal(f.window.__confirms.length, 1);
  f.window.__confirmAnswer = true;
  assert.equal(app.close(), true);
  assert.equal(overlays(f).length, 0);
  assert.equal(addButtons(f).length, 0, 'closing a retained form must not bring the launch UI back');
  assert.equal(f.timers.size, 0);
  assert.equal(app.status().retained, false);
  assert.equal(app.status().note, null);
});

test('Escape and the frame-leaves-new-record signal still close a retained form (user-initiated paths)', () => {
  const f = fixture();
  const app = f.load();
  app.open();
  f.settings.set(false);
  f.key('Escape');
  assert.equal(overlays(f).length, 0, 'Escape (clean form) closes');

  app.open(); // disabled: refused
  assert.equal(overlays(f).length, 0);
  f.settings.set(true);
  app.open();
  const iframe = frameOf(f);
  f.settings.set(false);
  iframe.contentWindow = {location: {href: 'https://instance.example/welcome.do'}};
  iframe.listeners.load(); // the user submitted; the native form navigated away
  assert.equal(overlays(f).length, 0);
});

test('re-enable while a form is retained keeps the same overlay and restores the launch button once', () => {
  const f = fixture();
  const app = f.load();
  app.open();
  const overlay = f.doc.querySelector('#sn-timecard-overlay');
  f.settings.set(false);
  f.settings.set(true);
  assert.equal(f.doc.querySelector('#sn-timecard-overlay'), overlay);
  assert.equal(overlays(f).length, 1);
  assert.equal(addButtons(f).length, 1);
  assert.equal(f.timers.size, 1);
  assert.equal(app.status().retained, false);
  assert.equal(app.status().note, null);
});

test('reinjection while a dirty form is open keeps the controller and draft (enabled and disabled-retained)', () => {
  const f = fixture();
  const first = f.load();
  first.open();
  frameOf(f).contentWindow = {g_form: {modified: true}, location: {href: 'x'}};
  const overlay = f.doc.querySelector('#sn-timecard-overlay');
  assert.equal(f.load(), first);
  assert.equal(overlay.isConnected, true);
  f.settings.set(false);
  assert.equal(f.load(), first, 'reinjection while disabled+retained also keeps it');
  assert.equal(overlays(f).length, 1);
  assert.equal(f.settings.subscribers(), 1, 'still subscribed exactly once');
  f.settings.set(true);
  assert.equal(addButtons(f).length, 1, 'the retained controller still follows settings');
});

test('reinjection without an open form replaces the controller and its settings subscription; disabled stays inert', () => {
  const f = fixture();
  const first = f.load();
  f.settings.set(false);
  const second = f.load();
  assert.notEqual(second, first);
  assert.equal(f.settings.subscribers(), 1, 'old subscription removed');
  assert.equal(addButtons(f).length, 0);
  assert.equal(f.timers.size, 0);
  f.settings.set(true);
  assert.equal(addButtons(f).length, 1);
  assert.equal(f.timers.size, 1);
  first.refresh();
  assert.equal(addButtons(f).length, 1, 'the stopped instance does nothing');
});

test('stop() fully tears down (reinjection path only): unsubscribes, clears timers; later settings are ignored', () => {
  const f = fixture();
  const app = f.load();
  app.stop();
  assert.equal(f.settings.subscribers(), 0);
  assert.equal(f.timers.size, 0);
  f.settings.set(true);
  assert.equal(addButtons(f).length, 0);
});

test('a stale settings callback (e.g. adopted by a reinjected helper) cannot revive a stopped instance', () => {
  const f = fixture();
  let cb;
  f.window.__snMiloMainSettings.subscribe = (feature, fn) => { cb = fn; return () => {}; }; // helper that cannot unsubscribe
  const app = f.load();
  cb({enabled: true, seedOnly: false});
  assert.equal(addButtons(f).length, 1);
  app.stop();
  cb({enabled: true, seedOnly: false});
  assert.equal(addButtons(f).length, 0);
  assert.equal(f.timers.size, 0);
});

test('content.js has no extension API bindings and only talks to the MAIN settings helper', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../features/timecard/content.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bchrome\s*\./);
  assert.doesNotMatch(src, /\b(?:browser|chrome)\.(?:runtime|storage|tabs|scripting|alarms|notifications)\b/);
  assert.doesNotMatch(src, /\bbrowser\s*\.\s*\w+\s*\.\s*\w+\(/);
  assert.match(src, /__snMiloMainSettings/);
});

test('reinjection re-attaches the gsft_main load watcher under a per-controller token; the old listener is inert', () => {
  const f = fixture();
  const iframe = f.doc.createElement('iframe');
  iframe.setAttribute('id', 'gsft_main');
  iframe.contentDocument = f.doc;
  const handlers = [];
  iframe.addEventListener = (type, cb) => { if (type === 'load') handlers.push(cb); };
  f.doc.body.append(iframe);
  const first = f.load();
  assert.equal(handlers.length, 1, 'first controller attaches once');
  first.refresh();
  assert.equal(handlers.length, 1, 'same controller never double-attaches');
  const second = f.load();
  assert.notEqual(second, first);
  second.refresh();
  assert.equal(handlers.length, 2, 'the new controller re-attaches after reinjection');
  second.refresh();
  assert.equal(handlers.length, 2, 'and only once');
  let before = f.timers.size;
  handlers[0]();
  assert.equal(f.timers.size, before, 'old listener no-ops');
  handlers[1]();
  assert.equal(f.timers.size, before + 1, 'new listener schedules exactly one re-mount');
  handlers[1]();
  assert.equal(f.timers.size, before + 1, 'coalesced');
});
