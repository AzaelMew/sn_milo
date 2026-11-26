// features/monitoring-routing/content.js against a stubbed classic form (vm sandbox: no browser, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'features/monitoring-routing/content.js'), 'utf8');
const SYS = n => String(n).repeat(32);
const TPL = SYS(3), GROUP = SYS(1), ME = SYS(2), RATE_ID = SYS(4), DOMAIN = SYS(5), CASE = SYS(6);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Minimal DOM: selects with options, a Channel row, and a body that collects the inserted bar.
function makeEnv({enabled = true, noSettings = false, groupRows = [{sys_id: GROUP, name: 'Monitoring'}], channel = 'monitoring', subs = ['Windows Operating system', 'Non-Windows', 'Database', 'Server capacity change'], fetchFails = false, autoFill = false, dropFirstCategoryReload = false, saveUnloads = true, missing = [], noSave = false, resetAssignee = false, wrongContract = false, rateRows = [{sys_id: RATE_ID}], templateRows = [{sys_id: TPL, name: 'Server capacity change'}], templateFills = true} = {}) {
  const log = [];
  const values = {contact_type: channel, u_type: 'service_request', category: '', subcategory: '', assignment_group: '', assigned_to: '', u_contract_invoice_rate: ''};
  const lists = {
    u_type: [['service_request', 'Service Request'], ['incident', 'Incident'], ['change', 'Change']],
    category: [['', '-- None --'], ['37', 'IT Infrastructure / Server']], // Service Request list: values differ from the Incident list
    subcategory: [['', '-- None --']]
  };
  const selects = Object.fromEntries(Object.keys(lists).map(f => [`sn_customerservice_case.${f}`, {options: lists[f].map(([value, text]) => ({value, text})),
    get selectedIndex() { return this.options.findIndex(o => o.value === values[f]); }}]));
  const displays = {};
  const saves = [];
  const saveButton = {disabled: false, click() { saves.push(Date.now()); if (saveUnloads) setTimeout(() => window.__pagehide?.(), 50); }};
  const reload = (field, items) => setTimeout(() => { selects[`sn_customerservice_case.${field}`].options = [['', '-- None --'], ...items].map(([value, text]) => ({value, text})); }, 30);
  const g_form = {
    getTableName: () => 'sn_customerservice_case',
    getUniqueValue: () => CASE,
    getMissingFields: () => missing,
    getDisplayValue: f => (f === 'contract' ? (wrongContract ? 'Other contract' : contractFor()) : displays[f]),
    getValue: f => values[f],
    setValue(f, v, display) {
      log.push([f, v, display]);
      values[f] = v;
      if (display) displays[f] = display;
      if (f === 'u_type') { values.category = ''; reload('category', v === 'change' ? [['26', 'Standard'], ['16', 'Normal']] : [['91', 'IT Infrastructure / Application platform'], ['92', 'IT Infrastructure / Server']]); }
      if (f === 'category' && v && dropFirstCategoryReload && !g_form.dropped) g_form.dropped = true; // change handler missed
      else if (f === 'category') { values.subcategory = ''; reload('subcategory', subs.map((t, i) => [`s${i}`, t])); }
      if (f === 'u_change_template' && v && templateFills) setTimeout(() => { values.subcategory = `s${subs.indexOf('Server capacity change')}`; }, 40); // the form fills the Subcategory from the template
      if (f === 'subcategory' && autoFill) setTimeout(() => { values.u_contract_invoice_rate = SYS(7); displays.u_contract_invoice_rate = 'INFRA/HÄIRIÖ/Käyttöjärjestelmä Windows OS'; }, 100);
      if (f === 'u_contract_invoice_rate') { const hit = rateResult.find(x => (x.sys_id?.value ?? x.sys_id) === v); lastContract = hit?.contract?.display_value || 'Some contract'; }
      if (f === 'assignment_group') values.assigned_to = ''; // the real form clears the assignee
      if (f === 'assigned_to' && resetAssignee) setTimeout(() => { values.assigned_to = ''; }, 120);
    }
  };
  let bar = null;
  const row = {style: {}, appendChild(node) { bar = node; node.isConnected = true; }};
  const mk = () => {
    const el = {dataset: {}, style: {}, children: [], listeners: {}, disabled: false, textContent: '',
      addEventListener(t, fn) { this.listeners[t] = fn; }, appendChild(c) { this.children.push(c); },
      querySelectorAll(sel) { return sel === 'button' ? this.children : []; },
      querySelector(sel) { const m = /data-name="([^"]+)"/.exec(sel); return this.children.find(c => c.dataset.name === m?.[1]) || null; },
      remove() { if (bar === this) bar = null; }};
    return el;
  };
  const document = {
    getElementById: id => id === 'sn-mr-bar' ? bar : id === 'element.sn_customerservice_case.contact_type' ? row : id === 'sysverb_update_and_stay' ? saveButton
      : id.startsWith('sys_display.sn_customerservice_case.') ? {value: displays[id.split('.').pop()] ?? ''} : selects[id] || null,
    createElement: () => mk(), body: {appendChild() {}}, documentElement: {appendChild() {}}
  };
  let lastContract = '';
  let rateResult = [{sys_id: RATE_ID}]; // rows of the most recent rate query (the contract comes from the record the form got)
  const contractFor = () => (values.u_contract_invoice_rate ? lastContract || 'Some contract' : '');
  let settingsCb = null;
  const settings = noSettings ? undefined : {subscribe(feature, cb) { assert.equal(feature, 'monitoring-routing'); settingsCb = cb; cb({enabled, seedOnly: false}); return () => { settingsCb = null; }; }};
  const intervals = [];
  const fetched = [];
  const window = {
    addEventListener(t, fn) { if (t === 'pagehide') window.__pagehide = fn; }, removeEventListener() {},
    getComputedStyle: () => ({position: 'static'}), g_form, g_user: {userID: ME, getFullName: () => 'Test User'}, g_ck: 'tok', __snMiloMainSettings: settings,
    fetch: async (url, init) => {
      fetched.push({url, init});
      if (fetchFails) return {ok: false, status: 500};
      if (url.includes(`/sn_customerservice_case/${CASE}`)) return {ok: true, json: async () => ({result: {sys_domain: DOMAIN}})};
      if (url.includes('/api/now/table/std_change_record_producer?')) return {ok: true, json: async () => ({result: templateRows})};
      if (url.includes('x_tifo_invoicing_invoice_rate')) {
        // rateRows: the same rows for every rate name, or a function of the (decoded) request URL for per-name rows.
        rateResult = typeof rateRows === 'function' ? rateRows(decodeURIComponent(url)) : rateRows;
        return {ok: true, json: async () => ({result: rateResult})};
      }
      return {ok: true, json: async () => ({result: groupRows})};
    }
  };
  const localStorage = {getItem: k => (k === 'snMrNoSave' && noSave ? '1' : null)};
  const ctx = vm.createContext({window, document, localStorage, location: {origin: 'https://x.service-now.com'}, console, setTimeout, clearTimeout,
    setInterval: (fn, ms) => { intervals.push(fn); return intervals.length; }, clearInterval() {}, fetch: (...a) => window.fetch(...a), AbortController, encodeURIComponent, URL});
  window.window = window; ctx.window = window;
  vm.runInContext(SRC, ctx);
  return {window, log, values, fetched, saves, displays,  tick: () => intervals.forEach(fn => fn()), bar: () => bar, setChannel: v => { values.contact_type = v; }, disable: () => settingsCb?.({enabled: false, seedOnly: false}), selects};
}

async function until(fn, ms = 8000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await sleep(20); } }

test('inert without the settings helper or while disabled', () => {
  assert.equal(makeEnv({noSettings: true}).window.__snMonitoringRouting, undefined);
  const off = makeEnv({enabled: false});
  off.tick();
  assert.equal(off.bar(), null);
});

async function run(opts, name = 'Windows') {
  const env = makeEnv(opts);
  env.tick();
  env.bar().querySelector(`[data-name="${name}"]`).listeners.click();
  await until(() => env.window.__snMonitoringRouting.lastRun, 15000);
  return env;
}

test('saves exactly once, only after the double check passes; last click is the form Save', async () => {
  const env = await run({});
  assert.equal(env.window.__snMonitoringRouting.lastRun, 'Saved');
  assert.equal(env.saves.length, 1);
});

test('bails without saving when a field is reset after being set (assignee cleared by the page)', async () => {
  const env = await run({resetAssignee: true});
  assert.match(env.window.__snMonitoringRouting.lastRun, /^Failed: not saved, check the form: Assigned to is a different user/);
  assert.equal(env.saves.length, 0);
});

test('bails without saving when mandatory fields are still empty', async () => {
  const env = await run({missing: ['short_description']});
  assert.match(env.window.__snMonitoringRouting.lastRun, /mandatory fields empty: short_description/);
  assert.equal(env.saves.length, 0);
});

test('MSSQL bails without saving when the derived Contract is not the SQL one', async () => {
  const rateRows = [{sys_id: {value: RATE_ID}, contract: {display_value: 'SQL Database Monitoring and Management'}}];
  const env = await run({rateRows, wrongContract: true}, 'MSSQL');
  assert.match(env.window.__snMonitoringRouting.lastRun, /Contract is "Other contract"/);
  assert.equal(env.saves.length, 0);
});

test('snMrNoSave=1 fills and verifies but never clicks Save', async () => {
  const env = await run({noSave: true});
  assert.equal(env.window.__snMonitoringRouting.lastRun, 'Filled (not saved)');
  assert.equal(env.saves.length, 0);
});

test('reports when Save was clicked but the form did not reload (never retries)', async () => {
  const env = await run({saveUnloads: false});
  assert.match(env.window.__snMonitoringRouting.lastRun, /^Save clicked, form did not reload/);
  assert.equal(env.saves.length, 1);
});

test('buttons are anchored absolutely to the Channel row (no layout space), two per row', () => {
  const env = makeEnv();
  env.tick();
  assert.match(env.bar().style.cssText, /position:absolute/);
  assert.match(env.bar().style.cssText, /repeat\(2,auto\)/);
});

test('buttons appear only when Channel is Monitoring and go away when it changes or the feature is disabled', () => {
  const env = makeEnv();
  env.tick();
  assert.deepEqual(env.bar().children.map(b => b.dataset.name), ['Windows', 'Linux', 'MSSQL', 'Disk']);
  env.setChannel('email'); env.tick();
  assert.equal(env.bar(), null);
  env.setChannel('monitoring'); env.tick();
  assert.ok(env.bar());
  env.disable();
  assert.equal(env.bar(), null);
});

for (const [name, sub] of [['Windows', 'Windows Operating system'], ['Linux', 'Non-Windows']]) {
  test(`${name}: sets Type, Category, Subcategory, Assignment group, Assigned to in order; never saves`, async () => {
    const env = makeEnv();
    env.tick();
    env.bar().querySelector(`[data-name="${name}"]`).listeners.click();
    await until(() => env.window.__snMonitoringRouting.lastRun);
    // Linux has no rate rule: everything else is filled, the rate stays blank and nothing is saved.
    if (name === 'Linux') assert.match(env.window.__snMonitoringRouting.lastRun, /^Filled, not saved: Contract Invoice Rate left blank/);
    else assert.equal(env.window.__snMonitoringRouting.lastRun, 'Saved');
    assert.equal(env.saves.length, name === 'Linux' ? 0 : 1);
    const writes = env.log.map(e => e[0]);
    assert.deepEqual(writes.filter(f => f !== 'u_contract_invoice_rate'), ['u_type', 'category', 'subcategory', 'assignment_group', 'assigned_to']);
    assert.equal(writes.includes('u_contract_invoice_rate'), name === 'Windows', 'only Windows fills the rate when the system left it empty');
    assert.equal(env.values.u_type, 'incident');
    assert.equal(env.values.category, '92');
    assert.equal(env.selects['sn_customerservice_case.subcategory'].options.find(o => o.value === env.values.subcategory).text, sub);
    assert.deepEqual(env.log.find(e => e[0] === 'assignment_group'), ['assignment_group', GROUP, 'Monitoring']);
    assert.deepEqual(env.log.find(e => e[0] === 'assigned_to'), ['assigned_to', ME, 'Test User']);
    assert.ok(env.fetched.every(f => f.init.method === undefined), 'read-only GETs only');
    assert.ok(env.fetched.some(f => /^\/api\/now\/table\/sys_user_group\?/.test(f.url)));
    if (name === 'Windows') {
      assert.deepEqual(env.log.find(e => e[0] === 'u_contract_invoice_rate'), ['u_contract_invoice_rate', RATE_ID, 'INFRA/HÄIRIÖ/Käyttöjärjestelmä Windows OS']);
      assert.equal(env.fetched.filter(f => f.url.includes('x_tifo_invoicing_invoice_rate')).length, 1, 'the backup name is only queried when the first name has no match');
      const q = decodeURIComponent(env.fetched.find(f => f.url.includes('x_tifo_invoicing_invoice_rate')).url);
      assert.match(q, new RegExp(`display_name=INFRA/HÄIRIÖ/Käyttöjärjestelmä Windows OS\\^sys_domain=${DOMAIN}\\^active=true`));
    } else assert.equal(env.fetched.some(f => f.url.includes('x_tifo_invoicing_invoice_rate')), false);
  });
}

test('fails without writing the group/assignee when the subcategory is missing', async () => {
  const env = makeEnv({subs: ['Other']});
  env.tick();
  env.bar().querySelector('[data-name="Linux"]').listeners.click();
  await until(() => env.window.__snMonitoringRouting.lastRun, 15000);
  assert.match(env.window.__snMonitoringRouting.lastRun, /^Failed: subcategory: option "Non-Windows" not found/);
  assert.deepEqual(env.log.map(e => e[0]), ['u_type', 'category'], 'group/assignee never written (the read-only lookup runs in parallel)');
});

test('fails when the group is not exactly one match, or the lookup errors', async () => {
  for (const opts of [{groupRows: []}, {groupRows: [{sys_id: GROUP}, {sys_id: SYS(3)}]}, {fetchFails: true}]) {
    const env = makeEnv(opts);
    env.tick();
    env.bar().querySelector('[data-name="Windows"]').listeners.click();
    await until(() => env.window.__snMonitoringRouting.lastRun);
    assert.match(env.window.__snMonitoringRouting.lastRun, /^Failed: /);
    assert.equal(env.log.some(e => e[0] === 'assignment_group'), false);
  }
});

test('disabling mid-run cancels before the next write', async () => {
  const env = makeEnv();
  env.tick();
  env.bar().querySelector('[data-name="Windows"]').listeners.click();
  await until(() => env.log.length >= 1);
  env.disable();
  await until(() => env.window.__snMonitoringRouting.lastRun);
  assert.equal(env.window.__snMonitoringRouting.lastRun, 'Cancelled');
  assert.ok(env.log.length < 5);
});

test('Windows leaves Contract Invoice Rate alone when the system filled it', async () => {
  const env = makeEnv({autoFill: true});
  env.tick();
  env.bar().querySelector('[data-name="Windows"]').listeners.click();
  await until(() => env.window.__snMonitoringRouting.lastRun);
  assert.equal(env.window.__snMonitoringRouting.lastRun, 'Saved');
  assert.equal(env.log.some(e => e[0] === 'u_contract_invoice_rate'), false);
  assert.equal(env.values.u_contract_invoice_rate, SYS(7));
});

for (const name of ['Windows', 'MSSQL']) {
  test(`${name}: trusts a different system-filled rate and its contract before saving`, async () => {
    const env = makeEnv({autoFill: true, wrongContract: true, rateRows: []});
    env.tick();
    env.bar().querySelector(`[data-name="${name}"]`).listeners.click();
    await until(() => env.values.u_contract_invoice_rate);
    env.displays.u_contract_invoice_rate = 'System-selected customer rate';
    await until(() => env.window.__snMonitoringRouting.lastRun);
    assert.equal(env.window.__snMonitoringRouting.lastRun, 'Saved');
    assert.equal(env.saves.length, 1);
    assert.equal(env.log.some(e => e[0] === 'u_contract_invoice_rate'), false);
  });
}

test('still validates the exact rate record when Milo set it, even if the label stays the same', async () => {
  const env = makeEnv();
  env.bar().querySelector('[data-name="Windows"]').listeners.click();
  await until(() => env.log.some(e => e[0] === 'u_contract_invoice_rate'));
  env.values.u_contract_invoice_rate = SYS(8);
  await until(() => env.window.__snMonitoringRouting.lastRun);
  assert.match(env.window.__snMonitoringRouting.lastRun, /Contract Invoice Rate is a different record/);
  assert.equal(env.saves.length, 0);
});

test('system-owned rates do not bypass mandatory-field validation', async () => {
  const env = await run({autoFill: true, missing: ['u_contract_invoice_rate']});
  assert.match(env.window.__snMonitoringRouting.lastRun, /mandatory fields empty: u_contract_invoice_rate/);
  assert.equal(env.saves.length, 0);
});

test('Windows fills everything else but leaves the rate blank and does not save when the case domain has no, or several, matching rates', async () => {
  for (const [rateRows, expected] of [
    [[], /left blank \(no active rate in the case's domain for "INFRA\/HÄIRIÖ\/Käyttöjärjestelmä Windows OS" or "INFRA\/INCIDENT\/Operating system Windows OS"\)/],
    [[{sys_id: RATE_ID}, {sys_id: SYS(8)}], /left blank \(expected exactly one active "INFRA\/HÄIRIÖ\/Käyttöjärjestelmä Windows OS" rate in the case's domain, found 2\)/]
  ]) {
    const env = makeEnv({rateRows});
    env.tick();
    env.bar().querySelector('[data-name="Windows"]').listeners.click();
    await until(() => env.window.__snMonitoringRouting.lastRun);
    assert.match(env.window.__snMonitoringRouting.lastRun, expected);
    assert.equal(env.log.some(e => e[0] === 'u_contract_invoice_rate'), false);
    assert.equal(env.saves.length, 0);
    for (const f of ['u_type', 'category', 'subcategory', 'assignment_group', 'assigned_to']) assert.ok(env.log.some(e => e[0] === f), `${f} still filled`);
  }
});

test('Windows falls back to its backup rate name when the case domain has no rate under its own name', async () => {
  const BACKUP = 'INFRA/INCIDENT/Operating system Windows OS';
  const env = makeEnv({rateRows: url => (url.includes(`display_name=${BACKUP}^`) ? [{sys_id: SYS(8)}] : [])});
  env.tick();
  env.bar().querySelector('[data-name="Windows"]').listeners.click();
  await until(() => env.window.__snMonitoringRouting.lastRun);
  assert.equal(env.window.__snMonitoringRouting.lastRun, 'Saved');
  assert.equal(env.saves.length, 1);
  assert.deepEqual(env.log.find(e => e[0] === 'u_contract_invoice_rate'), ['u_contract_invoice_rate', SYS(8), BACKUP]);
  const names = env.fetched.filter(f => f.url.includes('x_tifo_invoicing_invoice_rate')).map(f => /display_name=([^&^]+)/.exec(decodeURIComponent(f.url))?.[1]);
  assert.deepEqual(names, ['INFRA/HÄIRIÖ/Käyttöjärjestelmä Windows OS', BACKUP], 'own name first, then the backup');
});

test('MSSQL falls back to its backup rate name, still restricted to the SQL contract', async () => {
  const BACKUP = 'INFRA/INCIDENT/Tietokanta';
  const sql = {display_value: 'SQL Database Monitoring and Management'};
  const oracle = {display_value: 'Oracle Database Monitoring and Management'};
  const env = makeEnv({rateRows: url => (url.includes(`display_name=${BACKUP}^`)
    ? [{sys_id: {value: RATE_ID}, contract: oracle}, {sys_id: {value: SYS(8)}, contract: sql}]
    : [{sys_id: {value: SYS(9)}, contract: oracle}])});
  env.tick();
  env.bar().querySelector('[data-name="MSSQL"]').listeners.click();
  await until(() => env.window.__snMonitoringRouting.lastRun);
  assert.equal(env.window.__snMonitoringRouting.lastRun, 'Saved');
  assert.equal(env.values.u_contract_invoice_rate, SYS(8), 'the SQL-contract rate, not the Oracle one');
  assert.deepEqual(env.log.find(e => e[0] === 'u_contract_invoice_rate'), ['u_contract_invoice_rate', SYS(8), BACKUP]);
});

test('redoes the Category write once when its change handler was missed (Subcategory list never reloaded)', async () => {
  const env = makeEnv({dropFirstCategoryReload: true, autoFill: true});
  env.tick();
  env.bar().querySelector('[data-name="Linux"]').listeners.click();
  await until(() => env.window.__snMonitoringRouting.lastRun, 15000);
  assert.equal(env.window.__snMonitoringRouting.lastRun, 'Saved');
  assert.equal(env.log.filter(e => e[0] === 'category' && e[1]).length, 2);
});

test('MSSQL: Application platform / Database, and the rate under the SQL contract when two share the name', async () => {
  const rateRows = [{sys_id: {value: SYS(8), display_value: SYS(8)}, contract: {value: SYS(9), display_value: 'Oracle Database Monitoring and Management'}},
    {sys_id: {value: RATE_ID, display_value: RATE_ID}, contract: {value: SYS(3), display_value: 'SQL Database Monitoring and Management'}}];
  const env = makeEnv({rateRows});
  env.tick();
  assert.deepEqual(env.bar().children.map(b => b.dataset.name), ['Windows', 'Linux', 'MSSQL', 'Disk']);
  env.bar().querySelector('[data-name="MSSQL"]').listeners.click();
  await until(() => env.window.__snMonitoringRouting.lastRun);
  assert.equal(env.window.__snMonitoringRouting.lastRun, 'Saved');
  assert.equal(env.values.category, '91');
  assert.equal(env.selects['sn_customerservice_case.subcategory'].options.find(o => o.value === env.values.subcategory).text, 'Database');
  assert.deepEqual(env.log.find(e => e[0] === 'u_contract_invoice_rate'), ['u_contract_invoice_rate', RATE_ID, 'INFRA/HÄIRIÖ/Tietokanta']);
});

test('MSSQL picks the first matching rate when distinct contracts have the same SQL contract name', async () => {
  const rateRows = [
    {sys_id: {value: SYS(8)}, contract: {value: SYS(9), display_value: 'Oracle Database Monitoring and Management'}},
    {sys_id: {value: RATE_ID}, contract: {value: SYS(3), display_value: 'SQL Database Monitoring and Management'}},
    {sys_id: {value: SYS(7)}, contract: {value: SYS(1), display_value: 'SQL Database Monitoring and Management'}}
  ];
  const env = await run({rateRows}, 'MSSQL');
  assert.equal(env.window.__snMonitoringRouting.lastRun, 'Saved');
  assert.equal(env.saves.length, 1);
  assert.equal(env.values.u_contract_invoice_rate, RATE_ID);
});

test('MSSQL leaves the rate blank and does not save when no rate is under the SQL contract', async () => {
  const rateRows = [{sys_id: {value: SYS(8)}, contract: {value: SYS(9), display_value: 'Oracle Database Monitoring and Management'}}];
  const env = makeEnv({rateRows});
  env.tick();
  env.bar().querySelector('[data-name="MSSQL"]').listeners.click();
  await until(() => env.window.__snMonitoringRouting.lastRun);
  assert.match(env.window.__snMonitoringRouting.lastRun, /^Filled, not saved: Contract Invoice Rate left blank \(no active rate in the case's domain for "INFRA\/HÄIRIÖ\/Tietokanta" or "INFRA\/INCIDENT\/Tietokanta" under "SQL Database Monitoring and Management"\)$/);
  assert.equal(env.saves.length, 0);
  assert.equal(env.log.some(e => e[0] === 'u_contract_invoice_rate'), false);
});

const DISK_WRITES = ['u_type', 'category', 'u_change_template', 'assignment_group', 'assigned_to', 'u_contract_invoice_rate'];
const DISK_RATE = 'INFRA/VAKIOMUUTOS/Kapasiteetin lisäys/poisto';

test('Disk: Change / Standard / Change Template (the form fills the Subcategory), first of several same-named rates, group, assignee', async () => {
  const rateRows = [{sys_id: {value: RATE_ID}, contract: {display_value: 'Server Capacity Service'}}, {sys_id: {value: SYS(8)}, contract: {display_value: 'Server Capacity Service'}}];
  const env = await run({rateRows}, 'Disk');
  assert.equal(env.window.__snMonitoringRouting.lastRun, 'Saved');
  assert.equal(env.saves.length, 1);
  assert.deepEqual(env.log.map(e => e[0]), DISK_WRITES, 'Subcategory is not written by us when the template fills it');
  assert.equal(env.values.u_type, 'change');
  assert.equal(env.values.category, '26');
  assert.deepEqual(env.log.find(e => e[0] === 'u_change_template'), ['u_change_template', TPL, 'Server capacity change']);
  assert.equal(env.selects['sn_customerservice_case.subcategory'].options.find(o => o.value === env.values.subcategory).text, 'Server capacity change');
  assert.deepEqual(env.log.find(e => e[0] === 'u_contract_invoice_rate'), ['u_contract_invoice_rate', RATE_ID, DISK_RATE]);
  assert.match(decodeURIComponent(env.fetched.find(f => f.url.includes('std_change_record_producer')).url), /name=Server capacity change\^active=true/);
  assert.ok(env.fetched.every(f => f.init.method === undefined), 'read-only GETs only');
});

test('Disk without a Change Template record sets the Subcategory itself', async () => {
  const env = await run({templateRows: []}, 'Disk');
  assert.equal(env.window.__snMonitoringRouting.lastRun, 'Saved');
  assert.deepEqual(env.log.map(e => e[0]), ['u_type', 'category', 'subcategory', 'assignment_group', 'assigned_to', 'u_contract_invoice_rate']);
  assert.ok(!env.values.u_change_template);
});

test('Disk sets the Subcategory itself when the form did not fill it after the template', async () => {
  const env = await run({templateFills: false}, 'Disk');
  assert.equal(env.window.__snMonitoringRouting.lastRun, 'Saved');
  assert.deepEqual(env.log.map(e => e[0]), ['u_type', 'category', 'u_change_template', 'subcategory', 'assignment_group', 'assigned_to', 'u_contract_invoice_rate']);
});

test('Disk: a failed template lookup stops the run (no guess about whether the template exists)', async () => {
  const env = makeEnv({templateRows: null});
  env.window.fetch = (orig => async (url, init) => (url.includes('std_change_record_producer') ? {ok: false, status: 500} : orig(url, init)))(env.window.fetch);
  env.tick();
  env.bar().querySelector('[data-name="Disk"]').listeners.click();
  await until(() => env.window.__snMonitoringRouting.lastRun);
  assert.match(env.window.__snMonitoringRouting.lastRun, /^Failed: change template lookup failed/);
  assert.equal(env.saves.length, 0);
});

test('Disk with no rate under the case domain still fills the rest, leaves the rate blank and does not save', async () => {
  const env = await run({rateRows: []}, 'Disk');
  assert.match(env.window.__snMonitoringRouting.lastRun, /^Filled, not saved: Contract Invoice Rate left blank \(no active rate in the case's domain for "INFRA\/VAKIOMUUTOS/);
  assert.equal(env.saves.length, 0);
  assert.equal(env.values.assigned_to, ME);
});
