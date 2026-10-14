// The player view: joins the DM's table from a character link.

import { $, el, throttle, toast, clamp } from './util.js';
import { assets, persistStorage } from './store.js';
import { Client } from './net.js';
import { MapView } from './render.js';
import { AudioEngine } from './audio.js';
import { viewAssets } from './model.js';
import { ICONS, popover, closePopover, hpConditionsEditor, conditionChips, renderHandout, avatar } from './ui.js';

const P = { client: null, view: null, map: null, audio: null, me: null, entered: false, dismissed: null, handoutEl: null };
window.__player = P;

function parseLink() {
  const h = new URLSearchParams(location.hash.slice(1));
  return { hostId: h.get('h'), key: h.get('k') };
}

function joinScreen(state, detail = '') {
  let j = $('#join');
  if (!j) { j = el('div', { class: 'join', id: 'join' }); document.body.append(j); }
  j.innerHTML = '';
  const inner = el('div', {});
  if (state === 'bad-link') inner.append(el('div', { class: 'eyebrow' }, 'Erta Table'), el('h1', {}, 'This link is incomplete'), el('p', {}, 'Ask your DM to send your character link again.'));
  else if (state === 'denied') inner.append(el('div', { class: 'eyebrow' }, 'Erta Table'), el('h1', {}, 'Link not accepted'), el('p', {}, detail));
  else if (state === 'waiting') inner.append(el('div', { class: 'eyebrow' }, 'Erta Table'), el('h1', {}, 'The table isn’t open yet'), el('p', {}, 'Waiting for your DM to open the campaign. This page will connect on its own.'));
  else if (state === 'connecting') inner.append(el('div', { class: 'eyebrow' }, 'Erta Table'), el('h1', {}, 'Finding the table…'), el('p', {}, 'Connecting to your DM.'));
  else if (state === 'ready') {
    const me = P.me;
    inner.append(
      el('div', { class: 'eyebrow' }, P.view?.campaign?.name || 'Erta Table'),
      el('h1', { style: { color: me?.color } }, me?.name || 'Your character'),
      el('p', {}, P.view?.scene ? `The table is set: ${P.view.scene.name}.` : 'Your DM is setting the table.'),
      el('button', { class: 'btn primary', type: 'button', onclick: enter }, 'Take your seat'));
  }
  j.append(inner);
}

function enter() {
  P.entered = true;
  P.audio.unlock();
  $('#join')?.remove();
  render();
}

// ------------------------------------------------------------------ boot
async function boot() {
  const { hostId, key } = parseLink();
  if (!hostId || !key) { joinScreen('bad-link'); return; }
  persistStorage();
  buildApp();
  joinScreen('connecting');
  const client = new Client(hostId, { key });
  P.client = client;
  P.audio = new AudioEngine(async id => { await client.ensureAsset(id); return assets.url(id); }, () => client.now());
  try { Object.assign(P.audio.vol, JSON.parse(localStorage.getItem('erta-table-vol') || '{}')); } catch {}
  client.on('status', s => {
    renderStatus();
    if (!P.entered) { if (s === 'waiting') joinScreen('waiting'); else if (s === 'connecting' || s === 'reconnecting') joinScreen('connecting'); }
  });
  client.on('denied', reason => joinScreen('denied', reason));
  client.on('welcome', m => { onView(m.view); if (!P.entered) joinScreen('ready'); });
  client.on('progress', (id, f) => { const chip = $('#loading'); if (chip) { chip.hidden = f >= 1; chip.textContent = `Loading ${Math.round(f * 100)}%`; } });
  client.on('message', onMessage);
  client.start();
}

function onMessage(m) {
  switch (m.t) {
    case 'state': onView(m.view); return;
    case 'drag': P.map.setRemoteDrag(m.id, m.x, m.y); return;
    case 'ruler': P.map.setRemoteRuler(m.key, m.pts ? { pts: m.pts, color: m.color, name: m.name } : null); return;
    case 'ping': P.map.addPing(m.x, m.y, m.color, !!m.pull); return;
    case 'sfx': P.audio.sfx(m.asset, m.vol); return;
  }
}

function onView(v) {
  P.view = v;
  P.me = v.you;
  // fetch everything this view needs in the background
  for (const id of viewAssets(v)) P.client.ensureAsset(id).catch(() => {});
  P.audio.set('music', v.audio.music);
  P.audio.set('ambience', v.audio.ambience);
  if (P.entered) render();
}

// ------------------------------------------------------------------ app shell
function buildApp() {
  const canvas = el('canvas', { id: 'map', 'aria-label': 'Map' });
  document.getElementById('root').append(el('div', { class: 'player' },
    el('header', { class: 'topbar' },
      el('div', { class: 'title', id: 'title' }, 'Erta Table'),
      el('div', { class: 'spacer' }),
      el('span', { class: 'chip', id: 'loading', hidden: true }),
      el('span', { class: 'status', id: 'net' }),
      el('button', { class: 'btn icon ghost', type: 'button', title: 'Volume', html: ICONS.vol, onclick: e => volumePop(e) })),
    el('main', { class: 'stage', id: 'stage' },
      canvas,
      el('div', { class: 'toolbar', id: 'toolbar' }),
      el('div', { class: 'party-strip', id: 'party' }),
      el('div', { class: 'pc-card', id: 'pc' }),
      el('div', { class: 'paused', id: 'paused', hidden: true }, el('span', {}, 'Game paused')),
      el('div', { class: 'empty-stage', id: 'empty', hidden: true }))));
  P.map = new MapView(canvas, {
    role: 'player',
    getUrl: async id => { await P.client.ensureAsset(id); return assets.url(id); },
    getDiagonals: () => P.view?.settings?.diagonals || 'equal',
    canMoveToken: t => !!P.me && t.charId === P.me.charId && !P.view?.paused,
    onTokenDrag: (id, x, y, final) => { if (final) P.client.send({ t: 'move', id, x, y }); else dragOut(id, x, y); },
    onRuler: pts => rulerOut(pts),
    onPing: (x, y) => P.client.send({ t: 'ping', x, y }),
    onTemplateAdd: tpl => P.client.send({ t: 'tpl-add', tpl }),
    onTemplateRemove: id => {
      const t = P.view?.scene?.templates.find(t => t.id === id);
      if (t && t.owner === P.me?.charId) P.client.send({ t: 'tpl-del', id });
      else toast('Only the DM or whoever placed it can remove that template');
    },
    onTokenContext: (id, x, y) => { const t = P.view?.scene?.tokens.find(t => t.id === id); if (t?.charId === P.me?.charId) myHud(x, y); },
    onTokenDblClick: id => { const t = P.view?.scene?.tokens.find(t => t.id === id); if (t?.charId === P.me?.charId) $('#pc details')?.setAttribute('open', ''); },
  });
  P.map.myColor = '#66C39D';
  buildToolbar();
}

const dragOut = throttle((id, x, y) => P.client.send({ t: 'drag', id, x, y }), 50);
const rulerOut = throttle(pts => P.client.send({ t: 'ruler', pts }), 60);

const PTOOLS = [
  [['select', 'Move your token (drag the map to look around, hold to ping)'], ['ruler', 'Measure'], ['ping', 'Ping']],
  [['tpl:circle', 'Sphere / radius'], ['tpl:cone', 'Cone'], ['tpl:line', 'Line'], ['tpl:cube', 'Cube']],
];
const PICON = { select: 'select', ruler: 'ruler', ping: 'ping', 'tpl:circle': 'circle', 'tpl:cone': 'cone', 'tpl:line': 'line', 'tpl:cube': 'cube' };
function buildToolbar() {
  const tb = $('#toolbar'); tb.innerHTML = '';
  for (const grp of PTOOLS) {
    const g = el('div', { class: 'grp' });
    for (const [id, tip] of grp) g.append(el('button', { class: 'tool', type: 'button', 'data-tool': id, 'aria-label': tip, 'aria-pressed': id === 'select' ? 'true' : 'false', html: ICONS[PICON[id]] + `<span class="tip">${tip}</span>`, onclick: () => setTool(id) }));
    tb.append(g);
  }
  tb.append(el('div', { class: 'grp' }, el('button', { class: 'tool', type: 'button', 'aria-label': 'Fit map', html: ICONS.fit + '<span class="tip">Fit map to screen</span>', onclick: () => P.map.fit() })));
  const KEYS = { v: 'select', r: 'ruler', p: 'ping', c: 'tpl:circle', o: 'tpl:cone', l: 'tpl:line', b: 'tpl:cube' };
  window.addEventListener('keydown', e => { if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea, select')) return; const t = KEYS[e.key.toLowerCase()]; if (t) setTool(t); });
}
function setTool(id) {
  P.map.setTool(id);
  for (const b of document.querySelectorAll('.tool[data-tool]')) b.setAttribute('aria-pressed', b.dataset.tool === id ? 'true' : 'false');
}

function renderStatus() {
  const n = $('#net'); if (!n) return;
  const s = P.client?.status;
  const map = { online: ['on', 'At the table'], connecting: ['warn', 'Connecting…'], reconnecting: ['warn', 'Reconnecting…'], waiting: ['warn', 'Waiting for DM'], denied: ['bad', 'Link not accepted'] };
  const [cls, txt] = map[s] || ['warn', s || ''];
  n.innerHTML = ''; n.append(el('span', { class: 'dot ' + cls }), txt);
}

// ------------------------------------------------------------------ render
async function render() {
  const v = P.view; if (!v) return;
  $('#title').innerHTML = '';
  $('#title').append(v.scene?.name || v.campaign.name, el('small', {}, v.campaign.name));
  document.title = (P.me?.name || 'Player') + ' · ' + v.campaign.name;
  renderStatus();
  // map
  const empty = $('#empty');
  if (v.scene) {
    P.map.setScene({ ...v.scene, tokens: v.scene.tokens.map(t => ({ ...t, hidden: false })) });
    empty.hidden = true;
  } else {
    P.map.setScene(null);
    empty.hidden = false; empty.innerHTML = '';
    empty.append(el('div', {}, el('h2', {}, 'The table is being set'), el('p', {}, 'Your DM hasn’t shown a scene yet.')));
  }
  $('#paused').hidden = !v.paused;
  renderPc(); renderParty(); renderHandoutView();
}

function myChar() { return P.view?.party.find(p => p.id === P.me?.charId); }

function renderPc() {
  const box = $('#pc'); const ch = myChar();
  if (!ch) { box.hidden = true; return; }
  if (box.contains(document.activeElement) && document.activeElement.matches('input')) return;
  const wasOpen = box.querySelector('details')?.open;
  box.hidden = false; box.style.setProperty('--pc', ch.color);
  box.innerHTML = '';
  const f = ch.hp.max ? clamp(ch.hp.value / ch.hp.max, 0, 1) : 0;
  const data = { hp: { ...ch.hp }, conditions: [...ch.conditions] };
  box.append(
    el('div', { class: 'row' }, el('div', { class: 'nm grow' }, ch.name),
      el('div', { class: 'stats' }, el('span', { class: 'chip' }, 'AC ' + ch.ac), ch.speed ? el('span', { class: 'chip' }, ch.speed) : null)),
    el('div', { class: 'hp-big' }, el('b', {}, ch.hp.value), el('span', { class: 'muted' }, '/ ' + ch.hp.max), ch.hp.temp ? el('span', { style: { color: '#7fb7d9' } }, `+${ch.hp.temp} temp`) : null,
      el('span', { class: 'bar', style: { marginLeft: '8px' } }, el('i', { style: { width: f * 100 + '%', background: f > .5 ? '#4f9d69' : f > .25 ? '#d6a73c' : '#c8553d' } }))),
    ...(ch.conditions.length ? [conditionChips(ch.conditions)] : []),
    el('details', { open: wasOpen }, el('summary', {}, 'Change HP or conditions'),
      el('div', { style: { marginTop: '8px' } }, hpConditionsEditor(data, patch => sendPc(patch), { showMax: false }))));
}

function sendPc(patch) {
  const ch = myChar(); if (!ch) return;
  Object.assign(ch, patch); // optimistic
  P.client.send({ t: 'pc', ...patch });
  P.map.dirty = true;
}

function myHud(x, y) {
  const ch = myChar(); if (!ch) return;
  const data = { hp: { ...ch.hp }, conditions: [...ch.conditions] };
  popover(x + 8, y + 8, el('div', {}, el('h4', {}, ch.name), hpConditionsEditor(data, patch => sendPc(patch), { showMax: false })));
}

async function renderParty() {
  const box = $('#party'); box.innerHTML = '';
  for (const p of P.view.party) {
    if (p.id === P.me?.charId) continue;
    const url = p.img ? await assets.url(p.img) : null;
    const f = p.hp.max ? clamp(p.hp.value / p.hp.max, 0, 1) : 0;
    box.append(el('div', { class: 'pm', style: { borderLeft: `3px solid ${p.color}` } }, avatar(p.name, p.color, url),
      el('div', { style: { minWidth: 0 } }, el('div', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, p.name),
        el('div', { class: 'hpline' }, el('span', { class: 'bar' }, el('i', { style: { width: f * 100 + '%', background: f > .5 ? '#4f9d69' : f > .25 ? '#d6a73c' : '#c8553d' } })), `${p.hp.value}/${p.hp.max}`))));
  }
}

async function renderHandoutView() {
  const h = P.view.handout;
  const key = h ? (h.id + ':' + (h.at || '')) : null;
  if (!h || key === P.dismissed) { P.handoutEl?.remove(); P.handoutEl = null; P.handoutKey = null; return; }
  if (P.handoutKey === key) return;
  P.handoutEl?.remove();
  if (h.img) await P.client.ensureAsset(h.img).catch(() => {});
  const url = h.img ? await assets.url(h.img) : null;
  P.handoutKey = key;
  P.handoutEl = renderHandout(h, url, () => { P.dismissed = key; P.handoutEl?.remove(); P.handoutEl = null; P.handoutKey = null; });
  document.body.append(P.handoutEl);
}

function volumePop(e) {
  const r = e.currentTarget.getBoundingClientRect();
  popover(r.right - 300, r.bottom + 6, el('div', { class: 'stack vol-pop' }, el('h4', {}, 'Volume'),
    ['master', 'music', 'ambience', 'sfx'].map(k => el('label', { class: 'row' }, el('span', {}, { master: 'Everything', music: 'Music', ambience: 'Ambience', sfx: 'Effects' }[k]), (() => {
      const s = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: P.audio.vol[k] });
      s.addEventListener('input', () => { P.audio.setVolume(k, +s.value); try { localStorage.setItem('erta-table-vol', JSON.stringify(P.audio.vol)); } catch {} });
      return s;
    })()))));
}

boot();
