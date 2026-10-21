// Regression tests for scripts/generate-config.mjs. All inputs are sanitized temporary copies.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  generate, check, ensureGenerated, withGeneratedArtifacts, OUTPUT_FILES, GenerationError
} from '../scripts/generate-config.mjs';
import {SCRIPT_POLICY} from '../shared/script-policy.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts', 'generate-config.mjs');
const repoTemplate = JSON.parse(fs.readFileSync(path.join(repo, 'manifest.template.json'), 'utf8'));
const repoPackage = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));

const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, {recursive: true, force: true}); });
const PROD = 'https://example.service-now.com';
const TEST = 'https://exampletest.service-now.com';
const sampleConfig = (prod = PROD, testOrigin = TEST) => ({instances: [
  {origin: testOrigin, mode: 'test', enableSubmission: true},
  {origin: prod, mode: 'production', enableSubmission: true}
]});

function makeRoot({template = repoTemplate, packageVersion = repoPackage.version, config = sampleConfig()} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sn_milo-gen-test-'));
  fs.writeFileSync(path.join(root, 'manifest.template.json'), JSON.stringify(template, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'x', version: packageVersion}, null, 2) + '\n');
  if (config !== null) fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  roots.push(root);
  return root;
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const snapshot = root => Object.fromEntries(OUTPUT_FILES.map(rel => [rel, exists(root, rel) ? read(root, rel) : null]));
function walk(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
const tempLeftovers = root => walk(root).filter(f => f.includes('.gen-tmp-'));
const loadTimecardConfig = source => { const ctx = {}; vm.runInNewContext(source, ctx); return JSON.parse(JSON.stringify(ctx.SnTimecardConfig)); };
const originOfPattern = p => { const m = /^(https:\/\/[^/]+)\//.exec(p); assert.ok(m, `pattern ${p} must be an https origin pattern`); return m[1]; };
function allMatchPatterns(manifest) {
  return [
    ...(manifest.host_permissions || []),
    ...(manifest.content_scripts || []).flatMap(cs => [...(cs.matches || []), ...(cs.exclude_matches || [])]),
    ...(manifest.web_accessible_resources || []).flatMap(r => r.matches || [])
  ];
}
// content_scripts come from shared/script-policy.mjs; tests pass a sanitized policy with feature-shaped entries.
const contentScriptPolicy = [
  {id: 'kb', feature: 'kb-dark', origins: ['production'], paths: ['/kb', '/kb?*'], world: 'ISOLATED', run_at: 'document_start', all_frames: false, css: ['features/kb-dark/dark.css']},
  {id: 'tc-native', feature: 'timecard', origins: ['test', 'production'], paths: ['/task_time_worked.do*'], world: 'MAIN', run_at: 'document_start', all_frames: true, js: ['features/timecard/config.js']}
];

test('committed template and package versions agree and the template has no literal hosts', () => {
  assert.match(repoTemplate.version, /^\d+\.\d+\.\d+$/);
  assert.equal(repoPackage.version, repoTemplate.version);
  assert.doesNotMatch(fs.readFileSync(path.join(repo, 'manifest.template.json'), 'utf8'), /service-now\.com/);
  assert.equal(repoTemplate.manifest_version, 3);
  // storage.local.setAccessLevel needs Chrome 102; manifest content_scripts `world: 'MAIN'` needs Chrome 111
  assert.equal(repoTemplate.minimum_chrome_version, '111');
  assert.deepEqual(repoTemplate.permissions, ['alarms', 'notifications', 'scripting', 'storage', 'tabs']);
  assert.deepEqual(repoTemplate.background, {service_worker: 'background.js', type: 'module'});
  assert.equal(repoTemplate.options_ui.page, 'options.html');
  assert.equal(repoTemplate.content_scripts, undefined, 'content_scripts are generated from shared/script-policy.mjs');
});

test('generates manifest, timecard config and origins module from config.json', () => {
  const root = makeRoot();
  const result = generate({root});
  assert.deepEqual([...result.written].sort(), [...OUTPUT_FILES].sort());
  const manifest = JSON.parse(read(root, 'manifest.json'));
  assert.equal(manifest.version, repoTemplate.version);
  assert.equal(manifest.minimum_chrome_version, '111');
  assert.deepEqual(manifest.host_permissions, [`${PROD}/*`, `${TEST}/*`]);
  assert.equal(JSON.stringify(manifest).includes('{{'), false);
  assert.deepEqual(loadTimecardConfig(read(root, 'features/timecard/config.js')), sampleConfig());
  const origins = read(root, 'shared/origins.generated.mjs');
  assert.match(origins, new RegExp(`PRODUCTION_ORIGIN = '${PROD}'`));
  assert.match(origins, new RegExp(`TEST_ORIGIN = '${TEST}'`));
  assert.equal(check({root}).ok, true);
  assert.deepEqual(tempLeftovers(root), []);
});

test('generated timecard config.js has the exact source shape (matches committed example)', () => {
  const root = makeRoot({config: JSON.parse(fs.readFileSync(path.join(repo, 'config.example.json'), 'utf8'))});
  generate({root});
  assert.equal(read(root, 'features/timecard/config.js'), fs.readFileSync(path.join(repo, 'features/timecard/config.example.js'), 'utf8'));
  assert.equal(read(root, 'features/timecard/config.js'),
    "// Local instance configuration. No credentials are stored here.\n" +
    "globalThis.SnTimecardConfig = {\n  instances: [\n" +
    "    {origin: 'https://exampletest.service-now.com', mode: 'test', enableSubmission: true},\n" +
    "    {origin: 'https://example.service-now.com', mode: 'production', enableSubmission: true}\n" +
    "  ]\n};\n");
});

test('configured origins agree exactly with manifest host grants and every match pattern', () => {
  const root = makeRoot();
  generate({root, policy: contentScriptPolicy});
  const manifest = JSON.parse(read(root, 'manifest.json'));
  const configured = new Set(sampleConfig().instances.map(i => i.origin));
  assert.deepEqual(new Set(manifest.host_permissions.map(originOfPattern)), configured);
  assert.equal(manifest.host_permissions.length, configured.size);
  for (const pattern of allMatchPatterns(manifest)) assert.ok(configured.has(originOfPattern(pattern)), pattern);
  assert.deepEqual(manifest.content_scripts[0].matches, [`${PROD}/kb`, `${PROD}/kb?*`]);
  assert.deepEqual(manifest.content_scripts[1].matches, [`${TEST}/task_time_worked.do*`, `${PROD}/task_time_worked.do*`]);
  const timecardOrigins = new Set(loadTimecardConfig(read(root, 'features/timecard/config.js')).instances.map(i => i.origin));
  assert.deepEqual(timecardOrigins, configured);
});

test('template with a hard-coded host, an unknown placeholder or extra host grant is rejected', () => {
  const hardcoded = {...structuredClone(repoTemplate), content_scripts: [{matches: ['https://other.service-now.com/*'], js: ['a.js']}]};
  assert.throws(() => generate({root: makeRoot({template: hardcoded})}), /hard-coded host|placeholder/i);
  const unknown = {...structuredClone(repoTemplate), host_permissions: ['{{PRODUCTION_ORIGIN}}/*', '{{TEST_ORIGIN}}/*', '{{OTHER}}/*']};
  assert.throws(() => generate({root: makeRoot({template: unknown})}), /unknown placeholder.*OTHER/i);
  const missingGrant = {...structuredClone(repoTemplate), host_permissions: ['{{PRODUCTION_ORIGIN}}/*']};
  assert.throws(() => generate({root: makeRoot({template: missingGrant})}), /host_permissions/);
  const wideGrant = {...structuredClone(repoTemplate), host_permissions: ['{{PRODUCTION_ORIGIN}}/*', '{{TEST_ORIGIN}}/*', '<all_urls>']};
  assert.throws(() => generate({root: makeRoot({template: wideGrant})}), /host_permissions/);
});

test('version mismatch between template and package.json fails and is never silently corrected', () => {
  const root = makeRoot();
  generate({root});
  const before = snapshot(root);
  const tpl = {...structuredClone(repoTemplate), version: '99.0.0'};
  fs.writeFileSync(path.join(root, 'manifest.template.json'), JSON.stringify(tpl, null, 2) + '\n');
  const pkgBefore = read(root, 'package.json');
  const tplBefore = read(root, 'manifest.template.json');
  assert.throws(() => generate({root}), /version mismatch.*99\.0\.0/i);
  assert.equal(check({root}).ok, false);
  assert.deepEqual(snapshot(root), before, 'no output replaced');
  assert.equal(read(root, 'package.json'), pkgBefore);
  assert.equal(read(root, 'manifest.template.json'), tplBefore);
  const fresh = makeRoot({packageVersion: '0.9.0'});
  assert.throws(() => generate({root: fresh}), /version mismatch/i);
  for (const rel of OUTPUT_FILES) assert.equal(exists(fresh, rel), false, `${rel} must not be written`);
  assert.deepEqual(tempLeftovers(fresh), []);
});

test('missing config.json fails generate and check without writing anything', () => {
  const root = makeRoot({config: null});
  assert.throws(() => generate({root}), /config\.json/);
  const r = check({root});
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /config\.json/);
  for (const rel of OUTPUT_FILES) assert.equal(exists(root, rel), false);
});

test('invalid configs are rejected', () => {
  const bad = [
    {instances: [{origin: 'http://example.service-now.com', mode: 'production', enableSubmission: true}, {origin: TEST, mode: 'test', enableSubmission: true}]},
    {instances: [{origin: `${PROD}/path`, mode: 'production', enableSubmission: true}, {origin: TEST, mode: 'test', enableSubmission: true}]},
    {instances: [{origin: 'https://example.com', mode: 'production', enableSubmission: true}, {origin: TEST, mode: 'test', enableSubmission: true}]},
    {instances: [{origin: TEST, mode: 'test', enableSubmission: true}]},
    {instances: [{origin: PROD, mode: 'production', enableSubmission: true}, {origin: PROD, mode: 'test', enableSubmission: true}]},
    {instances: [{origin: PROD, mode: 'production', enableSubmission: 'yes'}, {origin: TEST, mode: 'test', enableSubmission: true}]},
    {instances: [{origin: PROD, mode: 'staging', enableSubmission: true}, {origin: TEST, mode: 'test', enableSubmission: true}]},
    {instances: [{origin: PROD, mode: 'production', enableSubmission: true, extra: 1}, {origin: TEST, mode: 'test', enableSubmission: true}]},
    {instances: [], other: true},
    []
  ];
  for (const config of bad) assert.throws(() => generate({root: makeRoot({config})}), GenerationError, JSON.stringify(config));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sn_milo-gen-test-'));
  fs.writeFileSync(path.join(root, 'manifest.template.json'), JSON.stringify(repoTemplate));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({version: repoTemplate.version}));
  fs.writeFileSync(path.join(root, 'config.json'), '{not json');
  assert.throws(() => generate({root}), /config\.json/);
  fs.rmSync(root, {recursive: true, force: true});
});

test('changed hosts make every artifact stale until regenerated', () => {
  const root = makeRoot();
  generate({root});
  const NEW_PROD = 'https://changed.service-now.com';
  const NEW_TEST = 'https://changedtest.service-now.com';
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(sampleConfig(NEW_PROD, NEW_TEST)));
  const stale = check({root});
  assert.equal(stale.ok, false);
  for (const rel of OUTPUT_FILES) assert.match(stale.problems.join('\n'), new RegExp(`stale: ${rel.replace('.', '\\.')}`));
  generate({root});
  assert.equal(check({root}).ok, true);
  const all = OUTPUT_FILES.map(rel => read(root, rel)).join('\n');
  assert.equal(all.includes(PROD), false);
  assert.equal(all.includes(TEST), false);
  assert.deepEqual(JSON.parse(read(root, 'manifest.json')).host_permissions, [`${NEW_PROD}/*`, `${NEW_TEST}/*`]);
});

test('--check detects stale and missing output without writing', () => {
  const root = makeRoot();
  generate({root});
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, read(root, 'manifest.json').replace(JSON.stringify(repoTemplate.version), '"9.9.9"'));
  const tampered = read(root, 'manifest.json');
  const mtime = fs.statSync(manifestPath).mtimeMs;
  fs.rmSync(path.join(root, 'features/timecard/config.js'));
  const r = check({root});
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /stale: manifest\.json/);
  assert.match(r.problems.join('\n'), /missing: features\/timecard\/config\.js/);
  assert.equal(read(root, 'manifest.json'), tampered);
  assert.equal(fs.statSync(manifestPath).mtimeMs, mtime);
  assert.equal(exists(root, 'features/timecard/config.js'), false);
  const cli = spawnSync(process.execPath, [script, '--check', '--root', root], {encoding: 'utf8'});
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /stale: manifest\.json/);
  assert.equal(read(root, 'manifest.json'), tampered);
  assert.equal(exists(root, 'features/timecard/config.js'), false);
});

test('regeneration is deterministic and idempotent', () => {
  const a = makeRoot();
  const b = makeRoot();
  generate({root: a});
  const first = snapshot(a);
  const second = generate({root: a});
  assert.deepEqual(second.written, [], 'unchanged artifacts are not rewritten');
  assert.deepEqual(snapshot(a), first);
  generate({root: b});
  assert.deepEqual(snapshot(b), first);
  const cli = spawnSync(process.execPath, [script, '--root', a], {encoding: 'utf8'});
  assert.equal(cli.status, 0, cli.stderr);
  const cliCheck = spawnSync(process.execPath, [script, '--check', '--root', a], {encoding: 'utf8'});
  assert.equal(cliCheck.status, 0, cliCheck.stderr);
  assert.deepEqual(snapshot(a), first);
});

test('generation failure prevents every browser call', async () => {
  const calls = [];
  const browser = {loadUnpacked: p => calls.push(['loadUnpacked', p]), reload: () => calls.push(['reload']), executeScript: () => calls.push(['executeScript'])};
  const failing = [
    makeRoot({config: null}),
    makeRoot({packageVersion: '2.0.0'}),
    makeRoot({config: {instances: [{origin: TEST, mode: 'test', enableSubmission: true}]}}),
    makeRoot({template: {...structuredClone(repoTemplate), host_permissions: ['https://other.service-now.com/*']}})
  ];
  for (const root of failing) {
    assert.throws(() => ensureGenerated({root}), GenerationError);
    await assert.rejects(withGeneratedArtifacts({root}, async () => {
      browser.loadUnpacked(root); browser.reload(); browser.executeScript();
    }), GenerationError);
  }
  assert.deepEqual(calls, []);
  const ok = makeRoot();
  const seen = await withGeneratedArtifacts({root: ok}, async info => {
    assert.equal(check({root: ok}).ok, true, 'artifacts are fresh before the browser call');
    browser.loadUnpacked(ok);
    return info;
  });
  assert.equal(seen.version, repoTemplate.version);
  assert.deepEqual(calls, [['loadUnpacked', ok]]);
});

test('policy-generated content_scripts are part of the generated manifest; an invalid policy writes nothing', () => {
  const root = makeRoot();
  generate({root});
  const manifest = JSON.parse(read(root, 'manifest.json'));
  assert.equal(manifest.content_scripts.length, SCRIPT_POLICY.length);
  for (const pattern of allMatchPatterns(manifest)) assert.ok([PROD, TEST].includes(originOfPattern(pattern)), pattern);
  const fresh = makeRoot();
  const bad = [{...contentScriptPolicy[0], paths: ['/kb*']}];
  assert.throws(() => generate({root: fresh, policy: bad}), /kb-dark paths/);
  for (const rel of OUTPUT_FILES) assert.equal(exists(fresh, rel), false, `${rel} must not be written`);
  const tpl = makeRoot({template: {...structuredClone(repoTemplate), content_scripts: [{matches: ['{{PRODUCTION_ORIGIN}}/*'], js: ['a.js']}]}});
  assert.throws(() => generate({root: tpl}), /must not define content_scripts/);
});

test('a write or rename failure mid-set propagates, restores the previous set and keeps the gate closed', async t => {
  const {mock} = t;
  const NEW_PROD = 'https://changed.service-now.com';
  const NEW_TEST = 'https://changedtest.service-now.com';
  for (const op of ['writeFileSync', 'renameSync']) {
    const root = makeRoot();
    generate({root});
    const before = snapshot(root);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(sampleConfig(NEW_PROD, NEW_TEST)));
    const real = fs[op];
    let n = 0;
    const injected = mock.method(fs, op, function (...args) {
      if (String(args[0]).includes('.gen-tmp-') && ++n === 2) throw Object.assign(new Error(`injected ${op} failure`), {code: 'EIO'});
      return real.apply(this, args);
    });
    try {
      assert.throws(() => generate({root}), new RegExp(`injected ${op} failure`), `${op}: error propagates`);
      assert.equal(n, 2, `${op}: failure hit the second file of the set`);
      assert.deepEqual(snapshot(root), before, `${op}: previous artifact set restored (never a mixed set)`);
      assert.deepEqual(walk(root).filter(f => f.includes('.gen-tmp-')), [], `${op}: no temp files left behind`);
      n = 0;
      const calls = [];
      assert.throws(() => ensureGenerated({root}), new RegExp(`injected ${op} failure`));
      n = 0;
      await assert.rejects(withGeneratedArtifacts({root}, async () => { calls.push('browser'); }), new RegExp(`injected ${op} failure`));
      assert.deepEqual(calls, [], `${op}: no browser call after a failed generation`);
    } finally {
      injected.mock.restore();
    }
    const r = check({root});
    assert.equal(r.ok, false, `${op}: --check still fails after the aborted generation`);
    for (const rel of OUTPUT_FILES) assert.match(r.problems.join('\n'), new RegExp(`stale: ${rel.replace('.', '\\.')}`));
    const cli = spawnSync(process.execPath, [script, '--check', '--root', root], {encoding: 'utf8'});
    assert.equal(cli.status, 1);
    generate({root});
    assert.equal(check({root}).ok, true, `${op}: a later successful generation recovers`);
  }
});

test('missing package.json / template: plain "is missing" errors (the copy hint is only for config.json)', () => {
  const root = makeRoot();
  fs.rmSync(path.join(root, 'package.json'));
  const r = check({root});
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes('package.json is missing'), JSON.stringify(r.problems));
  assert.ok(!r.problems.join('\n').includes('copy package.json'));
  const noTemplate = makeRoot();
  fs.rmSync(path.join(noTemplate, 'manifest.template.json'));
  assert.ok(check({root: noTemplate}).problems.includes('manifest.template.json is missing'));
  const noConfig = makeRoot({config: null});
  assert.ok(check({root: noConfig}).problems.includes('config.json is missing (copy config.example.json and edit it)'));
});

test('npm test runs generate:check first (clear failure when generated artifacts are missing/stale)', () => {
  assert.match(repoPackage.scripts.test, /^npm run generate:check && /);
  const root = makeRoot();
  const r = spawnSync(process.execPath, [script, '--check', '--root', root], {encoding: 'utf8'});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing: manifest\.json[\s\S]*Run `npm run generate`/);
});
