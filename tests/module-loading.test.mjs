// Exercise the ACTUAL worker's complete native ESM graph. No source rewriting/stripping imports, VM parsing or
// handler mocks can hide link/parse/evaluation failures: a broken imported feature prevents ALL worker setup.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {PACKAGE_FILES} from '../scripts/package.mjs';
import {ensureGenerated, OUTPUT_FILES} from '../scripts/generate-config.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'milo-esm-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const rel of [...PACKAGE_FILES.filter(f => !OUTPUT_FILES.includes(f)), 'manifest.template.json', 'package.json']) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), {recursive: true});
    fs.copyFileSync(path.join(repo, rel), path.join(root, rel));
  }
  fs.copyFileSync(path.join(repo, 'config.example.json'), path.join(root, 'config.json'));
  ensureGenerated({root});
  return root;
}
function load(root) {
  const helper = pathToFileURL(path.join(repo, 'tests/helpers/fake-chrome.mjs')).href;
  const entry = pathToFileURL(path.join(root, 'background.js')).href;
  const script = `import {createFakeChrome} from ${JSON.stringify(helper)};
    const fake = createFakeChrome(); globalThis.chrome = fake.chrome;
    let error = null, ready = false;
    try { await import(${JSON.stringify(entry)}); ready = (await snMilo.status()).ready; }
    catch(e) { error = {name:e.name, code:e.code, message:e.message}; }
    console.log(JSON.stringify({error, ready, app:typeof globalThis.snMilo,
      listeners:chrome.runtime.onMessage.listeners.length, access:fake.storage.ctl.accessLevelCalls.length}));`;
  const child = spawnSync(process.execPath, ['--import', path.join(repo, 'tests/setup/no-network.mjs'), '--input-type=module', '-e', script], {encoding: 'utf8', timeout: 10000});
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim().split('\n').at(-1));
}
test('actual worker ESM graph imports, registers listeners and reaches readiness', t => {
  const result = load(tree(t));
  assert.equal(result.error, null);
  assert.equal(result.ready, true);
  assert.equal(result.app, 'object');
  assert.equal(result.listeners, 1);
  assert.equal(result.access, 1);
});
for (const [kind, mutation, expected] of [
  ['missing import', "\nimport './deliberately-missing-module.mjs';\n", r => r.code === 'ERR_MODULE_NOT_FOUND'],
  ['syntax error', '\nexport const deliberateSyntaxFailure = ;\n', r => r.name === 'SyntaxError'],
  ['evaluation error', "\nthrow new Error('deliberate feature evaluation failure');\n", r => r.message === 'deliberate feature evaluation failure']
]) {
  test(`${kind} in an imported feature prevents extension-wide worker setup (not caught by handler guards)`, t => {
    const root = tree(t);
    fs.appendFileSync(path.join(root, 'features/interaction-alert/background.mjs'), mutation);
    const result = load(root);
    assert.ok(result.error && expected(result.error), JSON.stringify(result));
    assert.equal(result.ready, false);
    assert.equal(result.app, 'undefined');
    assert.equal(result.listeners, 0, 'no worker router or healthy-feature handlers were registered');
    assert.equal(result.access, 0, 'even the worker install never executed');
  });
}
