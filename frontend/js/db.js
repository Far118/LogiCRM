/**
 * db.js — API-клиент (заменяет IndexedDB-версию)
 *
 * Экспортирует те же функции что и старый db.js на IndexedDB:
 *   dbAdd, dbPut, dbGet, dbGetAll, dbGetByIndex, dbDelete, dbFilter,
 *   dbSearch, uuid, now, openDB
 *
 * Маппинг:
 *   dbAdd(store, record)            → POST   /api/:store
 *   dbPut(store, record)            → PUT    /api/:store/:id
 *   dbGet(store, id)                → GET    /api/:store/:id
 *   dbGetAll(store)                 → GET    /api/:store
 *   dbGetByIndex(store, index, val) → GET    /api/:store?index=val
 *   dbDelete(store, id)             → DELETE /api/:store/:id
 */

const BASE = '/api';

async function apiFetch(method, path, body = null) {
  const opts = {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
  };
  if (body !== null) opts.body = JSON.stringify(body);

  const res = await fetch(BASE + path, opts);
  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    const err = new Error(data.error ?? `HTTP ${res.status}`);
    if (data.existing_id)    err.existing_id    = data.existing_id;
    if (data.existing_name)  err.existing_name  = data.existing_name;
    if (data.existing_owner) err.existing_owner = data.existing_owner;
    throw err;
  }
  return data;
}

export async function dbAdd(store, record) {
  return apiFetch('POST', `/${store}`, record);
}

export async function dbPut(store, record) {
  if (!record.id) throw new Error(`dbPut: у записи нет id (store: ${store})`);
  return apiFetch('PUT', `/${store}/${record.id}`, record);
}

export async function dbGet(store, id) {
  if (!id) return null;
  try {
    return await apiFetch('GET', `/${store}/${id}`);
  } catch (err) {
    if (err.message.includes('не найд') || err.message.includes('404')) return null;
    throw err;
  }
}

export async function dbGetAll(store) {
  const result = await apiFetch('GET', `/${store}`);
  return Array.isArray(result) ? result : [];
}

export async function dbGetByIndex(store, indexName, value) {
  const result = await apiFetch(
    'GET',
    `/${store}?${encodeURIComponent(indexName)}=${encodeURIComponent(value)}`
  );
  return Array.isArray(result) ? result : [];
}

export async function dbDelete(store, id) {
  return apiFetch('DELETE', `/${store}/${id}`);
}

export async function dbFilter(store, predicate) {
  const all = await dbGetAll(store);
  return all.filter(predicate);
}

export async function dbSearch(store, queryStr, fields) {
  if (!queryStr?.trim()) return dbGetAll(store);
  const q = queryStr.toLowerCase().trim();
  const all = await dbGetAll(store);
  return all.filter(record =>
    fields.some(f => String(record[f] ?? '').toLowerCase().includes(q))
  );
}

export function uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
}

export function now() { return new Date().toISOString(); }
export function openDB() { return Promise.resolve(null); }
