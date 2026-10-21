// Public-repo guard: no private term (client / company / person names, real hosts, account ids …) may appear in any
// tracked or untracked-but-not-ignored file, in its content or its path. The terms live in the gitignored
// `private-terms.txt` (one case-insensitive regular expression per line, `#` comments), so this file itself leaks
// nothing. Without that file the test is skipped (CI / fresh clones); the owner's machine always has it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const termsFile = path.join(repo, 'private-terms.txt');
const BINARY = /\.(png|ico|zip|jpg|jpeg|gif|woff2?)$/i;

test('no private terms in the repository', {skip: !fs.existsSync(termsFile) && 'private-terms.txt not present'}, () => {
  const terms = fs.readFileSync(termsFile, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => new RegExp(l, 'i'));
  assert.ok(terms.length > 0, 'private-terms.txt lists at least one term');
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {cwd: repo, encoding: 'utf8'}).split('\n').filter(Boolean)
    .filter(f => fs.existsSync(path.join(repo, f)));
  const hits = [];
  for (const f of files) {
    for (const t of terms) if (t.test(f)) hits.push(`${f} (path) ~ ${t}`);
    if (BINARY.test(f)) continue;
    const lines = fs.readFileSync(path.join(repo, f), 'utf8').split('\n');
    lines.forEach((line, i) => { for (const t of terms) if (t.test(line)) hits.push(`${f}:${i + 1} ~ ${t}`); });
  }
  assert.deepEqual(hits, [], `private terms found:\n${hits.join('\n')}`);
});
