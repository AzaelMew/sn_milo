import test from 'node:test';
import assert from 'node:assert/strict';
import {createReinjectionRunner} from '../shared/reinject.mjs';
test('background runner shares in-progress pass and clears singleton after failure, timeout and success', async () => {
 let calls = 0;
 const run = createReinjectionRunner({ensureReady: async () => {}, reinject: async () => {
  calls++; if (calls === 1) throw new Error('discovery failed');
  if (calls === 2) return {failed: 1, tabs: [{errors: ['step timeout']}]};
  return {failed: 0};
 }});
 const first = run(); assert.equal(first, run()); await assert.rejects(first, /discovery failed/);
 assert.equal((await run()).failed, 1);
 assert.equal((await run()).failed, 0); assert.equal(calls, 3);
});
test('background runner bounds readiness and permits subsequent explicit pass', async () => {
 let calls = 0;
 const run = createReinjectionRunner({readyTimeoutMs: 10, ensureReady: () => ++calls === 1 ? new Promise(() => {}) : Promise.resolve(), reinject: async () => ({failed: 0})});
 await assert.rejects(run(), /timeout/); assert.equal((await run()).failed, 0);
});
