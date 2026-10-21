// Migrated from the original standalone Informatica button extension 1.1.0 test.js.
// The two original tests keep their names and every assertion. Adaptations only:
//   - explicit path to page.js (path.join(__dirname, ...)) instead of the cwd-relative "page.js";
//   - a sanitized example origin instead of the private production host (the Milo bridge uses location.origin; the
//     production-only scope comes from the generated manifest matches + the worker-scoped effective settings);
//   - an enabled MAIN settings stub (window.__snMiloMainSettings), because the Milo bridge is inert (no listener)
//     until the informatica-button feature is enabled.
// The tests after the migrated pair cover the Milo lifecycle of the bridge (inert while disabled, disable/re-enable,
// double injection, obsolete fetch results).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PAGE = path.join(__dirname, "page.js");
const ORIGIN = "https://example.service-now.com";
const FEATURE = "informatica-button";

function settingsStub(initial = true) {
	const cbs = new Set();
	let state = initial;
	const api = {
		subscribe(feature, cb) {
			if (feature !== FEATURE) return () => {};
			cbs.add(cb);
			if (state !== null) cb({ enabled: state, seedOnly: false });
			return () => cbs.delete(cb);
		},
		get: feature => (feature === FEATURE && state !== null ? { enabled: state, seedOnly: false } : null)
	};
	return { api, cbs, set(v) { state = v; for (const cb of [...cbs]) cb({ enabled: v, seedOnly: false }); } };
}

function loadBridge({ token = "tok", origin = ORIGIN, ok = true, value = "a@x.com", settings = settingsStub(true), window: existing, fetchImpl } = {}) {
	const listeners = existing ? existing.__listeners : []; const posts = existing ? existing.__posts : []; const fetches = existing ? existing.__fetches : [];
	const window = existing || {
		g_ck: token,
		__listeners: listeners, __posts: posts, __fetches: fetches,
		addEventListener(t, l) { listeners.push(l); },
		removeEventListener(t, l) { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); },
		postMessage(data, o) { posts.push({ data, o }); }
	};
	window.window = window;
	if (settings && !existing) window.__snMiloMainSettings = settings.api;
	const context = existing ? existing.__context : vm.createContext({
		window, location: { origin }, AbortController, setTimeout, clearTimeout,
		fetch: fetchImpl || (async (url, opts) => { fetches.push({ url, opts }); return { ok, status: ok ? 200 : 500, json: async () => ({ result: { u_external_work_notes_list: value } }) }; })
	});
	window.__context = context;
	vm.runInContext(fs.readFileSync(PAGE, "utf8"), context);
	return { listeners, posts, fetches, window, settings };
}
const req = (h, extra = {}, origin = ORIGIN) => h.listeners[0]({
	source: h.window, origin,
	data: { source: "sn-inf-extension", type: "fetch-list", id: "r1", table: "incident", sysId: "a".repeat(32), ...extra }
});

// ---- migrated original tests -------------------------------------------------------------------------------------
test("bridge reads only the external list field of the requested record", async () => {
	const h = loadBridge(); await req(h);
	assert.equal(h.fetches.length, 1);
	assert.equal(h.fetches[0].url, `/api/now/table/incident/${"a".repeat(32)}?sysparm_fields=u_external_work_notes_list`);
	assert.equal(h.fetches[0].opts.headers["X-UserToken"], "tok");
	assert.equal(h.posts[0].data.value, "a@x.com");
	assert.equal(h.posts[0].o, ORIGIN);
});
test("bridge rejects bad refs, foreign origins, missing token and opaque frames", async () => {
	let h = loadBridge(); await req(h, { table: "incident/../x" });
	assert.match(h.posts[0].data.error, /invalid/); assert.equal(h.fetches.length, 0);
	h = loadBridge(); await req(h, {}, "https://evil.example");
	assert.equal(h.fetches.length, 0); assert.equal(h.posts.length, 0);
	h = loadBridge({ token: "" }); await req(h);
	assert.match(h.posts[0].data.error, /g_ck/);
	assert.equal(loadBridge({ origin: "null" }).listeners.length, 0);
	h = loadBridge({ ok: false }); await req(h);
	assert.match(h.posts[0].data.error, /HTTP 500/);
});

// ---- Milo lifecycle ----------------------------------------------------------------------------------------------
test("bridge is read-only: GET with same-origin credentials, no method/body; foreign window sources are ignored", async () => {
	const h = loadBridge(); await req(h);
	assert.equal(h.fetches[0].opts.method, undefined);
	assert.equal(h.fetches[0].opts.body, undefined);
	assert.equal(h.fetches[0].opts.credentials, "same-origin");
	await h.listeners[0]({ source: {}, origin: ORIGIN, data: { source: "sn-inf-extension", type: "fetch-list", id: "r2", table: "incident", sysId: "a".repeat(32) } });
	assert.equal(h.fetches.length, 1, "message from another window ignored");
});

test("bridge is inert until enabled: no listener while disabled, unknown, or without the Milo settings helper", () => {
	assert.equal(loadBridge({ settings: settingsStub(false) }).listeners.length, 0, "disabled");
	assert.equal(loadBridge({ settings: settingsStub(null) }).listeners.length, 0, "state not yet known");
	assert.equal(loadBridge({ settings: null }).listeners.length, 0, "no __snMiloMainSettings: fail closed");
	const s = settingsStub(null);
	const h = loadBridge({ settings: s });
	s.set(true);
	assert.equal(h.listeners.length, 1, "starts when the state arrives");
	assert.equal(h.window.__snInfBridge.active, true);
});

test("disable removes the named listener; re-enable installs exactly one; repeated enabled callbacks are idempotent", async () => {
	const h = loadBridge();
	const first = h.listeners[0];
	h.settings.set(true); h.settings.set(true);
	assert.equal(h.listeners.length, 1);
	h.settings.set(false);
	assert.equal(h.listeners.length, 0);
	assert.equal(h.window.__snInfBridge.active, false);
	await first({ source: h.window, origin: ORIGIN, data: { source: "sn-inf-extension", type: "fetch-list", id: "late", table: "incident", sysId: "a".repeat(32) } });
	assert.equal(h.fetches.length, 0, "a message queued before disable does not fetch after disable");
	assert.equal(h.posts.length, 0);
	for (const v of [true, false, true]) h.settings.set(v);
	assert.equal(h.listeners.length, 1);
	await req(h);
	assert.equal(h.fetches.length, 1);
	assert.equal(h.posts.length, 1);
});

test("disable during an in-flight fetch aborts it and drops the obsolete result (no response posted)", async () => {
	let release; let signal;
	const fetches = [];
	const h = loadBridge({ fetchImpl: (url, opts) => { fetches.push(url); signal = opts.signal; return new Promise(r => { release = () => r({ ok: true, status: 200, json: async () => ({ result: { u_external_work_notes_list: "x@y.z" } }) }); }); } });
	const pending = req(h);
	await new Promise(r => setImmediate(r));
	assert.equal(fetches.length, 1);
	h.settings.set(false);
	assert.equal(signal.aborted, true, "fetch aborted on disable");
	release();
	await pending;
	assert.equal(h.posts.length, 0, "obsolete result ignored");
	// enabled again before the old fetch settles: the old generation's result is still dropped
	h.settings.set(true);
	const pending2 = req(h, { id: "r2" });
	await new Promise(r => setImmediate(r));
	const release2 = release;
	h.settings.set(false); h.settings.set(true);
	release2();
	await pending2;
	assert.equal(h.posts.length, 0, "result of a previous enable generation ignored");
});

test("double injection in the same MAIN context: the new bridge replaces the old one, exactly one listener", async () => {
	const h = loadBridge();
	const old = h.window.__snInfBridge;
	loadBridge({ window: h.window });
	assert.notEqual(h.window.__snInfBridge, old);
	assert.equal(old.active, false);
	assert.equal(h.listeners.length, 1, "one listener after takeover");
	h.settings.set(false); h.settings.set(true);
	assert.equal(h.listeners.length, 1, "the old bridge's subscription was dropped (it does not re-add a listener)");
	await req(h);
	assert.equal(h.fetches.length, 1);
	assert.equal(h.posts.length, 1);
});

test("page.js is an IIFE: evaluating twice in one context declares no global lexical bindings", () => {
	const h = loadBridge();
	assert.doesNotThrow(() => loadBridge({ window: h.window }));
});

// ---- guarded resolve (the bridge's only write) --------------------------------------------------------------------
function resolveHarness({ record = {}, patchOk = true, applyPatch = true } = {}) {
	const rec = { number: "INC1", short_description: "AMS Informatica error: x", state: "1", close_code: "", close_notes: "", ...record };
	const calls = [];
	const h = loadBridge({ fetchImpl: async (url, opts = {}) => {
		calls.push({ url, method: opts.method || "GET", body: opts.body });
		if (opts.method === "PATCH") {
			if (!patchOk) return { ok: false, status: 403, json: async () => ({}) };
			if (applyPatch) Object.assign(rec, JSON.parse(opts.body));
		}
		return { ok: true, status: 200, json: async () => ({ result: { ...rec } }) };
	} });
	const send = async (extra = {}) => {
		await h.listeners[0]({ source: h.window, origin: ORIGIN,
			data: { source: "sn-inf-extension", type: "resolve-record", id: "z1", table: "incident", sysId: "a".repeat(32), notes: "Notes", ...extra } });
		return h.posts.map(p => p.data).filter(d => d.type === "resolve-record-result").pop();
	};
	return { h, rec, calls, send };
}

test("resolve-record: GET precheck, one PATCH with the fixed state/code + supplied notes, GET read-back", async () => {
	const r = resolveHarness();
	const out = await r.send();
	assert.deepEqual([out.ok, out.number, out.state], [true, "INC1", "6"]);
	assert.deepEqual(r.calls.map(c => c.method), ["GET", "PATCH", "GET"]);
	assert.deepEqual(JSON.parse(r.calls[1].body), { state: "6", close_code: "Solution provided", close_notes: "Notes" });
});

test("resolve-record refuses: wrong table, bad id, missing/odd notes, non-Informatica, not-open — and never PATCHes", async () => {
	for (const extra of [{ table: "problem" }, { sysId: "nope" }, { notes: "" }, { notes: "a\nb" }, { notes: "x".repeat(201) }]) {
		const r = resolveHarness();
		const out = await r.send(extra);
		assert.equal(out.ok, false, JSON.stringify(extra));
		assert.equal(r.calls.length, 0, "no request at all for an invalid reference");
	}
	for (const record of [{ short_description: "Printer broken" }, { state: "6" }, { state: "7" }, { state: "8" }]) {
		const r = resolveHarness({ record });
		const out = await r.send();
		assert.equal(out.ok, false);
		assert.equal(out.stage, "precheck");
		assert.ok(!r.calls.some(c => c.method === "PATCH"), JSON.stringify(record));
	}
});

test("resolve-record: a rejected or ignored PATCH is reported by the read-back, never retried", async () => {
	for (const opts of [{ patchOk: false }, { applyPatch: false }]) {
		const r = resolveHarness(opts);
		const out = await r.send();
		assert.equal(out.ok, false);
		assert.equal(out.stage, "verify");
		assert.equal(r.calls.filter(c => c.method === "PATCH").length, 1);
	}
});

test("resolve-record is inert while the feature is disabled and without g_ck", async () => {
	const settings = settingsStub(false);
	const h = loadBridge({ settings });
	assert.equal(h.listeners.length, 0, "no listener while disabled");
	const noTok = resolveHarness();
	noTok.h.window.g_ck = "";
	const out = await noTok.send();
	assert.equal(out.ok, false);
	assert.equal(noTok.calls.length, 0);
});
