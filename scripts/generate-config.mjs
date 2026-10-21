#!/usr/bin/env node
// Generates local runtime artifacts from the committed manifest template and the private config.json.
//
//   node scripts/generate-config.mjs            validate inputs, (re)write artifacts atomically
//   node scripts/generate-config.mjs --check    compute expected artifacts, fail on missing/stale; never writes
//   [--root DIR]                                operate on another tree (tests use sanitized temp roots)
//
// Inputs:  manifest.template.json (structure + authoritative version), package.json (version must equal the
//          template's; never corrected automatically), config.json (private instance policy, gitignored).
// Outputs: manifest.json, features/timecard/config.js, shared/origins.generated.mjs (all gitignored).
// Host placeholders in the template: {{PRODUCTION_ORIGIN}}, {{TEST_ORIGIN}}; literal hosts are rejected.
// manifest content_scripts come ONLY from shared/script-policy.mjs (the template must not define them); the
// `policy` option exists so tests can generate from a sanitized policy.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {SCRIPT_POLICY, buildContentScripts, validatePolicy} from '../shared/script-policy.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT_FILES = Object.freeze(['manifest.json', 'features/timecard/config.js', 'shared/origins.generated.mjs']);
const PLACEHOLDERS = Object.freeze({PRODUCTION_ORIGIN: 'production', TEST_ORIGIN: 'test'});
const ORIGIN_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?\.service-now\.com$/;
const INSTANCE_KEYS = ['origin', 'mode', 'enableSubmission'];
const MODES = ['test', 'production'];

export class GenerationError extends Error {
  constructor(problems) {
    const list = [].concat(problems);
    super(`sn_milo generation failed:\n  - ${list.join('\n  - ')}`);
    this.name = 'GenerationError';
    this.problems = list;
  }
}

function readJson(root, rel, problems) {
  const file = path.join(root, rel);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    problems.push(error.code !== 'ENOENT' ? `${rel}: ${error.message}`
      : rel === 'config.json' ? 'config.json is missing (copy config.example.json and edit it)' : `${rel} is missing`);
    return undefined;
  }
  try { return {value: JSON.parse(text), text}; } catch (error) { problems.push(`${rel} is not valid JSON: ${error.message}`); return undefined; }
}

function validateConfig(config, problems) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) { problems.push('config.json must be an object'); return null; }
  const extraTop = Object.keys(config).filter(k => k !== 'instances');
  if (extraTop.length) problems.push(`config.json: unknown top-level key(s) ${extraTop.join(', ')}`);
  if (!Array.isArray(config.instances) || !config.instances.length) { problems.push('config.json: instances must be a non-empty array'); return null; }
  const seen = new Set();
  const byMode = {test: [], production: []};
  config.instances.forEach((instance, i) => {
    const at = `config.json instances[${i}]`;
    if (!instance || typeof instance !== 'object' || Array.isArray(instance)) { problems.push(`${at} must be an object`); return; }
    const extra = Object.keys(instance).filter(k => !INSTANCE_KEYS.includes(k));
    if (extra.length) problems.push(`${at}: unknown key(s) ${extra.join(', ')}`);
    if (typeof instance.origin !== 'string' || !ORIGIN_RE.test(instance.origin)) problems.push(`${at}.origin must be an exact https://<name>.service-now.com origin (no path/port/trailing slash)`);
    else if (seen.has(instance.origin)) problems.push(`${at}.origin duplicates ${instance.origin}`);
    else seen.add(instance.origin);
    if (!MODES.includes(instance.mode)) problems.push(`${at}.mode must be one of ${MODES.join('/')}`);
    else byMode[instance.mode].push(instance.origin);
    if (typeof instance.enableSubmission !== 'boolean') problems.push(`${at}.enableSubmission must be a boolean`);
  });
  for (const mode of MODES) if (byMode[mode].length !== 1) problems.push(`config.json must contain exactly one ${mode} instance (found ${byMode[mode].length})`);
  return {production: byMode.production[0], test: byMode.test[0]};
}

function resolvePlaceholders(value, origins, problems, where = 'manifest.template.json') {
  if (typeof value === 'string') {
    return value.replace(/\{\{([^}]*)\}\}/g, (match, name) => {
      if (!(name in PLACEHOLDERS)) { problems.push(`${where}: unknown placeholder ${match}`); return match; }
      return origins[PLACEHOLDERS[name]];
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => resolvePlaceholders(v, origins, problems, `${where}[${i}]`));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolvePlaceholders(v, origins, problems, `${where}.${k}`)]));
  return value;
}

function patternOrigin(pattern) {
  const m = /^([a-z*]+:\/\/[^/]*)(\/.*)?$/.exec(pattern);
  return m ? m[1] : null;
}

function validateManifest(manifest, origins, version, problems) {
  if (manifest.version !== version) problems.push(`generated manifest version ${manifest.version} != ${version}`);
  if (JSON.stringify(manifest).includes('{{')) problems.push('generated manifest still contains placeholders');
  const configured = new Set([origins.production, origins.test]);
  const expectedGrants = [...configured].map(o => `${o}/*`).sort();
  const grants = manifest.host_permissions;
  if (!Array.isArray(grants) || JSON.stringify([...grants].sort()) !== JSON.stringify(expectedGrants)) {
    problems.push(`host_permissions must be exactly ${expectedGrants.join(', ')} (got ${JSON.stringify(grants)})`);
  }
  const patterns = [
    ...(manifest.content_scripts || []).flatMap((cs, i) => [...(cs.matches || []), ...(cs.exclude_matches || [])].map(p => [`content_scripts[${i}]`, p])),
    ...(manifest.web_accessible_resources || []).flatMap((r, i) => (r.matches || []).map(p => [`web_accessible_resources[${i}]`, p]))
  ];
  for (const [where, pattern] of patterns) {
    if (!configured.has(patternOrigin(pattern))) problems.push(`${where}: match ${pattern} is not on a configured origin (hard-coded host? use a {{…_ORIGIN}} placeholder)`);
  }
}

const jsString = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function renderTimecardConfig(config) {
  const lines = config.instances.map(i => `    {origin: ${jsString(i.origin)}, mode: ${jsString(i.mode)}, enableSubmission: ${i.enableSubmission}}`);
  return '// Local instance configuration. No credentials are stored here.\n' +
    'globalThis.SnTimecardConfig = {\n  instances: [\n' + lines.join(',\n') + '\n  ]\n};\n';
}

function renderOrigins(origins) {
  return '// Generated by scripts/generate-config.mjs from config.json. Do not edit; gitignored.\n' +
    `export const PRODUCTION_ORIGIN = ${jsString(origins.production)};\n` +
    `export const TEST_ORIGIN = ${jsString(origins.test)};\n`;
}

/** Validate all inputs and compute every artifact in memory. Throws GenerationError; never writes. */
export function computeOutputs({root = REPO_ROOT, policy = SCRIPT_POLICY} = {}) {
  const problems = [];
  const template = readJson(root, 'manifest.template.json', problems);
  const pkg = readJson(root, 'package.json', problems);
  const config = readJson(root, 'config.json', problems);
  if (template && /service-now\.com/i.test(template.text)) problems.push('manifest.template.json contains a hard-coded host; use {{PRODUCTION_ORIGIN}}/{{TEST_ORIGIN}} placeholders');
  if (template && pkg && template.value.version !== pkg.value.version) {
    problems.push(`version mismatch: manifest.template.json ${template.value.version} != package.json ${pkg.value.version} (bump both; nothing is corrected automatically)`);
  }
  if (template && (typeof template.value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(template.value.version))) problems.push('manifest.template.json version must be MAJOR.MINOR.PATCH');
  if (template && template.value.content_scripts !== undefined) problems.push('manifest.template.json must not define content_scripts; they are generated from shared/script-policy.mjs');
  problems.push(...validatePolicy(policy));
  const origins = config ? validateConfig(config.value, problems) : null;
  if (problems.length) throw new GenerationError(problems);
  const manifest = resolvePlaceholders(template.value, origins, problems);
  if (policy.length) manifest.content_scripts = buildContentScripts(origins, policy);
  validateManifest(manifest, origins, template.value.version, problems);
  if (problems.length) throw new GenerationError(problems);
  return {
    version: template.value.version,
    origins,
    files: {
      'manifest.json': JSON.stringify(manifest, null, 2) + '\n',
      'features/timecard/config.js': renderTimecardConfig(config.value),
      'shared/origins.generated.mjs': renderOrigins(origins)
    }
  };
}

/** Generate artifacts. The whole output set is validated before any file is replaced (temp + rename); if a
 *  rename fails mid-set, files already replaced are restored to their previous content and the error propagates. */
export function generate({root = REPO_ROOT, policy} = {}) {
  const computed = computeOutputs({root, policy});
  const pending = [];
  try {
    for (const rel of OUTPUT_FILES) {
      const target = path.join(root, rel);
      const content = computed.files[rel];
      let current = null;
      try { current = fs.readFileSync(target, 'utf8'); } catch {}
      if (current === content) continue;
      fs.mkdirSync(path.dirname(target), {recursive: true});
      const temp = `${target}.gen-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(temp, content);
      pending.push({rel, temp, target, previous: current});
    }
    try {
      for (const p of pending) { fs.renameSync(p.temp, p.target); p.done = true; }
    } catch (error) {
      // Roll back already-renamed files so a failure never leaves a mixed old/new set (best effort; the
      // original error is rethrown either way and check() reports anything that could not be restored).
      for (const p of pending) {
        if (!p.done) continue;
        try { if (p.previous === null) fs.rmSync(p.target, {force: true}); else fs.writeFileSync(p.target, p.previous); } catch {}
      }
      throw error;
    }
  } finally {
    for (const p of pending) if (!p.done) fs.rmSync(p.temp, {force: true});
  }
  return {version: computed.version, origins: computed.origins, written: pending.map(p => p.rel)};
}

/** Compare on-disk artifacts with the expected output. Never writes. */
export function check({root = REPO_ROOT, policy} = {}) {
  let computed;
  try { computed = computeOutputs({root, policy}); } catch (error) {
    if (error instanceof GenerationError) return {ok: false, problems: error.problems};
    throw error;
  }
  const problems = [];
  for (const rel of OUTPUT_FILES) {
    let current;
    try { current = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { problems.push(`missing: ${rel}`); continue; }
    if (current !== computed.files[rel]) problems.push(`stale: ${rel}`);
  }
  return {ok: problems.length === 0, problems, version: computed.version, origins: computed.origins};
}

/** Gate for every load/update/package path: generate, then verify freshness. Throws on any failure. */
export function ensureGenerated({root = REPO_ROOT, policy} = {}) {
  generate({root, policy});
  const result = check({root, policy});
  if (!result.ok) throw new GenerationError(result.problems);
  return {root, version: result.version, origins: result.origins};
}

/** Run `fn` (the browser work) only after ensureGenerated succeeded. */
export async function withGeneratedArtifacts(options, fn) {
  const info = ensureGenerated(options);
  return fn(info);
}

function main(argv) {
  let checkOnly = false;
  let root = REPO_ROOT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') checkOnly = true;
    else if (argv[i] === '--root' && argv[i + 1]) root = path.resolve(argv[++i]);
    else { console.error(`unknown argument: ${argv[i]} (usage: generate-config.mjs [--check] [--root DIR])`); return 2; }
  }
  try {
    if (checkOnly) {
      const result = check({root});
      if (!result.ok) { console.error(`generate:check failed:\n  - ${result.problems.join('\n  - ')}\nRun \`npm run generate\`.`); return 1; }
      console.log(`generate:check ok (version ${result.version}; ${OUTPUT_FILES.length} artifacts fresh)`);
      return 0;
    }
    const result = generate({root});
    console.log(`generate ok (version ${result.version}); ${result.written.length ? `wrote ${result.written.join(', ')}` : 'all artifacts already up to date'}`);
    return 0;
  } catch (error) {
    console.error(error instanceof GenerationError ? error.message : error.stack);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
