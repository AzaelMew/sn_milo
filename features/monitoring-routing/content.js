// Monitoring routing buttons — MAIN-world content script (classic IIFE) for the classic case form frame.
// When the case's Channel is "Monitoring" it shows routing buttons (Windows, Linux, MSSQL, Disk; see BUTTONS). A click fills
// the form, re-reads every field twice to double check, and only if all are correct clicks the form's own Save once;
// otherwise it bails without saving (localStorage.snMrNoSave = "1" fills and verifies but skips the save, for tests).
//   Type = Incident, Category/Subcategory per button, Assignment group = Monitoring, Assigned to = the signed-in user
//   (g_user, so no person is named in source), and Contract Invoice Rate when the system did not fill it after the
//   Subcategory change: the active rate of that name in the case's own domain (never overwritten when filled).
// Runs in MAIN because the form is driven through g_form (choice lists reload and reference fields clear dependents
// through the page's own client scripts). Network: read-only GETs only (group, case domain, rate); the single write is
// the form's Save click. Buttons are absolutely positioned in the Channel row's empty gutter (no layout space).
// Lifecycle (see shared/main-settings.js): inert until window.__snMiloMainSettings reports the feature enabled;
// disable removes the buttons and cancels a run at its next checkpoint (a Save already clicked is not undone).
// A reinjected script stops the previous instance first, unless that one is mid-run (then the new one is inert).
(() => {
	'use strict';
	const FEATURE = 'monitoring-routing';
	const ORIGIN = location.origin;
	if (typeof ORIGIN !== 'string' || !/^https:\/\/[^/]+$/.test(ORIGIN)) return;
	const settings = window.__snMiloMainSettings;
	if (!settings) return; // no settings helper => fail closed
	const previous = window.__snMonitoringRouting;
	if (previous?.running) return;

	const TABLE = 'sn_customerservice_case';
	const BAR_ID = 'sn-mr-bar';
	const CHANNEL = 'monitoring';
	const TYPE = {field: 'u_type', label: 'Incident'};
	const CATEGORY = {field: 'category', label: 'IT Infrastructure / Server'};
	const GROUP = 'Monitoring';
	// Contract Invoice Rate: the system normally fills it after the Subcategory change. When it does not, `rate` names
	// the rate record to put there (display_name, in the case's own domain, active; matching contract name when configured).
	const RATE = {field: 'u_contract_invoice_rate', table: 'x_tifo_invoicing_invoice_rate', autoFillWaitMs: 500};
	// Change Template (Disk): a reference to std_change_record_producer. Setting it makes the form fill the Subcategory itself.
	const TEMPLATE = {field: 'u_change_template', table: 'std_change_record_producer'};
	// `type` defaults to TYPE.label. `contract` (optional) filters by contract display name; duplicate matching contract names may
	// use either record. `firstRate` accepts the first of several same-named rates. `template` (optional): use that Change Template
	// when it exists (the form then fills `subcategory`), otherwise just choose `subcategory`.
	const BUTTONS = [
		{name: 'Windows', category: CATEGORY.label, subcategory: 'Windows Operating system', rate: 'INFRA/HÄIRIÖ/Käyttöjärjestelmä Windows OS'},
		{name: 'Linux', category: CATEGORY.label, subcategory: 'Non-Windows'},
		{name: 'MSSQL', category: 'IT Infrastructure / Application platform', subcategory: 'Database', rate: 'INFRA/HÄIRIÖ/Tietokanta',
			contract: 'SQL Database Monitoring and Management'},
		{name: 'Disk', type: 'Change', category: 'Standard', template: 'Server capacity change', subcategory: 'Server capacity change',
			rate: 'INFRA/VAKIOMUUTOS/Kapasiteetin lisäys/poisto', firstRate: true}
	];

	const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
	const norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
	class Cancelled extends Error {}

	let stopped = false;
	let active = false; // feature enabled
	let timer = null;
	let run = null; // {cancelled}
	let unsubscribe = null;

	const ready = () => typeof window.g_form === 'object' && window.g_form && typeof window.g_form.getValue === 'function' &&
		window.g_form.getTableName?.() === TABLE;
	const bar = () => document.getElementById(BAR_ID);

	function checkpoint(r) {
		if (stopped || !active) r.cancelled = true;
		if (r.cancelled) throw new Cancelled('cancelled');
	}
	async function waitFor(r, fn, timeoutMs, stepMs = 40) {
		const end = Date.now() + timeoutMs;
		for (;;) {
			checkpoint(r);
			const value = fn();
			if (value) return value;
			if (Date.now() > end) return null;
			await sleep(stepMs);
		}
	}

	// Choice lists reload asynchronously after their parent changes (Type swaps the Category list, Category swaps
	// the Subcategory list), and the reload can clear a value set too early, or still hold the OLD list that happens to
	// contain the same label. So after a parent write, wait for the child's option list to differ from what it was
	// before the write (the reload landed); if it never changes (same list again) stop waiting after a short grace.
	const signature = field => {
		const select = document.getElementById(`${TABLE}.${field}`);
		return select?.options ? [...select.options].map(o => `${o.value}:${o.text}`).join('|') : '';
	};
	async function reloaded(r, field, before) {
		return Boolean(await waitFor(r, () => signature(field) !== before, 1500, 40));
	}
	function optionFor(field, label) {
		const select = document.getElementById(`${TABLE}.${field}`);
		if (!select?.options) return null;
		return [...select.options].find(o => norm(o.text) === norm(label)) || null;
	}
	/** Set a choice field. `child` names the dependent field whose list reloads afterwards. */
	async function setChoice(r, field, label, child) {
		const option = await waitFor(r, () => optionFor(field, label), 4000) || fail(`${field}: option "${label}" not found`);
		checkpoint(r);
		const before = child ? signature(child) : '';
		window.g_form.setValue(field, option.value);
		await waitFor(r, () => window.g_form.getValue(field) === option.value, 4000, 40) || fail(`${field} did not take "${label}"`);
		// A write made while the page is still busy with the previous reload can land without its change handler
		// running (the child list then never reloads). If the child list did not change, redo the write once.
		if (child && !(await reloaded(r, child, before))) {
			checkpoint(r);
			window.g_form.setValue(field, '');
			await sleep(150);
			checkpoint(r);
			window.g_form.setValue(field, option.value);
			await waitFor(r, () => window.g_form.getValue(field) === option.value, 4000, 40) || fail(`${field} did not take "${label}"`);
			await reloaded(r, child, before);
		}
		return option.value;
	}
	function fail(message) { throw new Error(message); }

	// Read-only GET against the Table API (never a write). Returns the parsed `result`.
	async function getJson(r, url, what) {
		const controller = new AbortController();
		const t = setTimeout(() => controller.abort(), 8000);
		try {
			checkpoint(r);
			const res = await fetch(url, {credentials: 'same-origin', signal: controller.signal,
				headers: {Accept: 'application/json', ...(window.g_ck ? {'X-UserToken': window.g_ck} : {})}});
			if (!res.ok) fail(`${what} lookup failed (HTTP ${res.status})`);
			return (await res.json()).result;
		} catch (error) {
			if (error.name === 'AbortError') fail(`${what} lookup timed out`);
			throw error;
		} finally { clearTimeout(t); }
	}
	const isId = v => typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v);

	// The group's sys_id (exactly one active match required).
	async function groupId(r) {
		const rows = await getJson(r, `/api/now/table/sys_user_group?sysparm_limit=2&sysparm_fields=sys_id,name&sysparm_query=${encodeURIComponent(`name=${GROUP}^active=true`)}`, 'group');
		if (!Array.isArray(rows) || rows.length !== 1 || !isId(rows[0].sys_id)) fail(`expected exactly one "${GROUP}" group`);
		return rows[0].sys_id;
	}

	// The rate record for THIS case: rates are per customer domain, so match the case's own sys_domain.
	async function rateId(r, displayName, contractName, first) {
		const caseId = window.g_form.getUniqueValue?.();
		if (!isId(caseId)) fail('case sys_id not available');
		const rec = await getJson(r, `/api/now/table/${TABLE}/${caseId}?sysparm_fields=sys_domain&sysparm_exclude_reference_link=true`, 'case domain');
		if (!isId(rec?.sys_domain)) fail('case domain not available');
		const rows = await getJson(r, `/api/now/table/${RATE.table}?sysparm_limit=20&sysparm_display_value=all&sysparm_exclude_reference_link=true&sysparm_fields=sys_id,contract&sysparm_query=${encodeURIComponent(`display_name=${displayName}^sys_domain=${rec.sys_domain}^active=true`)}`, 'rate');
		const field = v => (v && typeof v === 'object' ? v.value : v);
		const shown = v => (v && typeof v === 'object' ? v.display_value : v);
		const match = Array.isArray(rows) ? rows.filter(row => !contractName || shown(row.contract) === contractName) : [];
		// With an explicit contract name, the user accepts the first match even if distinct contracts share that name.
		if (!match.length || (!contractName && !first && match.length !== 1) || !isId(field(match[0].sys_id))) fail(`expected ${contractName || first ? 'at least one' : 'exactly one'} active "${displayName}" rate${contractName ? ` under "${contractName}"` : ''} in the case's domain`);
		return field(match[0].sys_id);
	}

	// The Change Template record by name (null when none exists; a failed lookup is an error, not "missing").
	async function templateId(r, name) {
		const rows = await getJson(r, `/api/now/table/${TEMPLATE.table}?sysparm_limit=5&sysparm_fields=sys_id,name&sysparm_query=${encodeURIComponent(`name=${name}^active=true`)}`, 'change template');
		if (!Array.isArray(rows)) fail('change template lookup failed');
		const hit = rows.find(row => isId(row.sys_id));
		return hit ? hit.sys_id : null;
	}

	async function setReference(r, field, sysId, display) {
		checkpoint(r);
		window.g_form.setValue(field, sysId, display);
		await waitFor(r, () => window.g_form.getValue(field) === sysId, 4000, 40) || fail(`${field} did not take "${display}"`);
	}

	async function fill(r, button) {
		const user = window.g_user;
		const me = user?.userID, myName = (user?.getFullName?.() || `${user?.firstName || ''} ${user?.lastName || ''}`).trim();
		if (!isId(me) || !myName) fail('signed-in user not available');
		const gidPromise = groupId(r); // independent of the form: resolve while the choice lists reload
		gidPromise.catch(() => {});
		const ratePromise = button.rate ? rateId(r, button.rate, button.contract, button.firstRate) : null; // only awaited if the system leaves the field empty
		ratePromise?.catch(() => {});
		const typeLabel = button.type || TYPE.label;
		const templatePromise = button.template ? templateId(r, button.template) : null;
		templatePromise?.catch(() => {});
		const typeValue = await setChoice(r, TYPE.field, typeLabel, CATEGORY.field);
		const categoryValue = await setChoice(r, CATEGORY.field, button.category, 'subcategory');
		// A Change Template, when it exists, makes the form fill the Subcategory; otherwise (or if the form did not) choose it.
		let templateSet = null;
		if (button.template) {
			const tid = await templatePromise;
			if (tid) {
				await setReference(r, TEMPLATE.field, tid, button.template);
				templateSet = tid;
				await waitFor(r, () => norm(selectedText('subcategory')) === norm(button.subcategory), 2000, 40);
			}
		}
		if (norm(selectedText('subcategory')) !== norm(button.subcategory)) await setChoice(r, 'subcategory', button.subcategory);
		const subValue = window.g_form.getValue('subcategory');
		const subAt = Date.now();
		const gid = await gidPromise;
		await setReference(r, 'assignment_group', gid, GROUP);
		await setReference(r, 'assigned_to', me, myName);
		// The group change can clear/refilter the assignee a moment later: re-set it once if that happened.
		await sleep(250);
		checkpoint(r);
		const f = window.g_form;
		if (f.getValue('assigned_to') !== me) await setReference(r, 'assigned_to', me, myName);

		// Last step: the system fills Contract Invoice Rate ~0.25s after the Subcategory change, which the group/assignee
		// writes above already took; only fill it ourselves when it did not (the wait counts from the Subcategory write).
		const rateField = RATE.field;
		let rateSet = null; // only our own write creates a local rate/contract expectation
		let rateIssue = null; // why Contract Invoice Rate stays blank (the run then fills the rest but does not save)
		if (!window.g_form.getValue(rateField)) {
			await waitFor(r, () => window.g_form.getValue(rateField), Math.max(0, subAt + RATE.autoFillWaitMs - Date.now()), 40);
			if (button.rate && !window.g_form.getValue(rateField)) {
				// A rate that cannot be found/set must not abort the run: fill the rest, leave it blank, do not save.
				try {
					const id = await ratePromise;
					if (!window.g_form.getValue(rateField)) {
						await setReference(r, rateField, id, button.rate);
						rateSet = id;
					}
				} catch (error) {
					if (error instanceof Cancelled) throw error;
					rateIssue = error.message;
				}
			}
		}
		if (!window.g_form.getValue(rateField)) rateIssue = rateIssue || 'no rate found for this button';

		// Double check: re-read every field independently (what the form shows + g_form), twice with a pause so a late
		// reset by the page is caught. Derived fields (Contract) get a moment to appear. Any mismatch => bail, no save.
		const exp = {typeLabel, templateSet, type: typeValue, category: categoryValue, sub: subValue, gid, me, myName, rateSet, rateBlank: Boolean(rateIssue)};
		let wrong = problems(button, exp);
		for (const end = Date.now() + 2000; wrong.length && Date.now() < end;) { await sleep(100); checkpoint(r); wrong = problems(button, exp); }
		if (!wrong.length) { await sleep(300); checkpoint(r); wrong = problems(button, exp); }
		if (wrong.length) fail(`not saved, check the form: ${wrong.join('; ')}`);
		if (rateIssue) return `Filled, not saved: Contract Invoice Rate left blank (${rateIssue})`;
		if (noSave()) return 'Filled (not saved)';
		return saveForm(r);
	}

	// Independent re-read of every field the button sets. Returns a list of problems (empty = all correct).
	const selectedText = field => {
		const select = document.getElementById(`${TABLE}.${field}`);
		return select?.options && select.selectedIndex >= 0 ? select.options[select.selectedIndex].text : null;
	};
	const shownValue = field => document.getElementById(`sys_display.${TABLE}.${field}`)?.value ?? null;
	function problems(button, exp) {
		const f = window.g_form, out = [];
		const same = (what, got, want) => { if (norm(got) !== norm(want)) out.push(`${what} is "${got ?? ''}", expected "${want}"`); };
		same('Type', selectedText(TYPE.field), exp.typeLabel);
		same('Category', selectedText(CATEGORY.field), button.category);
		same('Subcategory', selectedText('subcategory'), button.subcategory);
		if (f.getValue(TYPE.field) !== exp.type || f.getValue(CATEGORY.field) !== exp.category || f.getValue('subcategory') !== exp.sub) out.push('a choice value differs from the one set');
		if (exp.templateSet) {
			if (f.getValue(TEMPLATE.field) !== exp.templateSet) out.push('Change Template is a different record');
			same('Change Template', shownValue(TEMPLATE.field), button.template);
		}
		same('Assignment group', shownValue('assignment_group'), GROUP);
		if (f.getValue('assignment_group') !== exp.gid) out.push('Assignment group is a different record');
		same('Assigned to', shownValue('assigned_to'), exp.myName);
		if (f.getValue('assigned_to') !== exp.me) out.push('Assigned to is a different user');
		if (exp.rateSet) {
			if (!f.getValue(RATE.field)) out.push('Contract Invoice Rate is empty');
			else same('Contract Invoice Rate', shownValue(RATE.field), button.rate);
			if (f.getValue(RATE.field) !== exp.rateSet) out.push('Contract Invoice Rate is a different record');
			if (button.contract) same('Contract', f.getDisplayValue?.('contract'), button.contract);
		}
		// A rate left blank on purpose is the one allowed gap (the run then skips the save).
		const missing = (f.getMissingFields?.() || []).filter?.(name => !(exp.rateBlank && String(name).endsWith(RATE.field)));
		if (Array.isArray(missing) && missing.length) out.push(`mandatory fields empty: ${missing.join(', ')}`);
		return out;
	}

	// Test aid: localStorage.snMrNoSave = "1" fills and verifies but never clicks Save.
	const noSave = () => { try { return localStorage.getItem('snMrNoSave') === '1'; } catch { return false; } };

	// One click on the form's own Save button (runs the form's validation); never retried.
	async function saveForm(r) {
		checkpoint(r); // last checkpoint before the one write
		const save = document.getElementById('sysverb_update_and_stay');
		if (!save || save.disabled) fail('Save button not found; nothing saved');
		let unloaded = false;
		const onHide = () => { unloaded = true; };
		window.addEventListener?.('pagehide', onHide);
		save.click();
		for (const end = Date.now() + 4000; !unloaded && Date.now() < end;) await sleep(100);
		window.removeEventListener?.('pagehide', onHide);
		return unloaded ? 'Saved' : 'Save clicked, form did not reload: check it';
	}

	function setLabels(text) {
		for (const b of bar()?.querySelectorAll('button') || []) b.textContent = text ?? b.dataset.name;
	}
	async function click(button, element) {
		if (run) return; // one run at a time
		const r = run = {cancelled: false};
		api.running = true;
		for (const b of bar().querySelectorAll('button')) b.disabled = true;
		element.textContent = 'Working…';
		let result;
		try { result = await fill(r, button); }
		catch (error) { result = error instanceof Cancelled ? 'Cancelled' : `Failed: ${error.message}`; console.warn('[SN-MILO] monitoring-routing', result); }
		run = null;
		api.running = false;
		api.lastRun = result;
		const el = bar()?.querySelector(`[data-name="${button.name}"]`);
		if (el) {
			el.textContent = result;
			setTimeout(() => { for (const b of bar()?.querySelectorAll('button') || []) { b.disabled = false; b.textContent = b.dataset.name; } }, /^Failed/.test(result) || /check it|left blank/.test(result) ? 6000 : 2500);
		}
	}

	function ensureBar() {
		if (bar()) return;
		const div = document.createElement('div');
		div.id = BAR_ID;
		// Out of the layout flow (absolute, right-aligned in the empty gutter of the Channel row), so nothing is pushed down; max 2 per row.
		div.style.cssText = 'position:absolute;right:0;top:0;display:grid;grid-template-columns:repeat(2,auto);gap:6px;z-index:5;white-space:nowrap;'
		for (const b of BUTTONS) {
			const el = document.createElement('button');
			el.type = 'button';
			el.dataset.name = b.name;
			el.textContent = b.name;
			el.style.cssText = 'padding:0 14px;height:28px;border:1px solid #6aa9ff;border-radius:4px;background:#1c3a63;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer;';
			el.addEventListener('click', () => click(b, el));
			div.appendChild(el);
		}
		// Anchored to the Channel field's row (a fixed overlay would sit under the shell's action bar).
		const row = document.getElementById(`element.${TABLE}.contact_type`);
		if (!row) return;
		if (window.getComputedStyle?.(row).position === 'static') row.style.position = 'relative';
		row.appendChild(div);
	}

	function place() {
		if (stopped) return;
		if (!active || !ready()) { if (!run) bar()?.remove(); return; }
		if (norm(window.g_form.getValue('contact_type')) === CHANNEL) ensureBar();
		else if (!run) bar()?.remove();
	}

	function onSettings(state) {
		active = state.enabled === true && !stopped;
		if (active && !timer) { timer = setInterval(place, 1000); place(); }
		if (!active) { if (timer) clearInterval(timer); timer = null; if (run) run.cancelled = true; bar()?.remove(); }
	}

	function stop() {
		if (stopped) return;
		stopped = true;
		active = false;
		if (timer) clearInterval(timer);
		timer = null;
		if (run) run.cancelled = true;
		unsubscribe?.();
		bar()?.remove();
	}

	const api = {stop, running: false, lastRun: null};
	if (previous?.stop) { try { previous.stop(); } catch {} }
	window.__snMonitoringRouting = api;
	unsubscribe = settings.subscribe(FEATURE, onSettings);
})();
