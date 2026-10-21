import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const sourcePath = new URL('../../features/timecard/core.js', import.meta.url);
const source = existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : '';
const sandbox = vm.createContext({ URL, URLSearchParams });
vm.runInContext(source, sandbox, { filename: 'features/timecard/core.js' });
const core = sandbox.SnTimecardCore;
const TEST_ORIGIN = 'https://exampletest.service-now.com';
const PRODUCTION_ORIGIN = 'https://production.example.com';
const SYS_ID = '2fee8374838003d0da338098beaad32e';
const USER_ID = '0123456789abcdef0123456789abcdef';
const config = {
  instances: [
    { origin: TEST_ORIGIN, mode: 'test' },
    { origin: PRODUCTION_ORIGIN, mode: 'production' },
  ],
  enableSubmission: false,
};
const plain = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

test('allows only exact configured HTTPS origins', () => {
  assert.equal(core.isAllowedOrigin?.(TEST_ORIGIN, config), true);
  assert.equal(core.isAllowedOrigin(PRODUCTION_ORIGIN, config), true);
  for (const origin of [
    'https://unknown.example.com', `${TEST_ORIGIN}.evil.example`,
    `${TEST_ORIGIN}/`, `${TEST_ORIGIN}/case`, `${TEST_ORIGIN}?q=1`,
    `${TEST_ORIGIN}#hash`, `${TEST_ORIGIN}:444`,
    TEST_ORIGIN.replace('https:', 'http:'), 'null', '', null, undefined,
  ]) {
    assert.equal(core.isAllowedOrigin(origin, config), false, String(origin));
  }
});

test('fails closed for missing or malformed instance configuration', () => {
  for (const badConfig of [undefined, null, {}, { instances: null },
    { instances: {} }, { instances: [{ origin: TEST_ORIGIN, mode: 'staging' }] },
    { instances: [{ origin: `${TEST_ORIGIN}/`, mode: 'test' }] }]) {
    assert.equal(core.isAllowedOrigin(TEST_ORIGIN, badConfig), false);
  }
  assert.equal(core.isAllowedOrigin(TEST_ORIGIN, {
    instances: [null, {}, ...config.instances],
  }), true);
});

test('permits submissions only for an explicitly enabled test origin', () => {
  const enabled = { ...config, enableSubmission: true };
  assert.equal(core.writesAllowed?.(TEST_ORIGIN, enabled), true);
  assert.equal(core.writesAllowed(TEST_ORIGIN, config), false);
  assert.equal(core.writesAllowed(PRODUCTION_ORIGIN, enabled), false);
  assert.equal(core.writesAllowed(PRODUCTION_ORIGIN, config), false);
  assert.equal(core.writesAllowed(`${TEST_ORIGIN}.evil.example`, enabled), false);
  assert.equal(core.writesAllowed(`${TEST_ORIGIN}/`, enabled), false);
  for (const enableSubmission of [undefined, null, false, 1, 'true']) {
    assert.equal(core.writesAllowed(TEST_ORIGIN, { ...config, enableSubmission }), false);
  }
  for (const badConfig of [undefined, null, {}, { enableSubmission: true }]) {
    assert.equal(core.writesAllowed(TEST_ORIGIN, badConfig), false);
  }
});

test('extracts case context from Workspace record routes', () => {
  for (const table of ['sn_customerservice_case', 'sn_customerservice_case_internal']) {
    for (const suffix of ['', '/sub/record/task/other', '?sysparm_view=case#details']) {
      const url = `${TEST_ORIGIN}/now/cwf/agent/record/${table}/${SYS_ID}${suffix}`;
      assert.deepEqual(plain(core.parseCaseUrl?.(url)), { table, sysId: SYS_ID });
    }
  }
});

test('returns null for malformed or unrelated Workspace URLs', () => {
  const route = `/now/cwf/agent/record/sn_customerservice_case_internal/${SYS_ID}`;
  const invalid = [
    null, undefined, {}, '', 'not a URL', route, `ftp://example.com${route}`,
    `${TEST_ORIGIN}/now/cwf/agent/record/problem/${SYS_ID}`,
    `${TEST_ORIGIN}/now/cwf/agent/record/sn_customerservice_case_internal/-1`,
    `${TEST_ORIGIN}/now/cwf/agent/record/sn_customerservice_case_internal/${SYS_ID}a`,
    `${TEST_ORIGIN}/now/cwf/agent/record/sn_customerservice_case_internal/${'z'.repeat(32)}`,
    `${TEST_ORIGIN}${route}/unrelated`, `${TEST_ORIGIN}/prefix${route}`,
    `${TEST_ORIGIN}/now/cwf/agent/home`, `${TEST_ORIGIN}/problem.do?sys_id=${SYS_ID}`,
  ];
  for (const url of invalid) {
    assert.doesNotThrow(() => {
      assert.equal(core.parseCaseUrl(url), null, String(url));
    });
  }
});

test('extracts case context from direct Classic forms', () => {
  for (const table of ['sn_customerservice_case', 'sn_customerservice_case_internal']) {
    for (const sysId of [SYS_ID, SYS_ID.toUpperCase()]) {
      const url = `${TEST_ORIGIN}/${table}.do?sysparm_view=case&sys_id=${sysId}&sysparm_view_forced=true#form`;
      assert.deepEqual(plain(core.parseCaseUrl(url)), { table, sysId });
    }
  }
});

test('extracts case context from encoded Classic navigation targets', () => {
  for (const table of ['sn_customerservice_case', 'sn_customerservice_case_internal']) {
    const target = `${table}.do?sys_id=${SYS_ID}&sysparm_view=case&sysparm_view_forced=true`;
    const url = `${TEST_ORIGIN}/now/nav/ui/classic/params/target/${encodeURIComponent(target)}`;
    assert.deepEqual(plain(core.parseCaseUrl(url)), { table, sysId: SYS_ID });
  }
});

test('rejects ambiguous or invalid Classic form identifiers', () => {
  const prefix = `${TEST_ORIGIN}/now/nav/ui/classic/params/target/`;
  const invalidTargets = [
    `sn_customerservice_case_internal.do?sys_id=${SYS_ID}&sys_id=${SYS_ID}`,
    'sn_customerservice_case_internal.do?sys_id=-1',
    'sn_customerservice_case_internal.do?sys_id=',
    'sn_customerservice_case_internal.do?sysparm_view=case',
    `sn_customerservice_case_internal.do?sys_id=${SYS_ID.slice(1)}`,
    `sn_customerservice_case_internal.do?sys_id=${SYS_ID}a`,
    `sn_customerservice_case_internal.do?sys_id=${SYS_ID}%5EORactive=true`,
    `sn_customerservice_case_internal.do/extra?sys_id=${SYS_ID}`,
    `problem.do?sys_id=${SYS_ID}`,
    `https://evil.example/sn_customerservice_case_internal.do?sys_id=${SYS_ID}`,
  ];
  for (const target of invalidTargets) {
    assert.equal(core.parseCaseUrl(`${TEST_ORIGIN}/${target}`), null, target);
    assert.equal(core.parseCaseUrl(`${prefix}${encodeURIComponent(target)}`), null, target);
  }
  assert.equal(core.parseCaseUrl(`${prefix}%GG`), null);
  assert.equal(core.parseCaseUrl(`${prefix}%E0%A4%A`), null);
  const valid = `sn_customerservice_case_internal.do?sys_id=${SYS_ID}`;
  assert.equal(core.parseCaseUrl(`${prefix}${encodeURIComponent(encodeURIComponent(valid))}`), null);
});

test('builds the same-origin native Time Worked form with exact defaults', () => {
  for (const origin of [TEST_ORIGIN, PRODUCTION_ORIGIN]) {
    for (const table of ['sn_customerservice_case', 'sn_customerservice_case_internal']) {
      const context = { table, sysId: SYS_ID };
      const result = core.nativeFormUrl?.(origin, context, USER_ID, config);
      assert.equal(typeof result, 'string');
      const url = new URL(result);
      assert.equal(url.origin, origin);
      assert.equal(url.pathname, '/task_time_worked.do');
      assert.equal(url.hash, '');
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        sys_id: '-1',
        sysparm_view: 'csm',
        sysparm_query: `userDYNAMIC${USER_ID}^taskDYNAMIC${SYS_ID}`,
        sysparm_stack: 'no',
        sysparm_clear_stack: 'true',
        sysparm_titleless: 'true',
      });
      assert.equal([...url.searchParams].length, 6);
      assert.ok(result.includes('%5E'), 'encoded query uses URLSearchParams');
      assert.deepEqual(context, { table, sysId: SYS_ID });
    }
  }
});

test('refuses native form URLs outside the exact allowlist', () => {
  const context = { table: 'sn_customerservice_case_internal', sysId: SYS_ID };
  for (const origin of [
    'https://unknown.example.com', `${TEST_ORIGIN}.evil.example`,
    `${TEST_ORIGIN}/`, `${TEST_ORIGIN}/path`, `${TEST_ORIGIN}?x=1`,
    `${TEST_ORIGIN}#fragment`, TEST_ORIGIN.replace('https://', 'https://name:password@'),
    TEST_ORIGIN.replace('https:', 'http:'), 'javascript:alert(1)',
    'null', '', null, undefined,
  ]) {
    assert.equal(core.nativeFormUrl(origin, context, USER_ID, config), null, String(origin));
  }
  for (const badConfig of [undefined, null, {}, { instances: [] }]) {
    assert.equal(core.nativeFormUrl(TEST_ORIGIN, context, USER_ID, badConfig), null);
  }
});

test('rejects invalid user IDs before constructing the encoded query', () => {
  const context = { table: 'sn_customerservice_case_internal', sysId: SYS_ID };
  for (const userId of [
    `${USER_ID}^ORactive=true`, USER_ID.slice(1), `${USER_ID}a`,
    'z'.repeat(32), -1, '-1', '', null, undefined, {},
    { toString: () => USER_ID }, ` ${USER_ID}`, `${USER_ID}\n`,
  ]) {
    assert.equal(core.nativeFormUrl(TEST_ORIGIN, context, userId, config), null);
  }
  assert.equal(new URL(core.nativeFormUrl(TEST_ORIGIN, context, USER_ID.toUpperCase(), config))
    .searchParams.get('sysparm_query'), `userDYNAMIC${USER_ID.toUpperCase()}^taskDYNAMIC${SYS_ID}`);
});

test('rejects missing context or invalid case IDs without throwing', () => {
  const table = 'sn_customerservice_case_internal';
  const badContexts = [
    { table, sysId: `${SYS_ID}^ORactive=true` },
    null, undefined, {}, { table },
    ...[SYS_ID.slice(1), `${SYS_ID}a`, 'z'.repeat(32), '-1', -1, '', null,
      undefined, {}, { toString: () => SYS_ID }, ` ${SYS_ID}`, `${SYS_ID}\n`]
      .map((sysId) => ({ table, sysId })),
  ];
  for (const context of badContexts) {
    assert.equal(core.nativeFormUrl(TEST_ORIGIN, context, USER_ID, config), null);
  }
});

test('rejects native form context for unsupported task tables', () => {
  for (const table of [
    'problem', 'task', 'task_time_worked', 'sn_customerservice_case_extra',
    'SN_CUSTOMERSERVICE_CASE', 'sn_customerservice_case\n',
    '', null, undefined, {}, { toString: () => 'sn_customerservice_case' },
  ]) {
    assert.equal(core.nativeFormUrl(TEST_ORIGIN, { table, sysId: SYS_ID }, USER_ID, config), null);
  }
});

test('rejects Classic case IDs containing encoded trailing line breaks', () => {
  for (const ending of ['%0A', '%0D', '%0D%0A']) {
    const target = `sn_customerservice_case_internal.do?sys_id=${SYS_ID}${ending}`;
    assert.equal(core.parseCaseUrl(`${TEST_ORIGIN}/${target}`), null);
    assert.equal(core.parseCaseUrl(`${TEST_ORIGIN}/now/nav/ui/classic/params/target/${encodeURIComponent(target)}`), null);
  }
});

test('exports the same API through CommonJS when available', () => {
  const commonJS = vm.createContext({ URL, URLSearchParams, module: { exports: {} } });
  vm.runInContext(source, commonJS, { filename: 'features/timecard/core.js' });
  assert.equal(commonJS.module.exports, commonJS.SnTimecardCore);
  assert.deepEqual(Object.keys(commonJS.module.exports).sort(), [
    'isAllowedOrigin', 'nativeFormUrl', 'parseCaseUrl', 'writesAllowed',
  ]);
  assert.equal(commonJS.module.exports.writesAllowed(TEST_ORIGIN, config), false);
});

test('denies submissions when matching instance modes conflict', () => {
  const testInstance = { origin: PRODUCTION_ORIGIN, mode: 'test' };
  const productionInstance = { origin: PRODUCTION_ORIGIN, mode: 'production' };
  for (const instances of [
    [testInstance, productionInstance], [productionInstance, testInstance],
    [testInstance, { origin: PRODUCTION_ORIGIN }],
  ]) {
    assert.equal(core.writesAllowed(PRODUCTION_ORIGIN, { instances, enableSubmission: true }), false);
  }
});

test('does not normalize control characters into valid case identifiers', () => {
  for (const control of ['\n', '\r', '\t', '\u0000']) {
    const target = `sn_customerservice_case_internal.do?sys_id=${SYS_ID}${control}`;
    const encoded = `${TEST_ORIGIN}/now/nav/ui/classic/params/target/${encodeURIComponent(target)}`;
    assert.equal(core.parseCaseUrl(encoded), null);
    assert.equal(core.parseCaseUrl(`${TEST_ORIGIN}/${target}`), null);
    assert.equal(core.parseCaseUrl(`${TEST_ORIGIN}/now/cwf/agent/record/sn_customerservice_case/${SYS_ID}${control}`), null);
  }
});

test('publishes the browser global without CommonJS or browser APIs', () => {
  assert.equal(typeof core, 'object');
  assert.notEqual(core, null);
});
