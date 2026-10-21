// Migrated from the original standalone interaction alert extension 1.1.0 test.js.
// Every original test keeps its name and assertions; adaptations (module boundary, worker-owned heartbeat):
//   - explicit paths (path.join(__dirname, ...)) instead of cwd-relative "page.js"/"content.js"/"background.js";
//   - a sanitized example origin (tests/helpers/fake-chrome.mjs PROD) instead of the private production host;
//   - page.js gets an enabled MAIN settings stub (window.__snMiloMainSettings) and the window stub gains
//     removeEventListener: the Milo bridge is inert until the feature is enabled;
//   - content.js gets an enabled ISOLATED settings-controller stub (globalThis.__snMiloController) and its
//     chrome.runtime.sendMessage is routed through the REAL router (shared/router.mjs) + the REAL worker module
//     (background.mjs): the heartbeat lives in the worker as `ix.lastPollAt` (claim-poll / release-poll), so
//     "storage" assertions read the worker storage; snIxRows/snIxLog are now {feature:'interaction-alert', type:'rows'|'log'};
//   - the background tests drive the real router + module (createInteractionAlert) instead of evaluating a classic
//     background.js with global listeners; storage keys follow the collision inventory (ix.healthStateV1,
//     ix.lastSuccessfulPollAt, health notification snIxHealth); dedupe key seenInteractionsV1 unchanged;
//   - "untrusted senders are rejected": the router now rejects a foreign-origin sender ({ok:false,
//     error:'wrong-origin'}) before the module runs (the original module answered {ok:true} after ignoring the rows);
//     the asserted outcome — no notification — is unchanged;
//   - "orphaned poller retires": the trigger is a sendMessage that throws "Extension context invalidated" (content no
//     longer touches storage) and a missing chrome binding, as in the original.
// Tests after the migrated block cover the Milo lifecycle of the bridge and the poller.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PAGE = path.join(__dirname, "page.js");
const CONTENT = path.join(__dirname, "content.js");
const FEATURE = "interaction-alert";
const READY = { schema: 1, state: "ready", method: "import", decidedAt: 1, completedAt: 1, importedEntries: 0, lastImportAt: 1 };
const helpers = () => import(path.join(__dirname, "..", "..", "tests", "helpers", "fake-chrome.mjs"));
const routerModule = () => import(path.join(__dirname, "..", "..", "shared", "router.mjs"));
const featureModule = () => import(path.join(__dirname, "background.mjs"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const flush = async () => { for (let i = 0; i < 6; i++) await sleep(2); };

function mainSettingsStub(initial = { enabled: true, seedOnly: false }) {
	const cbs = new Set();
	let state = initial;
	return {
		api: {
			subscribe(feature, cb) { if (feature !== FEATURE) return () => {}; cbs.add(cb); if (state) cb({ ...state }); return () => cbs.delete(cb); },
			get: feature => (feature === FEATURE && state ? { ...state } : null)
		},
		set(next) { state = next; for (const cb of [...cbs]) cb({ ...next }); },
		cbs
	};
}

function loadBridge({ token = "test-token", status = 200, result = [], results = {}, failTables = [], origin = "https://prod.service-now.com", settings = mainSettingsStub(), existing, fetchImpl } = {}) {
	const listeners = existing ? existing.listeners : {};
	const posts = existing ? existing.posts : [];
	const fetches = existing ? existing.fetches : [];
	const location = { origin };
	const window = existing ? existing.window : {
		g_ck: token,
		addEventListener(type, listener) { listeners[type] = listener; },
		removeEventListener(type, listener) { if (listeners[type] === listener) delete listeners[type]; },
		postMessage(data, targetOrigin) {
			if (targetOrigin === "null") throw new SyntaxError("Invalid target origin 'null'");
			posts.push({ data, origin: targetOrigin });
		}
	};
	window.window = window;
	if (!existing && settings) window.__snMiloMainSettings = settings.api;
	const context = existing ? existing.context : vm.createContext({
		window,
		location,
		console: { log() {}, warn() {}, error() {} },
		URL,
		AbortController,
		encodeURIComponent,
		fetch: fetchImpl || (async (url, options) => {
			fetches.push({ url, options });
			const table = url.match(/^\/api\/now\/table\/([^?]+)/)?.[1] || "";
			if (failTables.includes(table)) {
				return { ok: false, status: 500, json: async () => ({ result: [] }) };
			}
			const rowsForTable = table in results ? results[table] : result;
			return { ok: status === 200, status, json: async () => ({ result: rowsForTable }) };
		})
	});
	vm.runInContext(fs.readFileSync(PAGE, "utf8"), context);
	return { listeners, posts, fetches, window, location, context, settings };
}

/** A worker (real router + real module) with an enabled, migrated critical-alert feature. */
async function createWorker({ stored = {}, failHeartbeatGet = false } = {}) {
	const { createFakeChrome, createFakeStorage, deliver, contentSender, ORIGINS, PROD } = await helpers();
	const { createMiloBackground } = await routerModule();
	const { createInteractionAlert } = await featureModule();
	const storage = createFakeStorage({ "ix.migrationV1": READY, ...stored });
	const { chrome, calls } = createFakeChrome({ storage });
	const notifications = [];
	chrome.notifications.create = async (id, options) => { notifications.push({ id, options }); return id; };
	if (failHeartbeatGet) {
		const get = chrome.storage.local.get;
		chrome.storage.local.get = async keys => { if ([].concat(keys).includes("ix.lastPollAt")) throw new Error("storage failed"); return get(keys); };
	}
	const module = createInteractionAlert({ console: { log() {}, info() {}, warn() {}, error() {} } });
	const app = createMiloBackground({ chrome, origins: ORIGINS, features: [module], log: { warn() {} } });
	app.install();
	await app.ensureReady();
	return { chrome, calls, storage, app, module, notifications, deliver, contentSender, PROD };
}

async function loadPoller({ stored = {}, origin, failStorageGet = false, failRowSend = false, failClaimInvalidated = false, extensionInvalidated = false, worker } = {}) {
	const w = worker || await createWorker({ stored, failHeartbeatGet: failStorageGet });
	origin = origin || w.PROD;
	const posts = [];
	const listeners = {};
	const timers = [];
	const logs = [];
	const messages = [];
	const sender = w.contentSender(w.PROD, { id: w.chrome.runtime.id, path: "/now/cwf/agent/list" });
	const chrome = extensionInvalidated ? undefined : {
		runtime: {
			id: w.chrome.runtime.id,
			sendMessage(message) {
				messages.push(message);
				if (failRowSend && message.type === "rows") throw new Error("context invalidated");
				if (failClaimInvalidated && message.type === "claim-poll") throw new Error("Extension context invalidated.");
				return w.deliver(w.chrome, message, sender).then(r => r.response);
			}
		}
	};
	const window = {
		addEventListener(type, listener) { listeners[type] = listener; },
		removeEventListener(type, listener) { if (listeners[type] === listener) delete listeners[type]; },
		postMessage(data, targetOrigin) {
			if (targetOrigin === "null") throw new SyntaxError("Invalid target origin 'null'");
			posts.push({ data, origin: targetOrigin });
		}
	};
	const milo = {
		subs: [],
		subscribe(feature, handlers, options) { const sub = { feature, handlers, options }; this.subs.push(sub); if (feature === FEATURE) handlers.start({ enabled: true, seedOnly: false, mode: "enabled" }); return () => {}; },
		effective: () => ({ enabled: true, seedOnly: false })
	};
	const sandboxConsole = { ...console, warn: (...args) => logs.push(args.join(" ")), log: (...args) => logs.push(args.join(" ")) };
	const context = vm.createContext({
		chrome, window, console: sandboxConsole, crypto,
		location: { origin },
		__snMiloController: milo,
		setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
		clearTimeout() {},
		setInterval: () => 0,
		clearInterval() {}
	});
	vm.runInContext(fs.readFileSync(CONTENT, "utf8"), context);
	const stateOf = () => w.storage.dump();
	return { listeners, posts, timers, logs, messages, window, worker: w, milo, context, get storage() { return stateOf(); } };
}

// ---- migrated original tests --------------------------------------------------------------------------------------
test("poller normalizes every API shape of the reference fields", async () => {
	const h = await loadPoller({ stored: { "ix.lastPollAt": 0 } });
	await h.window.snIxPollNow();
	await flush();
	await flush();
	const request = h.posts.find(p => p.data.type === "poll").data;
	await h.listeners.message({
		source: h.window,
		origin: h.worker.PROD,
		data: {
			source: "sn-ix-page", type: "poll-result", id: request.id,
			rows: [
				{ sys_id: "a".repeat(32), number: "IMSTK1", state: "New", type: "Phone",
					account: { display_value: "  Acme Oy  ", link: "https://example/x" } },
				{ sys_id: "b".repeat(32), number: "IMSTK2", account: "Beta Oyj" },
				{ sys_id: "c".repeat(32), number: "IMSTK3" },
				{ sys_id: "bad", number: "IMSTK4" }
			]
		}
	});
	await flush();
	const rows = h.messages.find(m => m.type === "rows").rows;
	assert.equal(rows.length, 3, "invalid sys_id must be dropped");
	assert.equal(rows[0].account, "Acme Oy");
	assert.equal(rows[1].account, "Beta Oyj");
	assert.equal(rows[2].account, "");
	assert.equal(rows[2].state, "");
});

test("opaque-origin frames are ignored instead of calling postMessage with null", async () => {
	assert.equal(loadBridge({ origin: "null" }).listeners.message, undefined);
	assert.equal((await loadPoller({ origin: "null" })).window.snIxPollNow, undefined);
});

test("bridge queries the interaction table with the list filter", async () => {
	const h = loadBridge({ results: { interaction: [{ sys_id: "a".repeat(32), number: "IMSTK1" }] } });
	await h.listeners.message({
		source: h.window,
		origin: h.location.origin,
		data: { source: "sn-ix-extension", type: "poll", id: "request-1", accounts: ["Acme Oy", "Beta Oyj"] }
	});
	assert.equal(h.fetches.length, 1);
	assert.match(h.fetches[0].url, /^\/api\/now\/table\/interaction\?/);
	assert.equal(h.fetches[0].options.headers["X-UserToken"], "test-token");
	const url = decodeURIComponent(h.fetches[0].url);
	assert.ok(url.includes("active=true^typeNOT INmonitoring,call,walk-in^ORtype=^account.name=Acme Oy^ORaccount.name=Beta Oyj"));
	assert.match(url, /sysparm_fields=sys_id,number,state,type,short_description,account,opened_for/);
	assert.deepEqual(JSON.parse(JSON.stringify(h.posts[0].data.rows.map(r => r.number))), ["IMSTK1"]);
	assert.equal(h.posts[0].data.id, "request-1");
});

test("bridge reports an error when the query fails", async () => {
	const h = loadBridge({ failTables: ["interaction"] });
	await h.listeners.message({
		source: h.window,
		origin: h.location.origin,
		data: { source: "sn-ix-extension", type: "poll", id: "request-2c", accounts: ["Acme Oy", "Beta Oyj"] }
	});
	assert.match(h.posts[0].data.error, /HTTP 500/);
	assert.equal(h.posts[0].data.rows, undefined);
});

test("bridge reports missing page session token without fetching", async () => {
	const h = loadBridge({ token: "" });
	await h.listeners.message({
		source: h.window,
		origin: h.location.origin,
		data: { source: "sn-ix-extension", type: "poll", id: "request-2", accounts: ["Acme Oy", "Beta Oyj"] }
	});
	assert.equal(h.fetches.length, 0);
	assert.match(h.posts[0].data.error, /g_ck/);
});

test("bridge rejects messages from another origin", async () => {
	const h = loadBridge();
	await h.listeners.message({
		source: h.window,
		origin: "https://evil.example",
		data: { source: "sn-ix-extension", type: "poll", id: "request-3", accounts: ["Acme Oy", "Beta Oyj"] }
	});
	assert.equal(h.fetches.length, 0);
	assert.equal(h.posts.length, 0);
});

test("background alerts once per new interaction and deduplicates", async () => {
	const w = await createWorker();
	const notifications = w.notifications;
	const stored = () => w.storage.dump();
	const sender = w.contentSender(w.PROD, { id: w.chrome.runtime.id, path: "/now/cwf/agent/list" });
	const row = (n, extra = {}) => ({ sys_id: String(n).repeat(32), number: `IMSTK${n}`, state: "New", type: "Phone", short_description: "printer", account: "Acme Oy", opened_for: "Matti", ...extra });
	async function send(input, snd = sender) {
		const r = await w.deliver(w.chrome, { feature: FEATURE, type: "rows", rows: input }, snd);
		assert.equal(r.keptOpen, r.response.error !== "wrong-origin");
		return r.response;
	}
	assert.equal((await send([row(1), row(2)])).ok, true);
	assert.equal(notifications.length, 2);
	assert.ok(notifications[0].options.message.startsWith("IMSTK1"));
	assert.ok(notifications[0].options.title.includes("Acme Oy"));
	assert.equal((await send([row(1), row(2)])).ok, true);
	assert.equal(notifications.length, 2, "same interaction must not notify twice");
	assert.equal((await send([])).ok, true);
	assert.equal((await send([row(1)])).ok, true);
	assert.equal(notifications.length, 2, "seen interactions stay suppressed after leaving the list");
	assert.equal((await send([row(1, { state: "Work in Progress" })])).ok, true);
	assert.equal(notifications.length, 2, "a state change is not a new ticket");
	assert.equal((await send([row(3)])).ok, true);
	assert.equal(notifications.length, 3);

	// Milo: untrusted senders are rejected by the router before the module (original: by handleRows); same outcome
	const evil = { id: w.chrome.runtime.id, url: "https://evil.example/", origin: "https://evil.example", frameId: 0, tab: { id: 7, url: "https://evil.example/" } };
	const rejected = await send([row(4)], evil);
	assert.deepEqual(rejected, { ok: false, error: "wrong-origin" });
	assert.equal(notifications.length, 3, "untrusted senders are rejected");

	await w.app.onNotificationClicked(notifications[0].id);
	const created = w.calls.filter(c => c[0] === "tabs.create").map(c => c[1]);
	assert.equal(created[0], `${w.PROD}/now/cwf/agent/record/interaction/${"1".repeat(32)}`);

	w.storage.put("seenInteractionsV1", Array.from({ length: 2000 }, (_, i) => i.toString(16).padStart(32, "0")));
	assert.equal((await send([row("f")])).ok, true);
	assert.equal(stored().seenInteractionsV1.length, 2001, "permanent dedupe must not evict older tickets");

	w.storage.put("seenInteractionsV1", []);
	notifications.length = 0;
	assert.deepEqual((await Promise.all([send([row(5)]), send([row(5)])])).map(r => r.ok), [true, true]);
	assert.equal(notifications.length, 1, "concurrent tabs must not duplicate an alert");
	await w.module.idle();
	assert.ok(stored().diagnosticLogsIxV1.some(e => e.event === "notification-created"), "own diagnostic log key");
	assert.equal(stored().diagnosticLogsV1, undefined, "never the critical log key");
});

test("poller heartbeat: a fresh heartbeat in another tab skips the tick", async () => {
	const h = await loadPoller({ stored: { "ix.lastPollAt": Date.now() } });
	await h.window.snIxPollNow();
	await flush();
	await flush();
	assert.equal(h.posts.filter(p => p.data.type === "poll").length, 0, "fresh heartbeat must suppress the tick");
});

test("poller heartbeat: a stale heartbeat is claimed and polling starts", async () => {
	const h = await loadPoller({ stored: { "ix.lastPollAt": 0 } });
	await h.window.snIxPollNow();
	await flush();
	await flush();
	assert.equal(h.posts.filter(p => p.data.type === "poll").length, 1);
	assert.ok(h.storage["ix.lastPollAt"] > Date.now() - 60000, "claim must write a heartbeat");
});

test("poller heartbeat: a future timestamp after a clock correction is stale", async () => {
	const h = await loadPoller({ stored: { "ix.lastPollAt": Date.now() + 3600000 } });
	await h.window.snIxPollNow();
	await flush();
	assert.equal(h.posts.filter(p => p.data.type === "poll").length, 1);
});

test("failed polls release the heartbeat before retrying", async () => {
	const apiFailure = await loadPoller({ stored: { "ix.lastPollAt": 0 } });
	await apiFailure.window.snIxPollNow();
	const request = apiFailure.posts.find(p => p.data.type === "poll").data;
	apiFailure.listeners.message({
		source: apiFailure.window,
		origin: apiFailure.worker.PROD,
		data: { source: "sn-ix-page", type: "poll-result", id: request.id, error: "failed" }
	});
	await flush();
	assert.equal(apiFailure.storage["ix.lastPollAt"], 0);
	assert.ok(apiFailure.timers.some(timer => timer.delay === 10000));

	const timeout = await loadPoller({ stored: { "ix.lastPollAt": 0 } });
	await timeout.window.snIxPollNow();
	await timeout.timers.find(timer => timer.delay === 30000).callback();
	await flush();
	assert.equal(timeout.storage["ix.lastPollAt"], 0);

	const backgroundFailure = await loadPoller({ stored: { "ix.lastPollAt": 0 }, failRowSend: true });
	await backgroundFailure.window.snIxPollNow();
	const backgroundRequest = backgroundFailure.posts.find(p => p.data.type === "poll").data;
	await assert.doesNotReject(() => backgroundFailure.listeners.message({
		source: backgroundFailure.window,
		origin: backgroundFailure.worker.PROD,
		data: { source: "sn-ix-page", type: "poll-result", id: backgroundRequest.id, rows: [] }
	}));
	await flush();
	assert.equal(backgroundFailure.storage["ix.lastPollAt"], 0);
	assert.ok(backgroundFailure.timers.some(timer => timer.delay === 10000));
});

test("poll startup failures are logged without an unhandled rejection", async () => {
	const h = await loadPoller({ failStorageGet: true });
	await assert.doesNotReject(() => h.window.snIxPollNow());
	assert.equal(h.posts.length, 0);
	// Milo: the start failure follows the full failure path (release → log → RETRY_MS)
	await flush();
	assert.ok(h.messages.some(m => m.type === "release-poll"));
	assert.ok(h.messages.some(m => m.type === "log" && m.event === "poll-start-failed"));
	assert.ok(h.timers.some(timer => timer.delay === 10000));
});

test("orphaned poller retires quietly after extension reload", async () => {
	const h = await loadPoller({ failClaimInvalidated: true });
	await h.window.snIxPollNow();
	await flush();
	await flush();
	await flush();
	assert.ok(h.logs.some(entry => entry.includes("orphaned poller retired")), h.logs.join("\n"));
	assert.equal(h.posts.length, 0);

	await h.window.snIxPollNow();
	await flush();
	assert.equal(h.posts.length, 0, "retired poller must not poll again");

	const gone = await loadPoller({ extensionInvalidated: true });
	await gone.window.snIxPollNow();
	await flush();
	await flush();
	assert.ok(gone.logs.some(entry => entry.includes("orphaned poller retired")), gone.logs.join("\n"));
	assert.equal(gone.posts.length, 0, "a poller without a chrome binding must retire");
});

test("health monitor alerts once when polling goes stale and again on recovery", async () => {
	const w = await createWorker();
	let tabCount = 1;
	w.chrome.tabs.query = async () => Array.from({ length: tabCount }, (_, i) => ({ id: i + 1 }));
	const notifications = w.notifications;
	const stored = () => w.storage.dump();
	const tick = async () => { await w.app.onAlarm({ name: "snIxHealthCheck" }); await flush(); await flush(); };
	const health = () => notifications.filter(n => n.id === "snIxHealth");

	await tick();
	assert.equal(health().length, 0, "a fresh start is not an outage");

	w.storage.put("ix.lastSuccessfulPollAt", Date.now() - 240000 - 60000);
	w.storage.put("ix.healthStateV1", { startedAt: Date.now() - 240000 - 120000 });
	await w.deliver(w.chrome, { feature: FEATURE, type: "log", event: "poll-failed", detail: "HTTP 401", level: "warn" },
		w.contentSender(w.PROD, { id: w.chrome.runtime.id, path: "/x" }));
	await tick();
	assert.equal(health().length, 1);
	assert.match(health()[0].options.title, /stopped working/);
	assert.match(health()[0].options.message, /HTTP 401/);
	await tick();
	assert.equal(health().length, 1, "one alert per outage");

	tabCount = 0;
	await tick();
	assert.equal(health().length, 1, "no ServiceNow tab means no monitoring and no alert");
	assert.equal(stored()["ix.healthStateV1"].alerted, false);
	tabCount = 1;
	await tick();
	assert.equal(health().length, 1, "opening a tab restarts the grace period");

	w.storage.put("ix.lastSuccessfulPollAt", Date.now() - 1000);
	w.storage.put("ix.healthStateV1", { startedAt: Date.now() - 1000, alerted: true });
	await tick();
	assert.equal(health().length, 2);
	assert.match(health()[1].options.title, /working again/);
	await tick();
	assert.equal(health().length, 2, "recovery is announced once");
	// Milo: the instance label is derived from the configured production origin (no committed host name)
	assert.equal(health()[0].options.title, "ServiceNow Interaction Alert (Prod) stopped working");
	assert.equal(health()[0].options.iconUrl, `chrome-extension://${w.chrome.runtime.id}/features/interaction-alert/icons/alert.png`);
});

// ---- Milo lifecycle: MAIN bridge ------------------------------------------------------------------------------------
const pollRequest = (h, id = "r1", origin = h.location.origin) => h.listeners.message?.({
	source: h.window, origin, data: { source: "sn-ix-extension", type: "poll", id, accounts: ["Acme Oy"] }
});

test("bridge is inert (no listener, no fetch) until the feature is enabled; seed mode arms it too", async () => {
	const settings = mainSettingsStub({ enabled: false, seedOnly: false });
	const h = loadBridge({ settings });
	assert.equal(h.listeners.message, undefined, "no listener while disabled");
	assert.equal(h.window.__snIxBridge.active, false);
	settings.set({ enabled: false, seedOnly: true });
	assert.equal(h.window.__snIxBridge.active, true, "seed-silently migration poll needs the bridge");
	await pollRequest(h);
	assert.equal(h.fetches.length, 1);
	settings.set({ enabled: false, seedOnly: false });
	assert.equal(h.listeners.message, undefined);
	const none = loadBridge({ settings: null });
	assert.equal(none.listeners.message, undefined, "no settings helper ⇒ inert");
	assert.equal(none.window.__snIxBridge.active, false);
});

test("bridge disable during an in-flight fetch aborts it and never posts the obsolete result; re-enable works", async () => {
	const settings = mainSettingsStub();
	const releases = [];
	const release = () => releases.forEach(r => r());
	const signals = [];
	const h = loadBridge({ settings, fetchImpl: async (url, options) => {
		signals.push(options.signal);
		await new Promise(r => releases.push(r));
		return { ok: true, status: 200, json: async () => ({ result: [{ sys_id: "a".repeat(32), number: "X" }] }) };
	} });
	const pending = pollRequest(h, "late");
	await flush();
	settings.set({ enabled: false, seedOnly: false });
	assert.equal(signals.length, 1);
	assert.ok(signals.every(s => s.aborted), "in-flight fetches aborted");
	release();
	await pending;
	assert.equal(h.posts.length, 0, "obsolete result dropped");
	settings.set({ enabled: true, seedOnly: false });
	assert.equal(typeof h.listeners.message, "function");
});

test("bridge double injection: the new bridge replaces the old one (one listener, old one stopped)", async () => {
	const settings = mainSettingsStub();
	const first = loadBridge({ settings, results: { interaction: [{ sys_id: "a".repeat(32), number: "A" }] } });
	const oldBridge = first.window.__snIxBridge;
	const oldListener = first.listeners.message;
	const second = loadBridge({ existing: first });
	assert.notEqual(second.window.__snIxBridge, oldBridge);
	assert.equal(oldBridge.active, false, "previous bridge stopped");
	assert.notEqual(first.listeners.message, oldListener, "only the new named listener remains");
	assert.equal(settings.cbs.size, 1, "old settings subscription dropped");
	await pollRequest(second, "after-takeover");
	assert.equal(second.posts.length, 1, "exactly one answer");
});

// ---- Milo lifecycle: ISOLATED poller ---------------------------------------------------------------------------------
test("poller is inert without a settings controller and while disabled; start/stop are idempotent and clean", async () => {
	const w = await createWorker();
	const h = await loadPoller({ worker: w });
	assert.equal(typeof h.listeners.message, "function", "enabled: named listener installed");
	const sub = h.milo.subs.find(s => s.feature === FEATURE);
	assert.equal(sub.options.allowSeedOnly, true);
	sub.handlers.start({ enabled: true, mode: "enabled" }); // idempotent
	sub.handlers.stop("disabled");
	assert.equal(h.listeners.message, undefined, "listener removed on stop");
	await h.window.snIxPollNow();
	await flush();
	assert.equal(h.messages.length, 0, "stopped poller sends nothing");
	assert.equal(h.context.__snIxController.active, false);
	sub.handlers.start({ enabled: true, mode: "enabled" });
	assert.equal(typeof h.listeners.message, "function");
	// same isolated world reinjection while live: no-op (keeps the live poller and its in-flight request)
	const before = h.context.__snIxController;
	vm.runInContext(fs.readFileSync(CONTENT, "utf8"), h.context);
	assert.equal(h.context.__snIxController, before);
	assert.equal(h.milo.subs.length, 1, "no second subscription");
	// no controller ⇒ nothing at all
	const ctx = vm.createContext({ chrome: { runtime: { id: "x", sendMessage() { throw new Error("must not send"); } } }, window: { addEventListener() { throw new Error("must not listen"); } }, console, crypto, location: { origin: w.PROD }, setTimeout() { throw new Error("no timers"); }, setInterval() { throw new Error("no timers"); } });
	vm.runInContext(fs.readFileSync(CONTENT, "utf8"), ctx);
});

test("poller stop during an in-flight request drops the late result (no rows message after disable)", async () => {
	const h = await loadPoller({ stored: { "ix.lastPollAt": 0 } });
	await h.window.snIxPollNow();
	await flush();
	const request = h.posts.find(p => p.data.type === "poll").data;
	const listener = h.listeners.message;
	h.milo.subs[0].handlers.stop("disabled");
	await listener({ source: h.window, origin: h.worker.PROD, data: { source: "sn-ix-page", type: "poll-result", id: request.id, rows: [] } });
	await flush();
	assert.equal(h.messages.filter(m => m.type === "rows").length, 0);
});

test("bridge: no accounts polls nothing; invalid accounts are refused without any request", async () => {
	const h = loadBridge({ results: {} });
	const poll = (id, accounts) => h.listeners.message({ source: h.window, origin: h.location.origin, data: { source: "sn-ix-extension", type: "poll", id, accounts } });
	await poll("none", []);
	assert.equal(h.fetches.length, 0);
	assert.deepEqual(JSON.parse(JSON.stringify(h.posts[0].data.rows)), []);
	for (const [i, accounts] of [undefined, "x", [""], ["a^ORactive=false"], [1], Array(21).fill("Acme Oy")].entries()) {
		await poll(`bad${i}`, accounts);
		assert.match(h.posts.at(-1).data.error, /invalid accounts/, JSON.stringify(accounts));
	}
	assert.equal(h.fetches.length, 0, "an invalid account never reaches the API");
});
