// Informatica button — MAIN-world bridge (classic content script, IIFE). Migrated from
// the original standalone Informatica button extension 1.1.0 page.js; request/response protocol, validation and the single read-only
// GET are unchanged. Milo changes:
//   - origin: the original compared location.origin with a hard-coded production host. Here the production-only
//     scope comes from (1) the generated manifest matches (shared/script-policy.mjs, production origin only) and
//     (2) the worker-scoped effective state relayed by shared/main-settings.js, which reports this feature enabled
//     only on the configured production origin. Opaque/non-https frames exit immediately; replies target the exact
//     location.origin and requests must come from this window with event.origin === location.origin.
//   - lifecycle: inert until window.__snMiloMainSettings reports the feature enabled (no settings helper ⇒ inert).
//     Enable adds ONE named message listener; disable removes it, aborts in-flight fetches and bumps a generation so
//     an obsolete result is never posted. window.__snInfBridge stays a replaceable controller {stop(), active}; a
//     re-injected bridge stops the previous one (which also drops its settings subscription).
//   - globals/tags unchanged (window.__snInfBridge, 'sn-inf-extension'/'sn-inf-page'): Milo and the original
//     extension must not run on the same documents (enforced at cutover), so no rename is needed.
(() => {
	const FEATURE = "informatica-button";
	const ORIGIN = location.origin;
	if (typeof ORIGIN !== "string" || !/^https:\/\/[^/]+$/.test(ORIGIN)) return;

	// MAIN-world bridge: the only place that can read g_ck. It fetches one record's External work notes list
	// (read-only) so the content script can confirm the Save really persisted, and can run the guarded resolve below.
	const previous = window.__snInfBridge;
	const inflight = new Set();
	let listening = false;
	let stopped = false;
	let generation = 0;
	let unsubscribe = null;

	function enable() {
		if (stopped || listening) return;
		listening = true;
		generation++;
		window.addEventListener("message", onMessage);
	}
	function disable() {
		if (!listening) return;
		listening = false;
		generation++;
		window.removeEventListener("message", onMessage);
		for (const controller of [...inflight]) { try { controller.abort(); } catch {} }
		inflight.clear();
	}
	const controller = {
		stop() {
			stopped = true;
			disable();
			if (unsubscribe) { try { unsubscribe(); } catch {} unsubscribe = null; }
		},
		get active() { return listening; }
	};
	window.__snInfBridge = controller;

	async function onMessage(event) {
		if (!listening || event.source !== window || event.origin !== ORIGIN) return;
		const request = event.data;
		if (request?.source !== "sn-inf-extension" || typeof request.id !== "string" ||
			(request.type !== "fetch-list" && request.type !== "resolve-record")) return;
		if (request.type === "resolve-record") return resolveRecord(event, request);
		const gen = generation;
		const live = () => listening && !stopped && gen === generation;
		const respond = payload => {
			if (!live()) return; // disabled / replaced meanwhile: drop the obsolete answer
			window.postMessage({ source: "sn-inf-page", type: "fetch-list-result", id: request.id, ...payload }, ORIGIN);
		};
		if (!/^[a-z0-9_]{1,80}$/.test(request.table) || !/^[0-9a-f]{32}$/i.test(request.sysId)) {
			respond({ error: "invalid record reference" });
			return;
		}
		const token = window.g_ck;
		if (typeof token !== "string" || !token) {
			respond({ error: "g_ck is not available yet" });
			return;
		}
		const abort = typeof AbortController === "function" ? new AbortController() : null;
		if (abort) inflight.add(abort);
		try {
			const response = await fetch(
				`/api/now/table/${request.table}/${request.sysId}?sysparm_fields=u_external_work_notes_list`,
				{ credentials: "same-origin", headers: { "Accept": "application/json", "X-UserToken": token },
					...(abort ? { signal: abort.signal } : {}) });
			if (!live()) return;
			if (!response.ok) {
				respond({ error: `HTTP ${response.status}` });
				return;
			}
			const data = await response.json();
			const value = data?.result?.u_external_work_notes_list;
			respond({ value: typeof value === "string" ? value : "" });
		} catch (error) {
			respond({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			if (abort) inflight.delete(abort);
		}
	}

	// ---- guarded resolve (the ONLY write this bridge can make) --------------------------------------------------
	// Sends one payload (fixed state/code, user-supplied notes) to one record the page is showing, once, and never retries a PATCH. Refuses anything
	// that is not an open Informatica incident (the marker may sit anywhere in the short description, e.g. behind a
	// monitoring-alarm prefix), then reads the record back so the caller learns what really happened.
	// Notes are user data (options page); everything else is fixed here.
	const RESOLVE = Object.freeze({ table: "incident", state: "6", close_code: "Solution provided" });
	const OPEN_STATES = new Set(["1", "2", "3"]);
	const REQUEST_TIMEOUT_MS = 20000;
	async function resolveRecord(event, request) {
		const gen = generation;
		const live = () => listening && !stopped && gen === generation;
		const respond = payload => {
			if (!live()) return;
			window.postMessage({ source: "sn-inf-page", type: "resolve-record-result", id: request.id, ...payload }, ORIGIN);
		};
		const notes = typeof request.notes === "string" ? request.notes.trim() : "";
		if (request.table !== RESOLVE.table || !/^[0-9a-f]{32}$/i.test(request.sysId) ||
			!notes || notes.length > 200 || /[\u0000-\u001f\u007f]/.test(notes)) {
			respond({ ok: false, stage: "validate", error: "invalid record reference" });
			return;
		}
		const token = window.g_ck;
		if (typeof token !== "string" || !token) {
			respond({ ok: false, stage: "validate", error: "g_ck is not available yet" });
			return;
		}
		const url = `/api/now/table/${RESOLVE.table}/${request.sysId}?sysparm_fields=number,short_description,state,close_code,close_notes`;
		const call = async (method, body) => {
			const abort = typeof AbortController === "function" ? new AbortController() : null;
			if (abort) { inflight.add(abort); }
			const timer = setTimeout(() => { try { abort?.abort(); } catch {} }, REQUEST_TIMEOUT_MS);
			try {
				const response = await fetch(url, { method, credentials: "same-origin",
					headers: { "Accept": "application/json", "X-UserToken": token,
						...(body ? { "Content-Type": "application/json" } : {}) },
					...(body ? { body: JSON.stringify(body) } : {}), ...(abort ? { signal: abort.signal } : {}) });
				if (!response.ok) return { error: `HTTP ${response.status}` };
				const data = await response.json();
				return { record: data?.result || {} };
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			} finally { clearTimeout(timer); if (abort) inflight.delete(abort); }
		};
		const before = await call("GET");
		if (!live()) return;
		if (before.error) { respond({ ok: false, stage: "precheck", error: before.error }); return; }
		const b = before.record;
		if (!/ams informatica/i.test(String(b.short_description || "").trim())) {
			respond({ ok: false, stage: "precheck", number: b.number, error: "not an Informatica ticket; refusing to resolve" });
			return;
		}
		if (typeof request.number === "string" && request.number && request.number !== b.number) {
			respond({ ok: false, stage: "precheck", number: b.number, error: `record is ${b.number}, page shows ${request.number}` });
			return;
		}
		if (!OPEN_STATES.has(String(b.state))) {
			respond({ ok: false, stage: "precheck", number: b.number, state: String(b.state), error: "ticket is not open; not touching it" });
			return;
		}
		const patched = await call("PATCH", { state: RESOLVE.state, close_code: RESOLVE.close_code, close_notes: notes });
		// A failed/ambiguous PATCH is still verified below: a timeout does not prove nothing was written.
		const after = await call("GET");
		if (!live()) return;
		const a = after.record;
		if (!a) { respond({ ok: false, stage: "verify", number: b.number, error: `could not verify (${after.error}); patch: ${patched.error || "sent"}` }); return; }
		const done = String(a.state) === RESOLVE.state && a.close_code === RESOLVE.close_code && a.close_notes === notes;
		respond(done ? { ok: true, number: b.number, state: String(a.state) }
			: { ok: false, stage: "verify", number: b.number, state: String(a.state),
				error: `read-back does not match (state ${a.state}, code "${a.close_code}")${patched.error ? `; patch: ${patched.error}` : ""}` });
	}

	const settings = window.__snMiloMainSettings;
	if (settings && typeof settings.subscribe === "function") {
		try {
			unsubscribe = settings.subscribe(FEATURE, state => (state?.enabled === true ? enable() : disable()));
		} catch (error) {
			console.warn("[SN-INF] settings subscription failed", error);
		}
	}
	if (typeof previous?.stop === "function" && previous !== controller) previous.stop();
})();
