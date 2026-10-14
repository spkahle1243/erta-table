// The DM view: campaigns, scenes, tokens, fog, party links, audio and handouts.
// This tab is the game server: players connect to it directly.

import { $, el, uid, debounce, throttle, toast, copyText, pickFiles, downloadBlob, fmtBytes, clone } from './util.js';
import { campaigns, assets, kv, persistStorage } from './store.js';
import { Host } from './net.js';
import { MapView } from './render.js';
import { FogMask, compact } from './fog.js';
import { AudioEngine, audioDuration } from './audio.js';
import { newCampaign, newCharacter, newScene, newToken, tokenStats, playerView, THEMES, DISPOSITION_COLORS } from './model.js';
import { ICONS, modal, confirmBox, promptBox, popover, closePopover, hpConditionsEditor, conditionChips, renderHandout, avatar } from './ui.js';
import { roll as rollDice, withAdvantage, DiceOverlay, RollLog } from './dice.js';
import { newCombat, combatant, sortCombat, current as currentCombatant, advance, combatView, renderStrip } from './combat.js';
import { loadBestiary, searchBestiary, renderStatBlock } from './statblock.js';

const DM_COLOR = '#E5916A';

const S = {
  camp: null, viewId: null, host: null, view: null, audio: null,
  selection: [], tab: 'scene', activeFog: new FogMask(), panelDirty: false,
  dice: null, log: null,
};
window.__dm = S; // handy for debugging from the console

// ======================================================================= home

async function renderHome() {
  document.title = 'Erta Table';
  const root = $('#root');
  root.innerHTML = '';
  const list = (await campaigns.list()).sort((a, b) => b.updated - a.updated);
  const home = el('div', { class: 'home' }, el('div', { class: 'home-inner' },
    el('div', { class: 'eyebrow' }, 'Erta Table · DM'),
    el('h1', {}, 'Your campaigns'),
    el('p', { class: 'sub' }, 'Open a campaign to host the table. Your friends join from their character links while this tab stays open.'),
    el('div', { class: 'camp-list' }, list.length ? list.map(c => el('div', { class: 'camp' },
      el('div', {},
        el('h2', {}, c.name),
        el('div', { class: 'meta' },
          el('span', { class: 'chip' }, THEMES[c.theme] || c.theme),
          el('span', { class: 'chip' }, `${c.characters.length} character${c.characters.length === 1 ? '' : 's'}`),
          el('span', { class: 'chip' }, `${c.scenes.length} scene${c.scenes.length === 1 ? '' : 's'}`),
          el('span', { class: 'chip' }, 'Saved ' + new Date(c.updated).toLocaleString()))),
      el('button', { class: 'btn primary', type: 'button', onclick: () => openCampaign(c.id) }, 'Open table'))) :
      el('p', { class: 'muted' }, 'No campaigns yet. Start one below.')),
    el('div', { class: 'actions' },
      list.some(c => c.theme === 'ironclad') ? null : el('button', { class: 'btn copper', type: 'button', onclick: () => createStarter('ironclad') }, 'Start Ironclad Inquiries (Boon, Orek, Vali)'),
      list.some(c => c.theme === 'erta') ? null : el('button', { class: 'btn copper', type: 'button', onclick: () => createStarter('erta') }, 'Start Erta'),
      el('button', { class: 'btn', type: 'button', onclick: createBlank }, 'New campaign'),
      el('button', { class: 'btn', type: 'button', onclick: importBackup }, 'Restore a backup')),
    el('p', { class: 'note' }, 'Everything is saved in this browser on this computer. Use “Back up” inside a campaign to keep a copy elsewhere or move to another computer; the player links keep working after a restore.'),
  ));
  root.append(home);
}

async function createStarter(theme) {
  const c = newCampaign({ name: theme === 'ironclad' ? 'Ironclad Inquiries' : 'Erta', theme });
  if (theme === 'ironclad') {
    c.characters.push(newCharacter(c, { name: 'Boon Gultor', player: 'Andy', color: '#B0421D', hp: 70, ac: 23, speed: '60 ft', init: 2 }));
    c.characters.push(newCharacter(c, { name: 'Orek Opaldigger', player: 'Colin', color: '#5A4A8C', hp: 108, ac: 17, speed: '30 ft', init: 2 }));
    c.characters.push(newCharacter(c, { name: 'Vali', player: 'Eddy', color: '#8A5F0A', hp: 132, ac: 22, speed: '35 ft', init: 2 }));
  }
  await campaigns.put(c);
  openCampaign(c.id);
}

async function createBlank() {
  const name = await promptBox('New campaign', { label: 'Name', placeholder: 'e.g. Erta: Up the Econa' });
  if (!name) return;
  const c = newCampaign({ name, theme: /ironclad/i.test(name) ? 'ironclad' : 'erta' });
  await campaigns.put(c);
  openCampaign(c.id);
}

// ======================================================================= campaign

async function openCampaign(id) {
  const c = await campaigns.get(id);
  if (!c) return toast('Campaign not found', 'bad');
  migrate(c);
  S.camp = c;
  S.viewId = c.activeSceneId || c.scenes[0]?.id || null;
  persistStorage();
  history.replaceState(null, '', location.pathname + location.search + '#c=' + c.id);
  buildApp();
  startHost();
  S.audio = new AudioEngine(id => assets.url(id));
  const vols = await kv.get('dm-volumes'); if (vols) Object.assign(S.audio.vol, vols);
  const unlock = () => { S.audio.unlock(); syncAudio(); window.removeEventListener('pointerdown', unlock, true); window.removeEventListener('keydown', unlock, true); };
  window.addEventListener('pointerdown', unlock, true); window.addEventListener('keydown', unlock, true);
  refreshAll();
}

function migrate(c) {
  c.audio ||= { library: [], music: null, ambience: null };
  c.audio.library ||= [];
  c.settings ||= { diagonals: 'equal', monsterHealth: 'bloodied' };
  c.handouts ||= [];
  c.rolls ||= [];
  c.actors ||= {};
  if (c.combat === undefined) c.combat = null;
  for (const ch of c.characters) ch.init ??= 0;
  for (const s of c.scenes) { s.templates ||= []; s.fog ||= { on: true, ops: [] }; s.kind ||= 'map'; for (const t of s.tokens) t.init ??= 0; }
}

const save = debounce(async () => {
  if (!S.camp) return;
  S.camp.updated = Date.now();
  try { await campaigns.put(S.camp); } catch (e) { console.error(e); toast('Could not save: ' + e.message, 'bad'); }
}, 400);
window.addEventListener('beforeunload', () => { if (S.camp) save.flush(); S.host?.destroy(); });

const scene = id => S.camp.scenes.find(s => s.id === (id ?? S.viewId)) || null;
const activeScene = () => S.camp.scenes.find(s => s.id === S.camp.activeSceneId) || null;
const viewingActive = () => S.viewId && S.viewId === S.camp.activeSceneId;

// Apply a change, save, push to players, redraw.
function change(fn, { panel = true, rail = false } = {}) {
  fn(S.camp);
  save();
  pushState();
  refreshMap();
  if (rail) renderRail(); else railSoon();
  if (panel) renderPanel();
}
const railSoon = debounce(() => renderRail(), 300);

// ======================================================================= networking

function startHost() {
  S.host?.destroy();
  const host = new Host(S.camp.hostId, async hello => {
    const ch = S.camp.characters.find(x => x.key === hello.key);
    if (!ch) return { ok: false, reason: 'This link is no longer valid. Ask your DM for a new one.' };
    return { ok: true, info: { charId: ch.id, name: ch.name, color: ch.color } };
  });
  S.host = host;
  host.on('status', s => renderStatus());
  host.on('clients', () => { renderStatus(); if (S.tab === 'party') renderPanel(); });
  host.on('join', (pid, info) => {
    toast(`${info.name} joined`, 'ok');
    host.send(pid, { t: 'welcome', view: viewFor(info.charId) });
    host.send(pid, { t: 'rolls', list: S.camp.rolls.filter(r => !r.hidden).slice(-40) });
  });
  host.on('leave', (pid, info) => toast(`${info.name} left`));
  host.on('message', onPlayerMessage);
  host.start();
}

function viewFor(charId) {
  const sc = activeScene();
  if (sc && sc.fog.on) S.activeFog.update(sc, 1024);
  return playerView(S.camp, charId, sc, (x, y) => S.activeFog.fogged(x, y));
}

const pushState = throttle(() => {
  if (!S.host || !S.camp) return;
  const sc = activeScene();
  if (sc && sc.fog.on) S.activeFog.update(sc, 1024);
  S.host.broadcast(info => ({ t: 'state', view: playerView(S.camp, info.charId, sc, (x, y) => S.activeFog.fogged(x, y)) }));
  syncAudio();
}, 70);

function onPlayerMessage(pid, m, info) {
  const c = S.camp, sc = activeScene();
  const ownsToken = id => sc?.tokens.find(t => t.id === id && t.charId && t.charId === info.charId);
  switch (m.t) {
    case 'drag': {
      if (c.paused || !ownsToken(m.id)) return;
      S.host.broadcast({ t: 'drag', id: m.id, x: m.x, y: m.y }, pid);
      if (viewingActive()) S.view.setRemoteDrag(m.id, m.x, m.y);
      return;
    }
    case 'move': {
      const t = !c.paused && ownsToken(m.id);
      if (!t) { S.host.send(pid, { t: 'state', view: viewFor(info.charId) }); return; }
      t.x = Math.round(m.x); t.y = Math.round(m.y);
      S.view.setRemoteDrag(m.id, null);
      change(() => {}, { panel: S.tab === 'tokens' });
      return;
    }
    case 'ruler': {
      const ch = c.characters.find(x => x.id === info.charId);
      const msg = { t: 'ruler', key: info.charId, pts: m.pts, color: ch?.color, name: ch?.name };
      S.host.broadcast(msg, pid);
      if (viewingActive()) S.view.setRemoteRuler(info.charId, m.pts ? { pts: m.pts, color: ch?.color, name: ch?.name } : null);
      return;
    }
    case 'ping': {
      const ch = c.characters.find(x => x.id === info.charId);
      S.host.broadcast({ t: 'ping', x: m.x, y: m.y, color: ch?.color }, pid);
      if (viewingActive()) S.view.addPing(m.x, m.y, ch?.color);
      return;
    }
    case 'tpl-add': {
      if (!sc) return;
      const ch = c.characters.find(x => x.id === info.charId);
      change(() => sc.templates.push({ ...sanitizeTpl(m.tpl), id: uid(8), owner: info.charId, color: ch?.color || '#E5916A' }), { panel: false });
      return;
    }
    case 'tpl-del': {
      if (!sc) return;
      const i = sc.templates.findIndex(t => t.id === m.id && t.owner === info.charId);
      if (i >= 0) change(() => sc.templates.splice(i, 1), { panel: false });
      return;
    }
    case 'roll': {
      const ch = c.characters.find(x => x.id === info.charId);
      const r = sanitizeRoll(m.roll);
      if (!r || !ch) return;
      r.by = { name: ch.name, color: ch.color, charId: ch.id };
      r.hidden = false;
      recordRoll(r);
      S.host.broadcast({ t: 'roll', roll: r }, pid);
      showRoll(r);
      if (m.purpose === 'init' && c.combat) {
        const e = c.combat.list.find(x => x.charId === ch.id);
        if (e) change(() => { e.init = r.total; sortCombat(c.combat); if (c.combat.list.every(x => x.init != null)) c.combat.askInit = false; }, { panel: S.tab === 'combat' });
      }
      return;
    }
    case 'pc': {
      const ch = c.characters.find(x => x.id === info.charId);
      if (!ch) return;
      change(() => {
        if (m.hp) ch.hp = { value: clampInt(m.hp.value, 0, 9999), max: ch.hp.max, temp: clampInt(m.hp.temp, 0, 999) };
        if (Array.isArray(m.conditions)) ch.conditions = m.conditions.map(String).slice(0, 30);
      }, { panel: S.tab === 'party' || S.tab === 'tokens' });
      return;
    }
  }
}

function sanitizeRoll(r) {
  if (!r || !Array.isArray(r.terms) || r.terms.length > 40) return null;
  let total = 0;
  for (const t of r.terms) {
    if (t.kind === 'num') total += (t.sign < 0 ? -1 : 1) * (Number(t.v) || 0);
    else if (t.kind === 'dice') {
      if (!Array.isArray(t.results) || t.results.length > 100) return null;
      if (t.results.some(x => !(x.v >= 1 && x.v <= t.sides))) return null;
      total += (t.sign < 0 ? -1 : 1) * t.results.filter(x => !x.dropped).reduce((a, x) => a + x.v, 0);
    } else return null;
  }
  if (total !== r.total) return null;
  return { id: String(r.id).slice(0, 20), formula: String(r.formula).slice(0, 80), label: String(r.label || '').slice(0, 120), terms: r.terms, total, nat: r.nat, ts: Date.now() };
}

function recordRoll(r) {
  S.camp.rolls.push(r);
  if (S.camp.rolls.length > 200) S.camp.rolls.splice(0, S.camp.rolls.length - 200);
  save();
}

async function showRoll(r) {
  await S.dice?.show(r, r.by?.color || DM_COLOR);
  S.log?.add(r, { mine: r.by?.name === 'DM' });
}

// The DM rolls: formula + options. Returns the roll.
function dmRoll(formula, { mode = null, hidden = null, label = '' } = {}) {
  if (hidden == null) hidden = !!document.getElementById('roll-hidden')?.checked;
  let r;
  try { r = rollDice(withAdvantage(formula, mode || S.log?.mode), { label, hidden, by: { name: 'DM', color: DM_COLOR } }); }
  catch (e) { toast(e.message, 'bad'); return null; }
  if (/d20/.test(formula)) S.log?.clearMode();
  recordRoll(r);
  if (!hidden) S.host?.broadcast({ t: 'roll', roll: r });
  showRoll(r);
  return r;
}

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
function sanitizeTpl(t) {
  return { shape: ['circle', 'cone', 'line', 'cube'].includes(t?.shape) ? t.shape : 'circle', x: +t.x || 0, y: +t.y || 0, dir: +t.dir || 0, len: clampInt(t.len, 5, 1000) };
}

// ======================================================================= audio

function syncAudio() {
  if (!S.audio) return;
  S.audio.set('music', S.camp.audio.music);
  S.audio.set('ambience', S.camp.audio.ambience);
}

function playTrack(track) {
  if (track.kind === 'sfx') {
    S.host.broadcast({ t: 'sfx', asset: track.asset, vol: track.vol ?? 1 });
    S.audio.sfx(track.asset, track.vol ?? 1);
    return;
  }
  change(c => { c.audio[track.kind] = { trackId: track.id, asset: track.asset, name: track.name, startedAt: Date.now(), loop: true, vol: track.vol ?? 1 }; });
}
function stopLayer(kind) { change(c => { c.audio[kind] = null; }); }
function togglePause(kind) {
  change(c => {
    const a = c.audio[kind]; if (!a) return;
    if (a.paused) c.audio[kind] = { ...a, paused: false, startedAt: Date.now() - (a.pausedAt || 0) * 1000, pausedAt: null };
    else {
      const el = S.audio.layers[kind]?.el;
      c.audio[kind] = { ...a, paused: true, pausedAt: el ? el.currentTime : (Date.now() - a.startedAt) / 1000 };
    }
  });
}

// ======================================================================= app shell

function buildApp() {
  const root = $('#root');
  root.innerHTML = '';
  const canvas = el('canvas', { id: 'map', 'aria-label': 'Map' });
  const app = el('div', { class: 'app', id: 'app' },
    el('header', { class: 'topbar' },
      el('button', { class: 'btn ghost small', type: 'button', onclick: goHome, title: 'All campaigns' }, '← Campaigns'),
      el('div', { class: 'title', id: 'camp-title' }),
      el('div', { class: 'spacer' }),
      el('div', { class: 'who', id: 'who' }),
      el('span', { class: 'status', id: 'net-status' }),
      el('button', { class: 'btn small', id: 'pause-btn', type: 'button', onclick: () => change(c => { c.paused = !c.paused; }) }, 'Pause'),
      el('button', { class: 'btn small', type: 'button', onclick: exportBackup }, 'Back up'),
      el('button', { class: 'btn icon ghost', type: 'button', title: 'Panel', html: ICONS.menu, onclick: () => $('#app').classList.toggle('show-panel') })),
    el('nav', { class: 'rail', id: 'rail', 'aria-label': 'Scenes' }),
    el('main', { class: 'stage', id: 'stage' },
      canvas,
      el('div', { class: 'toolbar', id: 'toolbar' }),
      el('div', { class: 'subbar', id: 'subbar', hidden: true }),
      el('div', { class: 'players-see', id: 'players-see' }),
      el('div', { class: 'banner', id: 'banner', hidden: true }),
      el('div', { class: 'combat-strip', id: 'combat-strip', hidden: true }),
      el('div', { class: 'dock', id: 'dock' }),
      el('div', { class: 'empty-stage', id: 'empty-stage', hidden: true })),
    el('aside', { class: 'panel', id: 'panel' },
      el('div', { class: 'tabs', role: 'tablist', id: 'tabs' }),
      el('div', { class: 'pane', id: 'pane' })));
  root.append(app);
  $('#pane').addEventListener('focusout', () => setTimeout(() => { if (S.panelDirty && !$('#pane').contains(document.activeElement)) renderPanel(true); }, 0));

  S.view = new MapView(canvas, {
    role: 'dm', color: '#E5916A',
    getUrl: id => assets.url(id),
    getDiagonals: () => S.camp.settings.diagonals,
    canMoveToken: () => true,
    onTokenDrag: (id, x, y, final) => {
      const sc = scene(); const t = sc?.tokens.find(t => t.id === id); if (!t) return;
      if (final) { change(() => { t.x = x; t.y = y; }, { panel: S.tab === 'tokens' }); }
      else if (viewingActive()) dragOut(id, x, y);
    },
    onRuler: pts => { if (viewingActive()) S.host.broadcast({ t: 'ruler', key: 'dm', pts, color: '#E5916A', name: 'DM' }); },
    onPing: (x, y, pull) => { if (viewingActive()) S.host.broadcast({ t: 'ping', x, y, color: '#E5916A', pull }); if (pull) toast(viewingActive() ? 'Pulled everyone’s view here' : 'Players aren’t on this scene'); },
    onTemplateAdd: tpl => change(() => scene().templates.push({ ...tpl, id: uid(8), owner: 'dm', color: '#E5916A' }), { panel: false }),
    onTemplateRemove: id => change(() => { const sc = scene(); sc.templates = sc.templates.filter(t => t.id !== id); }, { panel: false }),
    onFog: op => change(() => { const sc = scene(); sc.fog.ops.push(op); sc.fog.ops = compact(sc.fog.ops); }, { panel: false }),
    onSelect: ids => { S.selection = ids; if (ids.length && S.tab === 'scene') { S.tab = 'tokens'; renderTabs(); } if (S.tab === 'tokens') renderPanel(true); },
    onTokenContext: (id, x, y) => tokenHud(id, x, y),
    onTokenDblClick: id => { S.selection = [id]; S.tab = 'tokens'; renderTabs(); renderPanel(); },
    onTokenDelete: ids => change(() => { const sc = scene(); sc.tokens = sc.tokens.filter(t => !ids.includes(t.id)); S.selection = []; }),
    onDropFiles: dropFiles,
    onDropData: (charId, wx, wy) => placePc(charId, wx, wy),
  });
  buildToolbar();
  S.dice = new DiceOverlay();
  const dock = $('#dock');
  const head = el('button', { class: 'dock-h', type: 'button', onclick: () => { dock.classList.toggle('closed'); localStorage.setItem('erta-dock', dock.classList.contains('closed') ? 'closed' : 'open'); } }, el('span', {}, 'Dice & rolls'), el('span', { class: 'chev' }, '▾'));
  dock.append(head);
  if (localStorage.getItem('erta-dock') === 'closed') dock.classList.add('closed');
  S.log = new RollLog(dock, { canHide: true, onRoll: (f, o) => dmRoll(f, o) });
  S.log.setAll(S.camp.rolls.slice(-60));
}

const dragOut = throttle((id, x, y) => S.host.broadcast({ t: 'drag', id, x, y }), 50);

async function goHome() {
  save.flush();
  S.host?.destroy(); S.host = null;
  if (S.audio) { S.audio.set('music', null); S.audio.set('ambience', null); }
  S.camp = null;
  history.replaceState(null, '', location.pathname + location.search);
  renderHome();
}

function refreshAll() { renderTitle(); renderStatus(); renderRail(); refreshMap(); renderTabs(); renderPanel(true); }
function renderTitle() { $('#camp-title').textContent = S.camp.name; document.title = S.camp.name + ' · Erta Table'; }

function renderStatus() {
  const h = S.host; if (!h || !$('#net-status')) return;
  const map = { online: ['on', 'Table open'], starting: ['warn', 'Opening…'], reconnecting: ['warn', 'Reconnecting…'], taken: ['bad', 'Open in another tab'] };
  const [cls, txt] = map[h.status] || ['warn', h.status];
  const st = $('#net-status'); st.innerHTML = ''; st.append(el('span', { class: 'dot ' + cls }), txt);
  st.title = h.status === 'taken' ? 'This campaign is already hosting in another tab or window. Close that one; this tab will take over automatically.' : '';
  const online = new Set([...h.clients.values()].map(c => c.info.charId));
  const who = $('#who'); who.innerHTML = '';
  for (const ch of S.camp.characters) who.append(el('span', { class: 'p' + (online.has(ch.id) ? ' on' : ''), style: { background: ch.color }, title: `${ch.name} (${ch.player || 'player'}): ${online.has(ch.id) ? 'connected' : 'not connected'}` }, initials(ch.name)));
  $('#pause-btn').setAttribute('aria-pressed', S.camp.paused ? 'true' : 'false');
  $('#pause-btn').textContent = S.camp.paused ? 'Paused' : 'Pause';
}
const initials = n => String(n || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();

// ======================================================================= toolbar

const TOOLS = [
  [['select', 'Select & move (drag empty space to pan, hold to ping)'], ['ruler', 'Measure'], ['ping', 'Ping (Shift: pull everyone’s view)']],
  [['tpl:circle', 'Sphere / radius'], ['tpl:cone', 'Cone'], ['tpl:line', 'Line'], ['tpl:cube', 'Cube']],
  [['fog:reveal-rect', 'Reveal area'], ['fog:hide-rect', 'Hide area'], ['fog:reveal-brush', 'Reveal brush'], ['fog:hide-brush', 'Hide brush']],
];
const TOOL_ICON = { select: 'select', ruler: 'ruler', ping: 'ping', 'tpl:circle': 'circle', 'tpl:cone': 'cone', 'tpl:line': 'line', 'tpl:cube': 'cube', 'fog:reveal-rect': 'reveal', 'fog:hide-rect': 'hide', 'fog:reveal-brush': 'brush', 'fog:hide-brush': 'brush' };
const KEYS = { v: 'select', r: 'ruler', p: 'ping', c: 'tpl:circle', o: 'tpl:cone', l: 'tpl:line', b: 'tpl:cube', f: 'fog:reveal-rect', h: 'fog:hide-rect' };

function buildToolbar() {
  const tb = $('#toolbar'); tb.innerHTML = '';
  for (const grp of TOOLS) {
    const g = el('div', { class: 'grp' });
    for (const [id, tip] of grp) {
      const b = el('button', { class: 'tool', type: 'button', 'data-tool': id, 'aria-label': tip, 'aria-pressed': S.view.tool === id ? 'true' : 'false', html: ICONS[TOOL_ICON[id]] + `<span class="tip">${tip}</span>`, onclick: () => setTool(id) });
      if (id === 'fog:hide-brush') b.style.color = 'var(--copper)';
      g.append(b);
    }
    tb.append(g);
  }
  tb.append(el('div', { class: 'grp' }, el('button', { class: 'tool', type: 'button', 'aria-label': 'Fit map', html: ICONS.fit + '<span class="tip">Fit map to screen</span>', onclick: () => S.view.fit() })));
  window.addEventListener('keydown', e => {
    if (!S.camp || e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea, select')) return;
    if (e.key.toLowerCase() === 'n' && S.camp.combat) { nextTurn(); return; }
    const t = KEYS[e.key.toLowerCase()]; if (t) setTool(t);
  });
}

function setTool(id) {
  S.view.setTool(id);
  for (const b of document.querySelectorAll('.tool[data-tool]')) b.setAttribute('aria-pressed', b.dataset.tool === id ? 'true' : 'false');
  const sb = $('#subbar');
  if (id.startsWith('fog:')) {
    const sc = scene();
    sb.hidden = false; sb.innerHTML = '';
    const size = el('input', { type: 'range', min: 20, max: 400, value: S.view.fogBrush, style: { width: '110px' }, oninput: e => { S.view.fogBrush = +e.target.value; } });
    sb.append(
      el('span', { class: 'lbl' }, 'Fog'),
      id.endsWith('brush') ? el('label', { class: 'row', style: { gap: '6px' } }, el('span', { class: 'small muted' }, 'Brush'), size) : null,
      el('button', { class: 'btn small', type: 'button', onclick: () => change(() => { const s = scene(); s.fog.ops = [{ m: 'reveal', s: 'all' }]; }) }, 'Reveal all'),
      el('button', { class: 'btn small', type: 'button', onclick: () => change(() => { const s = scene(); s.fog.ops = []; }) }, 'Hide all'),
      el('button', { class: 'btn small', type: 'button', html: ICONS.undo + ' Undo', onclick: () => change(() => { scene().fog.ops.pop(); }) }),
      sc && !sc.fog.on ? el('span', { class: 'small', style: { color: 'var(--copper)' } }, 'Fog is off for this scene (Scene tab).') : null);
  } else sb.hidden = true;
}

// ======================================================================= rail

async function renderRail() {
  const rail = $('#rail'); if (!rail) return;
  rail.innerHTML = '';
  rail.append(el('div', { class: 'rail-h' }, el('h3', {}, 'Scenes'), el('button', { class: 'btn small', type: 'button', onclick: newSceneDialog }, '+ New')));
  const ul = el('ul', { class: 'scene-list' });
  for (const s of S.camp.scenes) {
    const thumb = el('span', { class: 'thumb' });
    if (s.bg) assets.url(s.bg).then(u => { if (u) thumb.style.backgroundImage = `url("${u}")`; });
    const li = el('li', { class: 'scene-item' + (s.id === S.viewId ? ' viewing' : ''), title: 'Click to view. Players only see the scene marked LIVE.', onclick: () => viewScene(s.id) },
      thumb, el('div', {}, el('div', { class: 'nm' }, s.name), el('div', { class: 'kind' }, s.kind === 'art' ? 'scene art' : `map · ${s.tokens.length} token${s.tokens.length === 1 ? '' : 's'}`)),
      s.id === S.camp.activeSceneId ? el('span', { class: 'live' }, 'LIVE') : null);
    li.addEventListener('dragover', e => e.preventDefault());
    li.addEventListener('drop', async e => { e.preventDefault(); const f = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('image/')); if (f) { await setBackground(s, f); } });
    ul.append(li);
  }
  rail.append(ul);
  if (!S.camp.scenes.length) rail.append(el('p', { class: 'empty' }, 'No scenes yet. Make one with “+ New”, or load a session pack (coming in step 2).'));
}

function viewScene(id) {
  S.viewId = id; S.selection = [];
  S.view.selected.clear();
  renderRail(); refreshMap(); if (S.tab === 'scene' || S.tab === 'tokens') renderPanel(true);
}

function refreshMap() {
  if (!S.view) return;
  const sc = scene();
  const empty = $('#empty-stage');
  if (!sc) {
    S.view.setScene(null);
    empty.hidden = false; empty.innerHTML = '';
    empty.append(el('div', {}, el('h2', {}, 'No scene yet'), el('p', {}, 'Create a scene, then drop a battle map or scene art onto it.'), el('button', { class: 'btn primary', type: 'button', style: { marginTop: '14px' }, onclick: newSceneDialog }, 'New scene')));
  } else {
    empty.hidden = !!sc.bg; empty.innerHTML = '';
    if (!sc.bg) empty.append(el('div', {}, el('h2', {}, sc.name), el('p', {}, 'Drop an image here to set the background, or use the Scene tab.')));
    S.view.setScene(dmSceneView(sc));
  }
  const ps = $('#players-see'); ps.innerHTML = '';
  const act = activeScene();
  if (sc && sc.id !== S.camp.activeSceneId) {
    ps.append(el('div', { class: 'row' },
      el('span', { class: 'chip', title: 'What the players are looking at' }, 'Players see: ' + (act ? act.name : 'nothing yet')),
      el('button', { class: 'btn small primary', type: 'button', onclick: () => activate(sc.id) }, 'Show this to players')));
  } else if (sc) ps.append(el('span', { class: 'chip', style: { color: 'var(--jade)', borderColor: 'var(--jade-line)' } }, '● Live for players'));
  renderCombatStrip();
  const banner = $('#banner');
  banner.hidden = !S.camp.paused; banner.textContent = 'Game paused: players can’t move tokens';
  renderStatus();
}

function renderCombatStrip() {
  const c = S.camp.combat;
  const v = c ? { ...combatView(c, null), list: c.list.map(x => ({ ...x })), current: currentCombatant(c)?.id } : null;
  renderStrip($('#combat-strip'), v, { resolveImg: id => assets.url(id), onClick: x => focusToken(x.tokenId) });
  S.view.activeToken = currentCombatant(c)?.tokenId || null;
  S.view.dirty = true;
}

function focusToken(tokenId) {
  const sc = scene(); const t = sc?.tokens.find(t => t.id === tokenId);
  if (!t) return;
  S.view.selected = new Set([t.id]); S.selection = [t.id];
  const c = S.view.tokenCenter(t); S.view.centerOn(c.x, c.y);
  if (S.tab === 'tokens') renderPanel(true);
}

function dmSceneView(sc) {
  return {
    ...sc,
    tokens: sc.tokens.map(t => { const st = tokenStats(S.camp, t); return { ...t, name: st.name, hp: st.hp, ac: st.ac, conditions: st.conditions, color: st.color, img: st.img, size: st.size || t.size }; }),
  };
}

function activate(id) {
  const sc = scene(id);
  change(c => {
    c.activeSceneId = id;
    const lib = c.audio.library;
    for (const k of ['music', 'ambience']) {
      const tid = sc?.[k]; const tr = tid && lib.find(t => t.id === tid);
      if (tr && c.audio[k]?.trackId !== tr.id) c.audio[k] = { trackId: tr.id, asset: tr.asset, name: tr.name, startedAt: Date.now(), loop: true, vol: tr.vol ?? 1 };
    }
  }, { rail: true });
  toast(`Players now see “${sc.name}”`, 'ok');
}

// ======================================================================= scenes

function newSceneDialog() {
  const name = el('input', { type: 'text', placeholder: 'e.g. The Ninth Gallery' });
  const kind = el('select', {}, el('option', { value: 'map' }, 'Battle map (grid, tokens, fog)'), el('option', { value: 'art' }, 'Scene art (a picture to set the scene)'));
  const squares = el('input', { type: 'number', min: 1, placeholder: 'e.g. 40' });
  let file = null;
  const fileBtn = el('button', { class: 'btn', type: 'button', onclick: async () => { [file] = await pickFiles({ accept: 'image/*' }); fileLbl.textContent = file ? `${file.name} (${fmtBytes(file.size)})` : 'No image'; if (file && !name.value) name.value = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '); } }, 'Choose image…');
  const fileLbl = el('span', { class: 'small muted' }, 'No image');
  const body = el('div', { class: 'stack' },
    el('label', { class: 'field' }, el('span', {}, 'Name'), name),
    el('label', { class: 'field' }, el('span', {}, 'Kind'), kind),
    el('div', { class: 'field' }, el('span', {}, 'Image'), el('div', { class: 'row' }, fileBtn, fileLbl)),
    el('label', { class: 'field' }, el('span', {}, 'Squares across (battle maps)'), squares),
    el('p', { class: 'muted small' }, 'Your battle-map prompts name a grid, like “40 × 16 squares”. Put the first number here and the grid lines up with the image. You can fine-tune it in the Scene tab.'));
  modal({ title: 'New scene', body, actions: [
    { label: 'Cancel', value: null },
    { label: 'Create scene', kind: 'primary', run: async () => {
      const sc = newScene({ name: name.value.trim() || 'New scene', kind: kind.value });
      S.camp.scenes.push(sc);
      if (file) await setBackground(sc, file, Number(squares.value) || 0, true);
      save(); S.viewId = sc.id; renderRail(); refreshMap(); S.tab = 'scene'; renderTabs(); renderPanel(true);
      return true;
    } },
  ] });
}

async function setBackground(sc, file, squaresAcross = 0, quiet = false) {
  const id = await assets.put(file, file.name);
  const url = await assets.url(id);
  const dims = await new Promise(res => { const i = new Image(); i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => res(null); i.src = url; });
  if (!dims) { toast('That image could not be read', 'bad'); return; }
  change(() => {
    sc.bg = id; sc.width = dims.w; sc.height = dims.h;
    if (squaresAcross) { sc.grid.size = dims.w / squaresAcross; sc.grid.ox = 0; sc.grid.oy = 0; }
    else if (!sc._gridSet) sc.grid.size = Math.max(40, Math.round(dims.w / 30));
  }, { rail: true });
  if (!quiet) toast('Background set', 'ok');
}

async function dropFiles(files, wx, wy) {
  const sc = scene();
  for (const f of files) {
    if (f.type.startsWith('audio/')) { await addTracks([f]); continue; }
    if (!f.type.startsWith('image/')) continue;
    if (!sc) { toast('Make a scene first', 'bad'); return; }
    if (!sc.bg) { await setBackground(sc, f); continue; }
    const id = await assets.put(f, f.name);
    const g = sc.grid;
    const t = newToken({ name: f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '), img: id, x: Math.floor((wx - g.ox) / g.size), y: Math.floor((wy - g.oy) / g.size), hidden: true });
    change(() => sc.tokens.push(t));
    toast(`Added ${t.name} (hidden until you reveal it)`);
  }
}

function placePc(charId, wx, wy) {
  const sc = scene(); if (!sc) return;
  const ch = S.camp.characters.find(c => c.id === charId); if (!ch) return;
  if (sc.tokens.some(t => t.charId === charId)) { toast(`${ch.name} is already on this scene`); return; }
  const g = sc.grid;
  change(() => sc.tokens.push(newToken({ name: ch.name, charId, size: ch.size || 1, x: Math.floor((wx - g.ox) / g.size), y: Math.floor((wy - g.oy) / g.size) })));
}

function placeParty() {
  const sc = scene(); if (!sc) return;
  const g = sc.grid;
  const cx = Math.floor((S.view.cam.x - g.ox) / g.size), cy = Math.floor((S.view.cam.y - g.oy) / g.size);
  let i = 0;
  change(() => {
    for (const ch of S.camp.characters) {
      if (sc.tokens.some(t => t.charId === ch.id)) continue;
      sc.tokens.push(newToken({ name: ch.name, charId: ch.id, size: ch.size || 1, x: cx + (i % 3) - 1, y: cy + Math.floor(i / 3) }));
      i++;
    }
  });
  if (!i) toast('The whole party is already on this scene');
}

// ======================================================================= token HUD (right-click)

function tokenHud(id, x, y) {
  const sc = scene(); const t = sc?.tokens.find(t => t.id === id); if (!t) return;
  const st = tokenStats(S.camp, t);
  const data = { hp: { ...st.hp }, conditions: [...(st.conditions || [])] };
  const ch = t.charId && S.camp.characters.find(c => c.id === t.charId);
  const content = el('div', {},
    el('h4', {}, st.name),
    hpConditionsEditor(data, patch => change(() => { const target = ch || t; Object.assign(target, patch); }, { panel: S.tab === 'tokens' || S.tab === 'party' }), { showMax: false }),
    el('div', { class: 'row', style: { marginTop: '10px' } },
      ch ? null : el('button', { class: 'btn small', type: 'button', html: (t.hidden ? ICONS.eye + ' Reveal' : ICONS.eyeoff + ' Hide'), onclick: () => { change(() => { t.hidden = !t.hidden; }); closePopover(); } }),
      el('button', { class: 'btn small', type: 'button', onclick: () => { closePopover(); S.selection = [id]; S.tab = 'tokens'; renderTabs(); renderPanel(true); } }, 'Edit…'),
      el('button', { class: 'btn small danger', type: 'button', onclick: () => { change(() => { sc.tokens = sc.tokens.filter(x => x.id !== id); }); closePopover(); } }, 'Remove')));
  popover(x + 8, y + 8, content);
}

// ======================================================================= side panel

const TABS = [['scene', 'Scene'], ['tokens', 'Tokens'], ['combat', 'Combat'], ['party', 'Party'], ['audio', 'Audio'], ['handouts', 'Handouts'], ['settings', 'Settings']];

function renderTabs() {
  const tabs = $('#tabs'); tabs.innerHTML = '';
  for (const [id, label] of TABS) tabs.append(el('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': S.tab === id ? 'true' : 'false', onclick: () => { S.tab = id; renderTabs(); renderPanel(true); } }, label));
}

function renderPanel(force = false) {
  const pane = $('#pane'); if (!pane || !S.camp) return;
  if (!force && pane.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) { S.panelDirty = true; return; }
  S.panelDirty = false;
  const top = pane.scrollTop;
  pane.innerHTML = '';
  const fn = { scene: paneScene, tokens: paneTokens, combat: paneCombat, party: paneParty, audio: paneAudio, handouts: paneHandouts, settings: paneSettings }[S.tab];
  pane.append(fn());
  pane.scrollTop = top;
}

function num(v, onCommit, attrs = {}) {
  const i = el('input', { type: 'number', value: v, ...attrs });
  i.addEventListener('change', () => onCommit(Number(i.value)));
  return i;
}
function txt(v, onCommit, attrs = {}) {
  const i = el('input', { type: 'text', value: v ?? '', ...attrs });
  i.addEventListener('change', () => onCommit(i.value));
  return i;
}

// ---------------------------------------------------------------- Scene tab
function paneScene() {
  const sc = scene();
  if (!sc) return el('div', { class: 'stack' }, el('h3', {}, 'No scene'), el('button', { class: 'btn primary', type: 'button', onclick: newSceneDialog }, 'New scene'));
  const g = sc.grid;
  const lib = S.camp.audio.library;
  const trackSel = (kind) => {
    const s = el('select', {}, el('option', { value: '' }, '— none —'), lib.filter(t => t.kind === kind).map(t => el('option', { value: t.id, selected: sc[kind] === t.id }, t.name)));
    s.addEventListener('change', () => change(() => { sc[kind] = s.value || null; }));
    return s;
  };
  const squares = el('input', { type: 'number', min: 1, step: 'any', value: +(sc.width / g.size).toFixed(2) });
  squares.addEventListener('change', () => { const n = Number(squares.value); if (n > 0) change(() => { sc.grid.size = sc.width / n; sc._gridSet = true; }); });
  return el('div', { class: 'stack' },
    el('h3', {}, sc.name),
    sc.id === S.camp.activeSceneId
      ? el('span', { class: 'chip', style: { color: 'var(--jade)', borderColor: 'var(--jade-line)', justifySelf: 'start' } }, '● Live for players')
      : el('button', { class: 'btn primary', type: 'button', onclick: () => activate(sc.id) }, 'Show this scene to players'),
    el('label', { class: 'field' }, el('span', {}, 'Name'), txt(sc.name, v => change(() => { sc.name = v || 'Scene'; }, { rail: true }))),
    el('label', { class: 'field' }, el('span', {}, 'Kind'), (() => {
      const s = el('select', {}, el('option', { value: 'map', selected: sc.kind === 'map' }, 'Battle map'), el('option', { value: 'art', selected: sc.kind === 'art' }, 'Scene art'));
      s.addEventListener('change', () => change(() => { sc.kind = s.value; if (s.value === 'art') sc.fog.on = false; }, { rail: true })); return s;
    })()),
    el('div', { class: 'row' },
      el('button', { class: 'btn', type: 'button', onclick: async () => { const [f] = await pickFiles({ accept: 'image/*' }); if (f) setBackground(sc, f); } }, sc.bg ? 'Replace image…' : 'Choose image…'),
      sc.bg ? el('span', { class: 'small muted' }, `${sc.width} × ${sc.height} px`) : null),
    sc.kind === 'map' ? el('div', { class: 'stack' },
      el('h4', {}, 'Grid'),
      el('div', { class: 'grid2' },
        el('label', { class: 'field' }, el('span', {}, 'Squares across'), squares),
        el('label', { class: 'field' }, el('span', {}, 'Square size (px)'), num(+g.size.toFixed(2), v => v > 4 && change(() => { g.size = v; sc._gridSet = true; }), { step: 'any', min: 5 }))),
      el('div', { class: 'grid2' },
        el('label', { class: 'field' }, el('span', {}, 'Nudge X (px)'), num(+g.ox.toFixed(1), v => change(() => { g.ox = v || 0; }), { step: 'any' })),
        el('label', { class: 'field' }, el('span', {}, 'Nudge Y (px)'), num(+g.oy.toFixed(1), v => change(() => { g.oy = v || 0; }), { step: 'any' }))),
      el('div', { class: 'row' },
        el('label', { class: 'check' }, (() => { const c = el('input', { type: 'checkbox', checked: g.show }); c.addEventListener('change', () => change(() => { g.show = c.checked; })); return c; })(), 'Show grid'),
        (() => { const c = el('input', { type: 'color', value: g.color }); c.addEventListener('change', () => change(() => { g.color = c.value; })); return c; })(),
        el('label', { class: 'row grow', style: { gap: '6px' } }, el('span', { class: 'small muted' }, 'Opacity'), (() => { const r = el('input', { type: 'range', min: 0, max: 1, step: 0.02, value: g.opacity }); r.addEventListener('change', () => change(() => { g.opacity = +r.value; })); r.addEventListener('input', () => { g.opacity = +r.value; refreshMap(); }); return r; })())),
      el('h4', {}, 'Fog of war'),
      el('label', { class: 'check' }, (() => { const c = el('input', { type: 'checkbox', checked: sc.fog.on }); c.addEventListener('change', () => change(() => { sc.fog.on = c.checked; })); return c; })(), 'Fog on (players see only what you reveal)'),
      el('div', { class: 'row' },
        el('button', { class: 'btn small', type: 'button', onclick: () => setTool('fog:reveal-rect') }, 'Reveal tool'),
        el('button', { class: 'btn small', type: 'button', onclick: () => change(() => { sc.fog.ops = [{ m: 'reveal', s: 'all' }]; }) }, 'Reveal all'),
        el('button', { class: 'btn small', type: 'button', onclick: () => change(() => { sc.fog.ops = []; }) }, 'Hide all')),
      el('p', { class: 'small muted' }, 'Monsters standing in fog are hidden from players automatically. Party tokens always show.'),
    ) : null,
    el('h4', {}, 'Scene audio'),
    el('p', { class: 'small muted' }, 'Starts automatically when you show this scene to players.'),
    el('div', { class: 'grid2' },
      el('label', { class: 'field' }, el('span', {}, 'Music'), trackSel('music')),
      el('label', { class: 'field' }, el('span', {}, 'Ambience'), trackSel('ambience'))),
    el('h4', {}, 'DM notes'),
    (() => { const t = el('textarea', { rows: 5, placeholder: 'Private to you.' }); t.value = sc.notes || ''; t.addEventListener('change', () => change(() => { sc.notes = t.value; }, { panel: false })); return t; })(),
    el('div', { class: 'sep' }),
    el('div', { class: 'row' },
      el('button', { class: 'btn small', type: 'button', onclick: () => { const copy = clone(sc); copy.id = uid(10); copy.name = sc.name + ' (copy)'; change(c => c.scenes.splice(c.scenes.indexOf(sc) + 1, 0, copy), { rail: true }); } }, 'Duplicate'),
      el('button', { class: 'btn small', type: 'button', onclick: () => moveScene(sc, -1) }, 'Move up'),
      el('button', { class: 'btn small', type: 'button', onclick: () => moveScene(sc, 1) }, 'Move down'),
      el('button', { class: 'btn small danger', type: 'button', onclick: async () => {
        if (!(await confirmBox('Delete scene?', `“${sc.name}” and its tokens will be deleted.`, { ok: 'Delete', danger: true }))) return;
        change(c => { c.scenes = c.scenes.filter(s => s.id !== sc.id); if (c.activeSceneId === sc.id) c.activeSceneId = null; }, { rail: true });
        S.viewId = S.camp.scenes[0]?.id || null; refreshMap(); renderRail(); renderPanel(true);
      } }, 'Delete')),
  );
}

function moveScene(sc, d) {
  change(c => { const i = c.scenes.indexOf(sc), j = i + d; if (j < 0 || j >= c.scenes.length) return; c.scenes.splice(i, 1); c.scenes.splice(j, 0, sc); }, { rail: true });
}

// ---------------------------------------------------------------- Tokens tab
function paneTokens() {
  const sc = scene();
  if (!sc) return el('p', { class: 'muted' }, 'Pick a scene first.');
  const wrap = el('div', { class: 'stack' });
  const sel = S.selection.length === 1 && sc.tokens.find(t => t.id === S.selection[0]);
  if (sel) wrap.append(tokenEditor(sc, sel), el('div', { class: 'sep' }));
  wrap.append(el('div', { class: 'row' }, el('h3', { class: 'grow' }, 'On this scene'),
    el('button', { class: 'btn small', type: 'button', onclick: placeParty }, 'Place party'),
    el('button', { class: 'btn small', type: 'button', onclick: () => addTokenDialog(sc) }, '+ Token')));
  const list = el('div', { class: 'list' });
  for (const t of sc.tokens) {
    const st = tokenStats(S.camp, t);
    const av = avatar(st.name, t.charId ? st.color : DISPOSITION_COLORS[t.disposition], null);
    if (st.img) assets.url(st.img).then(u => { if (u) { av.style.background = `url("${u}") center/cover`; av.textContent = ''; } });
    const f = st.hp?.max ? Math.max(0, st.hp.value / st.hp.max) : 0;
    list.append(el('div', { class: 'li' + (S.selection.includes(t.id) ? ' sel' : ''), onclick: () => { S.selection = [t.id]; S.view.selected = new Set([t.id]); S.view.dirty = true; renderPanel(true); } },
      av,
      el('div', { style: { minWidth: 0 } }, el('div', { class: 'nm' }, st.name + (t.hidden ? ' (hidden)' : '')),
        el('div', { class: 'hpline' }, el('span', { class: 'bar' }, el('i', { style: { width: (f * 100) + '%', background: f > .5 ? '#4f9d69' : f > .25 ? '#d6a73c' : '#c8553d' } })), `${st.hp?.value ?? '–'}/${st.hp?.max ?? '–'}`)),
      t.charId ? el('span', { class: 'chip' }, 'PC') : el('button', { class: 'btn icon ghost', type: 'button', title: t.hidden ? 'Reveal to players' : 'Hide from players', html: t.hidden ? ICONS.eyeoff : ICONS.eye, onclick: e => { e.stopPropagation(); change(() => { t.hidden = !t.hidden; }); } })));
  }
  if (!sc.tokens.length) list.append(el('p', { class: 'muted small' }, 'No tokens. Drop images onto the map, use “+ Token”, or drag a character from the Party tab.'));
  wrap.append(list);
  return wrap;
}

function tokenEditor(sc, t) {
  const ch = t.charId && S.camp.characters.find(c => c.id === t.charId);
  const st = tokenStats(S.camp, t);
  const data = { hp: { ...st.hp }, conditions: [...(st.conditions || [])] };
  const target = ch || t;
  const box = el('div', { class: 'card stack', style: { borderColor: ch ? ch.color : 'var(--line)' } });
  box.append(el('div', { class: 'row' }, el('h3', { class: 'grow', style: { margin: 0 } }, st.name), ch ? el('span', { class: 'chip' }, ch.player || 'PC') : null));
  if (!ch) {
    const disp = el('select', {}, ['hostile', 'neutral', 'friendly'].map(d => el('option', { value: d, selected: t.disposition === d }, d)));
    disp.addEventListener('change', () => change(() => { t.disposition = disp.value; }));
    box.append(
      el('label', { class: 'field' }, el('span', {}, 'Name'), txt(t.name, v => change(() => { t.name = v || 'Token'; }))),
      el('div', { class: 'grid3' },
        el('label', { class: 'field' }, el('span', {}, 'AC'), num(t.ac, v => change(() => { t.ac = v; }))),
        el('label', { class: 'field' }, el('span', {}, 'Size (squares)'), num(t.size, v => v >= 1 && change(() => { t.size = Math.min(8, Math.round(v)); }), { min: 1, max: 8 })),
        el('label', { class: 'field' }, el('span', {}, 'Attitude'), disp)),
      el('div', { class: 'grid3' }, el('label', { class: 'field' }, el('span', {}, 'Initiative bonus'), num(t.init || 0, v => change(() => { t.init = v || 0; })))),
      el('div', { class: 'row' },
        el('label', { class: 'check' }, (() => { const c = el('input', { type: 'checkbox', checked: t.hidden }); c.addEventListener('change', () => change(() => { t.hidden = c.checked; })); return c; })(), 'Hidden from players'),
        el('button', { class: 'btn small', type: 'button', onclick: async () => { const [f] = await pickFiles({ accept: 'image/*' }); if (f) { const id = await assets.put(f, f.name); change(() => { t.img = id; }); } } }, 'Token image…')));
  } else box.append(el('p', { class: 'small muted' }, 'Party token: HP, AC and conditions come from the character (Party tab), and the player can change HP and conditions too.'));
  box.append(hpConditionsEditor(data, patch => change(() => Object.assign(target, patch), { panel: false }), { showMax: !ch }));
  const actor = t.actorId && S.camp.actors[t.actorId];
  if (actor) box.append(el('details', { open: true }, el('summary', { class: 'small' }, 'Stat block'), renderStatBlock(actor, { onRoll: (f, label) => dmRoll(f, { label: label.replace(actor.name, st.name) }) })));
  box.append(el('div', { class: 'row' },
    el('button', { class: 'btn small', type: 'button', onclick: () => { const copy = { ...clone(t), id: uid(10), x: t.x + t.size }; if (!copy.charId) { copy.name = nextName(sc, t.name); change(() => sc.tokens.push(copy)); } } }, 'Duplicate'),
    el('button', { class: 'btn small', type: 'button', onclick: () => { const c = S.view.tokenCenter(t); S.view.centerOn(c.x, c.y); } }, 'Find on map'),
    el('button', { class: 'btn small danger', type: 'button', onclick: () => change(() => { sc.tokens = sc.tokens.filter(x => x.id !== t.id); S.selection = []; }) }, 'Remove')));
  return box;
}

function nextName(sc, base) {
  const stem = base.replace(/\s+\d+$/, '');
  let n = 2; while (sc.tokens.some(t => t.name === `${stem} ${n}`)) n++;
  return `${stem} ${n}`;
}

function addTokenDialog(sc) {
  const name = el('input', { type: 'text', placeholder: 'e.g. Xorn' });
  const hp = el('input', { type: 'number', value: 10, min: 1 });
  const ac = el('input', { type: 'number', value: 12 });
  const size = el('select', {}, [['1', 'Medium or smaller (1)'], ['2', 'Large (2×2)'], ['3', 'Huge (3×3)'], ['4', 'Gargantuan (4×4)']].map(([v, l]) => el('option', { value: v }, l)));
  const count = el('input', { type: 'number', value: 1, min: 1, max: 20 });
  const disp = el('select', {}, ['hostile', 'neutral', 'friendly'].map(d => el('option', { value: d }, d)));
  const hidden = el('input', { type: 'checkbox', checked: true });
  let file = null, picked = null;
  const fl = el('span', { class: 'small muted' }, 'Initials token');
  const find = el('input', { type: 'text', placeholder: 'Search the 2024 SRD monsters (e.g. xorn, stone giant)' });
  const hits = el('div', { class: 'hits' });
  const init = el('input', { type: 'number', value: 0 });
  find.addEventListener('input', async () => {
    const q = find.value; const res = await searchBestiary(q, 8);
    if (find.value !== q) return;
    hits.innerHTML = '';
    for (const m of res) hits.append(el('button', { class: 'btn small', type: 'button', onclick: () => {
      picked = m; name.value = m.name; hp.value = m.hp.max; ac.value = m.ac; init.value = m.init;
      size.value = String(Math.max(1, Math.round(m.squares))); hits.innerHTML = ''; find.value = m.name + ` (CR ${m.crText})`;
    } }, `${m.name} · CR ${m.crText}`));
  });
  modal({ title: 'Add tokens', body: el('div', { class: 'stack' },
    el('label', { class: 'field' }, el('span', {}, 'From the bestiary'), find), hits,
    el('label', { class: 'field' }, el('span', {}, 'Name'), name),
    el('div', { class: 'grid3' }, el('label', { class: 'field' }, el('span', {}, 'HP'), hp), el('label', { class: 'field' }, el('span', {}, 'AC'), ac), el('label', { class: 'field' }, el('span', {}, 'How many'), count)),
    el('div', { class: 'grid3' }, el('label', { class: 'field' }, el('span', {}, 'Size'), size), el('label', { class: 'field' }, el('span', {}, 'Attitude'), disp), el('label', { class: 'field' }, el('span', {}, 'Init bonus'), init)),
    el('div', { class: 'row' }, el('button', { class: 'btn small', type: 'button', onclick: async () => { [file] = await pickFiles({ accept: 'image/*' }); fl.textContent = file ? file.name : 'Initials token'; } }, 'Image…'), fl),
    el('label', { class: 'check' }, hidden, 'Start hidden from players')),
  actions: [{ label: 'Cancel' }, { label: 'Add', kind: 'primary', run: async () => {
    const img = file ? await assets.put(file, file.name) : null;
    const g = sc.grid, n = Math.max(1, Math.min(20, +count.value || 1));
    const cx = Math.floor((S.view.cam.x - g.ox) / g.size), cy = Math.floor((S.view.cam.y - g.oy) / g.size);
    const base = name.value.trim() || 'Creature', sz = +size.value;
    let actorId = null;
    if (picked) { actorId = 'srd:' + picked.id; S.camp.actors[actorId] ||= picked; }
    change(() => { for (let i = 0; i < n; i++) sc.tokens.push(newToken({ name: n > 1 ? `${base} ${i + 1}` : base, img, actorId, init: +init.value || 0, hp: { value: +hp.value || 1, max: +hp.value || 1, temp: 0 }, ac: +ac.value || 10, size: sz, disposition: disp.value, hidden: hidden.checked, x: cx + (i % 4) * sz, y: cy + Math.floor(i / 4) * sz })); });
  } }] });
}

// ---------------------------------------------------------------- Combat tab
function tokenCombatant(sc, t) {
  const st = tokenStats(S.camp, t);
  const ch = t.charId && S.camp.characters.find(c => c.id === t.charId);
  return combatant({ tokenId: t.id, charId: t.charId, name: st.name, img: st.img, color: t.charId ? st.color : null, bonus: ch ? (ch.init || 0) : (t.init || 0), hidden: t.hidden });
}

function startCombat(which) {
  const sc = scene(); if (!sc) return;
  const tokens = which === 'selected' ? sc.tokens.filter(t => S.selection.includes(t.id)) : sc.tokens;
  if (!tokens.length) { toast(which === 'selected' ? 'Select tokens on the map first (Shift-click for several)' : 'No tokens on this scene', 'bad'); return; }
  change(c => { c.combat = newCombat(tokens.map(t => tokenCombatant(sc, t))); c.combat.sceneId = sc.id; });
}

function rollNpcInit(all = false) {
  const c = S.camp.combat; if (!c) return;
  const todo = c.list.filter(x => !x.charId && (all || x.init == null));
  if (!todo.length) { toast('Every monster already has initiative'); return; }
  // One roll per distinct monster name, like rolling a group together.
  const byName = new Map();
  for (const x of todo) {
    const key = x.name.replace(/\s+\d+$/, '');
    if (!byName.has(key)) {
      const r = dmRoll(`1d20${x.bonus >= 0 ? '+' : ''}${x.bonus}`, { label: `${key}: Initiative`, hidden: true });
      byName.set(key, r?.total ?? 10);
    }
    x.init = byName.get(key);
  }
  change(() => sortCombat(c));
}

function paneCombat() {
  const c = S.camp.combat;
  const wrap = el('div', { class: 'stack' });
  if (!c) {
    wrap.append(el('h3', {}, 'Combat'),
      el('p', { class: 'small muted' }, 'Start a fight with everyone on this scene, or with the tokens you’ve selected (Shift-click to select several). Hidden monsters join hidden: players won’t see them in the turn order until you reveal them.'),
      el('div', { class: 'row' },
        el('button', { class: 'btn primary', type: 'button', onclick: () => startCombat('scene') }, 'Everyone on this scene'),
        el('button', { class: 'btn', type: 'button', onclick: () => startCombat('selected') }, `Selected (${S.selection.length})`)));
    return wrap;
  }
  const cur = currentCombatant(c);
  const missing = c.list.filter(x => x.init == null);
  wrap.append(
    el('div', { class: 'row' }, el('h3', { class: 'grow', style: { margin: 0 } }, c.started ? `Round ${c.round}` : 'Initiative'),
      el('button', { class: 'btn small danger', type: 'button', onclick: async () => { if (await confirmBox('End combat?', 'The turn order will be cleared.', { ok: 'End combat' })) change(cc => { cc.combat = null; }); } }, 'End')),
    el('div', { class: 'row' },
      el('button', { class: 'btn small', type: 'button', onclick: () => rollNpcInit(false) }, 'Roll monsters'),
      el('button', { class: 'btn small' + (c.askInit ? ' copper' : ''), type: 'button', onclick: () => change(() => { c.askInit = !c.askInit; }) }, c.askInit ? 'Waiting on players…' : 'Ask players to roll'),
      el('button', { class: 'btn small', type: 'button', onclick: () => { const sc = scene(); const have = new Set(c.list.map(x => x.tokenId)); const add = sc.tokens.filter(t => S.selection.includes(t.id) && !have.has(t.id)); if (!add.length) return toast('Select tokens not already in the fight'); change(() => { c.list.push(...add.map(t => tokenCombatant(sc, t))); sortCombat(c); }); } }, '+ Selected')),
    missing.length ? el('p', { class: 'small', style: { color: 'var(--copper)' } }, `Waiting on initiative: ${missing.map(x => x.name).join(', ')}`) : null,
  );
  const list = el('div', { class: 'list' });
  c.list.forEach((x, i) => {
    const sc = scene();
    const t = sc?.tokens.find(t => t.id === x.tokenId);
    const st = t ? tokenStats(S.camp, t) : null;
    const ini = el('input', { type: 'number', value: x.init ?? '', placeholder: '–', style: { width: '52px', textAlign: 'center', padding: '4px' }, 'aria-label': 'Initiative' });
    ini.addEventListener('click', e => e.stopPropagation());
    ini.addEventListener('change', () => change(() => { x.init = ini.value === '' ? null : Number(ini.value); sortCombat(c); }));
    const f = st?.hp?.max ? Math.max(0, st.hp.value / st.hp.max) : null;
    list.append(el('div', { class: 'li cbt' + (cur?.id === x.id ? ' sel' : '') + (x.defeated ? ' down' : ''), onclick: () => focusToken(x.tokenId) },
      ini,
      el('div', { style: { minWidth: 0 } }, el('div', { class: 'nm' }, x.name + (x.hidden ? ' (hidden)' : '')),
        f != null ? el('div', { class: 'hpline' }, el('span', { class: 'bar' }, el('i', { style: { width: f * 100 + '%', background: f > .5 ? '#4f9d69' : f > .25 ? '#d6a73c' : '#c8553d' } })), `${st.hp.value}/${st.hp.max}`) : el('div', { class: 'small muted' }, 'token not on this scene')),
      el('div', { class: 'row', style: { gap: '2px' } },
        el('button', { class: 'btn icon ghost', type: 'button', title: x.hidden ? 'Show in players’ turn order' : 'Hide from players', html: x.hidden ? ICONS.eyeoff : ICONS.eye, onclick: e => { e.stopPropagation(); change(() => { x.hidden = !x.hidden; }); } }),
        el('button', { class: 'btn icon ghost', type: 'button', title: x.defeated ? 'Back in the fight' : 'Defeated (skipped)', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 5l14 14M19 5L5 19"/></svg>', style: x.defeated ? { color: 'var(--danger)' } : null, onclick: e => { e.stopPropagation(); change(() => { x.defeated = !x.defeated; }); } }),
        el('button', { class: 'btn icon ghost', type: 'button', title: 'Remove from combat', html: ICONS.x, onclick: e => { e.stopPropagation(); change(() => { const wasCur = i === c.turn; c.list.splice(i, 1); if (i < c.turn || (wasCur && c.turn >= c.list.length)) c.turn = Math.max(0, c.turn - (i < c.turn ? 1 : 0)); if (c.turn >= c.list.length) c.turn = 0; }); } }))));
  });
  wrap.append(list);
  wrap.append(el('div', { class: 'row', style: { marginTop: '6px' } },
    c.started ? el('button', { class: 'btn', type: 'button', onclick: () => change(() => advance(c, -1)) }, '◂ Back') : null,
    el('button', { class: 'btn primary grow', type: 'button', onclick: () => nextTurn() }, c.started ? 'Next turn ▸' : 'Begin round 1 ▸')));
  wrap.append(el('p', { class: 'small muted' }, 'Players see the order across the top of their map and get a nudge when their turn comes up. Shortcut: N for next turn.'));
  return wrap;
}

function nextTurn() {
  const c = S.camp.combat; if (!c) return;
  if (!c.started && c.list.some(x => x.init == null)) { toast('Some combatants have no initiative yet', 'bad'); }
  change(() => { sortCombat(c); advance(c, 1); });
  const cur = currentCombatant(c);
  if (cur && !cur.hidden) {
    S.host.broadcast({ t: 'turn', id: cur.id, charId: cur.charId, name: cur.name, round: c.round });
    if (cur.tokenId && viewingActive()) { const t = scene()?.tokens.find(t => t.id === cur.tokenId); if (t) { const p = S.view.tokenCenter(t); S.view.addPing(p.x, p.y, '#E5916A'); } }
  }
}

// ---------------------------------------------------------------- Party tab
function playerLink(ch) {
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  const peer = new URLSearchParams(location.search).get('peer');
  return `${base}play.html${peer ? '?peer=' + peer : ''}#h=${S.camp.hostId}&k=${ch.key}`;
}

function paneParty() {
  const online = new Set([...(S.host?.clients.values() || [])].map(c => c.info.charId));
  const wrap = el('div', { class: 'stack' }, el('div', { class: 'row' }, el('h3', { class: 'grow' }, 'Party'), el('button', { class: 'btn small', type: 'button', onclick: () => change(c => c.characters.push(newCharacter(c, {}))) }, '+ Character')),
    el('p', { class: 'small muted' }, 'Send each player their own link. Opening it puts them at the table as that character. Drag a character onto the map to place their token.'));
  for (const ch of S.camp.characters) {
    const link = el('input', { type: 'text', readonly: true, value: playerLink(ch) });
    const av = avatar(ch.name, ch.color, null);
    if (ch.img) assets.url(ch.img).then(u => { if (u) { av.style.background = `url("${u}") center/cover`; av.textContent = ''; } });
    const head = el('div', { class: 'row', draggable: 'true' }, av, el('div', { class: 'grow' }, el('div', { style: { fontFamily: 'var(--display)', fontSize: '20px', lineHeight: 1.1 } }, ch.name), el('div', { class: 'small muted' }, (ch.player || 'No player set'))),
      el('span', { class: 'status' }, el('span', { class: 'dot ' + (online.has(ch.id) ? 'on' : '') }), el('span', { class: 'small muted' }, online.has(ch.id) ? 'here' : 'away')));
    head.addEventListener('dragstart', e => { e.dataTransfer.setData('text/erta-token', ch.id); e.dataTransfer.effectAllowed = 'copy'; });
    head.style.cursor = 'grab';
    const color = el('input', { type: 'color', value: ch.color }); color.addEventListener('change', () => change(() => { ch.color = color.value; }));
    const data = { hp: { ...ch.hp }, conditions: [...ch.conditions] };
    const det = el('details', {}, el('summary', { class: 'small' }, 'Edit details, HP and conditions'),
      el('div', { class: 'stack', style: { marginTop: '8px' } },
        el('div', { class: 'grid2' },
          el('label', { class: 'field' }, el('span', {}, 'Character'), txt(ch.name, v => change(() => { ch.name = v || 'Character'; }))),
          el('label', { class: 'field' }, el('span', {}, 'Player'), txt(ch.player, v => change(() => { ch.player = v; })))),
        el('div', { class: 'grid3' },
          el('label', { class: 'field' }, el('span', {}, 'AC'), num(ch.ac, v => change(() => { ch.ac = v; }))),
          el('label', { class: 'field' }, el('span', {}, 'Speed'), txt(ch.speed, v => change(() => { ch.speed = v; }))),
          el('label', { class: 'field' }, el('span', {}, 'Size'), num(ch.size || 1, v => v >= 1 && change(() => { ch.size = Math.min(4, Math.round(v)); }), { min: 1, max: 4 }))),
        el('div', { class: 'grid3' }, el('label', { class: 'field' }, el('span', {}, 'Initiative bonus'), num(ch.init || 0, v => change(() => { ch.init = v || 0; for (const x of S.camp.combat?.list || []) if (x.charId === ch.id) x.bonus = v || 0; })))),
        el('div', { class: 'row' }, color, el('button', { class: 'btn small', type: 'button', onclick: async () => { const [f] = await pickFiles({ accept: 'image/*' }); if (f) { const id = await assets.put(f, f.name); change(() => { ch.img = id; }); } } }, 'Token image…')),
        hpConditionsEditor(data, patch => change(() => Object.assign(ch, patch), { panel: false })),
        el('div', { class: 'row' },
          el('button', { class: 'btn small', type: 'button', onclick: async () => { if (await confirmBox('New link?', `${ch.name}'s old link will stop working. Send ${ch.player || 'the player'} the new one.`, { ok: 'Make new link' })) { S.host.kick(ch.id); change(() => { ch.key = uid(8); }); } } }, 'New link'),
          el('button', { class: 'btn small danger', type: 'button', onclick: async () => { if (await confirmBox('Remove character?', `${ch.name} and their tokens will be removed.`, { ok: 'Remove', danger: true })) change(c => { c.characters = c.characters.filter(x => x.id !== ch.id); for (const s of c.scenes) s.tokens = s.tokens.filter(t => t.charId !== ch.id); }); } }, 'Remove'))));
    wrap.append(el('div', { class: 'card pc stack', style: { borderLeftColor: ch.color } },
      head,
      el('div', { class: 'hpline' }, el('span', { class: 'lbl' }, 'HP'), `${ch.hp.value}/${ch.hp.max}${ch.hp.temp ? ' +' + ch.hp.temp : ''}`, el('span', { class: 'lbl', style: { marginLeft: '8px' } }, 'AC'), String(ch.ac)),
      ch.conditions.length ? conditionChips(ch.conditions) : null,
      el('div', { class: 'linkbox' }, link, el('button', { class: 'btn icon', type: 'button', title: 'Copy link', html: ICONS.copy, onclick: async () => { if (await copyText(link.value)) toast(`Copied ${ch.name}'s link`, 'ok'); } })),
      det));
  }
  return wrap;
}

// ---------------------------------------------------------------- Audio tab
async function addTracks(files) {
  for (const f of files) {
    if (!f.type.startsWith('audio/') && !/\.(mp3|ogg|wav|m4a|flac|webm)$/i.test(f.name)) continue;
    const id = await assets.put(f, f.name);
    const name = f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    const kind = /amb|ambien|wind|rain|drip|crowd|forest|cave|room|loop/i.test(name) ? 'ambience' : /sfx|hit|bang|boom|crash|door|roar|bell|thunder/i.test(name) ? 'sfx' : 'music';
    const url = await assets.url(id);
    const dur = await audioDuration(url);
    S.camp.audio.library.push({ id: uid(8), name, asset: id, kind, vol: 1, dur });
  }
  change(() => {});
  toast('Added to the audio library', 'ok');
}

function paneAudio() {
  const a = S.camp.audio;
  const np = el('div', { class: 'nowplaying' }, el('div', { class: 'lbl' }, 'Now playing for everyone'));
  for (const k of ['music', 'ambience']) {
    const cur = a[k];
    np.append(el('div', { class: 'np-row' }, el('span', { class: 'lbl' }, k),
      el('span', { class: 'small', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, cur ? cur.name + (cur.paused ? ' (paused)' : '') : '—'),
      el('div', { class: 'row', style: { gap: '4px' } },
        cur ? el('button', { class: 'btn icon', type: 'button', title: cur.paused ? 'Resume' : 'Pause', html: cur.paused ? ICONS.play : ICONS.pause, onclick: () => togglePause(k) }) : null,
        cur ? el('button', { class: 'btn icon', type: 'button', title: 'Stop (fades out)', html: ICONS.stop, onclick: () => stopLayer(k) }) : null)));
  }
  const wrap = el('div', { class: 'stack' }, np);
  // DM monitor volumes
  const vols = el('details', {}, el('summary', { class: 'small' }, 'Your own volume (only on this computer)'),
    el('div', { class: 'stack vol-pop', style: { marginTop: '8px' } }, ['master', 'music', 'ambience', 'sfx'].map(k => el('label', { class: 'row' }, el('span', { class: 'small' }, k), (() => {
      const r = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: S.audio?.vol[k] ?? 0.8 });
      r.addEventListener('input', () => { S.audio.setVolume(k, +r.value); kv.set('dm-volumes', S.audio.vol); });
      return r;
    })()))));
  wrap.append(vols);
  const sfx = a.library.filter(t => t.kind === 'sfx');
  if (sfx.length) wrap.append(el('h4', {}, 'Sound effects'), el('div', { class: 'sfx-board' }, sfx.map(t => el('button', { class: 'btn', type: 'button', onclick: () => playTrack(t) }, t.name))));
  wrap.append(el('div', { class: 'row', style: { marginTop: '6px' } }, el('h4', { class: 'grow', style: { margin: 0 } }, 'Library'),
    el('button', { class: 'btn small', type: 'button', onclick: async () => addTracks(await pickFiles({ accept: 'audio/*', multiple: true })) }, '+ Add audio files')));
  for (const kind of ['music', 'ambience', 'sfx']) {
    const items = a.library.filter(t => t.kind === kind);
    if (!items.length) continue;
    wrap.append(el('div', { class: 'lbl' }, { music: 'Music', ambience: 'Ambience', sfx: 'Effects' }[kind]));
    for (const t of items) {
      const playing = a[kind]?.trackId === t.id;
      const kindSel = el('select', { style: { width: 'auto', padding: '2px 4px', fontSize: '11px' } }, ['music', 'ambience', 'sfx'].map(k => el('option', { value: k, selected: k === t.kind }, k)));
      kindSel.addEventListener('change', () => change(() => { t.kind = kindSel.value; }));
      wrap.append(el('div', { class: 'track' + (playing ? ' playing' : '') },
        el('button', { class: 'btn icon', type: 'button', title: kind === 'sfx' ? 'Play for everyone' : 'Play for everyone (crossfades)', html: ICONS.play, onclick: () => playTrack(t) }),
        el('div', { style: { minWidth: 0 } }, el('div', { class: 'nm' }, t.name), el('div', { class: 'kind' }, t.dur ? fmtDur(t.dur) : '')),
        el('div', { class: 'row', style: { gap: '4px' } }, kindSel,
          el('button', { class: 'btn icon ghost', type: 'button', title: 'Remove from library', html: ICONS.x, onclick: () => change(c => { c.audio.library = c.audio.library.filter(x => x.id !== t.id); for (const s of c.scenes) { if (s.music === t.id) s.music = null; if (s.ambience === t.id) s.ambience = null; } }) }))));
    }
  }
  if (!a.library.length) wrap.append(el('p', { class: 'small muted' }, 'Add your Suno tracks and ambience loops here (or drop audio files on the map). Music and ambience loop and crossfade; effects play once.'));
  return wrap;
}
const fmtDur = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- Handouts tab
function paneHandouts() {
  const cur = S.camp.handout;
  const wrap = el('div', { class: 'stack' }, el('h3', {}, 'Handouts'));
  wrap.append(cur
    ? el('div', { class: 'card stack' }, el('div', { class: 'lbl' }, 'Showing to players now'), el('div', {}, cur.title || (cur.img ? 'Image' : 'Handout')),
      el('div', { class: 'row' }, el('button', { class: 'btn small', type: 'button', onclick: () => previewHandout(cur) }, 'Preview'), el('button', { class: 'btn small danger', type: 'button', onclick: () => change(c => { c.handout = null; }) }, 'Close for everyone')))
    : el('p', { class: 'small muted' }, 'Nothing showing. A handout pops up on every player’s screen until you close it (they can also dismiss it themselves).'));
  const title = el('input', { type: 'text', placeholder: 'Title (optional)' });
  const text = el('textarea', { rows: 6, placeholder: 'Letter, ledger, case card… (leave empty to show just an image)' });
  const style = el('select', {}, el('option', { value: 'paper' }, 'Paper (letters)'), el('option', { value: 'ledger' }, 'Ledger (typed records)'));
  let img = null;
  const il = el('span', { class: 'small muted' }, 'No image');
  wrap.append(el('h4', {}, 'New handout'), el('div', { class: 'stack' }, title, text,
    el('div', { class: 'row' }, style, el('button', { class: 'btn small', type: 'button', onclick: async () => { const [f] = await pickFiles({ accept: 'image/*' }); if (f) { img = await assets.put(f, f.name); il.textContent = f.name; } } }, 'Image…'), il),
    el('div', { class: 'row' },
      el('button', { class: 'btn primary', type: 'button', onclick: () => { const h = mkHandout(); if (h) change(c => { c.handout = h; c.handouts.unshift(h); }); } }, 'Show to players'),
      el('button', { class: 'btn', type: 'button', onclick: () => { const h = mkHandout(); if (h) { change(c => { c.handouts.unshift(h); }); toast('Saved for later'); } } }, 'Save for later'))));
  function mkHandout() {
    if (!text.value.trim() && !img) { toast('Write something or choose an image', 'bad'); return null; }
    return { id: uid(8), title: title.value.trim(), text: text.value.trim(), style: style.value, img };
  }
  if (S.camp.handouts.length) {
    wrap.append(el('h4', {}, 'Saved'));
    for (const h of S.camp.handouts) wrap.append(el('div', { class: 'track' },
      el('button', { class: 'btn icon', type: 'button', title: 'Show to players', html: ICONS.play, onclick: () => change(c => { c.handout = { ...h, at: Date.now() }; }) }),
      el('div', { class: 'nm' }, h.title || (h.text ? h.text.slice(0, 40) : 'Image')),
      el('div', { class: 'row', style: { gap: '4px' } },
        el('button', { class: 'btn icon ghost', type: 'button', title: 'Preview', html: ICONS.eye, onclick: () => previewHandout(h) }),
        el('button', { class: 'btn icon ghost', type: 'button', title: 'Delete', html: ICONS.x, onclick: () => change(c => { c.handouts = c.handouts.filter(x => x.id !== h.id); }) }))));
  }
  return wrap;
}

async function previewHandout(h) {
  const url = h.img ? await assets.url(h.img) : null;
  const ov = renderHandout(h, url, () => ov.remove());
  document.body.append(ov);
}

// ---------------------------------------------------------------- Settings tab
function paneSettings() {
  const st = S.camp.settings;
  const diag = el('select', {}, [['equal', 'Every square is 5 ft (2024 default)'], ['alternate', 'Diagonals alternate 5 / 10 ft']].map(([v, l]) => el('option', { value: v, selected: st.diagonals === v }, l)));
  diag.addEventListener('change', () => change(() => { st.diagonals = diag.value; }));
  const mh = el('select', {}, [['bloodied', 'Show when Bloodied (half HP or less)'], ['none', 'Show nothing'], ['full', 'Show exact HP bars']].map(([v, l]) => el('option', { value: v, selected: st.monsterHealth === v }, l)));
  mh.addEventListener('change', () => change(() => { st.monsterHealth = mh.value; }));
  const theme = el('select', {}, Object.entries(THEMES).map(([v, l]) => el('option', { value: v, selected: S.camp.theme === v }, l)));
  theme.addEventListener('change', () => change(() => { S.camp.theme = theme.value; }));
  return el('div', { class: 'stack' },
    el('h3', {}, 'Campaign'),
    el('label', { class: 'field' }, el('span', {}, 'Name'), txt(S.camp.name, v => { change(() => { S.camp.name = v || 'Campaign'; }); renderTitle(); })),
    el('label', { class: 'field' }, el('span', {}, 'Series'), theme),
    el('h4', {}, 'Rules'),
    el('label', { class: 'field' }, el('span', {}, 'Diagonal movement'), diag),
    el('label', { class: 'field' }, el('span', {}, 'Monster health players can see'), mh),
    el('h4', {}, 'Keyboard'),
    el('p', { class: 'small muted' }, 'V select · R ruler · P ping · C sphere · O cone · L line · B cube · F reveal · H hide · Delete removes · arrows nudge · Esc clears. Hold on empty map to ping; Shift+ping pulls every player’s view.'),
    el('h4', {}, 'Backups'),
    el('div', { class: 'row' }, el('button', { class: 'btn', type: 'button', onclick: exportBackup }, 'Back up this campaign'), el('button', { class: 'btn', type: 'button', onclick: importBackup }, 'Restore a backup…')),
    el('h4', {}, 'Danger'),
    el('button', { class: 'btn danger', type: 'button', onclick: async () => {
      if (!(await confirmBox('Delete campaign?', `“${S.camp.name}” will be deleted from this browser. Back it up first if you might want it again.`, { ok: 'Delete campaign', danger: true }))) return;
      const id = S.camp.id; S.host?.destroy(); S.camp = null; await campaigns.delete(id); renderHome();
    } }, 'Delete campaign'),
    el('p', { class: 'small muted', style: { marginTop: '18px' } }, 'Condition icons by Lorc, Delapouite and contributors at game-icons.net (CC BY 3.0).'));
}

// ======================================================================= backup

async function exportBackup() {
  const c = S.camp; save.flush();
  const zip = new window.JSZip();
  zip.file('campaign.json', JSON.stringify(c));
  const ids = new Set();
  for (const s of c.scenes) { if (s.bg) ids.add(s.bg); for (const t of s.tokens) if (t.img) ids.add(t.img); }
  for (const ch of c.characters) if (ch.img) ids.add(ch.img);
  for (const t of c.audio.library) ids.add(t.asset);
  for (const h of c.handouts || []) if (h.img) ids.add(h.img);
  const meta = [];
  for (const id of ids) { const a = await assets.get(id); if (!a) continue; zip.file('assets/' + id, a.blob); meta.push({ id, name: a.name, type: a.type }); }
  zip.file('assets.json', JSON.stringify(meta));
  toast('Packing backup…');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  downloadBlob(blob, `${c.name.replace(/[^\w-]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.ertatable`);
}

async function importBackup() {
  const [f] = await pickFiles({ accept: '.ertatable,.zip' });
  if (!f) return;
  try {
    const zip = await window.JSZip.loadAsync(f);
    const c = JSON.parse(await zip.file('campaign.json').async('string'));
    const meta = JSON.parse(await zip.file('assets.json').async('string'));
    for (const m of meta) { const buf = await zip.file('assets/' + m.id)?.async('arraybuffer'); if (buf) await assets.putRaw(m.id, m.type, m.name, buf); }
    const existing = await campaigns.get(c.id);
    if (existing && !(await confirmBox('Replace campaign?', `“${existing.name}” already exists here. Replace it with the backup?`, { ok: 'Replace', danger: true }))) return;
    await campaigns.put(c);
    toast(`Restored “${c.name}”`, 'ok');
    if (S.camp) { S.host?.destroy(); }
    openCampaign(c.id);
  } catch (e) { console.error(e); toast('That file isn’t an Erta Table backup', 'bad'); }
}

// ======================================================================= boot

async function boot() {
  const m = location.hash.match(/c=([\w]+)/);
  if (m && (await campaigns.get(m[1]))) openCampaign(m[1]);
  else renderHome();
}
boot();
