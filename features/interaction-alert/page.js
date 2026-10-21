// Interaction alert — MAIN-world bridge (classic content script, IIFE). Migrated from the original standalone interaction alert extension 1.1.0
// page.js. List query, table, fields, ordering, limit, the
// GET-only same-origin fetch with X-UserToken and the request/response protocol are unchanged.
// Milo changes:
//   - origin: production-only scope from the generated manifest match + the worker-scoped effective state relayed by
//     shared/main-settings.js; opaque/non-https frames exit; replies target the exact location.origin;
//   - lifecycle: the boolean guard window.__snIxPageBridgeLoaded (anonymous, unremovable listener) is replaced by a
//     replaceable controller window.__snIxBridge = {stop(), active}. The bridge is inert (no listener, so no fetch is
//     possible) until window.__snMiloMainSettings reports the feature enabled or seeding; disable removes the named
//     listener, aborts in-flight fetches and bumps a generation so an obsolete result is never posted. A reinjected
//     bridge stops the previous one (which also drops its settings subscription).
//   - globals/tags unchanged ('sn-ix-extension'/'sn-ix-page'): Milo and the original extension must not run on the
//     same documents (enforced at cutover; the original's anonymous listener cannot be retired).
(() => {
	const FEATURE = "interaction-alert";
	const ORIGIN = location.origin;
	if (typeof ORIGIN !== "string" || !/^https:\/\/[^/]+$/.test(ORIGIN)) return;

	// Mirrors a CSM Workspace interaction list (interaction table). Query copied from the list's live state
	// (encoded query): active, contact type not Monitoring/Call/Walk-in (or empty), and account is one of the
	// user's accounts (options page → worker `get-accounts` → the poll request; never stored in source). The Table API
	// rejects `type` on the CSM case tables (403) but allows it on `interaction`. The account condition is a
	// dot-walk in the query (account.name), one condition per configured account.
	const BASE_QUERY = "active=true^typeNOT INmonitoring,call,walk-in^ORtype=";
	const MAX_ACCOUNTS = 20;
	const accountQuery = accounts => BASE_QUERY + accounts.map((name, i) => `${i ? "^OR" : "^"}account.name=${name}`).join("");
	// Defence in depth (the worker already validates): never splice anything unexpected into an encoded query.
	const validAccounts = accounts => Array.isArray(accounts) && accounts.length <= MAX_ACCOUNTS &&
		accounts.every(a => typeof a === "string" && a.length > 0 && a.length <= 100 && !/[\^\u0000-\u001f\u007f]/.test(a));
	const TABLE = "interaction";
	const FIELDS = "sys_id,number,state,type,short_description,account,opened_for,sys_created_on";

	const previous = window.__snIxBridge;
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
		for (const abort of [...inflight]) { try { abort.abort(); } catch {} }
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
	window.__snIxBridge = controller;

	async function onMessage(event) {
		if (!listening || event.source !== window || event.origin !== ORIGIN) return;
		const request = event.data;
		if (request?.source !== "sn-ix-extension" || request.type !== "poll" ||
			typeof request.id !== "string") return;
		const gen = generation;
		const live = () => listening && !stopped && gen === generation;

		const respond = payload => {
			if (!live()) return; // disabled / replaced meanwhile: drop the obsolete answer
			window.postMessage({
				source: "sn-ix-page",
				type: "poll-result",
				id: request.id,
				...payload
			}, ORIGIN);
		};

		const token = window.g_ck;
		if (typeof token !== "string" || !token) {
			respond({ error: "ServiceNow session token g_ck is not available yet" });
			return;
		}

		const abort = typeof AbortController === "function" ? new AbortController() : null;
		if (abort) inflight.add(abort);
		try {
			if (!validAccounts(request.accounts)) {
				respond({ error: "poll request carried invalid accounts" });
				return;
			}
			if (request.accounts.length === 0) { // nothing configured: a successful, empty poll (no request is made)
				respond({ rows: [] });
				return;
			}
			const url =
				`/api/now/table/${TABLE}?sysparm_query=${encodeURIComponent(accountQuery(request.accounts) + "^ORDERBYDESCsys_created_on")}` +
				`&sysparm_fields=${FIELDS}&sysparm_limit=100&sysparm_display_value=true`;
			const response = await fetch(url, {
				credentials: "same-origin",
				headers: { "Accept": "application/json", "X-UserToken": token },
				...(abort ? { signal: abort.signal } : {})
			});
			// (live() is re-checked by respond(); no extra guard needed here)
			if (!response.ok) {
				respond({ error: `${TABLE} query returned HTTP ${response.status}` });
				return;
			}
			const data = await response.json();
			respond({ rows: Array.isArray(data.result) ? data.result : [] });
		} catch (error) {
			respond({ error: error instanceof Error ? error.message : String(error) });
		} finally {
			if (abort) inflight.delete(abort);
		}
	}

	const settings = window.__snMiloMainSettings;
	if (settings && typeof settings.subscribe === "function") {
		try {
			unsubscribe = settings.subscribe(FEATURE, state => (state?.enabled === true || state?.seedOnly === true ? enable() : disable()));
		} catch (error) {
			console.warn("[SN-IX] settings subscription failed", error);
		}
	}
	if (typeof previous?.stop === "function" && previous !== controller) previous.stop();
	console.log("[SN-IX] authenticated page bridge ready (inert until the feature is enabled)");
})();
