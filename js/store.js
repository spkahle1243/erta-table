// IndexedDB storage: campaigns (JSON) and assets (blobs keyed by content hash).
// Assets are shared by every campaign in this browser and are also the
// players' download cache, so a map sent once is never sent again.

import { sha256Hex } from './util.js';

const DB_NAME = 'erta-table';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('campaigns')) db.createObjectStore('campaigns', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const campaigns = {
  list: () => tx('campaigns', 'readonly', s => req(s.getAll())),
  get: id => tx('campaigns', 'readonly', s => req(s.get(id))),
  put: c => tx('campaigns', 'readwrite', s => req(s.put(c))),
  delete: id => tx('campaigns', 'readwrite', s => req(s.delete(id))),
};

export const kv = {
  get: k => tx('kv', 'readonly', s => req(s.get(k))),
  set: (k, v) => tx('kv', 'readwrite', s => req(v === undefined ? s.delete(k) : s.put(v, k))),
  delete: k => tx('kv', 'readwrite', s => req(s.delete(k))),
};

const urlCache = new Map();

export const assets = {
  async has(id) { return !!(await tx('assets', 'readonly', s => req(s.getKey(id)))); },
  get: id => tx('assets', 'readonly', s => req(s.get(id))),
  meta: async id => { const a = await assets.get(id); return a ? { id: a.id, name: a.name, type: a.type, size: a.size } : null; },
  async put(blob, name = '') {
    const buf = await blob.arrayBuffer();
    const id = (await sha256Hex(buf)).slice(0, 24);
    if (!(await assets.has(id))) {
      await tx('assets', 'readwrite', s => req(s.put({ id, name: name || blob.name || id, type: blob.type || 'application/octet-stream', size: blob.size, blob, added: Date.now() })));
    }
    return id;
  },
  // Stores bytes received from the DM under the id the DM gave them.
  async putRaw(id, type, name, buf) {
    const blob = new Blob([buf], { type });
    await tx('assets', 'readwrite', s => req(s.put({ id, name, type, size: blob.size, blob, added: Date.now() })));
    return id;
  },
  async url(id) {
    if (!id) return null;
    if (urlCache.has(id)) return urlCache.get(id);
    const a = await assets.get(id);
    if (!a) return null;
    const u = URL.createObjectURL(a.blob);
    urlCache.set(id, u);
    return u;
  },
  delete: id => tx('assets', 'readwrite', s => req(s.delete(id))),
};

// Ask the browser not to evict our storage under pressure (best effort).
export async function persistStorage() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch {}
  return false;
}
