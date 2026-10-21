// Inert TEST feature modules for router/lifecycle tests. Never shipped: they record calls and do nothing else.
import {sleep} from './fake-chrome.mjs';

export function testFeature(name, {alarms = [], prefixes = [], messages = {}, ...hooks} = {}) {
  const calls = [];
  const module = {
    name,
    alarms,
    notificationPrefixes: prefixes,
    messages: {
      async ping(msg, sender, ctx) {
        calls.push(['ping', msg.n]);
        if (msg.delay) await sleep(msg.delay);
        if (msg.throw) throw new Error('handler exploded');
        return {ok: true, pong: msg.n, enabledAfterAwait: ctx.isEnabled(name)};
      },
      seed: {allowSeedOnly: true, async handle(msg) { calls.push(['seed', msg.n]); return {ok: true}; }},
      ...messages
    },
    onAlarm(alarm, ctx) { calls.push(['alarm', alarm.name, ctx.isEnabled(name)]); },
    onNotificationClicked(id) { calls.push(['click', id]); },
    onEffectiveChange(next, prev) { calls.push(['effective', next.enabled, prev ? prev.enabled : null, next.seedOnly]); },
    onInstalled(details) { calls.push(['installed', details.reason]); },
    onStartup() { calls.push(['startup']); },
    ...hooks
  };
  return {module, calls};
}

/** The five inert features, with alarm names / notification prefixes shaped like the real inventory. */
export function inertFeatures() {
  const crit = testFeature('critical-alert', {alarms: ['snTkHealthCheck'], prefixes: ['snTk-', 'snCritHealth']});
  const ix = testFeature('interaction-alert', {alarms: ['snIxHealthCheck'], prefixes: ['snIx-', 'snIxHealth']});
  const inf = testFeature('informatica-button');
  const kb = testFeature('kb-dark');
  const tc = testFeature('timecard');
  return {crit, ix, inf, kb, tc, modules: [crit.module, ix.module, inf.module, kb.module, tc.module]};
}
