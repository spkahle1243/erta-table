// Image Kit: the list of pictures a table needs (tokens, battle maps, scene art, portraits),
// handed to the Image Kit app (Gemini Canvas, or image-kit.html with an API key),
// and the pictures it sends back, filed in their places.

import { el, toast, copyText, pickFiles } from './util.js';
import { assets } from './store.js';
import { modal } from './ui.js';

export const DEFAULT_TOKEN_STYLE = 'Painterly fantasy token portrait for a virtual tabletop. Head and shoulders (or the creature’s head and upper body) centred and facing the viewer, the whole subject inside a central circle with a little margin, dramatic rim light, plain dark smoky background, square 1:1 image, no border, no ring, no text, no watermark.';
const RATIOS = [['1:1', 1], ['4:3', 4 / 3], ['16:9', 16 / 9], ['3:4', 3 / 4], ['9:16', 9 / 16]];
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const nearestRatio = r => RATIOS.reduce((b, x) => (Math.abs(Math.log(x[1] / r)) < Math.abs(Math.log(b[1] / r)) ? x : b))[0];

// Token art lives beside the stat blocks (which a pack reload replaces).
export const artFor = (c, actorId) => (actorId && c.actorArt?.[actorId]) || null;

let sheetCache = null;
async function freshSheets() {
  if (!sheetCache) sheetCache = fetch('data/sheets/index.json').then(r => r.json()).then(idx => Promise.all(idx.map(x => fetch('data/sheets/' + x.file).then(r => r.json())))).catch(() => []);
  return sheetCache;
}

export async function buildKitList(c, { includeDone = false } = {}) {
  const items = [];
  const packs = Object.values(c.packs || {});
  // scenes and battle maps from packs
  for (const sc of c.scenes) {
    if (!sc.prompt) continue;
    const map = sc.kind === 'map';
    items.push({ id: 'scene:' + sc.id, kind: map ? 'map' : 'art', name: sc.name, subject: sc.prompt, aspect: map && sc.squares ? nearestRatio(sc.squares[0] / sc.squares[1]) : '16:9', squares: sc.squares || null, done: !!sc.bg });
  }
  // portraits (they become handouts)
  for (const p of packs) for (const po of p.portraits || []) {
    const ho = c.handouts.find(h => h.pack === p.id && h.packKey === 'portrait:' + slug(po.name));
    items.push({ id: `portrait:${p.id}:${slug(po.name)}`, kind: 'portrait', name: po.name, subject: po.prompt, aspect: '3:4', done: !!ho?.img });
  }
  // tokens: every stat block a pack brought, every monster on a scene, every summon
  const used = new Set(c.scenes.flatMap(s => s.tokens.map(t => t.actorId).filter(Boolean)));
  for (const [id, a] of Object.entries(c.actors || {})) {
    if (!id.startsWith('pack:') && !used.has(id)) continue;
    if (id.startsWith('pack:') && !c.packs?.[id.split(':')[1]]) continue;
    const packId = id.startsWith('pack:') ? id.split(':')[1] : null;
    const latest = packId ? c.packs[packId]?.actors?.[id.split(':').slice(2).join(':')] : null;
    const subject = latest?.token || a.token || `${a.name}, a ${String(a.size || '').toLowerCase()} ${String(a.type || 'creature').toLowerCase()}`.replace(/\s+/g, ' ');
    items.push({ id: 'token:' + id, kind: 'token', name: a.name, subject, aspect: '1:1', ring: '#c8553d', done: !!artFor(c, id) });
  }
  const sheets = await freshSheets();
  for (const ch of c.characters) {
    const sh = ch.sheet, fresh = sheets.find(s => s.id === sh?.id || s.name === ch.name);
    const subject = sh?.token || fresh?.token || (sh ? `${ch.name}, a ${sh.species} ${sh.classes.map(k => k.name.toLowerCase()).join(' and ')}` : `${ch.name}, an adventurer`);
    items.push({ id: 'pc:' + ch.id, kind: 'token', name: ch.name, subject, aspect: '1:1', ring: ch.color, done: !!ch.img });
  }
  const tokenStyle = packs.map(p => p.styleLocks?.token).find(Boolean) || DEFAULT_TOKEN_STYLE;
  const list = includeDone ? items : items.filter(i => !i.done);
  return { kit: 'erta-image-kit', v: 1, campaign: c.name, styles: { token: tokenStyle }, items: list, all: items };
}

// ---------------------------------------------------------------- bringing pictures home

// items: [{ id, name, blob }]. ctx: { camp, change(fn, opts), setBackground(sc, file, squares, quiet) }
export async function importImages(ctx, items) {
  const c = ctx.camp;
  let n = 0;
  const missed = [];
  for (const it of items) {
    const [kind, ...rest] = it.id.split(':');
    const file = new File([it.blob], `${slug(it.name || kind)}.jpg`, { type: it.blob.type || 'image/jpeg' });
    if (kind === 'scene') {
      const sc = c.scenes.find(s => s.id === rest[0]);
      if (!sc) { missed.push(it.name); continue; }
      await ctx.setBackground(sc, file, sc.squares?.[0] || 0, true); n++;
      continue;
    }
    const asset = await assets.put(file, file.name);
    if (kind === 'portrait') {
      const [packId, key] = rest;
      const po = c.packs?.[packId]?.portraits?.find(p => slug(p.name) === key);
      ctx.change(() => {
        let ho = c.handouts.find(h => h.pack === packId && h.packKey === 'portrait:' + key);
        if (!ho) { ho = { id: Math.random().toString(36).slice(2, 10), title: po?.name || it.name, text: '', style: 'portrait', img: null, pack: packId, packKey: 'portrait:' + key }; c.handouts.push(ho); }
        ho.img = asset;
      }, { panel: false });
      n++;
    } else if (kind === 'token') {
      const actorId = rest.join(':');
      ctx.change(() => {
        c.actorArt ||= {};
        c.actorArt[actorId] = asset;
        for (const s of c.scenes) for (const t of s.tokens) if (t.actorId === actorId && (!t.img || t.imgAuto)) { t.img = asset; t.imgAuto = true; }
      }, { panel: false });
      n++;
    } else if (kind === 'pc') {
      const ch = c.characters.find(x => x.id === rest[0]);
      if (!ch) { missed.push(it.name); continue; }
      ctx.change(() => { ch.img = asset; }, { panel: false });
      n++;
    } else missed.push(it.name);
  }
  ctx.change(() => {}, { rail: true });
  toast(`Filed ${n} picture${n === 1 ? '' : 's'}${missed.length ? `; ${missed.length} had nowhere to go (${missed.slice(0, 3).join(', ')})` : ''}`, missed.length ? '' : 'ok');
  return n;
}

export async function importZip(ctx, file) {
  if (!window.JSZip) { toast('Zip support didn’t load; reload the page and try again', 'bad'); return 0; }
  let zip;
  try { zip = await window.JSZip.loadAsync(file); } catch { toast('That file isn’t a zip', 'bad'); return 0; }
  const mf = zip.file('manifest.json');
  if (!mf) { toast('That zip didn’t come from the Image Kit (no manifest.json)', 'bad'); return 0; }
  let manifest;
  try { manifest = JSON.parse(await mf.async('string')); } catch { toast('The Image Kit manifest is damaged', 'bad'); return 0; }
  const items = [];
  for (const m of manifest.items || []) {
    const f = zip.file(m.file); if (!f) continue;
    items.push({ id: m.id, name: m.name, blob: new Blob([await f.async('arraybuffer')], { type: 'image/jpeg' }) });
  }
  return importImages(ctx, items);
}

// Pictures sent straight from an Image Kit page open on this same site.
let channel = null;
export function listenForKit(getCtx) {
  if (channel || typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel('erta-image-kit');
  channel.onmessage = async e => {
    const ctx = getCtx(); if (!ctx?.camp) return;
    if (e.data?.type === 'ping') channel.postMessage({ type: 'pong', campaign: ctx.camp.name });
    if (e.data?.type === 'images') {
      const items = (e.data.items || []).map(x => ({ id: String(x.id), name: x.name, blob: new Blob([x.buf], { type: x.type || 'image/jpeg' }) }));
      const n = await importImages(ctx, items);
      channel.postMessage({ type: 'received', count: n });
    }
  };
}

// ---------------------------------------------------------------- the dialog
export async function imageKitDialog(ctx) {
  const c = ctx.camp;
  let includeDone = false;
  const sum = el('p', { class: 'small' });
  const counts = async () => {
    const k = await buildKitList(c, { includeDone });
    const by = kind => k.items.filter(i => i.kind === kind).length;
    const parts = [[by('token'), 'token'], [by('map'), 'battle map'], [by('art'), 'scene picture'], [by('portrait'), 'portrait']].filter(([n]) => n).map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`);
    sum.textContent = k.items.length ? `${includeDone ? 'On the list' : 'Still needed'}: ${parts.join(', ')}.` : 'Every token, scene and portrait already has a picture.';
    return k;
  };
  await counts();
  const codeP = fetch('image-kit.html', { cache: 'no-cache' }).then(r => r.text()).catch(() => null);
  const redo = el('input', { type: 'checkbox' });
  redo.addEventListener('change', () => { includeDone = redo.checked; counts(); });
  const listText = async () => { const k = await buildKitList(c, { includeDone }); delete k.all; return JSON.stringify(k); };
  const body = el('div', { class: 'stack kit-dlg' },
    el('p', { class: 'small muted' }, 'The Image Kit makes the pictures this table needs with Google’s image models: token art for every creature and character, battle maps, scene art and portraits. You bring them back as one zip and each picture lands in its place.'),
    sum,
    el('label', { class: 'check small' }, redo, 'Also remake pictures that already have one'),
    el('div', { class: 'kit-way' },
      el('h4', {}, 'With your Gemini login (Gemini Canvas)'),
      el('p', { class: 'small muted' }, 'Copy the kit, paste it into a new Gemini chat with Canvas turned on, and send. Then copy the list and paste it into the kit. Your Gemini plan covers the pictures; no key needed.'),
      el('div', { class: 'row' },
        el('button', { class: 'btn small primary', type: 'button', onclick: async () => {
          try {
            const code = await codeP; if (!code) throw new Error();
            const msg = 'Open this in Canvas as an HTML app and run it exactly as written. Don’t change, shorten or restyle the code.\n\n```html\n' + code + '\n```';
            if (await copyText(msg)) toast('Image Kit copied. Paste it into Gemini with Canvas on.', 'ok');
          } catch { toast('Couldn’t read the Image Kit file', 'bad'); }
        } }, '1 · Copy the Image Kit'),
        el('button', { class: 'btn small primary', type: 'button', onclick: async () => { if (await copyText(await listText())) toast('List copied. Paste it into the Image Kit.', 'ok'); } }, '2 · Copy the list'))),
    el('div', { class: 'kit-way' },
      el('h4', {}, 'Or with a Gemini API key, right here'),
      el('p', { class: 'small muted' }, 'Opens the kit in a new tab with the list already loaded; add your key in its Settings. Pictures can go straight back to this table with “Send to”.'),
      el('div', { class: 'row' }, el('button', { class: 'btn small', type: 'button', onclick: async () => { window.open('image-kit.html#list=' + encodeURIComponent(await listText()), '_blank'); } }, 'Open the Image Kit'))),
    el('div', { class: 'kit-way' },
      el('h4', {}, 'Bring them home'),
      el('p', { class: 'small muted' }, 'Choose the zip the kit downloaded (or drop it on the map). Battle maps get their grid from the prep, tokens already on the map pick up their art, portraits become handouts.'),
      el('div', { class: 'row' }, el('button', { class: 'btn small copper', type: 'button', onclick: async () => {
        const [f] = await pickFiles({ accept: '.zip,application/zip' }); if (!f) return;
        const n = await importZip(ctx, f); if (n) { m.close(); ctx.renderPanel?.(true); }
      } }, 'Load images (.zip)…'))));
  const m = modal({ title: 'Image Kit', body, actions: [{ label: 'Close' }] });
}
