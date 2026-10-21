import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {ensureGenerated} from '../scripts/generate-config.mjs';
import {packageExtension, PACKAGE_FILES} from '../scripts/package.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'milo-package-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const rel of ['manifest.template.json', 'package.json', 'config.example.json', 'background.js', 'options.html', 'options.js', 'icons', 'features', 'shared']) {
    fs.cpSync(path.join(repo, rel), path.join(root, rel), {recursive: true});
  }
  fs.copyFileSync(path.join(root, 'config.example.json'), path.join(root, 'config.json'));
  return root;
}
function unzip(file) {
  const p = spawnSync('python3', ['-c', 'import zipfile,json,sys,base64; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({n:base64.b64encode(z.read(n)).decode() for n in z.namelist()}))', file], {encoding: 'utf8'});
  assert.equal(p.status, 0, p.stderr);
  return Object.fromEntries(Object.entries(JSON.parse(p.stdout)).map(([n, b]) => [n, Buffer.from(b, 'base64')]));
}
test('package is deterministic, runtime-complete, private and excludes source config/tests/dumps', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'tests/private-fixtures'), {recursive: true});
  fs.writeFileSync(path.join(root, 'tests/private-fixtures/private.txt'), 'SECRET_CANARY');
  fs.writeFileSync(path.join(root, 'features/timecard/dump.json'), 'SECRET_CANARY');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET_CANARY');
  const info = packageExtension({root});
  const first = fs.readFileSync(info.archive);
  const entries = unzip(info.archive);
  assert.deepEqual(Object.keys(entries), [...PACKAGE_FILES].sort());
  for (const name of ['manifest.json', 'features/timecard/config.js', 'shared/origins.generated.mjs', 'shared/router.mjs', 'shared/reinject.mjs', 'shared/options-view.mjs', 'shared/rules.mjs', 'shared/user-lists.mjs', 'features/critical-alert/icons/alert.png', 'features/interaction-alert/icons/alert.png']) assert.ok(entries[name], name);
  assert.ok(!Object.keys(entries).some(n => /(^tests\/|test\.cjs$|config\.json$|example|dump|\.env)/.test(n)));
  assert.ok(!first.includes(Buffer.from('SECRET_CANARY')));
  const manifest = JSON.parse(entries['manifest.json']);
  for (const cs of manifest.content_scripts) for (const rel of [...(cs.js || []), ...(cs.css || [])]) assert.ok(entries[rel], rel);
  assert.ok(entries[manifest.background.service_worker]);
  assert.ok(entries[manifest.options_ui.page]);
  // Every local static ESM dependency in packaged worker/options/shared modules resolves inside the zip.
  for (const [name, data] of Object.entries(entries).filter(([n]) => /\.(m?js)$/.test(n))) {
    for (const m of data.toString().matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      assert.ok(entries[path.posix.normalize(path.posix.join(path.posix.dirname(name), m[1]))], `${name} -> ${m[1]}`);
    }
  }
  assert.match(entries['features/timecard/config.js'].toString(), /service-now\.com/);
  assert.equal(fs.statSync(info.archive).mode & 0o777, 0o600);
  fs.utimesSync(path.join(root, 'background.js'), new Date(), new Date());
  packageExtension({root});
  assert.deepEqual(fs.readFileSync(info.archive), first);
});
test('invalid generation blocks all archive writes, including replacement of an existing archive', t => {
  const root = fixture(t);
  const dir = path.join(root, 'dist');
  fs.mkdirSync(dir);
  const target = path.join(dir, 'sn_milo-1.0.0-private.zip');
  fs.writeFileSync(target, 'previous-private-artifact');
  fs.writeFileSync(path.join(root, 'config.json'), '{broken');
  assert.throws(() => packageExtension({root}), /generation failed/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'previous-private-artifact');
  assert.deepEqual(fs.readdirSync(dir), ['sn_milo-1.0.0-private.zip']);
  fs.rmSync(dir, {recursive: true});
  assert.throws(() => packageExtension({root}), /generation failed/);
  assert.equal(fs.existsSync(dir), false);
});
test('freshness check failure after generation prevents archive writes', t => {
  const root = fixture(t);
  ensureGenerated({root});
  const read = fs.readFileSync;
  let manifestReads = 0;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    // generate sees a fresh existing artifact; a concurrent edit makes check see stale bytes.
    if (file === path.join(root, 'manifest.json') && ++manifestReads === 2) return '{}';
    return read.call(this, file, ...args);
  });
  assert.throws(() => packageExtension({root}), /stale: manifest.json/);
  assert.equal(fs.existsSync(path.join(root, 'dist')), false);
});

test('missing runtime assets abort before creating an archive', t => {
  const root = fixture(t);
  fs.rmSync(path.join(root, 'features/critical-alert/icons/alert.png'));
  assert.throws(() => packageExtension({root}), /alert\.png/);
  assert.equal(fs.existsSync(path.join(root, 'dist')), false);
});
