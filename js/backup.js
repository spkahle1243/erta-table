// Backups: the .ertatable file, automatic snapshots in this browser, and (in
// Chrome and Edge) incremental backups to a folder on this computer.
//
// Snapshots hold the campaign itself (scenes, tokens, sheets, clocks, rolls…),
// compressed, in IndexedDB; the pictures and tracks it uses stay in the asset
// store, which nothing ever deletes. A folder backup writes each picture or
// track once (assets/<id>) and the campaign as a dated .json beside them, so a
// later backup only adds what changed.

import { campaigns, assets, kv } from './store.js';

const SNAP_KEEP = 24, LABELLED_KEEP = 12, FOLDER_KEEP = 60;

// Every asset a campaign points at.
export function assetIds(c) {
  const ids = new Set();
  for (const s of c.scenes || []) { if (s.bg) ids.add(s.bg); for (const t of s.tokens || []) if (t.img) ids.add(t.img); }
  for (const ch of c.characters || []) if (ch.img) ids.add(ch.img);
  for (const t of c.audio?.library || []) if (t.asset) ids.add(t.asset);
  for (const h of c.handouts || []) if (h.img) ids.add(h.img);
  for (const v of Object.values(c.actorArt || {})) if (v) ids.add(v);
  return ids;
}

// ---------------------------------------------------------------- .ertatable
export async function buildZip(c) {
  const zip = new window.JSZip();
  zip.file('campaign.json', JSON.stringify(c));
  const meta = [];
  for (const id of assetIds(c)) { const a = await assets.get(id); if (!a) continue; zip.file('assets/' + id, a.blob); meta.push({ id, name: a.name, type: a.type }); }
  zip.file('assets.json', JSON.stringify(meta));
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}
export async function readZip(file) {
  const zip = await window.JSZip.loadAsync(file);
  const c = JSON.parse(await zip.file('campaign.json').async('string'));
  const meta = JSON.parse(await zip.file('assets.json')?.async('string') || '[]');
  for (const m of meta) { const buf = await zip.file('assets/' + m.id)?.async('arraybuffer'); if (buf) await assets.putRaw(m.id, m.type, m.name, buf); }
  return c;
}
export const fileName = (c, ext = '.ertatable') => `${String(c.name).replace(/[^\w-]+/g, '-')}-${new Date().toISOString().slice(0, 10)}${ext}`;

// ---------------------------------------------------------------- compression
async function pack(obj) {
  const text = JSON.stringify(obj);
  if (typeof CompressionStream === 'undefined') return { gz: false, data: text, size: text.length };
  const blob = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  return { gz: true, data: blob, size: blob.size };
}
async function unpack(rec) {
  if (!rec) return null;
  if (!rec.gz) return JSON.parse(rec.data);
  return JSON.parse(await new Response(rec.data.stream().pipeThrough(new DecompressionStream('gzip'))).text());
}

// ---------------------------------------------------------------- snapshots in this browser
const listKey = id => 'snaps:' + id, snapKey = (id, ts) => `snap:${id}:${ts}`;

export async function listSnapshots(campId) { return ((await kv.get(listKey(campId))) || []).sort((a, b) => b.ts - a.ts); }

export async function snapshot(c, label = '') {
  const ts = Date.now();
  const rec = await pack(c);
  await kv.set(snapKey(c.id, ts), rec);
  const list = await listSnapshots(c.id);
  list.unshift({ ts, label, size: rec.size, name: c.name, scenes: c.scenes?.length || 0 });
  // keep the newest automatic ones and the newest labelled ones
  const auto = list.filter(x => !x.label), named = list.filter(x => x.label);
  const keep = new Set([...auto.slice(0, SNAP_KEEP), ...named.slice(0, LABELLED_KEEP)].map(x => x.ts));
  for (const x of list) if (!keep.has(x.ts)) await kv.set(snapKey(c.id, x.ts), undefined);
  await kv.set(listKey(c.id), list.filter(x => keep.has(x.ts)));
  const index = new Set((await kv.get('snaps:index')) || []); index.add(c.id); await kv.set('snaps:index', [...index]);
  return ts;
}
export async function loadSnapshot(campId, ts) { return unpack(await kv.get(snapKey(campId, ts))); }

// Campaigns that have snapshots here but no longer exist (deleted, or lost).
export async function orphanSnapshots() {
  const ids = (await kv.get('snaps:index')) || [];
  const have = new Set((await campaigns.list()).map(c => c.id));
  const out = [];
  for (const id of ids) if (!have.has(id)) { const l = await listSnapshots(id); if (l.length) out.push({ id, latest: l[0], count: l.length }); }
  return out;
}

// ---------------------------------------------------------------- folder backups
export const folderSupported = () => typeof window.showDirectoryPicker === 'function';

export async function folderHandle() { try { return (await kv.get('backup-folder')) || null; } catch { return null; } }

// 'unsupported' | 'none' | 'granted' | 'prompt' | 'denied'
export async function folderState() {
  if (!folderSupported()) return 'unsupported';
  const h = await folderHandle(); if (!h) return 'none';
  try { return await h.queryPermission({ mode: 'readwrite' }); } catch { return 'none'; }
}
export async function chooseFolder() {
  const h = await window.showDirectoryPicker({ id: 'erta-table-backups', mode: 'readwrite' });
  await kv.set('backup-folder', h);
  return h;
}
export async function resumeFolder() {
  const h = await folderHandle(); if (!h) return false;
  return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
}
export async function forgetFolder() { await kv.set('backup-folder', undefined); }

const campDirName = c => `${String(c.name).replace(/[^\w -]+/g, '').trim().replace(/\s+/g, ' ') || 'Campaign'} (${String(c.id).slice(0, 6)})`;
const stamp = d => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`; };

async function exists(dir, name) { try { await dir.getFileHandle(name); return true; } catch { return false; } }
async function writeFile(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable(); await w.write(data); await w.close();
}

// Writes what's new: assets not yet in the folder, then the campaign. Returns { added, file }.
export async function backupToFolder(c, { label = '' } = {}) {
  const root = await folderHandle(); if (!root) throw new Error('No backup folder chosen');
  if ((await root.queryPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('The backup folder needs permission again');
  const dir = await root.getDirectoryHandle(campDirName(c), { create: true });
  const adir = await dir.getDirectoryHandle('assets', { create: true });
  const bdir = await dir.getDirectoryHandle('backups', { create: true });
  let added = 0;
  const meta = (await readJson(adir, 'assets.json')) || {};
  for (const id of assetIds(c)) {
    if (await exists(adir, id)) continue;
    const a = await assets.get(id); if (!a) continue;
    await writeFile(adir, id, a.blob); meta[id] = { name: a.name, type: a.type }; added++;
  }
  if (added) await writeFile(adir, 'assets.json', JSON.stringify(meta));
  const json = JSON.stringify(c);
  const file = `${stamp(new Date())}${label ? ' ' + label.replace(/[^\w -]+/g, '') : ''}.json`;
  await writeFile(bdir, file, json);
  await writeFile(dir, 'latest.json', json);
  // keep the folder tidy: the newest FOLDER_KEEP dated copies
  const names = [];
  for await (const [n, h] of bdir.entries()) if (h.kind === 'file' && n.endsWith('.json')) names.push(n);
  names.sort();
  for (const n of names.slice(0, Math.max(0, names.length - FOLDER_KEEP))) { try { await bdir.removeEntry(n); } catch {} }
  await kv.set('backup-last:' + c.id, Date.now());
  return { added, file, dir: campDirName(c) };
}
async function readJson(dir, name) { try { return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text()); } catch { return null; } }

// What a backup folder holds: campaigns and their dated copies. Works on the chosen
// root (many campaigns) or on one campaign's own folder.
export async function folderCatalog(root) {
  const out = [];
  const scan = async (dir, name) => {
    const b = await dir.getDirectoryHandle('backups').catch(() => null);
    const files = [];
    if (b) for await (const [n, h] of b.entries()) if (h.kind === 'file' && n.endsWith('.json')) files.push(n);
    if (await exists(dir, 'latest.json')) files.push('latest.json');
    if (files.length) out.push({ name, dir, files: files.sort().reverse() });
  };
  await scan(root, root.name);
  for await (const [n, h] of root.entries()) if (h.kind === 'directory' && n !== 'assets' && n !== 'backups') await scan(h, n);
  return out;
}
export async function readFolderBackup(dir, file) {
  const c = file === 'latest.json' ? await readJson(dir, 'latest.json') : await readJson(await dir.getDirectoryHandle('backups'), file);
  if (!c?.id) throw new Error('That file isn’t a campaign');
  const adir = await dir.getDirectoryHandle('assets').catch(() => null);
  const meta = adir ? (await readJson(adir, 'assets.json')) || {} : {};
  let missing = 0;
  for (const id of assetIds(c)) {
    if (await assets.has(id)) continue;
    try { const f = await (await adir.getFileHandle(id)).getFile(); await assets.putRaw(id, meta[id]?.type || f.type || 'application/octet-stream', meta[id]?.name || id, await f.arrayBuffer()); }
    catch { missing++; }
  }
  return { camp: c, missing };
}
