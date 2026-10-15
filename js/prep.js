// Session packs: loading a pack into a campaign, and the Prep tab that runs it.
// A pack is a prep page (scenes, read-alouds, checks, NPCs) plus the data the
// table needs: scenes to create, soundtrack slots, handouts, stat blocks,
// encounters and clocks.

import { el, uid, toast, copyText, pickFiles } from './util.js';
import { assets } from './store.js';
import { newScene, newToken } from './model.js';
import { ICONS, modal } from './ui.js';
import { renderStatBlock } from './statblock.js';
import { artFor } from './imagekit.js';

export const actorKey = (packId, key) => `pack:${packId}:${key}`;

// ---------------------------------------------------------------- loading
export function importPack(c, pack) {
  if (pack?.format !== 'erta-table-pack') throw new Error('Not an Erta Table session pack');
  c.packs ||= {}; c.clocks ||= [];
  const fresh = !c.packs[pack.id];
  c.packs[pack.id] = pack;
  // soundtrack slots
  const trackFor = {};
  for (const m of pack.music) {
    let t = c.audio.library.find(x => x.pack === pack.id && x.packKey === m.key);
    if (!t) { t = { id: uid(8), name: m.name, kind: 'music', asset: null, vol: 1, pack: pack.id, packKey: m.key }; c.audio.library.push(t); }
    t.prompt = m.prompt; t.name = t.asset ? t.name : m.name;
    trackFor[m.key] = t.id;
  }
  // scenes
  let added = 0;
  for (const s of pack.scenes) {
    let sc = c.scenes.find(x => x.packRef?.pack === pack.id && x.packRef.key === s.key);
    if (!sc) {
      sc = newScene({ name: s.name, kind: s.kind, music: s.music ? trackFor[s.music] : null });
      sc.packRef = { pack: pack.id, key: s.key, section: s.section };
      if (s.squares) sc.squares = s.squares;
      c.scenes.push(sc); added++;
    }
    sc.prompt = s.prompt; sc.packRef.section = s.section;
    if (s.squares) sc.squares = s.squares;
  }
  // handouts
  c.handouts ||= [];
  for (const h of pack.handouts) {
    const ex = c.handouts.find(x => x.pack === pack.id && x.packKey === h.key);
    if (ex) Object.assign(ex, { title: h.title, text: h.text, style: h.style });
    else c.handouts.push({ id: uid(8), title: h.title, text: h.text, style: h.style, img: null, pack: pack.id, packKey: h.key });
  }
  // stat blocks
  c.actors ||= {};
  for (const [k, a] of Object.entries(pack.actors || {})) c.actors[actorKey(pack.id, k)] = a;
  // clocks
  for (const k of pack.clocks || []) {
    const ex = c.clocks.find(x => x.pack === pack.id && x.key === k.key);
    if (ex) Object.assign(ex, { name: k.name, size: k.size, goal: k.goal, steps: k.steps || {} });
    else c.clocks.push({ id: uid(8), pack: pack.id, key: k.key, name: k.name, size: k.size, value: k.start || 0, visible: !!k.visible, goal: k.goal || '', steps: k.steps || {} });
  }
  c.activePack = pack.id;
  return { fresh, added };
}

export async function fetchPackIndex() {
  try { const r = await fetch(new URL('../packs/index.json', import.meta.url), { cache: 'no-cache' }); return r.ok ? await r.json() : []; } catch { return []; }
}
export async function fetchPack(file) {
  const r = await fetch(new URL('../packs/' + file, import.meta.url), { cache: 'no-cache' });
  if (!r.ok) throw new Error('Could not load the pack');
  return r.json();
}

// ---------------------------------------------------------------- clocks
export function clockWidget(k, { editable, onSet, onToggleVisible } = {}) {
  const pips = el('div', { class: 'pips', role: 'group', 'aria-label': k.name });
  for (let i = 0; i < k.size; i++) {
    const p = el('button', { class: 'pip' + (i < k.value ? ' on' : ''), type: 'button', disabled: !editable, 'aria-label': `Segment ${i + 1}`, title: k.steps?.[i + 1] || '' });
    if (editable) p.addEventListener('click', () => onSet(k.value === i + 1 ? i : i + 1));
    pips.append(p);
  }
  const step = k.steps?.[k.value];
  return el('div', { class: 'clockw' },
    el('div', { class: 'row' }, el('b', { class: 'grow' }, k.name), el('span', { class: 'mono small' }, `${k.value} / ${k.size}`),
      editable ? el('button', { class: 'btn icon ghost', type: 'button', title: k.visible ? 'Players can see this clock' : 'Hidden from players', html: k.visible ? ICONS.eye : ICONS.eyeoff, onclick: onToggleVisible }) : null),
    pips,
    k.goal ? el('div', { class: 'small muted' }, k.goal) : null,
    step ? el('div', { class: 'small', style: { color: 'var(--copper)' } }, `At ${k.value}: ${step}`) : null);
}

// ---------------------------------------------------------------- Prep tab
let styleFor = null;
function ensureStyle(pack) {
  if (styleFor === pack.id) return;
  document.getElementById('pack-style')?.remove();
  document.head.append(el('style', { id: 'pack-style' }, pack.css || ''));
  styleFor = pack.id;
}

// ctx: { camp, change(fn,opts), scene(id), viewScene(id), setBackground(sc,file,squares), dmRoll(f,opts), playTrack(t), showHandout(h), placeEncounter(enc, group|null), openActor(actorId), state }
export function paneprep(ctx) {
  const c = ctx.camp;
  const wrap = el('div', { class: 'stack prep-pane' });
  const packs = Object.values(c.packs || {});
  const pack = c.packs?.[c.activePack] || packs[0];
  const loader = el('div', { class: 'row' },
    el('button', { class: 'btn small', type: 'button', onclick: () => loadPackDialog(ctx) }, packs.length ? 'Load another pack…' : 'Load a session pack…'),
    el('button', { class: 'btn small copper', type: 'button', title: 'Make token art, battle maps, scene art and portraits with Gemini', onclick: () => ctx.imageKit?.() }, 'Image Kit…'),
    packs.length > 1 ? (() => { const s = el('select', { style: { width: 'auto' } }, packs.map(p => el('option', { value: p.id, selected: p.id === pack?.id }, p.title))); s.addEventListener('change', () => ctx.change(cc => { cc.activePack = s.value; })); return s; })() : null);
  if (!pack) {
    wrap.append(el('h3', {}, 'Session prep'), el('p', { class: 'small muted' }, 'A session pack brings your prep into the table: every scene and battle map ready for its image, the soundtrack slots, handouts you can push to players, stat blocks, encounters you can drop onto the map, and the case clocks.'), loader);
    return wrap;
  }
  ensureStyle(pack);
  const st = ctx.state;
  const secs = pack.sections;
  if (!secs.some(s => s.id === st.prepSection)) st.prepSection = secs.find(s => /^s\d/.test(s.id))?.id || secs[0].id;
  const nav = el('div', { class: 'prep-nav' }, secs.map(s => el('button', { class: 'chip-btn', type: 'button', 'aria-pressed': s.id === st.prepSection ? 'true' : 'false', title: s.title, onclick: () => { st.prepSection = s.id; ctx.renderPanel(true); ctx.scrollPane(0); } }, s.num && s.num !== '§' ? s.num : s.id === 'overview' ? '§' : s.id === 'prep' ? 'Prep' : s.title)));
  const head = el('div', { class: 'prep-head' },
    el('div', { class: 'row' }, el('div', { class: 'grow' }, el('div', { class: 'lbl' }, pack.eyebrow || 'Session pack'), el('h3', { style: { margin: 0 } }, pack.title)),
      el('label', { class: 'check small', title: 'Jump to the matching prep when you open a pack scene' }, (() => { const x = el('input', { type: 'checkbox', checked: st.prepFollow !== false }); x.addEventListener('change', () => { st.prepFollow = x.checked; }); return x; })(), 'Follow scene')),
    nav, loader);
  wrap.append(head);
  const sec = secs.find(s => s.id === st.prepSection);
  const doc = el('div', { class: 'prep-doc' });
  doc.innerHTML = `<div class="wrap">${sec.html}</div>`;
  enhance(doc, pack, ctx);
  wrap.append(doc);
  return wrap;
}

function enhance(doc, pack, ctx) {
  const c = ctx.camp;
  // Copy buttons on prompts
  for (const b of doc.querySelectorAll('details.art button.copy')) b.addEventListener('click', async e => {
    e.preventDefault(); e.stopPropagation();
    const p = b.closest('details').querySelector('.artp');
    if (p && await copyText(p.textContent.trim())) { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1400); }
  });
  // Scene prompts: link to their table scene
  for (const d of doc.querySelectorAll('details[data-scene]')) {
    const sc = c.scenes.find(s => s.packRef?.pack === pack.id && s.packRef.key === d.dataset.scene);
    if (!sc) continue;
    const bar = el('div', { class: 'pack-bar' },
      el('span', { class: 'small ' + (sc.bg ? 'ok' : 'need') }, sc.bg ? '✓ image attached' : 'needs an image'),
      el('button', { class: 'btn small', type: 'button', onclick: async () => { const [f] = await pickFiles({ accept: 'image/*' }); if (f) { await ctx.setBackground(sc, f, sc.squares?.[0] || 0); ctx.renderPanel(true); } } }, sc.bg ? 'Replace…' : 'Choose image…'),
      el('button', { class: 'btn small', type: 'button', onclick: () => ctx.viewScene(sc.id) }, 'Open scene'),
      sc.id === c.activeSceneId ? el('span', { class: 'chip', style: { color: 'var(--jade)' } }, 'live') : el('button', { class: 'btn small primary', type: 'button', onclick: () => ctx.activate(sc.id) }, 'Show players'));
    d.after(bar);
  }
  // Portrait prompts: once the Image Kit has made the portrait, show it to players
  for (const d of doc.querySelectorAll('details.art')) {
    const m = (d.querySelector('summary')?.textContent || '').match(/Portrait prompt\s*·\s*(.+?)\s*(\(|Copy|$)/);
    if (!m) continue;
    const key = 'portrait:' + m[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const ho = c.handouts.find(h => h.pack === pack.id && h.packKey === key);
    d.after(el('div', { class: 'pack-bar' },
      el('span', { class: 'small ' + (ho?.img ? 'ok' : 'need') }, ho?.img ? '✓ portrait made' : 'no portrait yet (Image Kit)'),
      ho?.img ? el('button', { class: 'btn small primary', type: 'button', onclick: () => ctx.showHandout({ ...ho, at: Date.now() }) }, 'Show players') : null));
  }
  // Soundtrack prompts: play or attach
  for (const d of doc.querySelectorAll('details[data-music]')) {
    const t = c.audio.library.find(x => x.pack === pack.id && x.packKey === d.dataset.music);
    if (!t) continue;
    const bar = el('div', { class: 'pack-bar' },
      t.asset ? el('button', { class: 'btn small', type: 'button', html: ICONS.play + ' Play for everyone', onclick: () => ctx.playTrack(t) }) : el('span', { class: 'small need' }, 'no track yet'),
      el('button', { class: 'btn small', type: 'button', onclick: async () => { const [f] = await pickFiles({ accept: 'audio/*' }); if (f) { await ctx.attachTrack(t, f); ctx.renderPanel(true); } } }, t.asset ? 'Replace file…' : 'Attach Suno file…'),
      t.asset ? (() => { const s = el('select', { style: { width: 'auto', fontSize: '12px', padding: '2px 4px' } }, ['music', 'ambience', 'sfx'].map(k => el('option', { value: k, selected: t.kind === k }, k))); s.addEventListener('change', () => ctx.change(() => { t.kind = s.value; })); return s; })() : null);
    d.after(bar);
  }
  // Read-alouds: show to players
  for (const ra of doc.querySelectorAll('.ra')) {
    const label = ra.getAttribute('data-label') || 'Read aloud';
    ra.append(el('button', { class: 'ra-push', type: 'button', title: 'Show this text on players’ screens', onclick: () => {
      const text = [...ra.querySelectorAll('p')].map(p => p.textContent.trim()).join('\n\n');
      ctx.showHandout({ id: uid(8), title: '', text, style: 'paper' });
    } }, 'Show players'));
  }
  // Handouts
  for (const h of doc.querySelectorAll('[data-handout]')) {
    const ho = c.handouts.find(x => x.pack === pack.id && x.packKey === h.dataset.handout);
    if (!ho) continue;
    h.style.position = 'relative';
    h.append(el('button', { class: 'ra-push', type: 'button', onclick: () => ctx.showHandout({ ...ho, at: Date.now() }) }, 'Show players'));
  }
  // Encounters
  for (const m of doc.querySelectorAll('.pack-enc')) {
    const enc = pack.encounters.find(e => e.key === m.dataset.encounter);
    if (!enc) continue;
    const box = el('div', { class: 'enc-run' },
      el('div', { class: 'row' }, el('b', { class: 'grow' }, `Run: ${enc.name}`), enc.xp ? el('span', { class: 'chip' }, `${enc.xp.toLocaleString()} XP`) : null),
      ...enc.groups.map((g, gi) => el('div', { class: 'row' },
        el('span', { class: 'grow small' }, g.label + ': ' + g.foes.map(f => `${f.count}× ${f.name || c.actors[actorKey(pack.id, f.actor)]?.name || f.actor}`).join(', ')),
        el('button', { class: 'btn small', type: 'button', onclick: () => ctx.placeEncounter(pack, enc, gi) }, 'Place (hidden)'))),
      el('div', { class: 'row' },
        [...new Set(enc.groups.flatMap(g => g.foes.map(f => f.actor)))].map(a => el('button', { class: 'btn small ghost', type: 'button', onclick: () => ctx.openActor(actorKey(pack.id, a)) }, (c.actors[actorKey(pack.id, a)]?.name || a) + ' stats'))));
    m.append(box);
  }
  // Clocks
  for (const host of doc.querySelectorAll('[data-clocks]')) {
    host.innerHTML = '';
    host.classList.add('clock-host');
    for (const key of host.dataset.clocks.split(',')) {
      const k = c.clocks.find(x => x.pack === pack.id && x.key === key);
      if (!k) continue;
      host.append(clockWidget(k, { editable: true, onSet: v => ctx.change(() => { k.value = v; }), onToggleVisible: () => ctx.change(() => { k.visible = !k.visible; }) }));
    }
  }
  // "Leads to" panels and in-page links
  for (const b of doc.querySelectorAll('.exits .lead')) b.addEventListener('click', () => {
    const ex = b.closest('.exits'), open = b.getAttribute('aria-expanded') === 'true';
    for (const o of ex.querySelectorAll('.lead')) { o.setAttribute('aria-expanded', 'false'); const p = doc.querySelector('#' + o.getAttribute('aria-controls')); if (p) p.hidden = true; }
    if (!open) { b.setAttribute('aria-expanded', 'true'); const p = doc.querySelector('#' + b.getAttribute('aria-controls')); if (p) p.hidden = false; }
  });
  for (const a of doc.querySelectorAll('a[href^="#"]')) a.addEventListener('click', e => {
    e.preventDefault();
    const id = a.getAttribute('href').slice(1);
    const local = doc.querySelector('#' + CSS.escape(id));
    if (local) { local.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const target = pack.sections.find(s => s.id === id || s.html.includes(`id="${id}"`));
    if (target) { ctx.state.prepSection = target.id; ctx.renderPanel(true); setTimeout(() => document.querySelector('.prep-doc #' + CSS.escape(id))?.scrollIntoView({ block: 'start' }), 50); }
  });
}

export async function loadPackDialog(ctx) {
  const list = await fetchPackIndex();
  const body = el('div', { class: 'stack' });
  const theme = ctx.camp.theme;
  const mine = list.filter(p => !p.series || p.series === theme);
  if (mine.length) {
    body.append(el('div', { class: 'lbl' }, 'Packs on your table site'));
    for (const p of mine) body.append(el('div', { class: 'track' },
      el('span', {}), el('div', {}, el('div', { class: 'nm' }, p.title), el('div', { class: 'kind' }, (p.eyebrow || '') + (p.built ? ' · ' + p.built : ''))),
      el('button', { class: 'btn small primary', type: 'button', onclick: async () => { try { const pk = await fetchPack(p.file); m.close(); ctx.loadPack(pk); } catch (e) { toast(e.message, 'bad'); } } }, ctx.camp.packs?.[p.id] ? 'Update' : 'Load')));
  }
  body.append(el('div', { class: 'lbl', style: { marginTop: '8px' } }, 'Or from a file'),
    el('button', { class: 'btn', type: 'button', onclick: async () => {
      const [f] = await pickFiles({ accept: '.json,application/json' }); if (!f) return;
      try { const pk = JSON.parse(await f.text()); m.close(); ctx.loadPack(pk); } catch (e) { toast('That isn’t a session pack', 'bad'); }
    } }, 'Choose pack file…'),
    el('p', { class: 'small muted' }, 'Reloading a pack you already have updates its text, stat blocks and clocks, and adds anything new. Your images, tracks, tokens and clock values stay put.'));
  const m = modal({ title: 'Session packs', body, actions: [{ label: 'Close' }] });
}

export function actorModal(a, onRoll) {
  modal({ title: a.name, wide: true, body: renderStatBlock(a, { onRoll }), actions: [{ label: 'Close' }] });
}

// Place an encounter group (or all groups) as hidden tokens near the view centre.
export function encounterTokens(c, pack, enc, groupIndex, center, grid) {
  const groups = groupIndex == null ? enc.groups : [enc.groups[groupIndex]];
  const out = [];
  let i = 0;
  for (const g of groups) for (const f of g.foes) {
    const a = c.actors[actorKey(pack.id, f.actor)];
    if (!a) continue;
    for (let n = 0; n < f.count; n++) {
      const sz = Math.max(1, Math.round(a.squares || 1));
      const name = f.name || (f.count > 1 || g.foes.length > 1 ? `${a.name} ${n + 1}` : a.name);
      out.push(newToken({
        name, actorId: actorKey(pack.id, f.actor), img: artFor(c, actorKey(pack.id, f.actor)), hp: { value: a.hp.max, max: a.hp.max, temp: 0 }, ac: a.ac, init: a.init, size: sz,
        disposition: f.disposition || 'hostile', hidden: true,
        x: center.cx + (i % 4) * Math.max(1, sz) - 1, y: center.cy + Math.floor(i / 4) * Math.max(1, sz) + 1,
      }));
      i++;
    }
  }
  return out;
}
