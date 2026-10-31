#!/usr/bin/env node
// LOCAL PRIVATE package: generated artifacts embed the configured instance policy. Never publish this archive.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ensureGenerated, REPO_ROOT} from './generate-config.mjs';

// Explicit runtime-only allowlist. New runtime dependencies must be reviewed and added here (never recurse).
export const PACKAGE_FILES = Object.freeze([
  'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png',
  'manifest.json', 'background.js', 'options.html', 'options.js',
  'shared/origins.generated.mjs', 'shared/features.mjs', 'shared/router.mjs', 'shared/reinject.mjs',
  'shared/script-policy.mjs', 'shared/informatica-gate.mjs', 'shared/informatica-maintenance.mjs', 'shared/options-view.mjs', 'shared/rules.mjs', 'shared/user-lists.mjs', 'shared/controller.js', 'shared/main-settings.js',
  'features/critical-alert/background.mjs', 'features/critical-alert/content.js', 'features/critical-alert/page.js', 'features/critical-alert/icons/alert.png',
  'features/interaction-alert/background.mjs', 'features/interaction-alert/content.js', 'features/interaction-alert/page.js', 'features/interaction-alert/icons/alert.png',
  'features/informatica-button/content.js', 'features/informatica-button/page.js',
  'features/monitoring-routing/content.js',
  'features/inbox-overlay/content.js',
  'features/kb-dark/content.js', 'features/kb-dark/dark.css',
  'features/timecard/background.mjs', 'features/timecard/config.js', 'features/timecard/core.js',
  'features/timecard/quick-actions.js', 'features/timecard/content.js', 'features/timecard/native-compat.js', 'features/timecard/native-actions.js'
]);

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Small dependency-free, stored ZIP writer. Fixed DOS epoch, sorted entries and no filesystem metadata:
// byte-identical inputs produce byte-identical archives regardless of file mtimes or umask.
function zip(entries) {
  const chunks = [], directory = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const filename = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x21, 12); // 1980-01-01, 00:00:00
    header.writeUInt32LE(crc32(data), 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    chunks.push(header, filename, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    header.copy(central, 8, 6, 30);
    central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += header.length + filename.length + data.length;
  }
  const index = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, index, end]);
}

export function packageExtension({root = REPO_ROOT} = {}) {
  // Generate + check BEFORE reading assets, making directories or writing/replacing any archive.
  const generated = ensureGenerated({root});
  const entries = [...PACKAGE_FILES].sort().map(rel => {
    const file = path.join(root, rel);
    if (!fs.lstatSync(file).isFile()) throw new Error(`not a regular runtime asset: ${rel}`);
    return [rel, fs.readFileSync(file)];
  });
  const bytes = zip(entries);
  const dir = path.join(root, 'dist');
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const archive = path.join(dir, `sn_milo-${generated.version}-private.zip`);
  const temp = `${archive}.gen-tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, bytes, {mode: 0o600, flag: 'wx'});
    fs.renameSync(temp, archive);
  } finally { fs.rmSync(temp, {force: true}); }
  return {archive, files: entries.length, bytes: bytes.length};
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('usage: node scripts/package.mjs (no arguments; writes only to local dist/)');
    const result = packageExtension();
    console.log(`LOCAL PRIVATE archive: ${result.archive} (${result.files} files, ${result.bytes} bytes). Contains instance policy; DO NOT publish or publicly share.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
