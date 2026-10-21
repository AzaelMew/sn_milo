// Timecard worker module. The overlay itself is a MAIN-world content controller (features/timecard/content.js) that
// has no extension API bindings and cannot message the worker. The only worker duty is the options status line:
// when the feature is disabled while a form is still open, report 'disabled; current form retained until closed'.
// It is a PULL: when the options page asks for status, the worker runs a tiny read-only function in the top frame of
// each open production/test tab (scripting.executeScript with `func` — no files are injected, nothing is written)
// and asks window.__snTimecardApp.status().overlayOpen. No relay, no stored per-tab state ⇒ nothing can go stale
// when a tab navigates, closes or the worker restarts. The page can forge the answer; it only changes a status string.
// Native Time Worked form compatibility is a static always-on content entry and has no worker involvement.
export const RETAINED_STATUS = 'disabled; current form retained until closed';

/** Runs in the page's MAIN world (serialised by executeScript): true only if an overlay is open. */
export function overlayProbe() {
  try {
    const app = window.__snTimecardApp;
    return Boolean(app) && typeof app.status === 'function' && app.status().overlayOpen === true;
  } catch { return false; }
}

export function createTimecard({tabTimeoutMs = 1500, maxTabs = 20, concurrency = 10} = {}) {
  return {
    name: 'timecard',
    messages: {},
    async describeStatus(ctx) {
      if (ctx.isEnabled('timecard')) return null; // an open form while enabled is the normal state
      const {chrome, origins} = ctx;
      const urls = [origins.production, origins.test].filter(Boolean).map(o => `${o}/*`);
      const tabs = await chrome.tabs.query({url: urls});
      const selected = tabs.slice(0, maxTabs);
      let next = 0, open = 0, unchecked = tabs.length - selected.length;
      async function inspect() {
        while (next < selected.length) {
          const tab = selected[next++];
          let timer;
          try {
            const result = await Promise.race([
              chrome.scripting.executeScript({target: {tabId: tab.id}, world: 'MAIN', func: overlayProbe}),
              new Promise(resolve => { timer = setTimeout(() => resolve(null), tabTimeoutMs); })
            ]);
            if (!result?.length) unchecked++;
            else if (result[0]?.result === true) open++;
          } catch { unchecked++; } // discarded / restricted / timed-out tab: not known to be closed
          finally { clearTimeout(timer); }
        }
      }
      // Bound both the work queue and each wait: 20 tabs / 10 workers take at most two 1.5 s waves,
      // below the router's 5 s hook limit. Chrome calls cannot be cancelled after a timeout; late results
      // are ignored by the race and cannot change the returned count.
      await Promise.all(Array.from({length: Math.min(concurrency, selected.length)}, inspect));
      if (!open) return unchecked ? `disabled; retained forms unknown (${unchecked} tabs not checked)` : null;
      if (unchecked) return `${RETAINED_STATUS} (${open} ${open === 1 ? 'tab' : 'tabs'}, +${unchecked} not checked)`;
      return open === 1 ? RETAINED_STATUS : `${RETAINED_STATUS} (${open} tabs)`;
    }
  };
}
