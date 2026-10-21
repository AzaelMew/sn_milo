// User-supplied lists (shared/user-lists.mjs): validation, normalization, and the worker paths that serve them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAccounts, validateRecipients, normalizeAccounts, normalizeRecipients, MAX_ACCOUNTS, MAX_RECIPIENTS} from '../shared/user-lists.mjs';
import {createMiloBackground} from '../shared/router.mjs';
import {createFakeChrome, createFakeStorage, deliver, contentSender, ORIGINS, PROD} from './helpers/fake-chrome.mjs';
import {createInteractionAlert} from '../features/interaction-alert/background.mjs';

test('accounts: trimmed, blank lines dropped, case-insensitive duplicates merged, injection refused', () => {
  assert.deepEqual(validateAccounts([' Acme Oy ', '', 'acme oy', 'Beta Oyj']), {ok: true, accounts: ['Acme Oy', 'Beta Oyj']});
  assert.equal(validateAccounts(['a^ORactive=false']).ok, false);
  assert.equal(validateAccounts(['x'.repeat(101)]).ok, false);
  assert.equal(validateAccounts(Array.from({length: MAX_ACCOUNTS + 1}, (_, i) => `a${i}`)).ok, false);
  assert.equal(validateAccounts('x').ok, false);
  assert.equal(validateAccounts([1]).ok, false);
});

test('recipients: lower-cased, validated, capped', () => {
  assert.deepEqual(validateRecipients(['  Alice@Example.com', 'alice@example.com', '']), {ok: true, emails: ['alice@example.com']});
  for (const bad of ['alice', 'a@b', 'a b@c.com', 'a@b.com,c@d.com', 'a^@b.com']) assert.equal(validateRecipients([bad]).ok, false, bad);
  assert.equal(validateRecipients(Array.from({length: MAX_RECIPIENTS + 1}, (_, i) => `a${i}@example.com`)).ok, false);
});

test('normalize: nothing stored ⇒ empty; malformed ⇒ empty with an error; valid passes', () => {
  assert.deepEqual(normalizeAccounts(undefined), {accounts: []});
  assert.match(normalizeAccounts('x').error, /malformed/);
  assert.match(normalizeAccounts({schema: 1, accounts: ['a^b']}).error, /ignored/);
  assert.deepEqual(normalizeAccounts({schema: 1, accounts: ['Acme Oy']}), {accounts: ['Acme Oy']});
  assert.deepEqual(normalizeRecipients({schema: 1, emails: ['a@b.co']}), {emails: ['a@b.co']});
});

test('worker: get-accounts serves the stored accounts (empty by default); Informatica refuses to start without recipients', async () => {
  const storage = createFakeStorage({'ix.migrationV1': {schema: 1, state: 'ready', method: 'import', decidedAt: 1, completedAt: 1, importedEntries: 0, lastImportAt: 1}});
  const {chrome} = createFakeChrome({storage});
  const app = createMiloBackground({chrome, origins: ORIGINS, features: [createInteractionAlert({console: {log() {}, info() {}, warn() {}, error() {}}})], log: {warn() {}}});
  app.install();
  await app.ensureReady();
  const sender = contentSender(PROD, {id: chrome.runtime.id, path: '/x'});
  const ask = async () => (await deliver(chrome, {feature: 'interaction-alert', type: 'get-accounts'}, sender)).response;
  assert.deepEqual(await ask(), {ok: true, accounts: []});
  storage.put('ix.accountsV1', {schema: 1, accounts: ['Acme Oy']});
  assert.deepEqual(await ask(), {ok: true, accounts: ['Acme Oy']});

  const inf = {id: chrome.runtime.id, tab: {id: 1, url: `${PROD}/now/record`}, url: `${PROD}/now/record`, origin: PROD, documentId: 'd', frameId: 0, documentLifecycle: 'active'};
  const run = () => new Promise(resolve => app.onMessage({feature: 'milo', type: 'informatica-run-start', lease: crypto.randomUUID()}, inf, resolve));
  const none = await run();
  assert.equal(none.ok, false);
  assert.match(none.error, /informatica-no-recipients/);
  assert.equal(storage.dump().miloInformaticaGateV1, undefined, 'no lease was taken');
  storage.put('inf.recipientsV1', {schema: 1, emails: ['alice@example.com']});
  const ok = await run();
  assert.deepEqual([ok.ok, ok.emails], [true, ['alice@example.com']]);
});
