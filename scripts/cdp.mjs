// Minimal browser-level CDP client for the developer scripts (library only: no CLI, no page evaluation helpers).
// Reviewed port of servicenow-timecard/scripts/cdp.mjs: the endpoint is never assumed. It comes from an explicit
// --cdp URL or SN_MILO_CDP (e.g. http://127.0.0.1:9333) and must be a loopback http endpoint.
export function resolveEndpoint({argv = [], env = process.env} = {}) {
  let value = env.SN_MILO_CDP;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cdp') value = argv[++i];
    else if (argv[i].startsWith('--cdp=')) value = argv[i].slice(6);
  }
  if (!value) throw new Error('no CDP endpoint: pass --cdp http://127.0.0.1:<port> or set SN_MILO_CDP (never assumed; 9333 may be your real browser)');
  let url;
  try { url = new URL(value); } catch { throw new Error(`invalid CDP endpoint ${JSON.stringify(value)}`); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error(`CDP endpoint must be http://127.0.0.1:<port> (loopback only), got ${JSON.stringify(value)}`);
  }
  return `http://${url.hostname}:${url.port}`;
}

export async function browserInfo(endpoint, {fetchImpl = fetch} = {}) {
  const response = await fetchImpl(`${endpoint}/json/version`, {signal: AbortSignal.timeout(5000)});
  if (!response.ok) throw new Error(`${endpoint}/json/version answered ${response.status}`);
  const info = await response.json();
  if (typeof info.webSocketDebuggerUrl !== 'string') throw new Error('no browser websocket in /json/version');
  return info;
}

/** Browser websocket with bounded connect/calls and immediate disconnect cleanup. */
export async function connectBrowser(info, {timeoutMs = 20000, connectTimeoutMs = 5000, WebSocketImpl = WebSocket} = {}) {
  const ws = new WebSocketImpl(info.webSocketDebuggerUrl);
  let nextId = 0, closed = null;
  const pending = new Map();
  const fail = error => {
    closed ||= error;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(closed); }
    pending.clear();
  };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('CDP connect timeout'); fail(error); reject(error);
      try { ws.close(); } catch {}
    }, connectTimeoutMs);
    const refused = message => { clearTimeout(timer); const error = new Error(message); fail(error); reject(error); };
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => refused('CDP websocket failed');
    ws.onclose = () => refused('CDP websocket closed');
  });
  ws.onerror = () => { fail(new Error('CDP websocket failed')); try { ws.close(); } catch {} };
  ws.onclose = () => fail(new Error('CDP websocket closed'));
  ws.onmessage = ({data}) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id); clearTimeout(p.timer);
    msg.error ? p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`)) : p.resolve(msg.result);
  };
  return {
    close: () => { fail(new Error('CDP websocket closed')); try { ws.close(); } catch {} },
    call: (method, params = {}, sessionId, ms = timeoutMs) => new Promise((resolve, reject) => {
      if (closed) { reject(closed); return; }
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, ms);
      pending.set(id, {resolve, reject, timer, method});
      try { ws.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})})); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    })
  };
}
