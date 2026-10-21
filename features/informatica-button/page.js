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

	// MAIN-world bridge: the only place that can read g_ck. Read-only: it
	// fetches one record's External work notes list so the content script can
	// confirm the Save really persisted before it posts anything.
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
		if (request?.source !== "sn-inf-extension" || request.type !== "fetch-list" ||
			typeof request.id !== "string") return;
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
