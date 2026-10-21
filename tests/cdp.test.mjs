import test from 'node:test';
import assert from 'node:assert/strict';
import {connectBrowser} from '../scripts/cdp.mjs';
class Socket {
 static last; static autoOpen = true;
 constructor() { Socket.last = this; if (Socket.autoOpen) queueMicrotask(() => this.onopen?.()); }
 send() { if (this.throwSend) throw new Error('send broken'); }
 close() { this.closed = true; this.onclose?.(); }
}
const info = {webSocketDebuggerUrl: 'ws://127.0.0.1:1/fixture'};
test('CDP connection timeout closes stalled socket', async () => {
 Socket.autoOpen = false;
 await assert.rejects(connectBrowser(info, {WebSocketImpl: Socket, connectTimeoutMs: 10}), /connect.*timeout/i);
 assert.equal(Socket.last.closed, true); Socket.autoOpen = true;
});
for (const event of ['onclose', 'onerror', 'close']) test(`CDP ${event} rejects all pending immediately and refuses new calls`, async () => {
 const c = await connectBrowser(info, {WebSocketImpl: Socket});
 const a = c.call('One'); const b = c.call('Two');
 const rejected = Promise.all([assert.rejects(a, /closed|failed/), assert.rejects(b, /closed|failed/)]);
 if (event === 'close') c.close(); else Socket.last[event]();
 await rejected; await assert.rejects(c.call('Three'), /closed|failed/);
});
test('CDP synchronous send failure removes pending entry/timer', async () => {
 const c = await connectBrowser(info, {WebSocketImpl: Socket, timeoutMs: 20}); Socket.last.throwSend = true;
 const timersBefore = process.getActiveResourcesInfo().filter(x => x === 'Timeout').length;
 await assert.rejects(c.call('Send'), /send broken/);
 assert.equal(process.getActiveResourcesInfo().filter(x => x === 'Timeout').length, timersBefore, 'no send-failure timer survives');
 Socket.last.throwSend = false;
 const p = c.call('Next'); Socket.last.onmessage({data: JSON.stringify({id: 2, result: {ok: true}})});
 assert.deepEqual(await p, {ok: true}); c.close();
});
