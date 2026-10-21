// Disposable, sandboxed Chromium-family browser for sn_milo browser tests.
// - launches only its own /usr/bin/vivaldi with a fresh empty profile under $TMPDIR;
// - refuses ports 9333/9222 and any port that already has a listener (never attaches to an existing endpoint);
// - auto-attaches to every target (pages, frames, workers, extension service workers) with
//   waitForDebuggerOnStart and pauses EVERY request of EVERY resource type: *.service-now.com requests are
//   fulfilled from fixtures or failed, everything else continues. --host-resolver-rules is a DNS backstop;
// - --disable-features=NativeNotifications,SystemNotifications: no notification ever reaches the desktop daemon;
// - close() kills only the PID it spawned (plus stragglers carrying its unique profile path).
// Options for restart tests: `profile` reuses a profile directory this test created earlier (must be under $TMPDIR and
// carry the sn_milo-browser-profile- prefix), `keepProfile` leaves it on disk at close(); `extraArgs` adds flags.
import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const FORBIDDEN_PORTS = Object.freeze([9222, 9333]);
const SN_HOST = /(^|\.)service-now\.com$/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function resolvePort(value, fallback) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`invalid CDP port ${value}`);
  if (FORBIDDEN_PORTS.includes(port)) throw new Error(`refusing CDP port ${port}: reserved for the user's real browser`);
  return port;
}

async function assertPortFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(1000)});
    throw new Error(`port ${port} already serves CDP; refusing to attach to an existing browser`);
  } catch (error) { if (/refusing/.test(error.message)) throw error; }
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', error => reject(new Error(`port ${port} is in use (${error.code}); refusing to attach`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

/**
 * @param {{port:number, fixtures?:(req:{url:string,method:string,resourceType:string})=>null|{status?:number,headers?:object,body:string}}} options
 */
export async function launchDisposableBrowser({port, fixtures = () => null, binary = '/usr/bin/vivaldi', profile: reuse = null, keepProfile = false, extraArgs = []} = {}) {
  // A later --disable-features/--enable-features switch would replace or undo ours (Chromium keeps one value per
  // switch): refuse them so desktop notifications can never be re-enabled by a test.
  const featureFlag = extraArgs.find(a => /^--(disable|enable)-features(=|$)/i.test(String(a)));
  if (featureFlag) throw new Error(`refusing extraArgs ${featureFlag}: would override --disable-features=NativeNotifications,SystemNotifications`);
  port = resolvePort(port);
  await assertPortFree(port);
  let profile;
  if (reuse) {
    const resolved = path.resolve(reuse);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('sn_milo-browser-profile-')) {
      throw new Error(`refusing to reuse profile ${reuse}: only a disposable sn_milo profile under $TMPDIR`);
    }
    profile = resolved;
  } else {
    profile = await mkdtemp(path.join(os.tmpdir(), 'sn_milo-browser-profile-'));
    if ((await readdir(profile)).length) throw new Error('profile directory is not empty');
  }
  const args = [
    '--headless=new', '--mute-audio', '--disable-vivaldi', '--enable-unsafe-extension-debugging',
    `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
    '--disable-component-update', '--host-resolver-rules=MAP *.service-now.com ~NOTFOUND, MAP service-now.com ~NOTFOUND',
    // Never route chrome.notifications to the user's desktop notification daemon (headless Chromium otherwise does):
    // the internal message center is used instead, invisible in headless. Tests also record notifications in the
    // worker instead of creating real ones (see tests/browser/alerts.browser.test.mjs).
    '--disable-features=NativeNotifications,SystemNotifications',
    ...extraArgs, 'about:blank'
  ];
  // VIVALDI_FFMPEG_AUTO=0: the /usr/bin/vivaldi wrapper must not start its background codec downloader.
  const child = spawn(binary, args, {stdio: ['ignore', 'ignore', 'pipe'], env: {...process.env, VIVALDI_FFMPEG_AUTO: '0'}});
  let stderr = '';
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  const intercepted = [];
  const interceptionErrors = [];
  const sessions = new Map();
  const ready = new Map(); // sessionId → promise settled once Fetch interception is armed and the target resumed
  const listeners = new Set();
  let ws;
  let nextId = 0;
  const pending = new Map();

  async function close() {
    try { ws?.close(); } catch {}
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(r => child.once('exit', r)), sleep(5000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await sleep(500); }
    }
    // Stragglers can only be ours: they carry our unique, freshly created profile path.
    const left = spawnSync('pgrep', ['-f', `--user-data-dir=${profile}`], {encoding: 'utf8'}).stdout.split('\n').filter(Boolean).map(Number);
    for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    if (!keepProfile) await rm(profile, {recursive: true, force: true});
    return {pid: child.pid, stragglersKilled: left.length};
  }

  try {
    let version;
    for (let i = 0; i < 150 && !version; i++) {
      if (child.exitCode !== null) throw new Error(`browser exited early: ${stderr}`);
      try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) version = await r.json(); } catch {}
      if (!version) await sleep(100);
    }
    if (!version) throw new Error(`browser did not expose CDP on ${port}`);
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP websocket failed')); });

    const call = (method, params = {}, sessionId, timeoutMs = 15000) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        const t = sessionId ? sessions.get(sessionId) : null;
        const what = method === 'Runtime.evaluate' ? ` ${JSON.stringify(String(params.expression).slice(0, 80))}` : '';
        reject(new Error(`${method} timed out after ${timeoutMs} ms${what} on ${t ? `${t.type} ${t.url}` : sessionId ? `detached session ${sessionId}` : 'browser'}`));
      }, timeoutMs);
      pending.set(id, {resolve, reject, timer, method});
      ws.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
    });

    ws.onmessage = ({data}) => {
      const msg = JSON.parse(data);
      if (msg.id) {
        const p = pending.get(msg.id); if (!p) return;
        pending.delete(msg.id); clearTimeout(p.timer);
        msg.error ? p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`)) : p.resolve(msg.result);
        return;
      }
      if (msg.method === 'Target.attachedToTarget') onAttached(msg.params, msg.sessionId);
      else if (msg.method === 'Target.detachedFromTarget') { sessions.delete(msg.params.sessionId); ready.delete(msg.params.sessionId); }
      else if (msg.method === 'Target.targetInfoChanged') {
        for (const [sid, t] of sessions) if (t.targetId === msg.params.targetInfo.targetId) sessions.set(sid, msg.params.targetInfo);
      }
      else if (msg.method === 'Fetch.requestPaused') onPaused(msg.params, msg.sessionId);
      for (const l of listeners) l(msg);
    };

    function onAttached(params) {
      ready.set(params.sessionId, armTarget(params));
    }
    async function armTarget({sessionId, targetInfo, waitingForDebugger}) {
      sessions.set(sessionId, targetInfo);
      try {
        if (['page', 'iframe', 'worker', 'shared_worker', 'service_worker'].includes(targetInfo.type)) {
          await call('Fetch.enable', {patterns: [{urlPattern: '*', requestStage: 'Request'}]}, sessionId);
          await call('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: true, flatten: true}, sessionId).catch(() => {});
        }
      } catch (error) {
        interceptionErrors.push({type: targetInfo.type, url: targetInfo.url, error: error.message});
      } finally {
        if (waitingForDebugger) await call('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      }
    }

    function onPaused({requestId, request, resourceType}, sessionId) {
      let host = '';
      try { host = new URL(request.url).hostname; } catch {}
      if (!SN_HOST.test(host)) { call('Fetch.continueRequest', {requestId}, sessionId).catch(() => {}); return; }
      const fixture = fixtures({url: request.url, method: request.method, resourceType});
      intercepted.push({url: request.url, method: request.method, resourceType, action: fixture ? 'fulfilled-fixture' : 'failed'});
      if (fixture) {
        call('Fetch.fulfillRequest', {requestId, responseCode: fixture.status || 200,
          responseHeaders: Object.entries(fixture.headers || {'Content-Type': 'text/html; charset=utf-8'}).map(([name, value]) => ({name, value})),
          body: Buffer.from(fixture.body).toString('base64')}, sessionId).catch(() => {});
      } else call('Fetch.failRequest', {requestId, errorReason: 'BlockedByClient'}, sessionId).catch(() => {});
    }

    await call('Target.setDiscoverTargets', {discover: true});
    await call('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: true, flatten: true});

    /** Session of a target, once its Fetch interception is armed (never before: a navigation started earlier could
     *  bypass the fixtures and hit the NOTFOUND resolver rule → error page). */
    async function sessionForTarget(targetId, timeoutMs = 15000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const sid = [...sessions.entries()].find(([, t]) => t.targetId === targetId)?.[0];
        if (sid && ready.has(sid)) { await ready.get(sid); return sid; }
        if (Date.now() > until) throw new Error(`no session for target ${targetId} within ${timeoutMs} ms`);
        await sleep(50);
      }
    }
    /** Open `url` in a new tab with interception armed BEFORE navigating: about:blank target → wait until its session
     *  is armed → Page.navigate (fails fast on a net error) → wait for that URL's document to be complete. A
     *  chrome-error:// document fails immediately instead of timing out. Per-call timeouts stay short so one hung
     *  evaluate during navigation is retried. Returns the page sessionId. */
    async function openPage(url, {timeoutMs = 20000} = {}) {
      const {targetId} = await call('Target.createTarget', {url: 'about:blank'});
      const sid = await sessionForTarget(targetId, timeoutMs);
      const nav = await call('Page.navigate', {url}, sid, timeoutMs);
      if (nav.errorText) throw new Error(`navigation to ${url} failed: ${nav.errorText}`);
      const until = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < until) {
        try {
          const r = await call('Runtime.evaluate', {expression: `[location.href, document.readyState]`, returnByValue: true}, sid, 3000);
          last = r.result?.value;
          if (last?.[0]?.startsWith('chrome-error:')) throw new Error(`navigation to ${url} shows an error page`);
          if (last?.[0] === url && last[1] === 'complete') return sid;
        } catch (error) { if (/error page/.test(error.message)) throw error; last = error.message; }
        await sleep(100);
      }
      throw new Error(`timed out loading ${url} (last: ${JSON.stringify(last)})`);
    }
    return {
      pid: child.pid, port, profile, version, call, sessions, intercepted, interceptionErrors, close, sessionForTarget, openPage,
      onEvent: l => { listeners.add(l); return () => listeners.delete(l); }
    };
  } catch (error) {
    await close();
    throw error;
  }
}
