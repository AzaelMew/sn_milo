// shared/script-policy.mjs is the single declarative source of manifest content_scripts. The generator emits them;
// these tests assert exact agreement with the generated manifest, the feature origin policy and the KB / test-host
// rules, and that the policy validator rejects violations.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SCRIPT_POLICY, buildContentScripts, validatePolicy, KB_PATHS} from '../shared/script-policy.mjs';
import {FEATURES} from '../shared/features.mjs';
import {computeOutputs, generate} from '../scripts/generate-config.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD = 'https://example.service-now.com';
const TEST = 'https://exampletest.service-now.com';
const origins = {production: PROD, test: TEST};
const entry = over => ({id: 'x', feature: 'timecard', origins: ['production'], paths: ['/*'], world: 'MAIN', run_at: 'document_idle', all_frames: false, js: ['features/timecard/content.js'], ...over});

test('policy is valid and frozen; controller + MAIN helper entries exist exactly as specified', () => {
  assert.deepEqual(validatePolicy(SCRIPT_POLICY), []);
  assert.ok(Object.isFrozen(SCRIPT_POLICY) && SCRIPT_POLICY.every(Object.isFrozen));
  const byId = Object.fromEntries(SCRIPT_POLICY.map(e => [e.id, e]));
  assert.deepEqual({...byId['settings-controller'], origins: [...byId['settings-controller'].origins], paths: [...byId['settings-controller'].paths], js: [...byId['settings-controller'].js]}, {
    id: 'settings-controller', feature: 'shared', origins: ['production', 'test'], paths: ['/*'], world: 'ISOLATED',
    run_at: 'document_start', all_frames: true, js: ['shared/controller.js']
  });
  assert.equal(byId['main-settings'].world, 'MAIN');
  assert.deepEqual([...byId['main-settings'].js], ['shared/main-settings.js']);
  assert.equal(byId['main-settings'].all_frames, true);
  assert.ok(SCRIPT_POLICY.indexOf(byId['main-settings']) < SCRIPT_POLICY.findIndex(e => e.world === 'MAIN' && e.feature !== 'shared') || !SCRIPT_POLICY.some(e => e.world === 'MAIN' && e.feature !== 'shared'),
    'MAIN helper precedes MAIN feature entries');
  assert.deepEqual([...KB_PATHS], ['/kb', '/kb?*']);
});

test('every policy file exists in the repo', () => {
  for (const e of SCRIPT_POLICY) for (const f of [...(e.js || []), ...(e.css || [])]) assert.ok(fs.existsSync(path.join(repo, f)), f);
});

test('generated manifest content_scripts agree exactly with the policy (repo generated manifest + temp generation)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sn_milo-policy-'));
  try {
    fs.copyFileSync(path.join(repo, 'manifest.template.json'), path.join(tmp, 'manifest.template.json'));
    fs.copyFileSync(path.join(repo, 'package.json'), path.join(tmp, 'package.json'));
    fs.copyFileSync(path.join(repo, 'config.example.json'), path.join(tmp, 'config.json'));
    generate({root: tmp});
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.content_scripts, buildContentScripts(origins));
    assert.equal(manifest.content_scripts.length, SCRIPT_POLICY.length);
    manifest.content_scripts.forEach((cs, i) => {
      const e = SCRIPT_POLICY[i];
      assert.deepEqual(cs.matches, e.origins.flatMap(role => e.paths.map(p => `${origins[role]}${p}`)));
      assert.equal(cs.world, e.world);
      assert.equal(cs.run_at, e.run_at);
      assert.equal(cs.all_frames, e.all_frames);
      assert.deepEqual(cs.js || [], [...(e.js || [])]);
    });
  } finally { fs.rmSync(tmp, {recursive: true, force: true}); }
  const local = path.join(repo, 'manifest.json');
  if (fs.existsSync(local)) {
    const manifest = JSON.parse(fs.readFileSync(local, 'utf8'));
    const real = computeOutputs({root: repo}).origins;
    assert.deepEqual(manifest.content_scripts, buildContentScripts(real), 'local generated manifest is fresh and policy-exact');
  }
});

test('template may not define content_scripts: the policy owns them', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sn_milo-policy-'));
  try {
    const tpl = JSON.parse(fs.readFileSync(path.join(repo, 'manifest.template.json'), 'utf8'));
    tpl.content_scripts = [{matches: ['{{PRODUCTION_ORIGIN}}/*'], js: ['x.js']}];
    fs.writeFileSync(path.join(tmp, 'manifest.template.json'), JSON.stringify(tpl));
    fs.copyFileSync(path.join(repo, 'package.json'), path.join(tmp, 'package.json'));
    fs.copyFileSync(path.join(repo, 'config.example.json'), path.join(tmp, 'config.json'));
    assert.throws(() => generate({root: tmp}), /content_scripts.*script-policy/);
  } finally { fs.rmSync(tmp, {recursive: true, force: true}); }
});

test('validator: test host only for timecard (and shared infrastructure); feature origins respected', () => {
  assert.match(validatePolicy([entry({feature: 'kb-dark', origins: ['test'], paths: KB_PATHS, css: ['a.css'], js: undefined, world: 'ISOLATED', run_at: 'document_start'})]).join(), /test/);
  assert.match(validatePolicy([entry({feature: 'critical-alert', origins: ['production', 'test']})]).join(), /critical-alert.*test/);
  assert.deepEqual(validatePolicy([entry({feature: 'timecard', origins: ['test', 'production']})]), []);
  assert.match(validatePolicy([entry({feature: 'nope'})]).join(), /unknown feature/);
  for (const name of Object.keys(FEATURES)) {
    if (!FEATURES[name].origins.includes('test')) assert.notDeepEqual(validatePolicy([entry({feature: name, origins: ['test'], ...(name === 'kb-dark' ? {paths: KB_PATHS} : {})})]), [], name);
  }
});

test('validator: KB patterns exactly /kb and /kb?* (never /kb*)', () => {
  const kb = over => entry({feature: 'kb-dark', world: 'ISOLATED', run_at: 'document_start', js: undefined, css: ['features/kb-dark/dark.css'], ...over});
  assert.deepEqual(validatePolicy([kb({paths: ['/kb', '/kb?*']})]), []);
  for (const paths of [['/kb*'], ['/kb'], ['/kb', '/kb*'], ['/*'], ['/kb?*', '/kb']]) assert.match(validatePolicy([kb({paths})]).join(), /kb-dark/, JSON.stringify(paths));
});

test('validator: world / run_at / files / ids / path syntax', () => {
  const cases = [
    entry({world: 'main'}), entry({run_at: 'later'}), entry({js: []}), entry({js: ['/abs.js']}), entry({js: ['../x.js']}),
    entry({all_frames: 'yes'}), entry({paths: ['kb']}), entry({paths: []}), entry({origins: []}), entry({origins: ['staging']}),
    entry({world: 'MAIN', css: ['a.css']}), entry({js: ['https://evil.example/x.js']})
  ];
  for (const c of cases) assert.notDeepEqual(validatePolicy([c]), [], JSON.stringify(c));
  assert.match(validatePolicy([entry({id: 'a'}), entry({id: 'a'})]).join(), /duplicate/);
});

// Expected content-script shape of the three production-only page features: the MAIN bridge (page.js) at
// document_start and the ISOLATED script (content.js) at document_idle, top frame only, production origin only.
const productionShape = feature => [
  {matches: [`${PROD}/*`], js: [`features/${feature}/page.js`], run_at: 'document_start', world: 'MAIN', all_frames: false},
  {matches: [`${PROD}/*`], js: [`features/${feature}/content.js`], run_at: 'document_idle', world: 'ISOLATED', all_frames: false}
];

test('informatica-button entries have the expected manifest shape (production + test, worlds, timing, frames)', () => {
  const inf = SCRIPT_POLICY.filter(e => e.feature === 'informatica-button');
  assert.deepEqual(inf.map(e => e.id), ['informatica-bridge', 'informatica-button']);
  const built = buildContentScripts(origins, inf);
  assert.deepEqual(built, productionShape('informatica-button').map(cs => ({...cs, matches: [`${PROD}/*`, `${TEST}/*`]})));
  for (const e of inf) assert.deepEqual([...e.origins], ['production', 'test']);
  // MAIN helper (settings relay) is injected before the MAIN bridge; the ISOLATED controller before the button script
  const idx = id => SCRIPT_POLICY.findIndex(e => e.id === id);
  assert.ok(idx('main-settings') < idx('informatica-bridge'));
  assert.ok(idx('settings-controller') < idx('informatica-button'));
});

test('minimum_chrome_version covers every manifest feature used (MAIN-world content scripts: 111; setAccessLevel: 102)', () => {
  const tpl = JSON.parse(fs.readFileSync(path.join(repo, 'manifest.template.json'), 'utf8'));
  const min = Number(tpl.minimum_chrome_version);
  assert.ok(Number.isInteger(min), 'minimum_chrome_version is set');
  assert.ok(min >= 102, 'chrome.storage.local.setAccessLevel');
  if (SCRIPT_POLICY.some(e => e.world === 'MAIN')) assert.ok(min >= 111, 'content_scripts world MAIN');
});

for (const [feature, prefix] of [['critical-alert', 'critical-alert'], ['interaction-alert', 'interaction-alert']]) {
  test(`${feature} entries have the expected manifest shape (production-only, MAIN bridge start, ISOLATED poller idle, top frame)`, () => {
    const entries = SCRIPT_POLICY.filter(e => e.feature === feature);
    assert.deepEqual(entries.map(e => e.id), [`${prefix}-bridge`, `${prefix}-poller`]);
    assert.deepEqual(buildContentScripts(origins, entries), productionShape(feature));
    for (const e of entries) assert.deepEqual([...e.origins], ['production'], 'never the test host');
    const idx = id => SCRIPT_POLICY.findIndex(e => e.id === id);
    assert.ok(idx('main-settings') < idx(`${prefix}-bridge`));
    assert.ok(idx('settings-controller') < idx(`${prefix}-poller`));
    // every executable/icon path the worker module uses exists, feature-relative
    for (const f of [`features/${feature}/page.js`, `features/${feature}/content.js`, `features/${feature}/icons/alert.png`]) assert.ok(fs.existsSync(path.join(repo, f)), f);
  });
}

test('background.js registers the real alert feature modules', () => {
  const src = fs.readFileSync(path.join(repo, 'background.js'), 'utf8');
  assert.match(src, /import \{createCriticalAlert\} from '\.\/features\/critical-alert\/background\.mjs'/);
  assert.match(src, /createCriticalAlert\(\)/);
  assert.match(src, /import \{createInteractionAlert\} from '\.\/features\/interaction-alert\/background\.mjs'/);
  assert.match(src, /createInteractionAlert\(\)/);
});

test('timecard entries have the expected manifest shape (both origins, order, worlds, timing, frame scopes)', () => {
  // [1] idle MAIN top frame on the whole site, [2] document_start MAIN all frames on task_time_worked.do; test origin first.
  const entries = SCRIPT_POLICY.filter(e => e.feature === 'timecard');
  assert.deepEqual(entries.map(e => e.id), ['timecard-overlay', 'timecard-native']);
  const expected = [
    {matches: [`${TEST}/*`, `${PROD}/*`], js: ['config.js', 'core.js', 'quick-actions.js', 'content.js'].map(f => `features/timecard/${f}`), run_at: 'document_idle', world: 'MAIN', all_frames: false},
    {matches: [`${TEST}/task_time_worked.do*`, `${PROD}/task_time_worked.do*`], js: ['config.js', 'core.js', 'quick-actions.js', 'native-compat.js', 'native-actions.js'].map(f => `features/timecard/${f}`), run_at: 'document_start', world: 'MAIN', all_frames: true}
  ];
  assert.deepEqual(buildContentScripts(origins, entries), expected);
  const idx = id => SCRIPT_POLICY.findIndex(e => e.id === id);
  assert.ok(idx('main-settings') < idx('timecard-overlay'), 'settings helper first (same world, document_start)');
  assert.ok(idx('main-settings') < idx('timecard-native'));
});

test('timecard, informatica, monitoring-routing and Inbox are the only features on the test origin; generated manifest, grants and config.js agree on both origins', () => {
  for (const e of SCRIPT_POLICY) if (e.origins.includes('test')) assert.ok(['timecard', 'informatica-button', 'monitoring-routing', 'inbox-overlay', 'shared'].includes(e.feature), e.id);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sn_milo-tc-'));
  try {
    fs.copyFileSync(path.join(repo, 'manifest.template.json'), path.join(tmp, 'manifest.template.json'));
    fs.copyFileSync(path.join(repo, 'package.json'), path.join(tmp, 'package.json'));
    fs.copyFileSync(path.join(repo, 'config.example.json'), path.join(tmp, 'config.json'));
    generate({root: tmp});
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
    const cfg = {};
    new Function('globalThis', fs.readFileSync(path.join(tmp, 'features/timecard/config.js'), 'utf8'))(cfg);
    assert.deepEqual(cfg.SnTimecardConfig.instances.map(i => i.origin).sort(), [PROD, TEST].sort(), 'config.js instances = configured origins');
    assert.deepEqual([...manifest.host_permissions].sort(), [`${PROD}/*`, `${TEST}/*`].sort());
    const tc = manifest.content_scripts.filter(cs => cs.js?.some(f => f.startsWith('features/timecard/')));
    assert.equal(tc.length, 2);
    assert.deepEqual(tc[0].matches, [`${TEST}/*`, `${PROD}/*`]);
    assert.deepEqual(tc[1].matches, [`${TEST}/task_time_worked.do*`, `${PROD}/task_time_worked.do*`]);
    for (const cs of manifest.content_scripts) if (cs.matches.some(m => m.startsWith(TEST))) assert.ok(cs.js.every(f => f.startsWith('features/timecard/') || f.startsWith('features/informatica-button/') || f.startsWith('features/monitoring-routing/') || f.startsWith('features/inbox-overlay/') || f.startsWith('shared/')), JSON.stringify(cs.js));
  } finally { fs.rmSync(tmp, {recursive: true, force: true}); }
});
