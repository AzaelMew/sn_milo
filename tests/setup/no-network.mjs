// Shared setup for unit tests: `node --import ./tests/setup/no-network.mjs --test ...`.
// Replaces every Node network entry point with a throwing stub so that a test sandbox that accidentally
// inherits real globals can never reach a ServiceNow instance (or anything else). Browser tests do not use it.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import {syncBuiltinESMExports} from 'node:module';

const blocked = name => function blockedNetworkCall() {
  throw new Error(`${name}: network access is disabled in sn_milo tests (tests/setup/no-network.mjs)`);
};

globalThis.fetch = blocked('fetch');
globalThis.WebSocket = class BlockedWebSocket { constructor() { blocked('WebSocket')(); } };
globalThis.EventSource = class BlockedEventSource { constructor() { blocked('EventSource')(); } };
for (const [name, mod] of [['http', http], ['https', https]]) {
  mod.request = blocked(`${name}.request`);
  mod.get = blocked(`${name}.get`);
}
net.connect = blocked('net.connect');
net.createConnection = blocked('net.createConnection');
net.Socket.prototype.connect = blocked('net.Socket.connect');
tls.connect = blocked('tls.connect');
dgram.createSocket = blocked('dgram.createSocket');
// Propagate the patched properties to named ESM imports (`import {request} from 'node:http'`).
syncBuiltinESMExports();
globalThis.__miloNoNetwork = true;
