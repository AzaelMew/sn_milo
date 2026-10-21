// These functions are serialized into the CURRENT extension worker / ISOLATED world.
// Never probe MAIN: extension instances have separate isolated globals after reload.
export function maintenanceInDocument(action, owner) {
  const controller = globalThis.__snInfController;
  if (action === 'release') {
    if (globalThis.__snInfMaintenance?.owner === owner) globalThis.__snInfMaintenance.owner = null;
    return {ok: true};
  }
  if (controller) {
    if (typeof controller.acquireMaintenance !== 'function') return {ok: false, reason: 'informatica-safety-unknown'};
    return controller.acquireMaintenance(owner);
  }
  // Also reserve an empty world: a late document_idle content script must inherit it.
  const lock = globalThis.__snInfMaintenance ||= {owner: null};
  if (lock.owner && lock.owner !== owner) return {ok: false, reason: 'informatica-maintenance-busy'};
  lock.owner = owner;
  return {ok: true};
}

// One global pre-load reservation. Any unknown/busy tab prevents loadUnpacked entirely.
// On failure release every attempted tab, even if the acquisition response was lost.
export async function reserveInformatica(chrome, origins, owner, probe, state = {held: [], cancelled: false}) {
  const held = state.held;
  try {
    const tabs = await chrome.tabs.query({url: Object.values(origins).map(o => `${o}/*`)});
    for (const tab of tabs) {
      if (!Number.isInteger(tab.id) || tab.discarded) continue;
      if (state.cancelled) throw new Error('informatica-maintenance-cancelled');
      held.push(tab.id);
      const r = await chrome.scripting.executeScript({target: {tabId: tab.id, frameIds: [0]}, world: 'ISOLATED', func: probe, args: ['acquire', owner]});
      if (state.cancelled) throw new Error('informatica-maintenance-cancelled');
      if (r.length !== 1 || r[0]?.result?.ok !== true) throw new Error(r[0]?.result?.reason || 'informatica-safety-unknown');
    }
    return held;
  } catch (error) {
    const failures = [];
    for (const tabId of held) {
      try { await chrome.scripting.executeScript({target: {tabId, frameIds: [0]}, world: 'ISOLATED', func: probe, args: ['release', owner]}); }
      catch { failures.push(tabId); }
    }
    if (failures.length) throw new Error(`${error.message}; Informatica maintenance release unconfirmed for ${failures.length} tabs; inspect before retry`);
    throw error;
  }
}
