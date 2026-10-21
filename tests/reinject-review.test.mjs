import test from 'node:test';
import assert from 'node:assert/strict';
import {reinjectOpenTabs} from '../shared/reinject.mjs';
const P = 'https://prod.service-now.com';
const origins = {production: P, test: 'https://test.service-now.com'};
const policy = [{id: 'frame', feature: 'shared', origins: ['production'], paths: ['/kb', '/kb?*'], world: 'ISOLATED', all_frames: true, js: ['shared/controller.js']}];
function fixture({running = false, hang = false, frames, race = false} = {}) {
 const calls = []; const tabs = [{id: 1, url: `${P}/other`}, {id: 2, url: `${P}/kb`}];
 frames ||= [{frameId: 0, documentId: 'top', result: {href: tabs[0].url, origin: P}}, {frameId: 3, documentId: 'kb', result: {href: `${P}/kb`, origin: P}}, {frameId: 4, documentId: 'blank', result: {href: 'about:blank', origin: P}}, {frameId: 5, documentId: 'src', result: {href: 'about:srcdoc', origin: P}}, {frameId: 6, documentId: 'opaque', result: {href: `${P}/kb`, origin: 'null'}}, {frameId: 7, documentId: 'foreign', result: {href: 'https://foreign.invalid/kb', origin: 'https://foreign.invalid'}}];
 const chrome = {tabs: {query: async () => tabs, get: async id => tabs.find(t => t.id === id)}, scripting: {
 executeScript: async i => { calls.push(i); if (i.func) {
  if (i.target.allFrames) return i.target.tabId === 1 ? frames : [{frameId: 0, documentId: 'two', result: {href: tabs[1].url, origin: P}}];
  if (i.target.frameIds) { assert.equal(i.world, 'ISOLATED'); return [{frameId: 0, documentId: i.target.tabId === 1 ? 'top' : 'two', result: i.args?.[0] === 'acquire' && i.target.tabId === 1 && running ? {ok: false, reason: 'informatica-in-progress'} : {ok: true}}]; }
  const f = frames.find(f => i.target.documentIds.includes(f.documentId)) || {frameId: 0, documentId: 'two', result: {href: tabs[1].url, origin: P}};
  return [{...f, result: race ? {...f.result, href: `${P}/changed`} : f.result}];
 }
 if (hang && i.target.tabId === 1) return new Promise(() => {});
 return [];
 }, insertCSS: async i => calls.push({insert: i}), removeCSS: async i => calls.push({remove: i})}};
 return {chrome, calls};
}
test('running Informatica skips whole tab before mutating injections', async () => {
 const f = fixture({running: true}); const s = await reinjectOpenTabs({...f, origins});
 assert.equal(s.tabs[0].skipped, 'informatica-in-progress');
 assert.equal(f.calls.filter(i => i.target?.tabId === 1 && i.files).length, 0);
 assert.equal(s.tabs[1].ok, true);
});
test('per-frame paths and exact non-opaque origins, never blank/srcdoc; pin document IDs', async () => {
 const f = fixture(); await reinjectOpenTabs({...f, origins, policy});
 assert.deepEqual(f.calls.filter(i => i.files && i.target.tabId === 1).map(i => i.target), [{tabId: 1, documentIds: ['kb']}]);
});
test('navigation race before file injection skips changed document', async () => {
 const f = fixture({race: true}); await reinjectOpenTabs({...f, origins, policy});
 assert.equal(f.calls.filter(i => i.files).length, 0);
});
test('hung executeScript times out tab without retry and continues other tabs', async () => {
 const f = fixture({hang: true}); const s = await reinjectOpenTabs({...f, origins, policy, stepTimeoutMs: 10, tabTimeoutMs: 50});
 assert.equal(s.failed, 1); assert.match(s.tabs[0].errors.join(' '), /timeout.*cannot be cancelled.*not retried/i);
 assert.equal(s.tabs[1].ok, true); assert.equal(s.tabs[1].steps.length, 1);
 assert.equal(f.calls.filter(i => i.files && i.target.tabId === 1).length, 1);
});
test('disabled KB still installs gated CSS: off attribute precedes paired programmatic replacement', async () => {
 const f = fixture(); await reinjectOpenTabs({...f, origins});
 const remove = f.calls.findIndex(i => i.remove); const insert = f.calls.findIndex(i => i.insert);
 assert.ok(remove >= 0 && insert > remove);
 const gate = f.calls.slice(0, remove).find(i => i.func && i.args?.[0] === true);
 assert.ok(gate, 'off gate established before CSS insertion');
 assert.deepEqual(f.calls[remove].remove, f.calls[insert].insert);
});

test('absolute tab budget does not start another operation once exhausted', async t => {
 let now = 1000; t.mock.method(Date, 'now', () => now);
 const f = fixture(); const execute = f.chrome.scripting.executeScript;
 f.chrome.scripting.executeScript = async i => { const r = await execute(i); if (i.files) now += 100; return r; };
 const s = await reinjectOpenTabs({...f, origins, policy: [policy[0], {...policy[0], id: 'second'}], stepTimeoutMs: 1000, tabTimeoutMs: 50});
 assert.equal(s.failed, 2);
 assert.equal(f.calls.filter(i => i.files && i.target.tabId === 1).length, 1, 'no second operation starts after tab deadline');
});
