// Persistent, worker-serialized exclusion. No expiry: a suspended document or an
// ambiguous reload may resume later. Orphan leases require inspected recovery.
export const INFORMATICA_GATE_KEY = 'miloInformaticaGateV1';
export function createInformaticaGate(storage) {
  let queue = Promise.resolve();
  const serial = fn => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };
  const read = async () => {
    const value = (await storage.get(INFORMATICA_GATE_KEY))[INFORMATICA_GATE_KEY];
    if (value === undefined) return {maintenance: null, leases: {}};
    if (!value || typeof value.leases !== 'object' || value.leases === null || Array.isArray(value.leases) ||
        Object.values(value.leases).some(v => typeof v !== 'string') ||
        !(value.maintenance === null || typeof value.maintenance === 'string')) throw Error('informatica-gate-corrupt');
    return value;
  };
  const write = value => storage.set({[INFORMATICA_GATE_KEY]: value});
  return Object.freeze({
    start: (id, document) => serial(async () => {
      const s = await read();
      if (s.maintenance) return {ok:false, error:'informatica-maintenance-busy'};
      if (typeof id !== 'string' || !id || id.length > 100 || !document) return {ok:false, error:'informatica-document-required'};
      if (Object.hasOwn(s.leases, id)) return {ok:false, error:'informatica-lease-duplicate'};
      Object.defineProperty(s.leases, id, {value:document, enumerable:true, configurable:true, writable:true});
      await write(s);
      return {ok:true};
    }),
    end: (id, document) => serial(async () => {
      const s = await read();
      if (Object.hasOwn(s.leases, id) && s.leases[id] === document) { delete s.leases[id]; await write(s); }
      return {ok:true};
    }),
    acquire: owner => serial(async () => {
      const s = await read();
      if (!owner || (s.maintenance && s.maintenance !== owner)) throw Error('informatica-maintenance-busy');
      if (Object.keys(s.leases).length) throw Error('informatica-in-progress (persistent run leases; inspect before recovery)');
      s.maintenance = owner;
      await write(s);
      return {ok:true, owner};
    }),
    release: owner => serial(async () => {
      const s = await read();
      if (s.maintenance !== owner) throw Error('informatica-maintenance-owner-mismatch');
      s.maintenance = null; await write(s); return {ok:true};
    }),
    status: () => serial(read),
    // Console only. Close/reload ALL Informatica documents and stop pending CDP
    // update work first; never expose this recovery through runtime messages.
    recoverAfterInspection: () => serial(async () => { await write({maintenance:null, leases:{}}); return {ok:true}; })
  });
}
