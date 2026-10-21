// Informatica button — ISOLATED-world content script (classic, IIFE). Migrated from
// the original standalone Informatica button extension 1.1.0 content.js. DOM lookup, placement, labels, the workflow steps and their
// ORDER are unchanged: add the three people → verify the saved list via the MAIN bridge (read-only GET) → click
// Save unless already persisted → verify it persisted → open the External work notes tab → paste the Description →
// (dry run stops here, i.e. AFTER Save) → click the compose pane's Post External work notes button once it is stable
// (a single click, never retried), then confirm the editor emptied.
//
// Milo lifecycle (see README "Informatica button"):
//   - origin: the original compared location.origin with a hard-coded production host. Here the scope comes from the
//     generated production-only manifest match plus the worker-scoped effective state (shared/controller.js reports
//     the feature enabled only on the configured production origin). Bridge messages use the exact location.origin.
//   - inert until globalThis.__snMiloController (ISOLATED settings controller) starts the feature; no controller ⇒
//     inert. start() is idempotent and creates one "session" (placement timer + owned button); stop(reason) clears
//     the timer and label timers, removes the owned button and cancels an in-progress run. Re-enable starts a new
//     session with exactly one button. globalThis.__snInfController stays a replaceable controller; a re-injected
//     script stops the previous one (session + settings subscription) before subscribing itself.
//   - clicks run only for the live session's own connected button while the controller reports the feature enabled.
//   - cancellation checkpoints: checkpoint(run) runs synchronously immediately before EVERY page write (typing,
//     picking a person, Save, opening the tab, pasting, the Post click) and after every await. A stopped
//     session/run throws there, so no further write begins after disable. Writes already done or in flight (a Save
//     click whose server request may be running, a person whose pick was clicked) are NOT undone: stop() reports
//     them immediately ("Already done: …. Nothing was undone.") on the console, in a short-lived #sn-inf-notice
//     status element and in __snInfController.lastRun {status:'cancelled', reason, completed[], message}.
//   - globals/tags unchanged (__snInfController, #sn-inf-button, 'sn-inf-extension'/'sn-inf-page', localStorage
//     snInfDryRun): Milo and the original extension must not run on the same documents (enforced at cutover).
(() => {
	const FEATURE = "informatica-button";
	const ORIGIN = location.origin;
	if (typeof ORIGIN !== "string" || !/^https:\/\/[^/]+$/.test(ORIGIN)) return;

	// Synchronous same-instance guard BEFORE subscription/timer/DOM work. A running
	// workflow must never be stopped by reinjection. Maintenance is inherited on takeover.
	const previous = globalThis.__snInfController;
	if (previous?.lastRun?.status === "running") return;
	const maintenance = globalThis.__snInfMaintenance ||= {owner: null};

	const TITLE_PREFIX = "ams informatica";
	// The people to add are user data (options page → worker): delivered with the run lease, never stored in source.
	let EMAILS = [];
	const BUTTON_ID = "sn-inf-button";
	const NOTICE_ID = "sn-inf-notice";
	const LIST_LABEL = "External work notes list";
	// Set localStorage.snInfDryRun = "1" to stop right before the Post click.
	const dryRun = () => localStorage.getItem("snInfDryRun") === "1";

	const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

	// --- Shadow-DOM-aware helpers -------------------------------------------
	function deepFindAll(root, pred, out = [], depth = 0) {
		if (!root || depth > 40) return out;
		// Passing a host element also searches its shadow tree: workspace
		// macroponents slot nested components as light-DOM children.
		if (root.nodeType === 1 && root.shadowRoot) deepFindAll(root.shadowRoot, pred, out, depth + 1);
		for (const el of root.querySelectorAll("*")) {
			if (pred(el)) out.push(el);
			if (el.shadowRoot) deepFindAll(el.shadowRoot, pred, out, depth + 1);
		}
		return out;
	}
	const visible = el => {
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0;
	};
	const deepFind = (root, pred) => deepFindAll(root, pred)[0] || null;
	const label = el => (el.getAttribute("aria-label") || "").trim();
	const text = el => (el.textContent || "").trim();

	// --- Run state + cancellation checkpoints --------------------------------
	class Cancelled extends Error {
		constructor(reason) { super(`cancelled (${reason})`); this.name = "Cancelled"; this.reason = reason; }
	}
	const milo = globalThis.__snMiloController;
	const enabledNow = () => {
		try { return milo?.effective?.(FEATURE)?.enabled === true; } catch { return false; }
	};
	let session = null; // {id, button, timer, timeouts:Set, run, stopped}
	let disposed = false;
	let sessionSeq = 0;

	/** Throws Cancelled unless the run's session is still the live one and the feature is still enabled. Call it
	 *  synchronously right before every page write and after every await. */
	function checkpoint(run) {
		if (!run.cancelled && (run.session.stopped || session !== run.session)) run.cancelled = "stopped";
		if (!run.cancelled && !enabledNow()) cancelRun(run, "disabled");
		if (run.cancelled) throw new Cancelled(run.cancelled);
	}

	async function waitFor(fn, timeoutMs, stepMs = 150, run = null) {
		const end = Date.now() + timeoutMs;
		for (;;) {
			if (run) checkpoint(run);
			const value = fn();
			if (value) return value;
			if (Date.now() > end) return null;
			await sleep(stepMs);
		}
	}

	// --- Locate the visible AMS Informatica record ---------------------------
	function nearestMacroponent(node) {
		while (node) {
			if (node.tagName && node.tagName.startsWith("MACROPONENT-")) return node;
			node = node.parentNode || node.host;
		}
		return null;
	}

	function findContext() {
		if (!/\/record\//.test(location.pathname)) return null;
		const title = deepFindAll(document, el => el.tagName === "H1" && visible(el) &&
			text(el).toLowerCase().startsWith(TITLE_PREFIX))[0];
		if (!title) return null;
		const scope = nearestMacroponent(title);
		if (!scope) return null;
		return { title, scope };
	}

	function recordRef() {
		const all = [...location.pathname.matchAll(/\/record\/([a-z0-9_]+)\/([0-9a-f]{32})/gi)];
		const last = all[all.length - 1];
		return last ? { table: last[1], sysId: last[2] } : null;
	}

	// --- Button (owned by one session) ---------------------------------------
	function ensureButton(s) {
		if (s.stopped) return null; // never (re)create UI for a stopped session
		if (s.button?.isConnected) return s.button;
		document.getElementById(BUTTON_ID)?.remove();
		const button = document.createElement("button");
		button.id = BUTTON_ID;
		button.type = "button";
		button.textContent = "Informatica";
		button.style.cssText = "position:fixed;z-index:2147483000;padding:0 14px;height:28px;" +
			"border:1px solid #6aa9ff;border-radius:4px;background:#1c3a63;color:#fff;" +
			"font:600 13px system-ui,sans-serif;cursor:pointer;display:none;";
		const onClick = () => run(s, button);
		button.addEventListener("click", onClick);
		s.button = button;
		s.onClick = onClick;
		document.body.appendChild(button);
		return button;
	}

	function later(s, fn, ms) {
		const id = setTimeout(() => { s.timeouts.delete(id); if (!s.stopped) fn(); }, ms);
		s.timeouts.add(id);
	}

	function setLabel(s, textValue, ms = 0) {
		const b = ensureButton(s);
		if (!b) return;
		b.textContent = textValue;
		if (ms) later(s, () => { if (!s.run || s.run.finished) b.textContent = "Informatica"; }, ms);
	}

	function place(s) {
		if (s.stopped) return;
		// An orphaned/disabled controller retires (and stops this session) here instead of fighting a newer
		// instance for the button.
		if (!enabledNow()) { if (session === s) stopSession("disabled"); return; }
		const b = ensureButton(s);
		if (!b) return;
		const ctx = findContext();
		if (!ctx) { b.style.display = "none"; return; }
		// Second row: right-aligned under the native action buttons (Record
		// Expense / Save / Record Time / ...), so it never covers one.
		const bar = deepFind(ctx.scope, el => el.tagName === "NOW-RECORD-COMMON-UIACTIONBAR");
		const rects = bar ? deepFindAll(bar.shadowRoot, el => el.tagName === "BUTTON" && visible(el))
			.map(el => el.getBoundingClientRect()) : [];
		b.style.display = "block";
		if (rects.length) {
			const right = Math.max(...rects.map(r => r.right));
			const bottom = Math.max(...rects.map(r => r.bottom));
			b.style.top = `${bottom + 6}px`;
			b.style.right = `${Math.max(8, document.documentElement.clientWidth - right)}px`;
		} else {
			b.style.top = "64px";
			b.style.right = "300px";
		}
	}

	// --- Steps ---------------------------------------------------------------
	function fail(message) {
		throw new Error(message);
	}

	function requireCtx() {
		return findContext() || fail("AMS Informatica record is no longer visible");
	}

	function chipFor(root, email) {
		return deepFind(root, el => el.tagName === "LI" && el.getAttribute("role") === "option" &&
			el.getAttribute("aria-selected") === "true" &&
			(el.id.toLowerCase() === email || text(el).toLowerCase() === email));
	}

	const findListInput = () => {
		const ctx = findContext();
		return ctx && deepFind(ctx.scope, el => el.tagName === "INPUT" &&
			label(el) === LIST_LABEL && visible(el));
	};
	const findSuggestion = email => deepFind(document, el => el.tagName === "LI" &&
		el.getAttribute("role") === "option" && el.getAttribute("aria-selected") === "false" &&
		text(el).toLowerCase() === email && visible(el));

	// The field needs time after each pick: it clears its input and closes the
	// dropdown asynchronously. Typing the next address before that finishes
	// glues it onto the previous text, so wait for a clean, idle field first.
	async function waitIdle(r, email) {
		await waitFor(() => { const i = findListInput(); return i && i.value === "" && !findSuggestion(email); }, 4000, 150, r);
		await sleep(100);
		checkpoint(r);
	}

	async function typeEmail(r, email) {
		for (let attempt = 0; attempt < 3; attempt++) {
			const input = findListInput() || fail(`"${LIST_LABEL}" field not found`);
			checkpoint(r);
			input.focus();
			if (input.value) {
				input.select();
				document.execCommand("delete");
				await sleep(300);
				checkpoint(r);
			}
			document.execCommand("insertText", false, email);
			const typed = await waitFor(() => findListInput()?.value.trim().toLowerCase() === email, 2000, 150, r);
			if (typed) {
				const option = await waitFor(() => findSuggestion(email), 6000, 150, r);
				if (option) return option;
			}
			// Mangled or no suggestion: wipe the field and try again.
			const stale = findListInput();
			checkpoint(r);
			if (stale) { stale.focus(); stale.select(); document.execCommand("delete"); }
			await sleep(700);
			checkpoint(r);
		}
		return fail(`could not enter ${email}`);
	}

	async function addEmails(r) {
		for (const email of EMAILS) {
			checkpoint(r);
			const input = findListInput() || fail(`"${LIST_LABEL}" field not found`);
			const chipRoot = input.getRootNode();
			if (chipFor(chipRoot, email)) continue;
			await waitIdle(r, email);
			const option = await typeEmail(r, email);
			checkpoint(r);
			r.progress.people++;
			option.click();
			await waitFor(() => chipFor(findListInput()?.getRootNode() || chipRoot, email), 4000, 150, r)
				|| fail(`${email} was not added`);
			await waitIdle(r, email);
		}
		return r.progress.people;
	}

	let requestSeq = 0;
	function fetchSavedList(r) {
		return new Promise(resolve => {
			const ref = recordRef();
			if (!ref) return resolve({ error: "could not read record id from URL" });
			const id = `${Date.now()}-${++requestSeq}`;
			const finish = value => {
				clearTimeout(timer);
				window.removeEventListener("message", onMessage);
				r.cleanups.delete(cancel);
				resolve(value);
			};
			const cancel = () => finish({ error: "cancelled" });
			const timer = setTimeout(() => finish({ error: "timed out" }), 8000);
			function onMessage(event) {
				const data = event.data;
				if (event.source !== window || event.origin !== ORIGIN ||
					data?.source !== "sn-inf-page" || data.type !== "fetch-list-result" || data.id !== id) return;
				finish(data);
			}
			r.cleanups.add(cancel);
			window.addEventListener("message", onMessage);
			window.postMessage({ source: "sn-inf-extension", type: "fetch-list", id, ...ref }, ORIGIN);
		});
	}

	// Ask the MAIN bridge to resolve the open record (one fixed payload, verified by read-back). No retry here or in
	// the bridge: after a timeout the outcome is unknown, so the run reports that instead of trying again.
	function resolveViaBridge(r) {
		return new Promise(resolve => {
			const ref = recordRef();
			if (!ref) return resolve({ ok: false, error: "could not read record id from URL" });
			const id = `${Date.now()}-${++requestSeq}`;
			const finish = value => {
				clearTimeout(timer);
				window.removeEventListener("message", onMessage);
				r.cleanups.delete(cancel);
				resolve(value);
			};
			const cancel = () => finish({ ok: false, unknown: true, error: "cancelled while the request was in flight" });
			const timer = setTimeout(() => finish({ ok: false, unknown: true, error: "timed out waiting for the bridge" }), 70000);
			function onMessage(event) {
				const data = event.data;
				if (event.source !== window || event.origin !== ORIGIN ||
					data?.source !== "sn-inf-page" || data.type !== "resolve-record-result" || data.id !== id) return;
				finish(data);
			}
			r.cleanups.add(cancel);
			window.addEventListener("message", onMessage);
			window.postMessage({ source: "sn-inf-extension", type: "resolve-record", id, notes: r.resolveNotes, ...ref }, ORIGIN);
		});
	}

	// Only after the note post is confirmed: a ticket is never closed on top of an escalation that did not post.
	async function resolveTicket(r) {
		checkpoint(r); // last checkpoint before the one write
		r.progress.resolveRequested = true;
		const result = await resolveViaBridge(r);
		if (result.ok) { r.progress.resolved = true; return; }
		fail(result.unknown ? `resolve outcome unknown (${result.error}); check the ticket`
			: `could not resolve: ${result.error}`);
	}

	const hasAllEmails = value => {
		const saved = String(value || "").toLowerCase().split(",").map(s => s.trim());
		return EMAILS.every(email => saved.includes(email));
	};

	// The record action bar's Save button (visible only). Used to persist the people list.
	const saveButtonOf = ctx => {
		const bar = deepFind(ctx.scope, el => el.tagName === "NOW-RECORD-COMMON-UIACTIONBAR");
		return bar && deepFind(bar.shadowRoot, el => el.tagName === "BUTTON" && text(el) === "Save" && visible(el));
	};

	async function saveList(r) {
		const first = await fetchSavedList(r);
		checkpoint(r);
		if (first.error) fail(`could not verify saved list: ${first.error}`);
		if (hasAllEmails(first.value)) { r.progress.alreadySaved = true; return; } // already persisted
		const save = saveButtonOf(requireCtx());
		if (!save) fail("Save button not found");
		checkpoint(r);
		r.progress.saveClicked = true;
		save.click();
		const end = Date.now() + 20000;
		while (Date.now() < end) {
			await sleep(1000);
			checkpoint(r);
			const result = await fetchSavedList(r);
			checkpoint(r);
			if (!result.error && hasAllEmails(result.value)) { r.progress.saveConfirmed = true; return; }
		}
		fail("Save did not persist the External work notes list within 20s");
	}

	// The compose pane's Post External work notes button: clicked once to submit the note; its visibility also proves
	// the External work notes tab is actually on screen.
	const postButtonOf = ctx => {
		const compose = deepFind(ctx.scope, el => el.tagName === "NOW-ACTIVITY-STREAM-COMPOSE-CONNECTED");
		return compose && deepFind(compose.shadowRoot, el => el.id === "postButton-u_external_work_notes");
	};

	function externalEditorFrame(ctx) {
		const compose = deepFind(ctx.scope, el => el.tagName === "NOW-ACTIVITY-STREAM-COMPOSE-CONNECTED");
		if (!compose) return null;
		const frames = deepFindAll(compose.shadowRoot, el => el.tagName === "IFRAME" &&
			el.id.endsWith("_ifr") && visible(el));
		return frames.length === 1 ? frames[0] : null;
	}

	const composeOf = ctx => deepFind(ctx.scope, el => el.tagName === "NOW-ACTIVITY-STREAM-COMPOSE-CONNECTED");
	const externalTabOf = ctx => {
		const compose = composeOf(ctx);
		return compose && deepFind(compose.shadowRoot, el => el.getAttribute("role") === "tab" &&
			label(el) === "External work notes");
	};

	// True only when the External work notes tab is selected AND its Post
	// button is actually on screen (the button exists in the DOM for every
	// compose tab, so existence alone proves nothing).
	function externalTabActive() {
		const ctx = findContext();
		if (!ctx) return false;
		const tab = externalTabOf(ctx);
		const post = postButtonOf(ctx);
		return Boolean(tab && tab.getAttribute("aria-selected") === "true" &&
			post && visible(post) && externalEditorFrame(ctx));
	}

	async function openExternalTab(r) {
		for (let attempt = 0; attempt < 3; attempt++) {
			const tab = externalTabOf(requireCtx()) || fail('"External work notes" tab not found');
			checkpoint(r);
			if (tab.getAttribute("aria-selected") !== "true") tab.click();
			if (await waitFor(externalTabActive, 4000, 150, r)) {
				await sleep(300); // let the tab panel finish rendering
				checkpoint(r);
				if (externalTabActive()) { r.progress.tabOpened = true; return; }
			}
		}
		fail("could not switch to the External work notes tab");
	}

	async function pasteDescription(r) {
		if (!externalTabActive()) fail("External work notes tab is not active; not pasting");
		const ctx = requireCtx();
		const desc = deepFind(ctx.scope, el => el.tagName === "TEXTAREA" &&
			label(el).startsWith("Description") && visible(el)) || fail("Description field not found");
		const value = desc.value.trim();
		if (!value) fail("Description is empty");
		const frame = externalEditorFrame(ctx) || fail("External work notes editor not found");
		const doc = frame.contentDocument || fail("editor document is not accessible");
		checkpoint(r);
		doc.body.focus();
		doc.execCommand("selectAll");
		doc.execCommand("insertText", false, value);
		r.progress.pasted = true;
		// The workspace only registers the pending note after it sees key events from the editor.
		for (const type of ["keydown", "keyup"]) {
			doc.body.dispatchEvent(new frame.contentWindow.KeyboardEvent(type, { key: "a", bubbles: true }));
		}
		if (doc.body.innerText.trim().length < Math.min(20, value.length)) fail("pasting into the editor failed");
		const save = await waitFor(() => {
			const c = findContext();
			const b = c && saveButtonOf(c);
			return b && !b.disabled ? b : null;
		}, 4000, 150, r);
		return save || fail("Save button not available after pasting; nothing was saved");
	}

	const editorText = () => {
		const c = findContext();
		const f = c && externalEditorFrame(c);
		return f?.contentDocument?.body?.innerText.trim() || "";
	};

	// Post the pending External work note with the compose pane's "Post External work notes" button, only once it has
	// stayed enabled and the tab active for a stretch, then confirm the note was submitted: the editor empties. Post is
	// NOT idempotent, so there is exactly ONE click and no retry (a second click after a slow UI could duplicate the
	// note); if the text stays, the run fails and the pasted note is left in the editor for the user to look at.
	// (The record's Save does not submit a pending external note on every instance, so it is not relied on.)
	const postClickTarget = post => deepFind(post.shadowRoot, el => el.tagName === "BUTTON") || post;
	const postEnabled = post => {
		const inner = deepFind(post.shadowRoot, el => el.tagName === "BUTTON");
		return !post.disabled && post.getAttribute("disabled") === null && post.getAttribute("aria-disabled") !== "true" &&
			!(inner && (inner.disabled || inner.getAttribute("aria-disabled") === "true"));
	};
	async function postNoteWhenReady(r) {
		const STABLE_MS = 800;
		let since = 0;
		const end = Date.now() + 15000;
		for (;;) {
			checkpoint(r);
			const c = findContext();
			const post = c && postButtonOf(c);
			const ready = externalTabActive() && post && postEnabled(post) && editorText();
			if (!ready) since = 0;
			else if (!since) since = Date.now();
			else if (Date.now() - since >= STABLE_MS) break;
			if (Date.now() > end) fail("Post button never became ready; nothing was posted");
			await sleep(150);
		}
		const c = requireCtx();
		const post = postButtonOf(c);
		if (!externalTabActive() || !post) fail("External work notes tab is not active; not posting");
		setLabel(r.session, "Posting…");
		checkpoint(r); // last checkpoint before the one Post click
		r.progress.notePostClicks++;
		postClickTarget(post).click();
		if (await waitFor(() => !editorText(), 15000, 150, r)) { r.progress.noteConfirmed = true; return; }
		fail("Post did not submit the note (the editor still has the text); not retried, check the ticket");
	}

	// --- Partial-completion report -------------------------------------------
	function describe(p) {
		const done = [];
		if (p.people) done.push(`added ${p.people} of ${EMAILS.length} people to "${LIST_LABEL}"${p.saveClicked ? "" : " (not saved)"}`);
		if (p.alreadySaved) done.push(`"${LIST_LABEL}" was already saved`);
		if (p.saveConfirmed) done.push("Save confirmed");
		else if (p.saveClicked) done.push("Save clicked (the record may have been saved)");
		if (p.tabOpened) done.push("opened the External work notes tab");
		if (p.pasted && !p.notePostClicks) done.push("pasted the Description into the External work notes editor (not posted)");
		if (p.noteConfirmed) done.push("note post confirmed");
		else if (p.notePostClicks) done.push("Post clicked for the note (it may have been posted)");
		if (p.resolved) done.push("ticket resolved (verified)");
		else if (p.resolveRequested) done.push("resolve was requested (the ticket may be resolved; check it)");
		return done;
	}

	function showNotice(message) {
		try {
			document.getElementById(NOTICE_ID)?.remove();
			const n = document.createElement("div");
			n.id = NOTICE_ID;
			n.setAttribute("role", "status");
			n.textContent = message;
			n.style.cssText = "position:fixed;z-index:2147483000;top:64px;right:24px;max-width:420px;padding:8px 12px;" +
				"border:1px solid #f0b429;border-radius:4px;background:#3a2c05;color:#fff;font:13px system-ui,sans-serif;";
			document.body.appendChild(n);
			setTimeout(() => { if (n.isConnected) n.remove(); }, 12000);
		} catch {}
	}

	function cancelRun(r, reason) {
		if (r.cancelled || r.finished) return;
		r.cancelled = reason;
		for (const cleanup of [...r.cleanups]) { try { cleanup(); } catch {} }
		const completed = describe(r.progress);
		const message = `Informatica stopped (${reason}). ` + (completed.length
			? `Already done: ${completed.join("; ")}. Nothing was undone; no further steps will run.`
			: "No step had completed; no further steps will run.");
		r.result = { status: "cancelled", reason, completed, message };
		controller.lastRun = r.result;
		console.warn("[SN-INF]", message);
		showNotice(message);
	}

	function leaseMessage(type, lease) {
		return new Promise((resolve, reject) => {
			try { chrome.runtime.sendMessage({feature:"milo", type, lease}, response => {
				if (chrome.runtime.lastError || !response?.ok) reject(new Error(response?.error || "informatica-authorization-unavailable"));
				else resolve(response);
			}); } catch (error) { reject(error); }
		});
	}

	async function run(s, b) {
		// Only the live session's own, connected button runs, and only while the feature is enabled.
		if (maintenance.owner || s.stopped || session !== s || s.button !== b || !b.isConnected || !enabledNow()) return;
		if (s.run && !s.run.finished) return;
		const r = { session: s, cancelled: null, finished: false, cleanups: new Set(), result: null,
			progress: { people: 0, alreadySaved: false, saveClicked: false, saveConfirmed: false, tabOpened: false,
				pasted: false, notePostClicks: 0, noteConfirmed: false, resolveRequested: false, resolved: false } };
		s.run = r;
		controller.lastRun = { status: "running", completed: [] };
		b.disabled = true;
		b.style.opacity = "0.7";
		const lease = crypto.randomUUID();
		try {
			const started = await leaseMessage("informatica-run-start", lease);
			EMAILS = Array.isArray(started.emails) ? started.emails.filter(e => typeof e === "string" && e) : [];
			r.resolveNotes = typeof started.resolve?.notes === "string" && started.resolve.notes ? started.resolve.notes : null; // user option, off by default; delivered with the lease
			if (!EMAILS.length) throw new Error("informatica-no-recipients: add them on the options page");
			checkpoint(r);
			if (maintenance.owner) throw new Error("informatica-maintenance-busy");
			setLabel(s, "Adding people…");
			await addEmails(r);
			setLabel(s, "Saving…");
			await saveList(r);
			// The workspace re-renders the form and compose pane after a save;
			// give it time to settle before touching the compose tabs.
			await sleep(1500);
			checkpoint(r);
			setLabel(s, "Opening tab…");
			await openExternalTab(r);
			setLabel(s, "Pasting…");
			await pasteDescription(r);
			checkpoint(r);
			if (dryRun()) {
				r.result = { status: "dry-run", completed: describe(r.progress) };
				setLabel(s, "Dry run: ready to post", 8000);
				return;
			}
			await postNoteWhenReady(r);
			if (r.resolveNotes) {
				setLabel(s, "Resolving…");
				await resolveTicket(r);
			}
			r.result = { status: r.progress.resolved ? "resolved" : "posted", completed: describe(r.progress) };
			setLabel(s, r.progress.resolved ? "Posted + resolved ✓" : "Posted ✓", 6000);
		} catch (error) {
			if (error instanceof Cancelled || r.cancelled) return; // reported by cancelRun at stop time
			console.warn("[SN-INF]", error);
			r.result = { status: "failed", error: error.message, completed: describe(r.progress) };
			setLabel(s, `Failed: ${error.message}`.slice(0, 70), 8000);
		} finally {
			// Release only after the actual workflow promise settles, never on cancellation alone.
			// A lost start response may still have persisted a lease: end is idempotent.
			try { await leaseMessage("informatica-run-end", lease); } catch {}
			r.finished = true;
			for (const cleanup of [...r.cleanups]) { try { cleanup(); } catch {} }
			if (r.result && !r.cancelled) controller.lastRun = r.result;
			if (!s.stopped) {
				b.disabled = false;
				b.style.opacity = "1";
			}
		}
	}

	// --- Session lifecycle ---------------------------------------------------
	function startSession() {
		if (disposed || session) return; // idempotent
		const s = { id: ++sessionSeq, button: null, onClick: null, timer: null, timeouts: new Set(), run: null, stopped: false };
		session = s;
		s.timer = setInterval(() => place(s), 1500);
		place(s);
		if (session === s) console.log("[SN-INF] Informatica button ready");
	}

	function stopSession(reason = "stopped") {
		const s = session;
		if (!s) return;
		session = null;
		s.stopped = true;
		clearInterval(s.timer);
		for (const id of s.timeouts) clearTimeout(id);
		s.timeouts.clear();
		if (s.run && !s.run.finished) cancelRun(s.run, reason);
		if (s.button) {
			s.button.removeEventListener("click", s.onClick);
			if (s.button.isConnected) s.button.remove();
		}
	}

	let unsubscribe = null;
	const controller = {
		version: 4,
		acquireMaintenance(owner) {
			if (disposed || !owner) return {ok: false, reason: "informatica-safety-unknown"};
			if (session?.run && !session.run.finished) return {ok: false, reason: "informatica-in-progress"};
			if (maintenance.owner && maintenance.owner !== owner) return {ok: false, reason: "informatica-maintenance-busy"};
			maintenance.owner = owner;
			return {ok: true};
		},
		releaseMaintenance(owner) { if (maintenance.owner === owner) maintenance.owner = null; },
		lastRun: null,
		get active() { return Boolean(session); },
		stop(reason = "stopped") {
			disposed = true;
			stopSession(reason);
			if (unsubscribe) { const u = unsubscribe; unsubscribe = null; try { u(); } catch {} }
		}
	};
	globalThis.__snInfController = controller;
	if (typeof previous?.stop === "function" && previous !== controller) {
		try { previous.stop("superseded"); } catch {}
	}
	if (milo && typeof milo.subscribe === "function") {
		unsubscribe = milo.subscribe(FEATURE, {
			start: () => startSession(),
			stop: reason => stopSession(reason || "disabled")
		});
	}
})();
