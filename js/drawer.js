// "Who's here": the NPC cards for the scene in front of you, from the session pack.
// Each card shows the portrait (once the Image Kit has made it), the role, the
// prep page's Look / Voice / Wants / Hiding lines and the sample line, with
// buttons for the stat block, a hidden token and showing the portrait.

import { el } from './util.js';
import { assets } from './store.js';
import { artFor } from './imagekit.js';
import { actorKey } from './prep.js';
import { npcsForPack } from './packbuild.js';

// The pack section for what's on screen: the viewed scene's, else the Prep tab's.
export function drawerSection(c, sc, prepSection) {
  const pack = (sc?.packRef && c.packs?.[sc.packRef.pack]) || c.packs?.[c.activePack] || Object.values(c.packs || {})[0];
  if (!pack) return { pack: null, section: null };
  npcsForPack(pack);
  const id = sc?.packRef?.pack === pack.id ? sc.packRef.section : prepSection;
  return { pack, section: pack.sections.find(s => s.id === id) || null };
}

export function presentNpcs(pack, section) {
  if (!pack || !section) return [];
  const keys = section.who || [];
  return keys.map(k => pack.npcs.find(n => n.key === k)).filter(Boolean);
}

export function portraitHandout(c, pack, n) {
  if (!n.portrait) return null;
  const key = String(n.portrait).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');   // the Image Kit's key
  return (c.handouts || []).find(h => h.pack === pack.id && h.packKey === 'portrait:' + key) || null;
}

// ctx: { camp, scene, prepSection, open, pick(sectionId|null), onClose, openActor(id), placeActor(pack, actorKey, name), showHandout(h) }
export function renderNpcDrawer(box, ctx) {
  const c = ctx.camp;
  const { pack, section: auto } = drawerSection(c, ctx.scene, ctx.prepSection);
  box.innerHTML = '';
  if (!pack) { box.hidden = true; return; }
  const section = (ctx.pick && pack.sections.find(s => s.id === ctx.pick)) || auto;
  const all = ctx.pick === '*';
  const list = all ? pack.npcs : presentNpcs(pack, section);
  const sel = el('select', { 'aria-label': 'Scene', style: { width: 'auto', fontSize: '12px', padding: '2px 6px' } },
    el('option', { value: '', selected: !ctx.pick }, auto ? `This scene (${auto.num && auto.num !== '§' ? auto.num + ' · ' : ''}${auto.title})` : 'This scene'),
    pack.sections.filter(s => s.who?.length).map(s => el('option', { value: s.id, selected: ctx.pick === s.id }, `${s.num && s.num !== '§' ? s.num + ' · ' : ''}${s.title}`)),
    el('option', { value: '*', selected: all }, 'Everyone in the pack'));
  sel.addEventListener('change', () => ctx.onPick(sel.value || null));
  box.append(el('div', { class: 'nd-head' },
    el('b', { class: 'grow' }, 'Who’s here'), sel,
    el('button', { class: 'btn icon ghost small', type: 'button', title: 'Close', 'aria-label': 'Close', onclick: ctx.onClose }, '✕')));
  if (!all && section?.whoText) box.append(el('div', { class: 'nd-who small muted' }, section.whoText));
  const body = el('div', { class: 'nd-body' });
  if (!list.length) body.append(el('p', { class: 'small muted' }, section ? 'No NPC cards for this scene in the prep.' : 'This scene isn’t from the session pack. Pick a scene above.'));
  for (const n of list) body.append(npcCard(c, pack, n, ctx));
  box.append(body);
  box.hidden = false;
}

function npcCard(c, pack, n, ctx) {
  const aKey = n.actor ? actorKey(pack.id, n.actor) : null;
  const ho = portraitHandout(c, pack, n);
  const img = ho?.img || (aKey && artFor(c, aKey)) || null;
  const pic = el('div', { class: 'nd-pic' + (img ? '' : ' none') }, img ? null : (n.name.replace(/^(the|high|old|sgt\.?|mayor|director|foreman|brother|corporal|sergeant)\s+/i, '')[0] || '?').toUpperCase());
  if (img) assets.url(img).then(u => { if (u) pic.style.backgroundImage = `url("${u}")`; });
  const fields = n.fields;
  const card = el('details', { class: 'nd-card' + (n.card ? '' : ' walk'), open: n.card && ctx.open?.has(n.key) },
    el('summary', {}, pic, el('div', { class: 'nd-t' }, el('div', { class: 'nd-nm' }, n.name), el('div', { class: 'nd-role' }, n.role || n.walkOn || ''))),
    n.walkOn && n.card ? el('p', { class: 'small muted' }, n.walkOn) : null,
    fields.length ? el('dl', {}, fields.flatMap(([k, v]) => [el('dt', {}, k), el('dd', { html: v })])) : null,
    n.line ? el('p', { class: 'nd-line' }, n.line) : null,
    el('div', { class: 'row nd-btns' },
      aKey && c.actors?.[aKey] ? el('button', { class: 'btn small', type: 'button', onclick: () => ctx.openActor(aKey) }, 'Stat block') : null,
      aKey && c.actors?.[aKey] ? el('button', { class: 'btn small', type: 'button', title: 'Put a hidden token for them in the middle of your view', onclick: () => ctx.placeActor(pack, n.actor, n.name) }, 'Place token') : null,
      ho?.img ? el('button', { class: 'btn small', type: 'button', onclick: () => ctx.showHandout(ho) }, 'Show portrait') : null,
      n.portrait && !ho?.img ? el('span', { class: 'small muted' }, 'Portrait: make it in the Image Kit') : null));
  card.addEventListener('toggle', () => { if (card.open) ctx.open?.add(n.key); else ctx.open?.delete(n.key); });
  return card;
}
