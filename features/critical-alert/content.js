// Critical alert — ISOLATED-world poller (classic content script, IIFE: no global lexical declarations). Migrated
// from the original standalone critical alert extension 3.3 content.js.
// Unchanged: poll timing (first poll after 5 s, every POLL_MS, RETRY_MS retry, 30 s request timeout), the
// postMessage protocol with the MAIN bridge ('sn-tk-extension'/'sn-tk-page'), row cleaning, every failure path
// (clear the pending id → release the heartbeat → log → retry after RETRY_MS), window.snTkPollNow.
// Milo changes:
//   - origin: production-only scope from the generated manifest match + worker-scoped effective state
//     (shared/controller.js reports the feature only on the configured production origin); exact location.origin
//     for postMessage; opaque/non-https frames exit;
//   - the worker answers a prerendered/inactive document with 'inactive-document': a quiet wait (retry on the normal
//     interval or document activation, no failure log/heartbeat release/10 s retry); a claim granted to a session
//     that was stopped meanwhile is released best-effort;
//   - inert until globalThis.__snMiloController starts the feature (enabled, or seed mode for the seed-silently
//     migration); stop(reason) clears every timer/interval, pending request and the named message listener;
//   - no chrome.storage (content scripts are denied it): the heartbeat election is a worker message
//     (`claim-poll` → {granted}; `release-poll` on every failure path); rows/logs go to the router as
//     {feature:'critical-alert', type:'rows'|'log'}; `complete` tells the worker whether every table answered
//     (only complete results may seed);
//   - globalThis.__snTkController is a replaceable controller {version, retired, active, stop()}. The same isolated
//     world belongs to the same extension instance (same code), so a reinjection while a live poller exists is a
//     no-op (keeps in-flight requests); a new extension instance gets a new world and its own controller, while the
//     orphan retires through the settings controller's liveness check or on its next chrome.* failure.
(() => {
	const FEATURE = "critical-alert";
	const VERSION = 1;
	const ORIGIN = location.origin;
	if (typeof ORIGIN !== "string" || !/^https:\/\/[^/]+$/.test(ORIGIN)) return;

	const POLL_MS = 120000;
	const RETRY_MS = 10000;
	const REQUEST_TIMEOUT_MS = 30000;
	const FIRST_POLL_MS = 5000;

	const previous = globalThis.__snTkController;
	if (previous && previous.retired === false && previous.version === VERSION) return;
	const milo = globalThis.__snMiloController;
	let retired = false;
	let session = null; // {mode, timeouts:Set, interval, pending:Set, inFlight, claiming, stopped}
	let unsubscribe = null;

	const controller = {
		version: VERSION,
		get retired() { return retired; },
		get active() { return Boolean(session); },
		get mode() { return session ? session.mode : null; },
		stop: reason => retire(reason || "stopped")
	};

	// After an extension reload the old content script stays in the page but its chrome.* bindings are dead; every
	// access then throws. Retire quietly; the new instance's worker re-attaches a fresh poller.
	function extensionAlive() {
		try {
			return !retired && globalThis.__snTkController === controller && Boolean(chrome?.runtime?.id);
		} catch {
			return false;
		}
	}
	const invalidated = error => String(error?.message || error).includes("Extension context invalidated") || !extensionAlive();

	function retire(reason = "invalidated") {
		if (retired) return;
		retired = true;
		stopSession(reason);
		if (unsubscribe) { const u = unsubscribe; unsubscribe = null; try { u(); } catch {} }
		if (reason === "invalidated") console.warn("[SN-TK] extension reloaded; orphaned poller retired. Waiting for automatic recovery (or reload this tab).");
	}

	function send(message) {
		if (!extensionAlive()) return Promise.reject(new Error("Extension context invalidated."));
		try {
			return Promise.resolve(chrome.runtime.sendMessage({ feature: FEATURE, ...message }));
		} catch (error) {
			return Promise.reject(error);
		}
	}

	function report(event, detail, level = "info") {
		if (!extensionAlive()) return;
		send({ type: "log", event, detail: String(detail || ""), level }).catch(error => { if (invalidated(error)) retire(); });
	}

	function cleanAccount(value) {
		// The Table API returns reference fields as { display_value, link } on
		// this instance; accept a plain string too so both shapes work.
		if (typeof value === "string") return value.trim();
		if (value && typeof value === "object" && typeof value.display_value === "string") {
			return value.display_value.trim();
		}
		return "";
	}

	function cleanRows(rows) {
		if (!Array.isArray(rows)) return [];
		return rows.slice(0, 100).map(row => ({
			sys_id: typeof row?.sys_id === "string" ? row.sys_id : "",
			number: typeof row?.number === "string" ? row.number : "",
			priority: typeof row?.priority === "string" ? row.priority : "",
			state: typeof row?.state === "string" ? row.state : "",
			short_description: typeof row?.short_description === "string" ? row.short_description : "",
			account: cleanAccount(row?.account)
		})).filter(row => /^[0-9a-f]{32}$/i.test(row.sys_id) && row.number);
	}

	function releaseHeartbeat() {
		if (!extensionAlive()) return Promise.resolve();
		return send({ type: "release-poll" }).then(response => {
			if (!response?.ok) console.warn("[SN-TK] could not release poll heartbeat:", response?.error || "no response");
		}, error => {
			console.warn("[SN-TK] could not release poll heartbeat:", error?.message || error);
			if (invalidated(error)) retire();
		});
	}

	/** Best effort, even for a retired controller: release a claim whose session ended before it could post. */
	function releaseOrphanClaim() {
		try {
			if (!chrome?.runtime?.id) return;
			Promise.resolve(chrome.runtime.sendMessage({ feature: FEATURE, type: "release-poll" })).catch(() => {});
		} catch {}
	}

	/** Document activation (prerender → active, tab shown): retry a poll that was refused as inactive-document. */
	function onActivate() {
		const s = session;
		if (!s || s.stopped || retired || !s.inactive) return;
		s.inactive = false;
		poll();
	}

	/** setTimeout owned by a session: cleared on stop, never fires for a stopped/replaced session. */
	function later(s, fn, ms) {
		if (s.stopped || session !== s) return;
		const id = setTimeout(() => {
			s.timeouts.delete(id);
			if (!s.stopped && session === s) fn();
		}, ms);
		s.timeouts.add(id);
	}

	async function poll() {
		const s = session;
		if (!s || s.stopped || s.inFlight || s.claiming || retired) return;
		s.claiming = true;
		try {
			if (!extensionAlive()) return retire();
			// ponytail: heartbeat leader election, now in the worker (claims serialized there); a duplicate API
			// call is still possible across worker restarts, never a duplicate notification (dedupe + queue).
			const claim = await send({ type: "claim-poll" });
			if (s.stopped || session !== s || retired) {
				s.claiming = false;
				if (claim?.ok && claim.granted) releaseOrphanClaim(); // granted to a session that is gone: don't hold the window
				return;
			}
			if (!claim?.ok) throw new Error(claim?.error || "no response to claim-poll");
			if (!claim.granted) { s.claiming = false; return; } // another tab owns this cycle
			// The alert rules are user data kept in extension storage (unreachable from here): ask the worker.
			const ruleSet = await send({ type: "get-rules" });
			s.claiming = false;
			if (s.stopped || session !== s || retired) { releaseOrphanClaim(); return; }
			if (!ruleSet?.ok || !Array.isArray(ruleSet.rules)) throw new Error(ruleSet?.error || "no response to get-rules");
			s.inFlight = true;
			const id = crypto.randomUUID();
			s.pending.add(id);
			try {
				window.postMessage({ source: "sn-tk-extension", type: "poll", id, rules: ruleSet.rules }, ORIGIN);
			} catch (error) {
				s.pending.delete(id);
				throw error;
			}
			later(s, async () => {
				if (!s.pending.delete(id)) return;
				s.inFlight = false;
				await releaseHeartbeat();
				console.warn("[SN-TK] ServiceNow request timed out; retrying in 10 seconds");
				report("poll-timeout", `request=${id}`, "warn");
				later(s, poll, RETRY_MS);
			}, REQUEST_TIMEOUT_MS);
		} catch (error) {
			s.claiming = false;
			s.inFlight = false;
			if (invalidated(error)) {
				retire();
				return;
			}
			if (s.stopped || session !== s) return;
			if (error instanceof Error && error.message === "inactive-document") {
				// prerendered / bfcached document: not an outage. Wait quietly (the normal interval or the activation
				// events below retry) — no heartbeat release, no failure log, no 10 s retry.
				s.inactive = true;
				return;
			}
			await releaseHeartbeat();
			report("poll-start-failed", error instanceof Error ? error.message : String(error), "warn");
			later(s, poll, RETRY_MS);
		}
	}

	async function onMessage(event) {
		const s = session;
		if (!s || s.stopped || retired || event.source !== window || event.origin !== ORIGIN) return;
		const result = event.data;
		if (result?.source !== "sn-tk-page" || result.type !== "poll-result" ||
			typeof result.id !== "string" || !s.pending.delete(result.id)) return;
		s.inFlight = false;
		if (!extensionAlive()) return retire();

		if (result.error) {
			await releaseHeartbeat();
			console.warn("[SN-TK] poll failed:", result.error);
			report("poll-failed", `request=${result.id} error=${result.error}`, "warn");
			later(s, poll, RETRY_MS);
			return;
		}

		const rows = cleanRows(result.rows);
		report("rows-received", `request=${result.id} raw=${Array.isArray(result.rows) ? result.rows.length : 0} valid=${rows.length}`);
		let response;
		try {
			response = await send({ type: "rows", rows, complete: !result.warning });
		} catch (error) {
			if (invalidated(error) && !extensionAlive()) return retire();
			response = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (!response?.ok) {
			report("background-failed", response?.error || "no response", "warn");
			await releaseHeartbeat();
			later(s, poll, RETRY_MS);
		}
	}

	function startSession(mode) {
		if (retired) return;
		if (session) { session.mode = mode; return; } // idempotent
		const s = { mode, timeouts: new Set(), interval: null, pending: new Set(), inFlight: false, claiming: false, inactive: false, stopped: false };
		session = s;
		window.addEventListener("message", onMessage);
		try { document.addEventListener("visibilitychange", onActivate); document.addEventListener("prerenderingchange", onActivate); } catch {}
		later(s, poll, FIRST_POLL_MS);
		s.interval = setInterval(() => poll(), POLL_MS);
		console.log(`[SN-TK] poller ready${mode === "seed" ? " (seed mode: notifications held)" : ""}; dashboard DOM is untouched`);
	}

	function stopSession() {
		const s = session;
		if (!s) return;
		session = null;
		s.stopped = true;
		clearInterval(s.interval);
		for (const id of s.timeouts) clearTimeout(id);
		s.timeouts.clear();
		s.pending.clear();
		s.inFlight = false;
		window.removeEventListener("message", onMessage);
		try { document.removeEventListener("visibilitychange", onActivate); document.removeEventListener("prerenderingchange", onActivate); } catch {}
	}

	globalThis.__snTkController = controller;
	if (typeof previous?.stop === "function" && previous !== controller) {
		try { previous.stop("superseded"); } catch {}
	}
	window.snTkPollNow = () => poll();
	if (!milo || typeof milo.subscribe !== "function") return; // no settings controller ⇒ inert
	unsubscribe = milo.subscribe(FEATURE, {
		start: state => startSession(state?.mode === "seed" ? "seed" : "enabled"),
		stop: reason => {
			stopSession(reason);
			if (reason === "invalidated") retire("invalidated");
		}
	}, { allowSeedOnly: true });
})();
