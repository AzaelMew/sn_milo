// Proves the shared test setup (tests/setup/no-network.mjs) is active in test processes and that every
// network entry point throws instead of reaching a real host.
import test from 'node:test';
import assert from 'node:assert/strict';
import http, {request as namedHttpRequest} from 'node:http';
import https, {get as namedHttpsGet} from 'node:https';
import net, {connect as namedNetConnect} from 'node:net';
import tls from 'node:tls';

const blocked = /network access is disabled in sn_milo tests/;
// Hosts use the reserved .invalid TLD so even a broken stub could never resolve a real instance.
const target = 'https://milo-no-network.invalid/api/now/table/x';
const host = 'milo-no-network.invalid';

test('setup marker is present in the test process', () => {
  assert.equal(globalThis.__miloNoNetwork, true);
});

test('global fetch throws', () => {
  assert.throws(() => fetch(target), blocked);
});

test('http/https request and get throw (default and named imports)', () => {
  assert.throws(() => http.request(target), blocked);
  assert.throws(() => http.get(target), blocked);
  assert.throws(() => https.request(target), blocked);
  assert.throws(() => https.get(target), blocked);
  assert.throws(() => namedHttpRequest(target), blocked);
  assert.throws(() => namedHttpsGet(target), blocked);
});

test('raw net/tls connections throw', () => {
  assert.throws(() => net.connect(443, host), blocked);
  assert.throws(() => net.createConnection(443, host), blocked);
  assert.throws(() => namedNetConnect(443, host), blocked);
  assert.throws(() => new net.Socket().connect(443, host), blocked);
  assert.throws(() => tls.connect(443, host), blocked);
});

test('WebSocket constructor throws', () => {
  assert.throws(() => new WebSocket('wss://milo-no-network.invalid/'), blocked);
});
