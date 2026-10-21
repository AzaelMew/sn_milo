// Developer scripts: generation gate before any CDP call, explicit endpoint, --yes confirmation.
// A counting TCP server stands in for "a browser": the scripts must not even connect when the gate fails.
import './dev-tools-safety.test.mjs'; // Included by the explicit npm test:unit entrypoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolveEndpoint} from '../scripts/cdp.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('resolveEndpoint: explicit and loopback only', () => {
  assert.throws(() => resolveEndpoint({argv: [], env: {}}), /no CDP endpoint/);
  assert.equal(resolveEndpoint({argv: [], env: {SN_MILO_CDP: 'http://127.0.0.1:9461'}}), 'http://127.0.0.1:9461');
  assert.equal(resolveEndpoint({argv: ['--cdp', 'http://localhost:9461/'], env: {SN_MILO_CDP: 'http://127.0.0.1:1'}}), 'http://localhost:9461', 'argument wins');
  assert.equal(resolveEndpoint({argv: ['--cdp=http://127.0.0.1:9462'], env: {}}), 'http://127.0.0.1:9462');
  for (const bad of ['http://192.168.1.5:9333', 'https://127.0.0.1:9333', 'http://127.0.0.1', 'http://127.0.0.1:9333/json', 'http://u:p@127.0.0.1:9333', 'ws://127.0.0.1:9333', 'nonsense', 'http://evil.example:9333']) {
    assert.throws(() => resolveEndpoint({argv: [], env: {SN_MILO_CDP: bad}}), /CDP endpoint/, bad);
  }
});

function sanitizedRoot({breakIt}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'sn_milo-devtools-'));
  fs.writeFileSync(path.join(root, 'manifest.template.json'), fs.readFileSync(path.join(repo, 'manifest.template.json')));
  fs.writeFileSync(path.join(root, 'package.json'), fs.readFileSync(path.join(repo, 'package.json')));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({instances: [
    {origin: 'https://prod-example.service-now.com', mode: 'production', enableSubmission: false},
    {origin: 'https://test-example.service-now.com', mode: 'test', enableSubmission: false}]}));
  if (breakIt === 'version') fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({...JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')), version: '9.9.9'}));
  if (breakIt === 'config') fs.writeFileSync(path.join(root, 'config.json'), '{not json');
  return root;
}

async function withCountingServer(fn) {
  const hits = [];
  const server = net.createServer(socket => { hits.push('connect'); socket.destroy(); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try { return await fn(server.address().port, hits); } finally { server.close(); }
}
const runScript = (script, args, env = {}) => new Promise(resolve => {
  const child = spawn(process.execPath, [path.join(repo, 'scripts', script), ...args], {env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = ''; let stderr = '';
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  child.on('close', code => resolve({code, stdout, stderr}));
});

for (const script of ['apply-update.mjs', 'load-extension.mjs']) {
  for (const breakIt of ['version', 'config']) {
    test(`${script}: generator failure (${breakIt}) ⇒ exit 1 and ZERO connections to the endpoint`, async () => {
      const root = sanitizedRoot({breakIt});
      try {
        await withCountingServer(async (port, hits) => {
          const r = await runScript(script, ['--yes', '--root', root, '--cdp', `http://127.0.0.1:${port}`]);
          assert.equal(r.code, 1, r.stderr);
          assert.match(r.stderr, /generation failed/);
          assert.match(r.stderr, /no CDP calls were made/);
          assert.equal(hits.length, 0);
        });
      } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });
  }

  test(`${script}: no endpoint ⇒ exit 2 without any connection; endpoint but no --yes ⇒ reads /json/version only and stops`, async () => {
    const root = sanitizedRoot({});
    try {
      const noEndpoint = await runScript(script, ['--yes', '--root', root], {SN_MILO_CDP: ''});
      assert.equal(noEndpoint.code, 2);
      assert.match(noEndpoint.stderr, /no CDP endpoint/);
      const requests = [];
      const http = await import('node:http');
      const server = http.createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({Browser: 'FakeBrowser/1.2.3', 'Protocol-Version': '1.3', webSocketDebuggerUrl: 'ws://127.0.0.1:1/never'}));
      });
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      try {
        const r = await runScript(script, ['--root', root, '--cdp', `http://127.0.0.1:${server.address().port}`]);
        assert.equal(r.code, 2);
        assert.match(r.stdout, /FakeBrowser\/1\.2\.3/);
        assert.match(r.stderr, /without --yes/);
        assert.deepEqual(requests, ['GET /json/version']);
      } finally { server.close(); }
    } finally { fs.rmSync(root, {recursive: true, force: true}); }
  });
}

test('CLI websocket failures are friendly, exit 1, and disclose no automatic retry', async () => {
  const root = sanitizedRoot({});
  const http = await import('node:http');
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    // This endpoint is this test's own HTTP listener, not a browser or existing CDP port.
    res.end(JSON.stringify({Browser: 'Fixture/1', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/no-websocket`}));
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const r = await runScript('apply-update.mjs', ['--root', root, '--yes', '--cdp', `http://127.0.0.1:${server.address().port}`]);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /developer update failed: CDP websocket failed/);
    assert.match(r.stderr, /No automatic retry.*may still complete/);
    assert.doesNotMatch(r.stderr, /at .*scripts\/.*\.mjs:/, 'no uncaught stack trace');
  } finally { server.close(); fs.rmSync(root, {recursive: true, force: true}); }
});

test('scripts do not hard-code the repo path, port 9333 or an extension id', () => {
  for (const f of ['apply-update.mjs', 'load-extension.mjs', 'cdp.mjs', 'dev-tools.mjs']) {
    const text = fs.readFileSync(path.join(repo, 'scripts', f), 'utf8').replace(/\/\/.*$/gm, '').replace(/'[^'\n]*(never assumed|loopback)[^'\n]*'/g, "''");
    assert.ok(!/servicenow-timecard\/extension|\/home\/azael/.test(text), f);
    assert.ok(!/127\.0\.0\.1:9333|localhost:9333/.test(text), `${f}: no assumed port`);
    assert.ok(!/service-now\.com/.test(text.replace(/\/\/.*$/gm, '').replace(/`[^`]*service-now[^`]*`/g, '')), `${f}: no instance host`);
  }
});
