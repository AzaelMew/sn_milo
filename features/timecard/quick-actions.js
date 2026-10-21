(() => {
 'use strict';
 // User-created quick actions persisted in localStorage on the ServiceNow
 // origin, so both the case page and the same-origin native form iframe
 // share one list without any extension API (content scripts run in MAIN
 // world, where chrome.storage is unavailable).
 const STORAGE_KEY = 'sn-timecard-quick-actions-v1';
 const MIN_MINUTES = 1;
 const MAX_MINUTES = 10080; // 7 days

 function normalize(value) {
  if (!value || typeof value !== 'object') return null;
  const label = String(value.label ?? '').trim().slice(0, 60);
  const minutes = Number(value.minutes);
  const comment = String(value.comment ?? '').trim().slice(0, 500);
  const workNotes = value.workNotes === true;
  if (!label || !Number.isInteger(minutes) ||
    minutes < MIN_MINUTES || minutes > MAX_MINUTES) return null;
  let id = typeof value.id === 'string' && value.id ? value.id : null;
  if (!id) {
   id = globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  return { id, label, minutes, comment, workNotes };
 }

 function load(storage = globalThis.localStorage) {
  try {
   const raw = storage?.getItem(STORAGE_KEY);
   if (!raw) return [];
   const parsed = JSON.parse(raw);
   if (!Array.isArray(parsed)) return [];
   return parsed.map(normalize).filter(Boolean);
  } catch { return []; }
 }

 function save(actions, storage = globalThis.localStorage) {
  const list = (Array.isArray(actions) ? actions : []).map(normalize).filter(Boolean);
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* storage full/blocked */ }
  return list;
 }

 function add(action, storage = globalThis.localStorage) {
  const normalized = normalize(action);
  if (!normalized) return null;
  const list = load(storage);
  list.push(normalized);
  save(list, storage);
  return normalized;
 }

 function remove(id, storage = globalThis.localStorage) {
  return save(load(storage).filter((action) => action.id !== id), storage);
 }

 // GlideDuration display format: "D HH:MM:SS".
 function duration(minutes) {
  const total = Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, Math.floor(Number(minutes) || 0)));
  const days = Math.floor(total / 60 / 24);
  const hours = Math.floor((total % (60 * 24)) / 60);
  const mins = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${days} ${pad(hours)}:${pad(mins)}:00`;
 }

 const api = { STORAGE_KEY, load, save, add, remove, duration, normalize };
 globalThis.SnTimecardQuickActions = api;
 if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
