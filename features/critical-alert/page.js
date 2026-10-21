// Critical alert — MAIN-world bridge (classic content script, IIFE). Migrated from the original standalone critical alert extension 3.3
// page.js. Query, tables, fields, the GET-only same-origin
// fetches with X-UserToken, the partial-failure merge and the request/response protocol are unchanged.
// Milo changes:
//   - origin: production-only scope from the generated manifest match + the worker-scoped effective state relayed by
//     shared/main-settings.js; opaque/non-https frames exit; replies target the exact location.origin;
//   - lifecycle: the boolean guard window.__snTkPageBridgeLoaded (anonymous, unremovable listener) is replaced by a
//     replaceable controller window.__snTkBridge = {stop(), active}. The bridge is inert (no listener, so no fetch is
//     possible) until window.__snMiloMainSettings reports the feature enabled or seeding; disable removes the named
//     listener, aborts in-flight fetches and bumps a generation so an obsolete result is never posted. A reinjected
//     bridge stops the previous one (which also drops its settings subscription).
//   - globals/tags unchanged ('sn-tk-extension'/'sn-tk-page'): Milo and the original extension must not run on the
//     same documents (enforced at cutover; the original's anonymous listener cannot be retired).
(() => {
	const FEATURE = "critical-alert";
	const ORIGIN = location.origin;
	if (typeof ORIGIN !== "string" || !/^https:\/\/[^/]+$/.test(ORIGIN)) return;

	// Scope to the captured SOC Jono queue (active, state New). Which tickets matter is decided by the user's rules
	// (options page): the worker hands the enabled rules' conditions with every poll request and one server-side
	// query is made per rule and table, so a matching ticket cannot be hidden beyond an arbitrary client-side row
	// limit. The account field is only returned when querying the CSM tables directly — a parent task query
	// silently drops it, and a dot-walk in the *fields* (account.name) does too (verified live 2026-10-01); the
	// account condition is a dot-walk in the *query*. Querying sn_customerservice_case also covers
	// sn_customerservice_case_internal via subclassing. change_task is omitted: it has no account field.
	const BASE_QUERY = "assignment_group=59ebfe66c3acc2503bd2993ce001312e^active=true^state=1";
	const MAX_RULES = 10;
	const TABLES = ["sn_customerservice_case", "sn_customerservice_task"];
	const ruleQuery = rule => BASE_QUERY +
		(rule.priority ? `^priority=${rule.priority}` : "") +
		(rule.account ? `^account.name=${rule.account}` : "");
	// Defence in depth (the worker already validates): never splice anything unexpected into an encoded query.
	function validRules(rules) {
		return Array.isArray(rules) && rules.length <= MAX_RULES && rules.every(r => r && typeof r === "object" &&
			/^[1-5]?$/.test(r.priority) && typeof r.account === "string" && r.account.length <= 100 &&
			!/[\^\u0000-\u001f\u007f]/.test(r.account) && (r.priority || r.account));
	}
	const FIELDS = "sys_id,number,priority,state,short_description,account";

	const previous = window.__snTkBridge;
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
	window.__snTkBridge = controller;

	async function onMessage(event) {
		if (!listening || event.source !== window || event.origin !== ORIGIN) return;
		const request = event.data;
		if (request?.source !== "sn-tk-extension" || request.type !== "poll" ||
			typeof request.id !== "string") return;
		const gen = generation;
		const live = () => listening && !stopped && gen === generation;

		const respond = payload => {
			if (!live()) return; // disabled / replaced meanwhile: drop the obsolete answer
			window.postMessage({
				source: "sn-tk-page",
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
			if (!validRules(request.rules)) {
				respond({ error: "poll request carried invalid alert rules" });
				return;
			}
			if (request.rules.length === 0) { // every rule is off: a successful, empty poll (no request is made)
				respond({ rows: [] });
				return;
			}
			const jobs = request.rules.flatMap(rule => TABLES.map(table => ({ table, query: ruleQuery(rule) })));
			const settled = await Promise.allSettled(jobs.map(async ({ table, query }) => {
				const url =
					`/api/now/table/${table}?sysparm_query=${encodeURIComponent(query)}` +
					`&sysparm_fields=${FIELDS}&sysparm_limit=50&sysparm_display_value=true`;
				const response = await fetch(url, {
					credentials: "same-origin",
					headers: {
						"Accept": "application/json",
						"X-UserToken": token
					},
					...(abort ? { signal: abort.signal } : {})
				});
				if (!response.ok) {
					throw new Error(`${table} query returned HTTP ${response.status}`);
				}
				const data = await response.json();
				return Array.isArray(data.result) ? data.result : [];
			}));
			// (live() is re-checked by respond(); no extra guard needed here)

			const rows = [];
			const failures = [];
			const seenIds = new Set(); // overlapping rules return the same ticket more than once
			settled.forEach((outcome, index) => {
				if (outcome.status === "fulfilled") {
					for (const row of outcome.value) {
						if (typeof row?.sys_id === "string" && seenIds.has(row.sys_id)) continue;
						if (typeof row?.sys_id === "string") seenIds.add(row.sys_id);
						rows.push(row);
					}
				} else {
					failures.push(outcome.reason instanceof Error ?
						outcome.reason.message : String(outcome.reason));
				}
			});
			if (rows.length === 0 && failures.length > 0) {
				respond({ error: [...new Set(failures)].join("; ") });
				return;
			}
			respond({ rows, ...(failures.length ? { warning: [...new Set(failures)].join("; ") } : {}) });
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
			console.warn("[SN-TK] settings subscription failed", error);
		}
	}
	if (typeof previous?.stop === "function" && previous !== controller) previous.stop();
	console.log("[SN-TK] authenticated page bridge ready (inert until the feature is enabled)");
})();
