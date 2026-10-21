// Migrated from the original standalone critical alert extension 3.3 test.js.
// Every original test keeps its name and assertions; adaptations (module boundary, worker-owned heartbeat):
//   - explicit paths (path.join(__dirname, ...)) instead of cwd-relative "page.js"/"content.js"/"background.js";
//   - a sanitized example origin (tests/helpers/fake-chrome.mjs PROD) instead of the private production host;
//   - page.js gets an enabled MAIN settings stub (window.__snMiloMainSettings) and the window stub gains
//     removeEventListener: the Milo bridge is inert until the feature is enabled;
//   - content.js gets an enabled ISOLATED settings-controller stub (globalThis.__snMiloController) and its
//     chrome.runtime.sendMessage is routed through the REAL router (shared/router.mjs) + the REAL worker module
//     (background.mjs): the heartbeat lives in the worker as `crit.lastPollAt` (claim-poll / release-poll), so
//     "storage" assertions read the worker storage; snTkRows/snTkLog are now {feature:'critical-alert', type:'rows'|'log'};
//   - the background tests drive the real router + module (createCriticalAlert) instead of evaluating a classic
//     background.js with global listeners; storage keys follow the collision inventory (crit.healthStateV1,
//     crit.lastSuccessfulPollAt, health notification snCritHealth); dedupe key seenMatchesV4 unchanged;
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
const FEATURE = "critical-alert";
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
	const { createCriticalAlert } = await featureModule();
	const storage = createFakeStorage({ "crit.migrationV1": READY, ...stored });
	const { chrome, calls } = createFakeChrome({ storage });
	const notifications = [];
	chrome.notifications.create = async (id, options) => { notifications.push({ id, options }); return id; };
	if (failHeartbeatGet) {
		const get = chrome.storage.local.get;
		chrome.storage.local.get = async keys => { if ([].concat(keys).includes("crit.lastPollAt")) throw new Error("storage failed"); return get(keys); };
	}
	const module = createCriticalAlert({ console: { log() {}, info() {}, warn() {}, error() {} } });
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
	const sender = w.contentSender(w.PROD, { id: w.chrome.runtime.id, path: "/now/platform-analytics-workspace/dashboard" });
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
test("poller keeps the account field from every API shape", async () => {
	const h = await loadPoller({ stored: { "crit.lastPollAt": 0 } });
	await h.window.snTkPollNow();
	await flush();
	await flush();
	const request = h.posts.find(p => p.data.type === "poll").data;
	await h.listeners.message({
		source: h.window,
		origin: h.worker.PROD,
		data: {
			source: "sn-tk-page", type: "poll-result", id: request.id,
			rows: [
				{ sys_id: "a".repeat(32), number: "CSTK1", priority: "1 - Critical", state: "New",
					account: { display_value: "  Acme Oy  ", link: "https://example/x" } },
				{ sys_id: "b".repeat(32), number: "CSTK2", priority: "1 - Critical", state: "New", account: "Acme Oy" },
				{ sys_id: "c".repeat(32), number: "CSTK3", priority: "1 - Critical", state: "New" }
			]
		}
	});
	await flush();
	const rowsMessage = h.messages.find(m => m.type === "rows");
	assert.equal(rowsMessage.rows[0].account, "Acme Oy", "object shape must be unwrapped and trimmed");
	assert.equal(rowsMessage.rows[1].account, "Acme Oy", "string shape must pass through");
	assert.equal(rowsMessage.rows[2].account, "", "missing account must become empty string, not undefined");
});

test("opaque-origin frames are ignored instead of calling postMessage with null", async () => {
	assert.equal(loadBridge({ origin: "null" }).listeners.message, undefined);
	assert.equal((await loadPoller({ origin: "null" })).window.snTkPollNow, undefined);
});

test("bridge queries CSM tables directly and merges rows", async () => {
	const h = loadBridge({
		results: {
			sn_customerservice_case: [{ sys_id: "a".repeat(32), number: "CSTK1" }],
			sn_customerservice_task: [{ sys_id: "b".repeat(32), number: "CSTASK1" }]
		}
	});
	await h.listeners.message({
		source: h.window,
		origin: h.location.origin,
		data: { source: "sn-tk-extension", type: "poll", id: "request-1", rules: [{ priority: "1", account: "" }] }
	});
	assert.equal(h.fetches.length, 2, "bridge must query the case and task tables");
	assert.match(h.fetches[0].url, /^\/api\/now\/table\/sn_customerservice_case\?/);
	assert.match(h.fetches[1].url, /^\/api\/now\/table\/sn_customerservice_task\?/);
	assert.equal(h.fetches[0].options.headers["X-UserToken"], "test-token");
	assert.match(decodeURIComponent(h.fetches[0].url), /\^active=true\^state=1\^priority=1&sysparm_fields=/);
	assert.match(decodeURIComponent(h.fetches[0].url), /sysparm_fields=sys_id,number,priority,state,short_description,account/);
	assert.deepEqual(
		JSON.parse(JSON.stringify(h.posts[0].data.rows.map(row => row.number))),
		["CSTK1", "CSTASK1"]
	);
	assert.equal(h.posts[0].data.id, "request-1");
});

test("bridge: one query per rule and table, overlapping tickets merged, account is a query condition", async () => {
	const h = loadBridge({
		results: {
			sn_customerservice_case: [{ sys_id: "a".repeat(32), number: "CSTK1" }],
			sn_customerservice_task: []
		}
	});
	await h.listeners.message({
		source: h.window, origin: h.location.origin,
		data: { source: "sn-tk-extension", type: "poll", id: "multi", rules: [{ priority: "1", account: "" }, { priority: "", account: "Acme Oy" }] }
	});
	assert.equal(h.fetches.length, 4);
	const urls = h.fetches.map(f => decodeURIComponent(f.url));
	assert.ok(urls[0].includes("^state=1^priority=1&"));
	assert.ok(urls[2].includes("^state=1^account.name=Acme Oy&"));
	assert.ok(urls.every(u => u.includes("assignment_group=") && u.includes("^active=true^state=1")));
	assert.deepEqual(JSON.parse(JSON.stringify(h.posts[0].data.rows.map(row => row.number))), ["CSTK1"], "same ticket from two rules is returned once");
});

test("bridge: no enabled rules polls nothing; invalid rules are refused without any request", async () => {
	const h = loadBridge({ results: {} });
	await h.listeners.message({ source: h.window, origin: h.location.origin, data: { source: "sn-tk-extension", type: "poll", id: "none", rules: [] } });
	assert.equal(h.fetches.length, 0);
	assert.deepEqual(JSON.parse(JSON.stringify(h.posts[0].data.rows)), []);
	for (const [i, rules] of [undefined, "x", [{ priority: "9", account: "" }], [{ priority: "", account: "a^ORactive=false" }], [{ priority: "", account: "" }], Array(11).fill({ priority: "1", account: "" })].entries()) {
		await h.listeners.message({ source: h.window, origin: h.location.origin, data: { source: "sn-tk-extension", type: "poll", id: `bad${i}`, rules } });
		assert.match(h.posts.at(-1).data.error, /invalid alert rules/, JSON.stringify(rules));
	}
	assert.equal(h.fetches.length, 0, "an invalid rule never reaches the API");
});

test("bridge returns rows from the healthy table when the other fails", async () => {
	const h = loadBridge({
		results: { sn_customerservice_case: [{ sys_id: "c".repeat(32), number: "CSTK9" }] },
		failTables: ["sn_customerservice_task"]
	});
	await h.listeners.message({
		source: h.window,
		origin: h.location.origin,
		data: { source: "sn-tk-extension", type: "poll", id: "request-2b", rules: [{ priority: "1", account: "" }] }
	});
	assert.equal(h.posts[0].data.error, undefined);
	assert.deepEqual(
		JSON.parse(JSON.stringify(h.posts[0].data.rows.map(row => row.number))),
		["CSTK9"]
	);
	assert.match(h.posts[0].data.warning, /sn_customerservice_task/);
});

test("bridge reports an error only when every table query fails", async () => {
	const h = loadBridge({ failTables: ["sn_customerservice_case", "sn_customerservice_task"] });
	await h.listeners.message({
		source: h.window,
		origin: h.location.origin,
		data: { source: "sn-tk-extension", type: "poll", id: "request-2c", rules: [{ priority: "1", account: "" }] }
	});
	assert.match(h.posts[0].data.error, /HTTP 500/);
	assert.equal(h.posts[0].data.rows, undefined);
});

test("bridge reports missing page session token without fetching", async () => {
	const h = loadBridge({ token: "" });
	await h.listeners.message({
		source: h.window,
		origin: h.location.origin,
		data: { source: "sn-tk-extension", type: "poll", id: "request-2", rules: [{ priority: "1", account: "" }] }
	});
	assert.equal(h.fetches.length, 0);
	assert.match(h.posts[0].data.error, /g_ck/);
});

test("bridge rejects messages from another origin", async () => {
	const h = loadBridge();
	await h.listeners.message({
		source: h.window,
		origin: "https://evil.example",
		data: { source: "sn-tk-extension", type: "poll", id: "request-3", rules: [{ priority: "1", account: "" }] }
	});
	assert.equal(h.fetches.length, 0);
	assert.equal(h.posts.length, 0);
});

const RULES = { schema: 1, rules: [
	{ id: "critical", name: "Critical", enabled: true, priority: "1", account: "" },
	{ id: "acme", name: "Acme", enabled: true, priority: "", account: "Acme Oy" }
] };
test("background alerts only on New + a matching enabled rule and deduplicates", async () => {
	const w = await createWorker({ stored: { "crit.rulesV1": RULES } });
	const notifications = w.notifications;
	const stored = () => w.storage.dump();
	const sender = w.contentSender(w.PROD, { id: w.chrome.runtime.id, path: "/now/platform-analytics-workspace/dashboard" });
	const rows = [
		{ sys_id: "1".repeat(32), number: "HIGH-OTHER", priority: "2 - High", state: "New", short_description: "alert", account: "Metsä Oy" },
		{ sys_id: "2".repeat(32), number: "HIGH-HOLD", priority: "2 - High", state: "On Hold", short_description: "no", account: "Acme Oy" },
		{ sys_id: "3".repeat(32), number: "CRIT-NEW", priority: "1 - Critical", state: "New", short_description: "production later", account: "Acme Oy" },
		{ sys_id: "5".repeat(32), number: "CRIT-HOLD", priority: "1 - Critical", state: "On Hold", short_description: "wrong state", account: "Metsä Oy" },
		{ sys_id: "6".repeat(32), number: "LOW-NO-ACCT", priority: "4 - Low", state: "New", short_description: "no account", account: "" }
	];
	async function send(input = rows, snd = sender) {
		const r = await w.deliver(w.chrome, { feature: FEATURE, type: "rows", rows: input }, snd);
		assert.equal(r.keptOpen, true);
		return r.response;
	}
	assert.equal((await send()).ok, true);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].options.message.startsWith("CRIT-NEW"), true);
	assert.ok(notifications[0].options.message.includes("Account: Acme Oy"), "notification must name the account");
	assert.ok(notifications[0].options.message.includes("Rule: Critical, Acme"), "notification names every matching rule");
	assert.equal((await send()).ok, true);
	assert.equal(notifications.length, 1, "same match must not notify twice");
	await w.module.idle();
	assert.ok(stored().diagnosticLogsV1.some(entry =>
		entry.event === "notification-created" && entry.number === "CRIT-NEW"));
	assert.ok(stored().diagnosticLogsV1.some(entry =>
		entry.event === "poll-result" &&
		entry.matches.some(match => match.number === "CRIT-NEW" && match.status === "already-seen")));
	assert.equal((await send([])).ok, true);
	assert.equal((await send()).ok, true);
	assert.equal(notifications.length, 1, "seen matches must remain suppressed after leaving the queue");

	// any Critical (other account) and any Acme Oy ticket (non-critical) both alert
	await send([
		{ sys_id: "7".repeat(32), number: "CRIT-ANY-ACCT", priority: "1 - Critical", state: "New", short_description: "", account: "Metsä Oy" },
		{ sys_id: "8".repeat(32), number: "ACME-LOW", priority: "4 - Low", state: "New", short_description: "", account: "Acme Oy" }
	]);
	assert.deepEqual(notifications.slice(1).map(n => n.options.message.split("\n")[0].split(" ")[0]), ["CRIT-ANY-ACCT", "ACME-LOW"]);
	notifications.splice(1, 2);

	const otherSender = w.contentSender(w.PROD, { id: w.chrome.runtime.id, path: "/any-page.do" });
	const freshRow = { sys_id: "4".repeat(32), number: "CRIT-OTHER", priority: "1 - Critical", state: "New", short_description: "", account: "Acme Oy" };
	assert.equal((await send([freshRow], otherSender)).ok, true);
	assert.equal(notifications.length, 2, "alerts must work from any ServiceNow page");

	w.storage.put("seenMatchesV4", Array.from({ length: 2000 }, (_, index) =>
		`${index.toString(16).padStart(32, "0")}|1 - Critical|New|Acme Oy`));
	const overflow = { sys_id: "f".repeat(32), number: "CRIT-OVERFLOW", priority: "1 - Critical", state: "New", short_description: "", account: "Acme Oy" };
	assert.equal((await send([overflow])).ok, true);
	assert.equal(stored().seenMatchesV4.length, 2001, "permanent dedupe must not evict older tickets");

	w.storage.put("seenMatchesV4", []);
	notifications.length = 0;
	const concurrent = { sys_id: "e".repeat(32), number: "CRIT-CONCURRENT", priority: "1 - Critical", state: "New", short_description: "", account: "Acme Oy" };
	assert.deepEqual((await Promise.all([send([concurrent]), send([concurrent])])).map(result => result.ok), [true, true]);
	assert.equal(notifications.length, 1, "concurrent tabs must not duplicate an alert");
	// notification click action (original onClicked): task.do for the row's sys_id
	await w.app.onNotificationClicked(`snTk-${"e".repeat(32)}`);
	assert.deepEqual(w.calls.filter(c => c[0] === "tabs.create"), [["tabs.create", `${w.PROD}/task.do?sys_id=${"e".repeat(32)}`]]);
});

test("poller heartbeat: a fresh heartbeat in another tab skips the tick", async () => {
	const h = await loadPoller({ stored: { "crit.lastPollAt": Date.now() } });
	await h.window.snTkPollNow();
	await flush();
	await flush();
	assert.equal(h.posts.filter(p => p.data.type === "poll").length, 0, "fresh heartbeat must suppress the tick");
});

test("poller heartbeat: a stale heartbeat is claimed and polling starts", async () => {
	const h = await loadPoller({ stored: { "crit.lastPollAt": 0 } });
	await h.window.snTkPollNow();
	await flush();
	await flush();
	assert.equal(h.posts.filter(p => p.data.type === "poll").length, 1);
	assert.ok(h.storage["crit.lastPollAt"] > Date.now() - 60000, "claim must write a heartbeat");
});

test("poller heartbeat: a future timestamp after a clock correction is stale", async () => {
	const h = await loadPoller({ stored: { "crit.lastPollAt": Date.now() + 3600000 } });
	await h.window.snTkPollNow();
	await flush();
	assert.equal(h.posts.filter(p => p.data.type === "poll").length, 1);
});

test("failed polls release the heartbeat before retrying", async () => {
	const apiFailure = await loadPoller({ stored: { "crit.lastPollAt": 0 } });
	await apiFailure.window.snTkPollNow();
	const request = apiFailure.posts.find(p => p.data.type === "poll").data;
	apiFailure.listeners.message({
		source: apiFailure.window,
		origin: apiFailure.worker.PROD,
		data: { source: "sn-tk-page", type: "poll-result", id: request.id, error: "failed" }
	});
	await flush();
	assert.equal(apiFailure.storage["crit.lastPollAt"], 0);
	assert.ok(apiFailure.timers.some(timer => timer.delay === 10000));

	const timeout = await loadPoller({ stored: { "crit.lastPollAt": 0 } });
	await timeout.window.snTkPollNow();
	await timeout.timers.find(timer => timer.delay === 30000).callback();
	await flush();
	assert.equal(timeout.storage["crit.lastPollAt"], 0);

	const backgroundFailure = await loadPoller({ stored: { "crit.lastPollAt": 0 }, failRowSend: true });
	await backgroundFailure.window.snTkPollNow();
	const backgroundRequest = backgroundFailure.posts.find(p => p.data.type === "poll").data;
	await assert.doesNotReject(() => backgroundFailure.listeners.message({
		source: backgroundFailure.window,
		origin: backgroundFailure.worker.PROD,
		data: { source: "sn-tk-page", type: "poll-result", id: backgroundRequest.id, rows: [] }
	}));
	await flush();
	assert.equal(backgroundFailure.storage["crit.lastPollAt"], 0);
	assert.ok(backgroundFailure.timers.some(timer => timer.delay === 10000));
});

test("poll startup failures are logged without an unhandled rejection", async () => {
	const h = await loadPoller({ failStorageGet: true });
	await assert.doesNotReject(() => h.window.snTkPollNow());
	assert.equal(h.posts.length, 0);
	// Milo: the start failure follows the full failure path (release → log → RETRY_MS)
	await flush();
	assert.ok(h.messages.some(m => m.type === "release-poll"));
	assert.ok(h.messages.some(m => m.type === "log" && m.event === "poll-start-failed"));
	assert.ok(h.timers.some(timer => timer.delay === 10000));
});

test("orphaned poller retires quietly after extension reload", async () => {
	const h = await loadPoller({ failClaimInvalidated: true });
	await h.window.snTkPollNow();
	await flush();
	await flush();
	await flush();
	assert.ok(h.logs.some(entry => entry.includes("orphaned poller retired")), h.logs.join("\n"));
	assert.equal(h.posts.length, 0);

	await h.window.snTkPollNow();
	await flush();
	assert.equal(h.posts.length, 0, "retired poller must not poll again");

	const gone = await loadPoller({ extensionInvalidated: true });
	await gone.window.snTkPollNow();
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
	const tick = async () => { await w.app.onAlarm({ name: "snTkHealthCheck" }); await flush(); await flush(); };
	const health = () => notifications.filter(n => n.id === "snCritHealth");

	await tick();
	assert.equal(health().length, 0, "a fresh start is not an outage");

	w.storage.put("crit.lastSuccessfulPollAt", Date.now() - 360000 - 60000);
	w.storage.put("crit.healthStateV1", { startedAt: Date.now() - 360000 - 120000 });
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
	assert.equal(stored()["crit.healthStateV1"].alerted, false);
	tabCount = 1;
	await tick();
	assert.equal(health().length, 1, "opening a tab restarts the grace period");

	w.storage.put("crit.lastSuccessfulPollAt", Date.now() - 1000);
	w.storage.put("crit.healthStateV1", { startedAt: Date.now() - 1000, alerted: true });
	await tick();
	assert.equal(health().length, 2);
	assert.match(health()[1].options.title, /working again/);
	await tick();
	assert.equal(health().length, 2, "recovery is announced once");
	// Milo: the instance label is derived from the configured production origin (no committed host name)
	assert.equal(health()[0].options.title, "ServiceNow Critical Alert (Prod) stopped working");
	assert.equal(health()[0].options.iconUrl, `chrome-extension://${w.chrome.runtime.id}/features/critical-alert/icons/alert.png`);
});

// ---- Milo lifecycle: MAIN bridge ------------------------------------------------------------------------------------
const pollRequest = (h, id = "r1", origin = h.location.origin) => h.listeners.message?.({
	source: h.window, origin, data: { source: "sn-tk-extension", type: "poll", id, rules: [{ priority: "1", account: "" }] }
});

test("bridge is inert (no listener, no fetch) until the feature is enabled; seed mode arms it too", async () => {
	const settings = mainSettingsStub({ enabled: false, seedOnly: false });
	const h = loadBridge({ settings });
	assert.equal(h.listeners.message, undefined, "no listener while disabled");
	assert.equal(h.window.__snTkBridge.active, false);
	settings.set({ enabled: false, seedOnly: true });
	assert.equal(h.window.__snTkBridge.active, true, "seed-silently migration poll needs the bridge");
	await pollRequest(h);
	assert.equal(h.fetches.length, 2);
	settings.set({ enabled: false, seedOnly: false });
	assert.equal(h.listeners.message, undefined);
	const none = loadBridge({ settings: null });
	assert.equal(none.listeners.message, undefined, "no settings helper ⇒ inert");
	assert.equal(none.window.__snTkBridge.active, false);
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
	assert.equal(signals.length, 2);
	assert.ok(signals.every(s => s.aborted), "in-flight fetches aborted");
	release();
	await pending;
	assert.equal(h.posts.length, 0, "obsolete result dropped");
	settings.set({ enabled: true, seedOnly: false });
	assert.equal(typeof h.listeners.message, "function");
});

test("bridge double injection: the new bridge replaces the old one (one listener, old one stopped)", async () => {
	const settings = mainSettingsStub();
	const first = loadBridge({ settings, results: { sn_customerservice_case: [{ sys_id: "a".repeat(32), number: "A" }] } });
	const oldBridge = first.window.__snTkBridge;
	const oldListener = first.listeners.message;
	const second = loadBridge({ existing: first });
	assert.notEqual(second.window.__snTkBridge, oldBridge);
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
	await h.window.snTkPollNow();
	await flush();
	assert.equal(h.messages.length, 0, "stopped poller sends nothing");
	assert.equal(h.context.__snTkController.active, false);
	sub.handlers.start({ enabled: true, mode: "enabled" });
	assert.equal(typeof h.listeners.message, "function");
	// same isolated world reinjection while live: no-op (keeps the live poller and its in-flight request)
	const before = h.context.__snTkController;
	vm.runInContext(fs.readFileSync(CONTENT, "utf8"), h.context);
	assert.equal(h.context.__snTkController, before);
	assert.equal(h.milo.subs.length, 1, "no second subscription");
	// no controller ⇒ nothing at all
	const ctx = vm.createContext({ chrome: { runtime: { id: "x", sendMessage() { throw new Error("must not send"); } } }, window: { addEventListener() { throw new Error("must not listen"); } }, console, crypto, location: { origin: w.PROD }, setTimeout() { throw new Error("no timers"); }, setInterval() { throw new Error("no timers"); } });
	vm.runInContext(fs.readFileSync(CONTENT, "utf8"), ctx);
});

test("poller stop during an in-flight request drops the late result (no rows message after disable)", async () => {
	const h = await loadPoller({ stored: { "crit.lastPollAt": 0 } });
	await h.window.snTkPollNow();
	await flush();
	const request = h.posts.find(p => p.data.type === "poll").data;
	const listener = h.listeners.message;
	h.milo.subs[0].handlers.stop("disabled");
	await listener({ source: h.window, origin: h.worker.PROD, data: { source: "sn-tk-page", type: "poll-result", id: request.id, rows: [] } });
	await flush();
	assert.equal(h.messages.filter(m => m.type === "rows").length, 0);
});

test("rules: get-rules hands out only enabled conditions; disabled/edited rules change what alerts; default is Critical", async () => {
	const w = await createWorker();
	const sender = w.contentSender(w.PROD, { id: w.chrome.runtime.id, path: "/x" });
	const ask = async () => (await w.deliver(w.chrome, { feature: FEATURE, type: "get-rules" }, sender)).response;
	assert.deepEqual(await ask(), { ok: true, rules: [{ priority: "1", account: "" }] }, "no stored rules: default Critical rule");
	w.storage.put("crit.rulesV1", { schema: 1, rules: [
		{ id: "a", name: "A", enabled: true, priority: "", account: "Acme Oy" },
		{ id: "b", name: "B", enabled: false, priority: "2", account: "" },
		{ id: "c", name: "C", enabled: true, priority: "", account: "acme oy" }
	] });
	assert.deepEqual(await ask(), { ok: true, rules: [{ priority: "", account: "Acme Oy" }] }, "disabled rules and duplicates are not queried");
	const crit = { sys_id: "9".repeat(32), number: "CRIT-9", priority: "1 - Critical", state: "New", short_description: "", account: "Other" };
	const acme = { sys_id: "8".repeat(32), number: "ACME-8", priority: "3 - Moderate", state: "New", short_description: "", account: "ACME OY" };
	await w.deliver(w.chrome, { feature: FEATURE, type: "rows", rows: [crit, acme] }, sender);
	assert.deepEqual(w.notifications.map(n => n.options.message.split(" ")[0]), ["ACME-8"], "Critical is off in this rule set; account compares case-insensitively");
	w.storage.put("crit.rulesV1", { schema: 1, rules: [] });
	assert.deepEqual(await ask(), { ok: true, rules: [] });
	w.storage.put("crit.rulesV1", "garbage");
	assert.deepEqual(await ask(), { ok: true, rules: [{ priority: "1", account: "" }] }, "malformed storage falls back to the default rule instead of going silent");
});
