// The DM view: campaigns, scenes, tokens, fog, party links, audio and handouts.
// This tab is the game server: players connect to it directly.

import { $, el, uid, debounce, throttle, toast, copyText, pickFiles, downloadBlob, fmtBytes, clone } from './util.js';
import { campaigns, assets, kv, persistStorage } from './store.js';
import { Host, setRelay, encodeRelay, testRelay } from './net.js';
import { MapView } from './render.js';
import { FogMask, compact } from './fog.js';
import { AudioEngine, audioDuration } from './audio.js';
import { newCampaign, newCharacter, newScene, newToken, tokenStats, playerView, THEMES, DISPOSITION_COLORS } from './model.js';
import { renderMonsterPanel as monsterPanel } from './monster.js';
import { ICONS, modal, confirmBox, promptBox, popover, closePopover, hpConditionsEditor, conditionChips, renderHandout, avatar, titleCard } from './ui.js';
import { roll as rollDice, withAdvantage, DiceOverlay, RollLog, DICE_SKINS } from './dice.js';
import { newCombat, combatant, sortCombat, current as currentCombatant, advance, combatView, renderStrip } from './combat.js';
import { loadBestiary, searchBestiary, renderStatBlock } from './statblock.js';
import { importPack, paneprep, actorModal, encounterTokens, clockWidget, orderPackScenes, loadPrepFile } from './prep.js';
import { Engine, actorFor, sheetNumbers, stripHtml } from './rules.js';
import { LIGHTS, moveBlocked, visionOn } from './vision.js';
import { tokenSight, tokenLight } from './model.js';
import { wrapUpDialog } from './wrapup.js';
import { renderNpcDrawer, drawerSection, presentNpcs } from './drawer.js';
import { SYNTHS, synthName } from './sfx.js';
import * as backup from './backup.js';
import { detectGrid, gridFromBox, guessCount } from './gridfit.js';
import { SheetWindow, AREA_SHAPE, needsTarget } from './sheet.js';
import { imageKitDialog, importZip, listenForKit, artFor } from './imagekit.js';

const DM_COLOR = '#E5916A';

const S = {
  camp: null, viewId: null, host: null, view: null, audio: null,
  selection: [], tab: 'scene', activeFog: new FogMask(), panelDirty: false,
  dice: null, log: null, prepSection: null, prepFollow: true,
  engine: null, targets: {}, pending: new Map(), sheetWin: null, engScene: null,
  asks: new Map(), turnBusy: false, monPin: null, lightPreset: 'torch',
  drawer: { show: false, pick: null, open: new Set() },
};
window.__dm = S; // handy for debugging from the console
queueMicrotask(() => { S.change = (fn, o) => change(fn, o); });

// ======================================================================= home

async function renderHome() {
  document.title = 'Erta Table';
  const root = $('#root');
  root.innerHTML = '';
  const list = (await campaigns.list()).sort((a, b) => b.updated - a.updated);
  const orphans = await backup.orphanSnapshots().catch(() => []);
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
      el('button', { class: 'btn', type: 'button', onclick: importBackup }, 'Restore a backup'),
      backup.folderSupported() ? el('button', { class: 'btn', type: 'button', onclick: restoreFromFolder }, 'Restore from a folder') : null),
    orphans.length ? el('div', { class: 'stack', style: { marginTop: '18px' } }, el('div', { class: 'lbl' }, 'Snapshots of campaigns that are no longer here'),
      orphans.map(o => el('div', { class: 'row' }, el('span', { class: 'grow' }, `${o.latest.name} · ${new Date(o.latest.ts).toLocaleString()} · ${o.count} snapshot${o.count === 1 ? '' : 's'}`),
        el('button', { class: 'btn small', type: 'button', onclick: async () => { const c = await backup.loadSnapshot(o.id, o.latest.ts); if (c) restoreCampaign(c, 'the snapshot'); } }, 'Bring it back')))) : null,
    el('p', { class: 'note' }, 'Everything is saved in this browser on this computer, with automatic snapshots every ten minutes of play. For a copy elsewhere, pick a backup folder in a campaign’s Settings (Chrome, Edge) or use “Back up”; the player links keep working after a restore.'),
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
  S.targets = {}; S.pending.clear();
  buildApp();
  makeEngine();
  startHost();
  autoAttachSheets();
  listenForKit(kitCtx);
  S.lastSnapAt = 0; S.folderErr = null;
  setTimeout(() => autoBackup('Opened', true), 1500);
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
  c.packs ||= {};
  c.clocks ||= [];
  c.actors ||= {};
  if (c.combat === undefined) c.combat = null;
  for (const ch of c.characters) { ch.init ??= 0; ch.effects ||= []; ch.state ||= {}; }
  if (!c.sceneOrderV1) { for (const p of Object.values(c.packs)) orderPackScenes(c, p); c.sceneOrderV1 = true; }
  for (const s of c.scenes) { s.templates ||= []; s.fog ||= { on: true, ops: [] }; s.kind ||= 'map'; s.walls ||= []; s.lights ||= []; s.vision ||= { on: false, light: 'bright' }; for (const t of s.tokens) t.init ??= 0; }
  for (const ch of c.characters) ch.items ||= [];
  c.journal ||= [];
  if (!c.sessionStart) startSession(c);
}

// A session runs from one wrap-up to the next: the journal and the clocks' starting values.
function startSession(c) {
  c.sessionStart = Date.now();
  c.sessionClocks = Object.fromEntries((c.clocks || []).map(k => [k.id, k.value]));
  c.sessionHp = Object.fromEntries(c.characters.map(ch => [ch.id, { ...ch.hp }]));
}

function journal(type, text, data = {}) {
  if (!S.camp) return;
  const j = (S.camp.journal ||= []);
  j.push({ ts: Date.now(), type, text, ...data });
  if (j.length > 3000) j.splice(0, j.length - 3000);
  save();
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
  S.sheetWin?.render();
}
const railSoon = debounce(() => renderRail(), 300);

// ======================================================================= networking

function startHost() {
  S.host?.destroy();
  setRelay(S.camp.settings.relay || null);
  const host = new Host(S.camp.hostId, async hello => {
    if (hello.role === 'companion') return hello.key && hello.key === S.camp.companionKey ? { ok: true, info: { charId: null, name: 'Your second screen', role: 'companion', color: DM_COLOR } } : { ok: false, reason: 'This second-screen link was reset. Copy the new one from the DM’s Settings.' };
    if (hello.role === 'watch') return hello.key && hello.key === S.camp.watchKey ? { ok: true, info: { charId: null, name: 'Spectator', role: 'watch', color: '#93B5D8' } } : { ok: false, reason: 'This spectator link was reset. Ask the DM for the new one.' };
    const ch = S.camp.characters.find(x => x.key === hello.key);
    if (!ch) return { ok: false, reason: 'This link is no longer valid. Ask your DM for a new one.' };
    return { ok: true, info: { charId: ch.id, name: ch.name, color: ch.color } };
  });
  S.host = host;
  host.on('status', s => renderStatus());
  host.on('clients', () => { renderStatus(); if (S.tab === 'party') renderPanel(); });
  host.on('join', (pid, info) => {
    toast(info.role === 'companion' ? 'Your second screen is connected' : info.role === 'watch' ? 'A spectator view connected' : `${info.name} joined`, 'ok');
    if (info.role === 'companion') { host.send(pid, { t: 'welcome', companion: companionView() }); return; }
    host.send(pid, { t: 'welcome', view: viewFor(info.charId), watch: info.role === 'watch' });
    host.send(pid, { t: 'rolls', list: S.camp.rolls.filter(r => !r.hidden).slice(-40).map(publicCard) });
    host.send(pid, { t: 'targets', map: targetMap() });
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
  let cv = null;
  S.host.broadcast(info => info.role === 'companion' ? { t: 'cstate', view: cv ||= companionView() } : { t: 'state', view: playerView(S.camp, info.charId, sc, (x, y) => S.activeFog.fogged(x, y)) });
  syncAudio();
}, 70);

function onPlayerMessage(pid, m, info) {
  if (info?.role === 'watch') return;               // spectators only watch
  if (info?.role === 'companion') { companionCmd(pid, m); return; }
  const c = S.camp, sc = activeScene();
  const ownsToken = id => sc?.tokens.find(t => t.id === id && ((t.charId && t.charId === info.charId) || (t.owner && t.owner === info.charId)));
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
      const from = { x: t.x, y: t.y }, to = { x: Math.round(m.x), y: Math.round(m.y) };
      if (moveBlocked(sc, t, from, to)) { S.view.setRemoteDrag(m.id, null); S.host.send(pid, { t: 'notice', text: 'A wall is in the way.' }); S.host.send(pid, { t: 'state', view: viewFor(info.charId) }); return; }
      t.x = to.x; t.y = to.y;
      S.view.setRemoteDrag(m.id, null);
      change(() => {}, { panel: S.tab === 'tokens' });
      afterMove(sc, t, from);
      return;
    }
    case 'door': {
      const w = sc?.walls?.find(x => x.id === m.id && x.door && !x.secret);
      if (!w) return;
      if (w.locked) { S.host.send(pid, { t: 'notice', text: 'It’s locked.' }); return; }
      change(() => { w.open = !w.open; }, { panel: false });
      return;
    }
    case 'answer': {
      const a = S.asks.get(String(m.id || ''));
      if (a && a.charId === info.charId && (m.choice == null || a.options.some(o => o.id === m.choice))) a.done(m.choice ?? null);
      return;
    }
    case 'dice-skin': {
      const ch = c.characters.find(x => x.id === info.charId); if (!ch) return;
      change(() => { ch.dice = DICE_SKINS[m.skin] ? m.skin : null; }, { panel: S.tab === 'party' });
      return;
    }
    case 'light': {
      const ch = c.characters.find(x => x.id === info.charId); if (!ch) return;
      const L = LIGHTS[m.kind];
      change(() => { ch.light = L ? { kind: m.kind, bright: L.bright, dim: L.dim } : null; }, { panel: S.tab === 'party' });
      return;
    }
    case 'give-item': case 'drop-item': {
      const ch = c.characters.find(x => x.id === info.charId); if (!ch) return;
      const it = (ch.items || []).find(x => x.id === m.id); if (!it) return;
      if (m.t === 'drop-item') { change(() => { ch.items = ch.items.filter(x => x !== it); }); journal('loot', `${ch.name} dropped ${it.name}`); return; }
      const to = c.characters.find(x => x.id === m.to); if (!to || to === ch) return;
      change(() => passItem(ch, to, it));
      journal('loot', `${ch.name} gave ${it.name} to ${to.name}`);
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
    case 'use': case 'check': case 'death': case 'rest': case 'sheet-state': case 'end-conc': case 'end-effect': case 'save-roll': case 'targets':
      onRulesMessage(pid, m, info);
      return;
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
  // each roller's dice skin travels with the roll, so every screen shows the same dice
  if (r.by) { const ch = r.by.charId && S.camp.characters.find(c => c.id === r.by.charId); r.by.dice = ch ? (ch.dice || null) : (r.by.name === 'DM' ? S.camp.settings.dmDice || null : null); }
  S.camp.rolls.push(r);
  if (S.camp.rolls.length > 200) S.camp.rolls.splice(0, S.camp.rolls.length - 200);
  save();
}

async function showRoll(r) {
  await S.dice?.show(r, r.by?.color || DM_COLOR, r.by?.dice);
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
  if (!track.asset) { toast(`“${track.name}” has no audio file yet: attach one in Audio or Prep`, 'bad'); return; }
  if (track.kind === 'sfx') {
    S.host.broadcast({ t: 'sfx', asset: track.asset, vol: track.vol ?? 1 });
    S.audio.sfx(track.asset, track.vol ?? 1);
    return;
  }
  change(c => { c.audio[track.kind] = { trackId: track.id, asset: track.asset, name: track.name, startedAt: Date.now(), loop: true, vol: track.vol ?? 1 }; });
}
function stopLayer(kind) { change(c => { c.audio[kind] = null; if (kind === 'music') c.audio.preCombat = null; }); }

// A built-in sound for everyone (js/sfx.js).
function playSynth(key, vol = 1) {
  S.host?.broadcast({ t: 'sfx', synth: key, vol });
  S.audio?.synth(key, vol);
}
// The sound board: built-ins first, then the library's effects. Number keys 1–9 and 0 play the first ten.
function boardPads() {
  const lib = S.camp.audio.library.filter(t => t.kind === 'sfx' && t.asset).map(t => ({ name: t.name, play: () => playTrack(t) }));
  const hide = new Set(S.camp.audio.hiddenSynths || []);
  const syn = SYNTHS.filter(([k]) => !hide.has(k)).map(([k, n]) => ({ name: n, synth: k, play: () => playSynth(k) }));
  return [...lib, ...syn];
}

// Combat music: the scene's combat loop (or your default) when initiative starts, and back when the fight ends.
// An area animation on every screen showing that scene.
function areaFx(tpl, kind) {
  if (S.camp.settings.areaFx === false) return;
  const sc = S.engScene || scene();
  const t = { shape: tpl.shape, x: tpl.x, y: tpl.y, dir: tpl.dir || 0, len: tpl.len, wid: tpl.wid };
  if (sc?.id === S.viewId) S.view?.playFx(t, kind);
  if (sc?.id === S.camp.activeSceneId) S.host?.broadcast({ t: 'fx', scene: sc.id, tpl: t, kind });
  const sfx = { fire: 'fire', thunder: 'thunder', lightning: 'thunder', cold: 'wind', acid: 'splash', poison: 'wind', necrotic: 'rumble', radiant: 'bell', force: 'magic', psychic: 'magic', bludgeoning: 'explosion' }[kind] || 'magic';
  if (S.camp.settings.areaFxSound !== false) { S.audio?.synth(sfx, 0.7); if (sc?.id === S.camp.activeSceneId) S.host?.broadcast({ t: 'sfx', synth: sfx, vol: 0.7 }); }
}

function combatTrackFor(sc) {
  const lib = S.camp.audio.library;
  const id = sc?.combatMusic || S.camp.audio.combatDefault;
  return lib.find(t => t.id === id && t.asset) || null;
}
function combatMusicOn(sc) {
  if (S.camp.settings.combatMusic === false) return;
  const tr = combatTrackFor(sc); if (!tr) return;
  if (S.camp.audio.music?.trackId === tr.id) return;
  change(c => { c.audio.preCombat = c.audio.music?.combat ? c.audio.preCombat : (c.audio.music || null); c.audio.music = { trackId: tr.id, asset: tr.asset, name: tr.name, startedAt: Date.now(), loop: true, vol: tr.vol ?? 1, combat: true }; }, { panel: S.tab === 'audio' });
  toast(`Combat music: ${tr.name}`);
}
function combatMusicOff() {
  const a = S.camp.audio; if (!a.music?.combat) return;
  change(c => { c.audio.music = c.audio.preCombat ? { ...c.audio.preCombat } : null; c.audio.preCombat = null; }, { panel: S.tab === 'audio' });
}
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
      el('div', { class: 'clock-chips', id: 'clock-chips' }),
      el('div', { class: 'who', id: 'who' }),
      el('span', { class: 'status', id: 'net-status' }),
      el('button', { class: 'btn small', id: 'pause-btn', type: 'button', onclick: () => change(c => { c.paused = !c.paused; }) }, 'Pause'),
      el('button', { class: 'btn small', id: 'who-btn', type: 'button', title: 'NPC cards for the people in this scene (E)', onclick: () => toggleDrawer() }, 'Who’s here'),
      el('button', { class: 'btn small', type: 'button', title: 'Recap the session, the clocks and the loot, ready for your prep project', onclick: () => openWrapUp() }, 'Wrap up'),
      el('button', { class: 'btn small copper', id: 'backup-chip', type: 'button', hidden: true, title: 'The browser needs your OK to keep writing backups to your folder', onclick: async () => { if (await backup.resumeFolder()) autoBackup('', true); renderBackupChip(); } }, 'Resume folder backups'),
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
      el('div', { class: 'mon-panel', id: 'mon-panel', hidden: true }),
      el('div', { class: 'npc-drawer', id: 'npc-drawer', hidden: true }),
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
      if (final) { const from = S.dragFrom?.id === id ? S.dragFrom : { x: t.x, y: t.y }; S.dragFrom = null; change(() => { t.x = x; t.y = y; }, { panel: S.tab === 'tokens' }); if (from.x !== x || from.y !== y) afterMove(sc, t, from); }
      else { if (S.dragFrom?.id !== id) S.dragFrom = { id, x: t.x, y: t.y }; if (viewingActive()) dragOut(id, x, y); }
    },
    onWallAdd: w => change(() => { const sc = scene(); (sc.walls ||= []).push({ id: uid(8), ...w, ...(w.door ? { open: false } : {}) }); }, { panel: false }),
    onWallRemove: id => change(() => { const sc = scene(); sc.walls = (sc.walls || []).filter(w => w.id !== id); }, { panel: false }),
    onLightAdd: (x, y) => change(() => { const sc = scene(); const L = LIGHTS[S.lightPreset] || LIGHTS.torch; (sc.lights ||= []).push({ id: uid(8), x, y, bright: L.bright, dim: L.dim, kind: S.lightPreset }); }, { panel: false }),
    onLightRemove: id => change(() => { const sc = scene(); sc.lights = (sc.lights || []).filter(l => l.id !== id); }, { panel: false }),
    onDoor: id => { const w = scene()?.walls?.find(x => x.id === id); if (w) change(() => { w.open = !w.open; }, { panel: false }); },
    onDoorContext: (id, x, y) => doorHud(id, x, y),
    onRuler: pts => { if (viewingActive()) S.host.broadcast({ t: 'ruler', key: 'dm', pts, color: '#E5916A', name: 'DM' }); },
    onPing: (x, y, pull) => { if (viewingActive()) S.host.broadcast({ t: 'ping', x, y, color: '#E5916A', pull }); if (pull) toast(viewingActive() ? 'Pulled everyone’s view here' : 'Players aren’t on this scene'); },
    onGridBox: box => onGridBox(box),
    onTemplateAdd: tpl => change(() => scene().templates.push({ ...tpl, id: uid(8), owner: 'dm', color: '#E5916A' }), { panel: false }),
    onTemplateRemove: id => change(() => { const sc = scene(); sc.templates = sc.templates.filter(t => t.id !== id); }, { panel: false }),
    onFog: op => change(() => { const sc = scene(); sc.fog.ops.push(op); sc.fog.ops = compact(sc.fog.ops); }, { panel: false }),
    onSelect: ids => { S.selection = ids; if (ids.length && S.tab === 'scene') { S.tab = 'tokens'; renderTabs(); } if (S.tab === 'tokens') renderPanel(true); },
    onTokenContext: (id, x, y) => tokenHud(id, x, y),
    onTokenDblClick: id => { S.selection = [id]; S.tab = 'tokens'; renderTabs(); renderPanel(); },
    onToolChange: id => setTool(id),
    onTokenDelete: ids => change(() => { const sc = scene(); sc.tokens = sc.tokens.filter(t => !ids.includes(t.id)); S.selection = []; }),
    onDropFiles: dropFiles,
    onDropData: (charId, wx, wy) => placePc(charId, wx, wy),
  });
  buildToolbar();
  S.dice = new DiceOverlay();
  S.dice.onFlourish = k => S.audio?.synth(k);
  const dock = $('#dock');
  const head = el('button', { class: 'dock-h', type: 'button', onclick: () => { dock.classList.toggle('closed'); localStorage.setItem('erta-dock', dock.classList.contains('closed') ? 'closed' : 'open'); } }, el('span', {}, 'Dice & rolls'), el('span', { class: 'chev' }, '▾'));
  dock.append(head);
  if (localStorage.getItem('erta-dock') === 'closed') dock.classList.add('closed');
  S.log = new RollLog(dock, { canHide: true, onRoll: (f, o) => dmRoll(f, o), onUndo: cd => undoCard(cd) });
  S.log.el.prepend(el("div", { class: "pending", id: "pending", hidden: true }));
  S.sheetWin = new SheetWindow('dm');
  S.log.setAll(S.camp.rolls.slice(-60));
}

const dragOut = throttle((id, x, y) => S.host.broadcast({ t: 'drag', id, x, y }), 50);

async function goHome() {
  save.flush();
  await autoBackup();
  S.host?.destroy(); S.host = null;
  if (S.audio) { S.audio.set('music', null); S.audio.set('ambience', null); }
  S.camp = null;
  history.replaceState(null, '', location.pathname + location.search);
  renderHome();
}

function refreshAll() { renderTitle(); renderStatus(); renderRail(); refreshMap(); renderTabs(); renderPanel(true); renderDrawer(); }

// ---------------------------------------------------------------- Who's here
function toggleDrawer(show = !S.drawer.show) { S.drawer.show = show; S.drawer.pick = null; renderDrawer(); }
function renderDrawer() {
  const box = $('#npc-drawer'), btn = $('#who-btn'); if (!box || !S.camp) return;
  const { pack, section } = drawerSection(S.camp, scene(), S.prepSection);
  const n = presentNpcs(pack, section).length;
  if (btn) { btn.hidden = !pack; btn.textContent = n ? `Who’s here · ${n}` : 'Who’s here'; btn.setAttribute('aria-pressed', S.drawer.show ? 'true' : 'false'); }
  if (!S.drawer.show || !pack) { box.hidden = true; return; }
  renderNpcDrawer(box, {
    camp: S.camp, scene: scene(), prepSection: S.prepSection, pick: S.drawer.pick, open: S.drawer.open,
    onPick: v => { S.drawer.pick = v; renderDrawer(); },
    onClose: () => toggleDrawer(false),
    openActor: id => { const a = S.camp.actors[id]; if (a) actorModal(a, (f, label) => dmRoll(f, { label })); },
    placeActor: (pk, key, name) => placeEncounter(pk, { key: 'npc', name, groups: [{ label: name, foes: [{ actor: key, count: 1, name, disposition: 'neutral' }] }] }, 0, true),
    showHandout: h => { change(c => { c.handout = { ...h, at: Date.now() }; }); toast('Showing to players'); },
  });
}
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
  const roles = [...h.clients.values()].map(c => c.info.role).filter(Boolean);
  if (roles.includes('companion')) who.append(el('span', { class: 'p on extra', title: 'Your second screen is connected' }, '⧉'));
  const w = roles.filter(r => r === 'watch').length;
  if (w) who.append(el('span', { class: 'p on extra', title: `${w} spectator view${w === 1 ? '' : 's'} watching` }, '◉' + (w > 1 ? w : '')));
  const cc = $('#clock-chips');
  if (cc) {
    cc.innerHTML = '';
    for (const k of (S.camp.clocks || []).filter(k => !S.camp.activePack || k.pack === S.camp.activePack)) {
      const b = el('button', { class: 'clock-chip' + (k.visible ? '' : ' hidden'), type: 'button', title: `${k.name}${k.visible ? '' : ' (hidden from players)'}. Click +1, right-click −1.${k.steps?.[k.value] ? '\nAt ' + k.value + ': ' + k.steps[k.value] : ''}`,
        onclick: () => { const was = k.value; change(() => { k.value = Math.min(k.size, k.value + 1); }); if (k.value !== was) clockEvent(k, was); } },
        el('span', { class: 'nm' }, k.name), el('span', { class: 'pp' }, Array.from({ length: k.size }, (_, i) => el('i', { class: i < k.value ? 'on' : '' }))));
      b.addEventListener('contextmenu', e => { e.preventDefault(); const was = k.value; change(() => { k.value = Math.max(0, k.value - 1); }); if (k.value !== was) clockEvent(k, was); });
      cc.append(b);
    }
  }
  $('#pause-btn').setAttribute('aria-pressed', S.camp.paused ? 'true' : 'false');
  $('#pause-btn').textContent = S.camp.paused ? 'Paused' : 'Pause';
}
function clockEvent(k, was) { journal('clock', `${k.name}: ${was} → ${k.value}${k.steps?.[k.value] ? ' (' + k.steps[k.value] + ')' : ''}`, { clock: k.id, name: k.name, from: was, to: k.value }); }
const initials = n => String(n || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();

// ======================================================================= second screen & spectators
// The DM's second screen (a tablet beside you) gets this: the tracker with real HP, the clocks,
// the prep for the live scene, music and the sound board, the party, and the last rolls.
function companionView() {
  const c = S.camp, sc = activeScene() || scene();
  const online = new Set([...(S.host?.clients.values() || [])].map(x => x.info.charId).filter(Boolean));
  const cb = c.combat, csc = cb && c.scenes.find(x => x.id === cb.sceneId);
  const { pack, section } = drawerSection(c, sc, S.prepSection);
  const cur = cb ? currentCombatant(cb) : null;
  return {
    name: c.name, paused: !!c.paused, at: Date.now(),
    scene: sc ? { id: sc.id, name: sc.name, notes: sc.notes || '', live: sc.id === c.activeSceneId } : null,
    scenes: c.scenes.map(x => ({ id: x.id, name: x.name, live: x.id === c.activeSceneId })),
    combat: cb ? { round: cb.round, started: !!cb.started, busy: !!S.turnBusy, list: cb.list.map(x => {
      const t = csc?.tokens.find(t => t.id === x.tokenId); const st = t ? tokenStats(c, t) : null;
      return { id: x.id, token: x.tokenId, name: x.name, init: x.init, pc: !!x.charId, hidden: !!x.hidden || !!t?.hidden, hp: st?.hp || null, ac: st?.ac ?? null, cond: (st?.conditions || []).map(k => String(k).replace(/:\d+$/, '')), current: x === cur, down: !!x.defeated || (st && st.hp?.value <= 0) };
    }) } : null,
    clocks: (c.clocks || []).filter(k => !c.activePack || k.pack === c.activePack || !k.pack).map(k => ({ id: k.id, name: k.name, size: k.size, value: k.value, visible: !!k.visible, goal: k.goal || '', step: k.steps?.[k.value] || '' })),
    audio: { music: c.audio.music?.name || null, ambience: c.audio.ambience?.name || null,
      tracks: c.audio.library.filter(t => t.kind !== 'sfx' && t.asset).map(t => ({ id: t.id, name: t.name, kind: t.kind, playing: c.audio[t.kind]?.trackId === t.id })),
      pads: boardPads().map((p, i) => ({ i, name: p.name })) },
    party: c.characters.map(ch => ({ id: ch.id, name: ch.name, color: ch.color, hp: ch.hp, ac: ch.ac, cond: (ch.conditions || []).map(k => String(k).replace(/:\d+$/, '')), online: online.has(ch.id), react: !!ch.reactUsed, conc: ch.concentration?.name || null })),
    waiting: [...S.pending.values()].map(p => `${p.name}: ${p.label}`),
    rolls: c.rolls.filter(r => !r.undone).slice(-14).reverse().map(r => r.kind === 'card' ? { card: true, title: r.title, lines: (r.lines || []).map(l => l.t).slice(0, 10) } : { title: (r.by?.name || '') + (r.label ? ': ' + r.label : ''), formula: r.formula, total: r.total, nat: r.terms?.some(t => t.sides === 20) ? r.nat : null, hidden: !!r.hidden }),
    prep: pack ? { pack: pack.id, title: pack.title, sections: pack.sections.map(x => ({ id: x.id, num: x.num, title: x.title })), current: section?.id || null } : null,
    npcs: presentNpcs(pack, section).map(n => ({ name: n.name, role: n.role || n.walkOn || '', fields: n.fields, line: n.line })),
  };
}

function companionCmd(pid, m) {
  const c = S.camp;
  if (m.t === 'prep') {   // the prep text for a section, sent on request (it can be long)
    const pack = c.packs?.[m.pack]; const sec = pack?.sections.find(x => x.id === m.id);
    if (sec) S.host.send(pid, { t: 'cprep', pack: pack.id, id: sec.id, html: sec.html, css: pack.css || '' });
    return;
  }
  if (m.t !== 'cmd') return;
  switch (m.op) {
    case 'next': nextTurn(); return;
    case 'prev': { const cb = c.combat; if (cb) change(() => { advance(cb, -1); }); return; }
    case 'hp': {
      const cb = c.combat, csc = cb && c.scenes.find(x => x.id === cb.sceneId);
      const t = (csc || activeScene())?.tokens.find(t => t.id === m.token); if (!t || !S.engine) return;
      S.engScene = csc || activeScene();
      const A = S.engine.actor(t), n = Math.abs(Math.round(+m.delta || 0)); if (!n) return;
      const card = S.engine.newCard(`${A.name}: ${m.delta < 0 ? 'damage' : 'healing'} from the DM`);
      if (m.delta < 0) S.engine.applyDamage(A, n, card); else S.engine.applyHeal(A, n, card);
      postCard(card); change(() => {}, { panel: ['tokens', 'party', 'combat'].includes(S.tab) });
      return;
    }
    case 'clock': { const k = (c.clocks || []).find(x => x.id === m.id); if (!k) return; const was = k.value; const v = Math.max(0, Math.min(k.size, Math.round(+m.value))); if (v === was) return; change(() => { k.value = v; }, { rail: false }); clockEvent(k, was); renderStatus(); return; }
    case 'clock-vis': { const k = (c.clocks || []).find(x => x.id === m.id); if (k) change(() => { k.visible = !k.visible; }); return; }
    case 'play': { const t = c.audio.library.find(x => x.id === m.id); if (t) playTrack(t); return; }
    case 'stop': if (['music', 'ambience'].includes(m.layer)) stopLayer(m.layer); return;
    case 'pad': { const p = boardPads()[m.i]; if (p) p.play(); return; }
    case 'notes': { const x = c.scenes.find(s => s.id === m.scene); if (x) change(() => { x.notes = String(m.text || '').slice(0, 20000); }, { panel: S.tab === 'scene' }); return; }
    case 'show': { if (c.scenes.some(s => s.id === m.scene)) { viewScene(m.scene); activate(m.scene); } return; }
    case 'pause': change(cc => { cc.paused = !cc.paused; }); return;
  }
}

function secondScreenLink(kind) {
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  const peer = new URLSearchParams(location.search).get('peer');
  const r = encodeRelay(S.camp.settings.relay);
  const q = peer ? '?peer=' + peer : '';
  return kind === 'companion' ? `${base}companion.html${q}#h=${S.camp.hostId}&k=${S.camp.companionKey}${r ? '&r=' + r : ''}`
    : `${base}play.html${q}#h=${S.camp.hostId}&w=${S.camp.watchKey}${r ? '&r=' + r : ''}`;
}

function screensBox() {
  const c = S.camp;
  if (!c.companionKey || !c.watchKey) { c.companionKey ||= uid(18); c.watchKey ||= uid(18); save(); }
  const row = (kind, title, text) => {
    const link = el('input', { type: 'text', readonly: true, value: secondScreenLink(kind) });
    return el('div', { class: 'stack', style: { gap: '6px' } }, el('b', {}, title), el('p', { class: 'small muted', style: { margin: 0 } }, text),
      el('div', { class: 'row' }, link, el('button', { class: 'btn small', type: 'button', html: ICONS.copy + ' Copy', onclick: async () => { if (await copyText(link.value)) toast('Link copied', 'ok'); } }),
        el('button', { class: 'btn small ghost', type: 'button', title: 'Open it in a new window', onclick: () => window.open(link.value, '_blank') }, 'Open')));
  };
  return el('div', { class: 'stack' },
    row('companion', 'Second DM screen', 'Open this on a tablet or a second monitor: the tracker with real HP, next turn, the clocks, the prep for the live scene, music and the sound board. It controls the table, so keep it to yourself.'),
    row('watch', 'Spectator view', 'A clean, read-only view of what the party sees, with dice, title cards and music: for streaming or recording (OBS: add it as a Browser source), or a TV at the table.'),
    el('button', { class: 'btn small ghost', type: 'button', title: 'Old second-screen and spectator links stop working', onclick: async () => {
      if (!(await confirmBox('Reset these links?', 'The old second-screen and spectator links stop working. Copy the new ones after.', { ok: 'Reset' }))) return;
      change(cc => { cc.companionKey = uid(18); cc.watchKey = uid(18); });
      for (const x of S.host?.clients.values() || []) if (x.info.role) { try { x.conn.close(); } catch {} }
      renderPanel(true);
    } }, 'Reset these links'));
}

// ======================================================================= toolbar

const TOOLS = [
  [['select', 'Select & move (drag empty space to pan, hold to ping)'], ['ruler', 'Measure'], ['ping', 'Ping (Shift: pull everyone’s view)']],
  [['tpl:circle', 'Sphere / radius'], ['tpl:cone', 'Cone'], ['tpl:line', 'Line'], ['tpl:cube', 'Cube']],
  [['fog:reveal-rect', 'Reveal area'], ['fog:hide-rect', 'Hide area'], ['fog:reveal-brush', 'Reveal brush'], ['fog:hide-brush', 'Hide brush']],
  [['wall', 'Walls (drag to draw, right-click removes)'], ['door', 'Doors (drag to draw; click a door to open it)'], ['light', 'Lights (click to place, right-click removes)']],
];
const TOOL_ICON = { select: 'select', ruler: 'ruler', ping: 'ping', 'tpl:circle': 'circle', 'tpl:cone': 'cone', 'tpl:line': 'line', 'tpl:cube': 'cube', 'fog:reveal-rect': 'reveal', 'fog:hide-rect': 'hide', 'fog:reveal-brush': 'brush', 'fog:hide-brush': 'brush', wall: 'wall', door: 'door', light: 'light' };
const KEYS = { v: 'select', r: 'ruler', p: 'ping', c: 'tpl:circle', o: 'tpl:cone', l: 'tpl:line', b: 'tpl:cube', f: 'fog:reveal-rect', h: 'fog:hide-rect', w: 'wall', d: 'door', i: 'light' };

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
    if (e.key.toLowerCase() === 't') { toggleTarget('dm', S.view.hover, e.shiftKey); return; }
    if (e.key.toLowerCase() === 'e') { toggleDrawer(); return; }
    if (/^[0-9]$/.test(e.key)) { const p = boardPads()[(+e.key + 9) % 10]; if (p) { p.play(); toast('♪ ' + p.name); } return; }
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
  } else if (id === 'wall' || id === 'door' || id === 'light') {
    sb.hidden = false; sb.innerHTML = '';
    wallBar(sb, id);
  } else sb.hidden = true;
  S.view.dirty = true;
}

function wallBar(sb, id) {
  const sc = scene();
  if (!sc) { sb.append(el('span', { class: 'small muted' }, 'Make or open a scene first.')); return; }
  const v = sc.vision || (sc.vision = { on: false, light: 'bright' });
  const on = el('input', { type: 'checkbox', checked: v.on });
  on.addEventListener('change', () => change(() => { sc.vision.on = on.checked; }));
  const amb = el('select', { 'aria-label': 'Light on this scene', style: { width: 'auto', padding: '2px 6px' } }, [['bright', 'Bright (daylight)'], ['dim', 'Dim (dusk, moonlight)'], ['dark', 'Dark (needs light or darkvision)']].map(([k, l]) => el('option', { value: k, selected: v.light === k }, l)));
  amb.addEventListener('change', () => change(() => { sc.vision.light = amb.value; }));
  const show = el('input', { type: 'checkbox', checked: S.view.showWalls });
  show.addEventListener('change', () => { S.view.showWalls = show.checked; S.view.dirty = true; });
  const prev = el('input', { type: 'checkbox', checked: S.view.previewVision });
  prev.addEventListener('change', () => { S.view.previewVision = prev.checked; S.view.dirty = true; });
  sb.append(el('span', { class: 'lbl' }, id === 'light' ? 'Lights' : id === 'door' ? 'Doors' : 'Walls'),
    el('label', { class: 'check small', title: 'Players see only what their tokens can see: walls block sight, darkness needs light or darkvision' }, on, 'Vision'),
    amb,
    el('label', { class: 'check small' }, prev, 'Preview party vision'),
    el('label', { class: 'check small', title: 'Keep walls and lights drawn after you switch tools' }, show, 'Always show walls'));
  if (id === 'light') {
    const pre = el('select', { 'aria-label': 'New light', style: { width: 'auto', padding: '2px 6px' } }, Object.entries(LIGHTS).map(([k, L]) => el('option', { value: k, selected: S.lightPreset === k }, `${L.name} (${L.bright}/${L.dim} ft)`)));
    pre.addEventListener('change', () => { S.lightPreset = pre.value; });
    sb.append(pre, el('button', { class: 'btn small', type: 'button', onclick: () => change(() => { scene().lights = []; }) }, 'Remove all lights'));
  } else {
    sb.append(
      el('button', { class: 'btn small', type: 'button', html: ICONS.undo + ' Undo', onclick: () => change(() => { scene().walls.pop(); }) }),
      el('button', { class: 'btn small', type: 'button', onclick: async () => { if (await confirmBox('Remove every wall?', 'All walls and doors on this scene will be removed.', { ok: 'Remove all', danger: true })) change(() => { scene().walls = []; }); } }, 'Clear'),
      el('span', { class: 'small muted' }, 'Drag to draw · ends snap to corners and to other walls (Shift: free) · right-click removes'));
  }
}

function doorHud(id, x, y) {
  const sc = scene(); const w = sc?.walls?.find(x => x.id === id); if (!w) return;
  const set = patch => { change(() => Object.assign(w, patch), { panel: false }); closePopover(); };
  popover(x + 8, y + 8, el('div', { class: 'stack' }, el('h4', {}, 'Door'),
    el('button', { class: 'btn small', type: 'button', onclick: () => set({ open: !w.open }) }, w.open ? 'Close it' : 'Open it'),
    el('button', { class: 'btn small', type: 'button', onclick: () => set({ locked: !w.locked, open: w.locked ? w.open : false }) }, w.locked ? 'Unlock (players can open it)' : 'Lock (players can’t open it)'),
    el('button', { class: 'btn small', type: 'button', onclick: () => set({ secret: !w.secret }) }, w.secret ? 'Not secret' : 'Make it secret (looks like wall)'),
    el('button', { class: 'btn small danger', type: 'button', onclick: () => { change(() => { sc.walls = sc.walls.filter(x => x !== w); }, { panel: false }); closePopover(); } }, 'Remove door')));
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
      thumb, el('div', {}, el('div', { class: 'nm' }, s.name), el('div', { class: 'kind' }, (s.kind === 'art' ? 'scene art' : `map · ${s.tokens.length} token${s.tokens.length === 1 ? '' : 's'}`) + (s.bg ? '' : ' · needs image'))),
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
  const sc = S.camp.scenes.find(s => s.id === id);
  if (S.prepFollow !== false && sc?.packRef?.section) S.prepSection = sc.packRef.section;
  if (S.tab === 'prep') renderPanel(true);
  S.drawer.pick = null; renderDrawer();
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
  renderMonsterPanel();
}

function renderMonsterPanel() {
  const box = $('#mon-panel'); if (!box || !S.camp) return;
  monsterPanel(box, {
    camp: S.camp, engine: S.engine, pinned: S.monPin, busy: S.turnBusy,
    scene: () => (S.camp.combat && S.camp.scenes.find(x => x.id === S.camp.combat.sceneId)) || scene(),
    targets: () => S.targets.dm || [],
    current: () => currentCombatant(S.camp.combat),
    use: (sc, t, entry, i, spellId) => npcUse(sc, t, entry, i, spellId),
    run: async (sc, t, req) => { S.engScene = sc; await S.engine.use(t, req); },
    roll: (f, label) => dmRoll(f, { label }),
    change: fn => change(fn, { panel: false }),
    nextTurn: () => nextTurn(),
    unpin: () => { S.monPin = null; renderMonsterPanel(); },
    focus: id => focusToken(id),
    resolveImg: id => assets.url(id),
  });
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
    tokens: sc.tokens.map(t => { const st = tokenStats(S.camp, t); return { ...t, name: st.name, hp: st.hp, ac: st.ac, conditions: st.icons, color: st.color, img: st.img, size: st.size || t.size, light: tokenLight(S.camp, t), sight: t.charId && visionOn(sc) ? tokenSight(S.camp, t) : null }; }),
  };
}

function activate(id) {
  const sc = scene(id);
  change(c => {
    c.activeSceneId = id;
    const lib = c.audio.library;
    for (const k of ['music', 'ambience']) {
      const tid = sc?.[k]; const tr = tid && lib.find(t => t.id === tid);
      if (tr && tr.asset && c.audio[k]?.trackId !== tr.id) c.audio[k] = { trackId: tr.id, asset: tr.asset, name: tr.name, startedAt: Date.now(), loop: true, vol: tr.vol ?? 1 };
    }
  }, { rail: true });
  toast(`Players now see “${sc.name}”`, 'ok');
  if (S.camp.settings.titleCards !== false) showTitleCard(titleFor(sc));
  journal('scene', sc.name, { scene: sc.name, section: sc.packRef?.section || null, pack: sc.packRef?.pack || null });
}

// ---------------------------------------------------------------- title cards
function titleFor(sc) {
  const pack = sc.packRef && S.camp.packs?.[sc.packRef.pack];
  const sec = pack?.sections.find(x => x.id === sc.packRef.section);
  let sub = '';
  if (sec) { const d = new DOMParser().parseFromString(sec.html, 'text/html'); sub = [...d.querySelectorAll('.scene-head .chips .chip')].map(x => x.textContent.trim()).filter(Boolean).join(' · '); }
  const eyebrow = sec && /^\d+$/.test(sec.num || '') ? `Scene ${sec.num}` : (sec?.num === '☼' ? sec.title : '');
  return { eyebrow, title: sc.name.replace(/\s*\(battle map\)$/i, ''), sub };
}
function showTitleCard(card) {
  if (!card?.title) return;
  S.host?.broadcast({ t: 'title', ...card });
  titleCard(card, { mini: true });
}
function titleCardDialog(sc) {
  const d = sc ? titleFor(sc) : { eyebrow: '', title: '', sub: '' };
  const f = k => { const i = el('input', { type: 'text', value: d[k] || '' }); i.addEventListener('input', () => { d[k] = i.value; }); return i; };
  modal({ title: 'Title card', body: el('div', { class: 'stack' },
      el('label', { class: 'field' }, el('span', {}, 'Above (small)'), f('eyebrow')),
      el('label', { class: 'field' }, el('span', {}, 'Title'), f('title')),
      el('label', { class: 'field' }, el('span', {}, 'Below'), f('sub')),
      el('p', { class: 'small muted' }, 'Fades in over every player’s screen for a few seconds: “Three days later”, “Meanwhile, in the Nexus”, a new chapter.')),
    actions: [{ label: 'Cancel' }, { label: 'Show to players', kind: 'primary', run: () => showTitleCard({ ...d }) }] });
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
  if (!squaresAcross && sc.squares) squaresAcross = sc.squares[0];
  // A map from elsewhere with its own printed grid: find it.
  const found = !squaresAcross && !sc._gridSet && sc.kind === 'map' ? await findGrid(url) : null;
  change(() => {
    sc.bg = id; sc.width = dims.w; sc.height = dims.h;
    if (squaresAcross) { sc.grid.size = dims.w / squaresAcross; sc.grid.ox = 0; sc.grid.oy = 0; }
    else if (found) { Object.assign(sc.grid, { size: found.size, ox: found.ox, oy: found.oy }); }
    else if (!sc._gridSet) sc.grid.size = Math.max(40, Math.round(dims.w / 30));
  }, { rail: true });
  if (found && !quiet) toast(`Found the map’s grid: ${found.cols} × ${found.rows} squares. Check it in the Scene tab.`, 'ok');
  else if (!quiet) toast('Background set', 'ok');
}

async function findGrid(url) {
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    return detectGrid(img);
  } catch { return null; }
}

// Draw a box over a known number of squares; the grid snaps to it.
function onGridBox(box) {
  const sc = scene(); if (!sc) return;
  const g = { ...guessCount(box, sc.grid.size) };
  const across = el('input', { type: 'number', min: 1, value: g.across, style: { width: '64px' } });
  const down = el('input', { type: 'number', min: 1, value: g.down, style: { width: '64px' } });
  const apply = () => {
    const fit = gridFromBox(box, Math.max(1, +across.value || 1), Math.max(1, +down.value || 1));
    change(() => { Object.assign(sc.grid, fit); sc._gridSet = true; });
    closePopover(); setTool('select');
    toast(`Grid set: ${(sc.width / fit.size).toFixed(1)} × ${(sc.height / fit.size).toFixed(1)} squares`, 'ok');
  };
  const r = $('#map').getBoundingClientRect();
  popover(r.left + r.width / 2 - 120, r.top + 80, el('div', { class: 'stack', style: { gap: '8px' } },
    el('b', {}, 'How many squares is that box?'),
    el('div', { class: 'row' }, across, el('span', {}, 'across ×'), down, el('span', {}, 'down')),
    el('p', { class: 'small muted', style: { margin: 0 } }, 'Draw it edge to edge over whole squares. The bigger the box, the truer the grid.'),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', type: 'button', onclick: apply }, 'Set the grid'), el('button', { class: 'btn small', type: 'button', onclick: () => closePopover() }, 'Cancel'))));
  across.focus(); across.select();
}

async function dropFiles(files, wx, wy) {
  const sc = scene();
  for (const f of files) {
    if (f.type.startsWith('audio/')) { await addTracks([f]); continue; }
    if (/\.zip$/i.test(f.name) || /zip/.test(f.type)) { await importZip(kitCtx(), f); continue; }
    if (/\.html?$/i.test(f.name) || f.type === 'text/html') { await loadPrepFile(f, { loadPack }); continue; }
    if (/\.json$/i.test(f.name)) { try { const pk = JSON.parse(await f.text()); if (pk.format === 'erta-table-pack') { loadPack(pk); continue; } } catch {} toast('That .json isn’t a session pack', 'bad'); continue; }
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

const TABS = [['prep', 'Prep'], ['scene', 'Scene'], ['tokens', 'Tokens'], ['combat', 'Combat'], ['party', 'Party'], ['audio', 'Audio'], ['handouts', 'Handouts'], ['settings', 'Settings']];

function panePrep() {
  return paneprep({
    camp: S.camp, state: S,
    change: (fn, o) => change(fn, o),
    renderPanel, scrollPane: y => { $('#pane').scrollTop = y; },
    viewScene, activate, setBackground,
    playTrack: t => playTrack(t),
    attachTrack,
    showHandout: h => { change(c => { c.handout = h; }); toast('Showing to players'); if (h.title) journal('handout', h.title); },
    giveItem: (it, charId, n) => giveItem(it, charId, n),
    clockEvent: (k, was) => clockEvent(k, was),
    loadPack,
    placeEncounter: (pack, enc, gi) => placeEncounter(pack, enc, gi),
    imageKit: () => imageKitDialog(kitCtx()),
    openActor: id => { const a = S.camp.actors[id]; if (a) actorModal(a, (f, label) => dmRoll(f, { label })); },
  });
}

function loadPack(pk) {
  let res;
  try { change(c => { res = importPack(c, pk); c.sessionClocks ||= {}; for (const k of c.clocks) if (!(k.id in c.sessionClocks)) c.sessionClocks[k.id] = k.value; }, { rail: true }); }
  catch (e) { toast(e.message, 'bad'); return; }
  S.tab = 'prep'; S.prepSection = null; renderTabs(); renderPanel(true); renderDrawer();
  toast(res.fresh ? `Loaded “${pk.title}”: ${res.added} scenes ready for images` : `Updated “${pk.title}”${res.added ? `, ${res.added} new scenes` : ''}`, 'ok');
}

async function attachTrack(t, f) {
  const id = await assets.put(f, f.name);
  const dur = await audioDuration(await assets.url(id));
  change(() => { t.asset = id; t.dur = dur; t.file = f.name; });
  toast(`Attached to “${t.name}”`, 'ok');
}

function placeEncounter(pack, enc, gi, here = false) {
  const target = (!here && S.camp.scenes.find(x => x.packRef?.pack === pack.id && x.packRef.key === enc.scene)) || scene();
  if (!target) { toast('Make a scene first', 'bad'); return; }
  if (target.id !== S.viewId) viewScene(target.id);
  const g = target.grid;
  const center = { cx: Math.floor((S.view.cam.x - g.ox) / g.size), cy: Math.floor((S.view.cam.y - g.oy) / g.size) };
  const toks = encounterTokens(S.camp, pack, enc, gi, center, g);
  change(() => target.tokens.push(...toks));
  toast(`Placed ${toks.length} hidden token${toks.length === 1 ? '' : 's'} on “${target.name}”. Drag them into place, then reveal.`, 'ok');
}

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
  $('#app')?.classList.toggle('wide-panel', S.tab === 'prep');
  const fn = { prep: panePrep, scene: paneScene, tokens: paneTokens, combat: paneCombat, party: paneParty, audio: paneAudio, handouts: paneHandouts, settings: paneSettings }[S.tab];
  pane.append(fn());
  pane.scrollTop = top;
  if (S.tab === 'prep') renderDrawer();
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
  const trackSel = (kind, field = kind) => {
    const s = el('select', {}, el('option', { value: '' }, field === 'combatMusic' ? '— your default —' : '— none —'), lib.filter(t => t.kind === kind || sc[field] === t.id).map(t => el('option', { value: t.id, selected: sc[field] === t.id }, t.name + (t.asset ? '' : ' (no file yet)'))));
    s.addEventListener('change', () => change(() => { sc[field] = s.value || null; }));
    return s;
  };
  const squares = el('input', { type: 'number', min: 1, step: 'any', value: +(sc.width / g.size).toFixed(2) });
  squares.addEventListener('change', () => { const n = Number(squares.value); if (n > 0) change(() => { sc.grid.size = sc.width / n; sc._gridSet = true; }); });
  return el('div', { class: 'stack' },
    el('h3', {}, sc.name),
    sc.id === S.camp.activeSceneId
      ? el('span', { class: 'chip', style: { color: 'var(--jade)', borderColor: 'var(--jade-line)', justifySelf: 'start' } }, '● Live for players')
      : el('button', { class: 'btn primary', type: 'button', onclick: () => activate(sc.id) }, 'Show this scene to players'),
    el('div', { class: 'row' }, el('button', { class: 'btn small', type: 'button', title: 'A cinematic card over the players’ screens', onclick: () => titleCardDialog(sc) }, 'Title card…')),
    el('label', { class: 'field' }, el('span', {}, 'Name'), txt(sc.name, v => change(() => { sc.name = v || 'Scene'; }, { rail: true }))),
    el('label', { class: 'field' }, el('span', {}, 'Kind'), (() => {
      const s = el('select', {}, el('option', { value: 'map', selected: sc.kind === 'map' }, 'Battle map'), el('option', { value: 'art', selected: sc.kind === 'art' }, 'Scene art'));
      s.addEventListener('change', () => change(() => { sc.kind = s.value; if (s.value === 'art') sc.fog.on = false; }, { rail: true })); return s;
    })()),
    sc.prompt ? el('details', { class: 'prompt-box', open: !sc.bg }, el('summary', { class: 'small' }, (sc.kind === 'map' ? 'Battle map prompt' : 'Art prompt') + (sc.squares ? ` · ${sc.squares[0]} × ${sc.squares[1]} squares` : '')),
      el('p', { class: 'small' }, sc.prompt),
      el('button', { class: 'btn small', type: 'button', html: ICONS.copy + ' Copy prompt', onclick: async () => { if (await copyText(sc.prompt)) toast('Prompt copied', 'ok'); } })) : null,
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
      sc.bg ? el('div', { class: 'row' },
        el('button', { class: 'btn small', type: 'button', title: 'Look for a grid printed on the map', onclick: async () => {
          const f = await findGrid(await assets.url(sc.bg));
          if (!f) { toast('No printed grid found. Draw a box over some squares instead.', 'bad'); return; }
          change(() => { Object.assign(sc.grid, { size: f.size, ox: f.ox, oy: f.oy }); sc._gridSet = true; }); toast(`Found ${f.cols} × ${f.rows} squares`, 'ok');
        } }, 'Find the grid'),
        el('button', { class: 'btn small', type: 'button', title: 'Drag a box over a few whole squares, then say how many', onclick: () => { setTool('grid'); toast('Drag a box over a few whole squares on the map'); } }, 'Align by drawing…'),
        sc.squares ? el('button', { class: 'btn small ghost', type: 'button', title: 'Use the prep’s square count', onclick: () => change(() => { g.size = sc.width / sc.squares[0]; g.ox = 0; g.oy = 0; sc._gridSet = true; }) }, `Prep: ${sc.squares[0]} × ${sc.squares[1]}`) : null) : null,
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
    sc.kind === 'map' ? el('label', { class: 'field' }, el('span', {}, 'Combat music (plays when initiative starts)'), trackSel('music', 'combatMusic')) : null,
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
      el('div', { class: 'grid3' }, el('label', { class: 'field' }, el('span', {}, 'Initiative bonus'), num(t.init || 0, v => change(() => { t.init = v || 0; }))),
        el('label', { class: 'field', style: { gridColumn: 'span 2' } }, el('span', {}, 'Carries a light'), lightSelect(t.light, l => change(() => { t.light = l; })))),
      el('div', { class: 'row' },
        el('label', { class: 'check' }, (() => { const c = el('input', { type: 'checkbox', checked: t.hidden }); c.addEventListener('change', () => change(() => { t.hidden = c.checked; })); return c; })(), 'Hidden from players'),
        el('button', { class: 'btn small', type: 'button', onclick: async () => { const [f] = await pickFiles({ accept: 'image/*' }); if (f) { const id = await assets.put(f, f.name); change(() => { t.img = id; }); } } }, 'Token image…')));
  } else box.append(el('p', { class: 'small muted' }, 'Party token: HP, AC and conditions come from the character (Party tab), and the player can change HP and conditions too.'));
  box.append(hpConditionsEditor(data, patch => change(() => Object.assign(target, patch), { panel: false }), { showMax: !ch }));
  const actor = t.actorId && S.camp.actors[t.actorId];
  if (actor && !ch) box.append(el('button', { class: 'btn small', type: 'button', title: 'Keep this creature’s actions on the map, outside its turn too', onclick: () => { S.monPin = t.id; renderMonsterPanel(); } }, 'Show its actions panel'));
  if (actor) box.append(el('details', { open: true }, el('summary', { class: 'small' }, 'Stat block'), renderStatBlock(actor, { onRoll: (f, label) => dmRoll(f, { label: label.replace(actor.name, st.name) }), onUse: (entry, i, spellId) => npcUse(sc, t, entry, i, spellId), spells: S.engine?.spells })));
  if (ch?.sheet) box.append(el('button', { class: 'btn small', type: 'button', onclick: () => openSheet(ch.id) }, 'Open character sheet'));
  box.append(el('div', { class: 'row' },
    el('button', { class: 'btn small', type: 'button', onclick: () => { const copy = { ...clone(t), id: uid(10), x: t.x + t.size }; if (!copy.charId) { copy.name = nextName(sc, t.name); change(() => sc.tokens.push(copy)); } } }, 'Duplicate'),
    el('button', { class: 'btn small', type: 'button', onclick: () => { const c = S.view.tokenCenter(t); S.view.centerOn(c.x, c.y); } }, 'Find on map'),
    el('button', { class: 'btn small danger', type: 'button', onclick: () => change(() => { sc.tokens = sc.tokens.filter(x => x.id !== t.id); S.selection = []; }) }, 'Remove')));
  return box;
}

function skinSelect(cur, onPick) {
  const s = el('select', {}, Object.entries(DICE_SKINS).map(([k, v]) => el('option', { value: k, selected: (cur || 'classic') === k }, v.name)));
  s.addEventListener('change', () => onPick(s.value === 'classic' ? null : s.value));
  return s;
}
function lightSelect(cur, onPick) {
  const sel = el('select', { 'aria-label': 'Light' }, el('option', { value: '' }, 'No light'), Object.entries(LIGHTS).map(([k, L]) => el('option', { value: k, selected: cur?.kind === k }, `${L.name} (${L.bright} ft bright, +${L.dim} dim)`)));
  sel.addEventListener('change', () => { const L = LIGHTS[sel.value]; onPick(L ? { kind: sel.value, bright: L.bright, dim: L.dim } : null); });
  return sel;
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
    const art = img || artFor(S.camp, actorId);
    change(() => { for (let i = 0; i < n; i++) sc.tokens.push(newToken({ name: n > 1 ? `${base} ${i + 1}` : base, img: art, actorId, init: +init.value || 0, hp: { value: +hp.value || 1, max: +hp.value || 1, temp: 0 }, ac: +ac.value || 10, size: sz, disposition: disp.value, hidden: hidden.checked, x: cx + (i % 4) * sz, y: cy + Math.floor(i / 4) * sz })); });
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
  change(c => { c.combat = newCombat(tokens.map(t => tokenCombatant(sc, t))); c.combat.sceneId = sc.id; c.combat.startedAt = Date.now(); });
  combatMusicOn(sc);
  const foes = tokens.filter(t => !t.charId && t.disposition !== 'friendly').map(t => t.name.replace(/\s+\d+$/, ''));
  journal('combat-start', `A fight began on ${sc.name}`, { scene: sc.name, foes: countNames(foes), pack: S.camp.activePack || null });
}
function countNames(list) { const m = new Map(); for (const n of list) m.set(n, (m.get(n) || 0) + 1); return [...m].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)); }
function endCombat() {
  const c = S.camp.combat; if (!c) return;
  const sc = S.camp.scenes.find(x => x.id === c.sceneId);
  const down = c.list.filter(x => !x.charId).filter(x => { const t = sc?.tokens.find(t => t.id === x.tokenId); return x.defeated || (t && t.hp?.value <= 0); }).map(x => x.name.replace(/\s+\d+$/, ''));
  journal('combat-end', `The fight ended after ${c.started ? c.round : 0} round${c.round === 1 ? '' : 's'}`, { rounds: c.started ? c.round : 0, defeated: countNames(down), scene: sc?.name || '' });
  change(cc => { cc.combat = null; });
  combatMusicOff();
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
      el('button', { class: 'btn small danger', type: 'button', onclick: async () => { if (await confirmBox('End combat?', 'The turn order will be cleared.', { ok: 'End combat' })) endCombat(); } }, 'End')),
    el('div', { class: 'row' },
      el('button', { class: 'btn small', type: 'button', onclick: () => rollNpcInit(false) }, 'Roll monsters'),
      el('button', { class: 'btn small' + (c.askInit ? ' copper' : ''), type: 'button', onclick: () => change(() => { c.askInit = !c.askInit; }) }, c.askInit ? 'Waiting on players…' : 'Ask players to roll'),
      el('button', { class: 'btn small', type: 'button', onclick: () => { const sc = scene(); const have = new Set(c.list.map(x => x.tokenId)); const add = sc.tokens.filter(t => S.selection.includes(t.id) && !have.has(t.id)); if (!add.length) return toast('Select tokens not already in the fight'); change(() => { c.list.push(...add.map(t => tokenCombatant(sc, t))); sortCombat(c); }); } }, '+ Selected')),
    missing.length ? el('p', { class: 'small', style: { color: 'var(--copper)' } }, `Waiting on initiative: ${missing.map(x => x.name).join(', ')}`) : '',
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
    el('button', { class: 'btn primary grow', type: 'button', disabled: S.turnBusy, onclick: () => nextTurn() }, S.turnBusy ? 'Resolving…' : c.started ? 'Next turn ▸' : 'Begin round 1 ▸')));
  wrap.append(el('p', { class: 'small muted' }, 'Players see the order across the top of their map and get a nudge when their turn comes up. Shortcut: N for next turn.'));
  return wrap;
}

const keyOf = x => (x.charId ? 'c:' + x.charId : 't:' + x.tokenId);

// End the current turn (end-of-turn saves and zones), move on, then start the next one
// (durations, recharges, start-of-turn effects). Turns run one at a time.
async function nextTurn() {
  const c = S.camp.combat; if (!c || S.turnBusy) return;
  if (!c.started && c.list.some(x => x.init == null)) { toast('Some combatants have no initiative yet', 'bad'); }
  S.turnBusy = true; renderMonsterPanel();
  try {
    S.engScene = S.camp.scenes.find(x => x.id === c.sceneId) || activeScene() || scene();
    const prev = currentCombatant(c);
    if (prev && S.engine) {
      const cd = await S.engine.onTurnEnd(keyOf(prev));
      if (cd.lines.length) postCard(cd);
    }
    if (S.camp.combat !== c) return;
    change(() => { sortCombat(c); advance(c, 1); });
    const cur = currentCombatant(c);
    if (cur && !cur.hidden) {
      S.host.broadcast({ t: 'turn', id: cur.id, charId: cur.charId, name: cur.name, round: c.round });
      if (cur.tokenId && viewingActive()) { const t = scene()?.tokens.find(t => t.id === cur.tokenId); if (t) { const p = S.view.tokenCenter(t); S.view.addPing(p.x, p.y, '#E5916A'); } }
    }
    if (cur && S.engine) {
      const cd = await S.engine.onTurnStart(keyOf(cur), { round: c.round });
      if (cd.lines.length) postCard(cd);
      change(() => {}, { panel: S.tab === 'combat' });
    }
  } finally { S.turnBusy = false; renderMonsterPanel(); }
}

// After a token lands on a new square: Booming Blade, zones it walked into, emanations.
async function afterMove(sc, t, from) {
  if (!S.engine) return;
  S.engScene = sc;
  const cd = await S.engine.onMoved(t, from);
  if (cd) postCard(cd);
  change(() => {}, { panel: false });
}

// ---------------------------------------------------------------- Party tab
function playerLink(ch) {
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  const peer = new URLSearchParams(location.search).get('peer');
  const r = encodeRelay(S.camp.settings.relay);
  return `${base}play.html${peer ? '?peer=' + peer : ''}#h=${S.camp.hostId}&k=${ch.key}${r ? '&r=' + r : ''}`;
}

function routeLabel(charId) {
  const c = [...(S.host?.clients.values() || [])].find(x => x.info.charId === charId);
  const n = c?.net;
  if (!n) return 'here';
  return `here · ${n.route === 'relay' ? 'via relay' : 'direct'}${n.rtt != null ? ` · ${n.rtt} ms` : ''}`;
}

function relayBox() {
  const st = S.camp.settings;
  const r = { urls: [], username: '', credential: '', force: false, ...(st.relay || {}) };
  const urls = el('textarea', { rows: 2, placeholder: 'turn:relay.example.com:443?transport=tcp' }); urls.value = (r.urls || []).join('\n');
  const user = el('input', { type: 'text', value: r.username || '', autocomplete: 'off' });
  const pass = el('input', { type: 'password', value: r.credential || '', autocomplete: 'new-password' });
  const force = el('input', { type: 'checkbox', checked: !!r.force });
  const out = el('div', { class: 'small muted' });
  const read = () => ({ urls: urls.value.split(/[\s,]+/).map(x => x.trim()).filter(x => /^turns?:/.test(x)), username: user.value.trim(), credential: pass.value, force: force.checked });
  return el('div', { class: 'stack' },
    el('p', { class: 'small muted', style: { margin: 0 } }, 'Most players connect straight to your browser. A school, office or hotel network can block that; a TURN relay carries the connection for them instead. Free and paid relays exist (Metered, Cloudflare, Twilio); paste its address and login here. Player links then carry it, so send the links again after you change it.'),
    el('label', { class: 'field' }, el('span', {}, 'Relay address (TURN), one per line'), urls),
    el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', {}, 'User name'), user), el('label', { class: 'field' }, el('span', {}, 'Password'), pass)),
    el('label', { class: 'check' }, force, 'Always go through the relay (for testing, or if direct routes keep failing)'),
    el('div', { class: 'row' },
      el('button', { class: 'btn small primary', type: 'button', onclick: () => {
        const v = read();
        change(() => { st.relay = v.urls.length ? v : null; });
        startHost();
        toast(v.urls.length ? 'Relay saved. Players reconnect on their own; send new links to anyone who hasn’t opened theirs.' : 'Relay removed', 'ok');
      } }, 'Save'),
      el('button', { class: 'btn small', type: 'button', onclick: async () => { out.textContent = 'Testing…'; const t = await testRelay(read()); out.textContent = t.ok ? `✓ The relay answered in ${t.ms} ms.` : '✗ ' + t.why; } }, 'Test the relay')),
    out);
}

function paneParty() {
  const online = new Set([...(S.host?.clients.values() || [])].map(c => c.info.charId));
  const wrap = el('div', { class: 'stack' }, el('div', { class: 'row' }, el('h3', { class: 'grow' }, 'Party'), el('button', { class: 'btn small', type: 'button', onclick: () => change(c => c.characters.push(newCharacter(c, {}))) }, '+ Character')),
    el('p', { class: 'small muted' }, 'Send each player their own link. Opening it puts them at the table as that character. Drag a character onto the map to place their token.'));
  const fromSheets = (S.sheetList || []).filter(x => x.series === S.camp.theme && !S.camp.characters.some(c => c.name.toLowerCase() === x.name.toLowerCase()));
  if (fromSheets.length) wrap.append(el('div', { class: 'card stack' },
    el('div', { class: 'small' }, `Converted sheets ready for this campaign: ${fromSheets.map(x => x.name).join(', ')}.`),
    el('div', { class: 'row' }, el('button', { class: 'btn small primary', type: 'button', onclick: async () => {
      const sheets = await Promise.all(fromSheets.map(x => fetchSheet(x.file)));
      change(c => { for (const sh of sheets) { const ch = newCharacter(c, { name: sh.name, player: sh.player || '', color: sh.color, hp: sh.hp, ac: sh.ac, speed: sh.speed }); c.characters.push(ch); applySheet(ch, sh); } });
      toast(`Added ${sheets.map(s => s.name).join(', ')}`, 'ok');
    } }, `Add ${fromSheets.length === 1 ? fromSheets[0].name : 'them'} to the party`))));
  for (const ch of S.camp.characters) {
    const link = el('input', { type: 'text', readonly: true, value: playerLink(ch) });
    const av = avatar(ch.name, ch.color, null);
    if (ch.img) assets.url(ch.img).then(u => { if (u) { av.style.background = `url("${u}") center/cover`; av.textContent = ''; } });
    const head = el('div', { class: 'row', draggable: 'true' }, av, el('div', { class: 'grow' }, el('div', { style: { fontFamily: 'var(--display)', fontSize: '20px', lineHeight: 1.1 } }, ch.name), el('div', { class: 'small muted' }, (ch.player || 'No player set'))),
      el('span', { class: 'status' }, el('span', { class: 'dot ' + (online.has(ch.id) ? 'on' : '') }), el('span', { class: 'small muted', title: 'How their connection travels: direct, or through your relay' }, online.has(ch.id) ? routeLabel(ch.id) : 'away')));
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
        el('label', { class: 'field' }, el('span', {}, 'Carries a light (the player can change this too)'), lightSelect(ch.light, l => change(() => { ch.light = l; }))),
        el('label', { class: 'field' }, el('span', {}, 'Dice (the player can change this too)'), skinSelect(ch.dice, v => change(() => { ch.dice = v; }))),
        hpConditionsEditor(data, patch => change(() => Object.assign(ch, patch), { panel: false })),
        el('div', { class: 'row' },
          el('button', { class: 'btn small', type: 'button', onclick: async () => { if (await confirmBox('New link?', `${ch.name}'s old link will stop working. Send ${ch.player || 'the player'} the new one.`, { ok: 'Make new link' })) { S.host.kick(ch.id); change(() => { ch.key = uid(8); }); } } }, 'New link'),
          el('button', { class: 'btn small danger', type: 'button', onclick: async () => { if (await confirmBox('Remove character?', `${ch.name} and their tokens will be removed.`, { ok: 'Remove', danger: true })) change(c => { c.characters = c.characters.filter(x => x.id !== ch.id); for (const s of c.scenes) s.tokens = s.tokens.filter(t => t.charId !== ch.id); }); } }, 'Remove'))));
    wrap.append(el('div', { class: 'card pc stack', style: { borderLeftColor: ch.color } },
      head,
      el('div', { class: 'hpline' }, el('span', { class: 'lbl' }, 'HP'), `${ch.hp.value}/${ch.hp.max}${ch.hp.temp ? ' +' + ch.hp.temp : ''}`, el('span', { class: 'lbl', style: { marginLeft: '8px' } }, 'AC'), String(ch.ac)),
      ch.conditions.length ? conditionChips(ch.conditions) : null,
      sheetControls(ch),
      partyItems(ch),
      el('div', { class: 'linkbox' }, link, el('button', { class: 'btn icon', type: 'button', title: 'Copy link', html: ICONS.copy, onclick: async () => { if (await copyText(link.value)) toast(`Copied ${ch.name}'s link`, 'ok'); } })),
      det));
  }
  return wrap;
}

function partyItems(ch) {
  const items = ch.items || [];
  const box = el('details', { class: 'items-box' }, el('summary', { class: 'small' }, items.length ? `Carrying ${items.length} item${items.length === 1 ? '' : 's'} from play` : 'No items from play yet'));
  const list = el('div', { class: 'stack', style: { marginTop: '6px' } });
  for (const it of items) list.append(el('div', { class: 'track' },
    el('span', {}),
    el('div', { style: { minWidth: 0 } }, el('div', { class: 'nm' }, it.name), el('div', { class: 'kind' }, (it.type || '') + (it.charges ? ` · ${it.charges.left}/${it.charges.max} charges` : ` · ×${it.qty ?? 1}`))),
    el('div', { class: 'row', style: { gap: '4px' } },
      el('button', { class: 'btn icon ghost', type: 'button', title: 'One fewer', onclick: () => change(() => { if (it.charges) it.charges.left = Math.max(0, it.charges.left - 1); else { it.qty = (it.qty ?? 1) - 1; if (it.qty <= 0) ch.items = ch.items.filter(x => x !== it); } }) }, '−'),
      el('button', { class: 'btn icon ghost', type: 'button', title: 'One more', onclick: () => change(() => { if (it.charges) it.charges.left = Math.min(it.charges.max, it.charges.left + 1); else it.qty = (it.qty ?? 1) + 1; }) }, '+'),
      el('button', { class: 'btn icon ghost', type: 'button', title: 'Take it away', html: ICONS.x, onclick: () => change(() => { ch.items = ch.items.filter(x => x !== it); }) }))));
  list.append(el('button', { class: 'btn small', type: 'button', onclick: () => giveItemDialog(ch) }, '+ Give an item…'));
  box.append(list);
  return box;
}

// All the loot the loaded packs know about.
function packItems() { return Object.values(S.camp.packs || {}).flatMap(p => (p.items || []).map(it => ({ ...it, pack: p.id, packTitle: p.title }))); }

function giveItemDialog(ch) {
  const all = packItems();
  const sel = el('select', {}, el('option', { value: '' }, all.length ? 'From your session packs…' : 'No pack items loaded'), all.map((it, i) => el('option', { value: i }, `${it.name} · ${it.packTitle}`)));
  const name = el('input', { type: 'text', placeholder: 'Or name a new item' });
  const text = el('textarea', { rows: 3, placeholder: 'What it does (optional)' });
  const qty = el('input', { type: 'number', min: 1, value: 1 });
  modal({ title: `Give ${ch.name} an item`, body: el('div', { class: 'stack' }, sel, name, text, el('label', { class: 'field' }, el('span', {}, 'How many'), qty)),
    actions: [{ label: 'Cancel' }, { label: 'Give', kind: 'primary', run: () => {
      const n = Math.max(1, Number(qty.value) || 1);
      const it = sel.value !== '' ? all[Number(sel.value)] : name.value.trim() ? { key: 'custom:' + uid(6), name: name.value.trim(), type: 'Loot', text: text.value.trim(), qty: 1 } : null;
      if (!it) { toast('Pick an item or name one', 'bad'); return false; }
      giveItem(it, ch.id, n);
    } }] });
}

function addItem(ch, it, n = 1) {
  ch.items ||= [];
  const ex = it.key && ch.items.find(x => x.key === it.key && x.pack === it.pack);
  if (ex && !ex.charges) { ex.qty = (ex.qty ?? 1) + n; return ex; }
  const copy = { id: uid(8), key: it.key || null, pack: it.pack || null, name: it.name, type: it.type || '', text: it.text || '', qty: it.charges ? 1 : n, auto: it.auto ? clone(it.auto) : null };
  if (it.charges) copy.charges = { max: it.charges, left: it.charges };
  ch.items.push(copy);
  return copy;
}
function giveItem(it, charId, n = 1) {
  const ch = S.camp.characters.find(c => c.id === charId); if (!ch) return;
  change(() => addItem(ch, it, n));
  journal('loot', `${ch.name} got ${it.name}${n > 1 ? ' ×' + n : ''}`, { char: ch.name, item: it.name, qty: n });
  toast(`${ch.name} now carries ${it.name}${n > 1 ? ' ×' + n : ''}`, 'ok');
}
// Hand one of an item (or the whole charged item) to someone else.
function passItem(from, to, it) {
  if (it.charges || (it.qty ?? 1) <= 1) { from.items = from.items.filter(x => x !== it); (to.items ||= []).push(it); return; }
  it.qty -= 1;
  addItem(to, { ...it, charges: null }, 1);
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
  // Sound board
  const pads = boardPads();
  wrap.append(el('div', { class: 'row', style: { marginTop: '4px' } }, el('h4', { class: 'grow', style: { margin: 0 } }, 'Sound board'),
      el('button', { class: 'btn small ghost', type: 'button', title: 'Choose which built-in sounds show', onclick: () => synthPicker() }, 'Built-ins…')),
    el('div', { class: 'sfx-board' }, pads.map((p, i) => el('button', { class: 'pad' + (p.synth ? ' syn' : ''), type: 'button', title: (i < 10 ? `Key ${(i + 1) % 10} · ` : '') + 'Plays for everyone', onclick: () => p.play() }, i < 10 ? el('kbd', {}, String((i + 1) % 10)) : null, p.name))),
    el('p', { class: 'small muted' }, 'Built-in sounds are made on the spot in each browser, so they need no files. Effects you add to the library show here first. Number keys 1–9 and 0 play the first ten.'));
  // Combat music
  const cm = el('select', {}, el('option', { value: '' }, '— none —'), a.library.filter(t => t.kind === 'music').map(t => el('option', { value: t.id, selected: a.combatDefault === t.id }, t.name + (t.asset ? '' : ' (no file yet)'))));
  cm.addEventListener('change', () => change(c => { c.audio.combatDefault = cm.value || null; }));
  wrap.append(el('h4', {}, 'Combat music'),
    el('label', { class: 'check' }, (() => { const x = el('input', { type: 'checkbox', checked: S.camp.settings.combatMusic !== false }); x.addEventListener('change', () => change(c => { c.settings.combatMusic = x.checked; })); return x; })(), 'Switch to combat music when initiative starts, and back when the fight ends'),
    el('label', { class: 'field' }, el('span', {}, 'Default combat music (for scenes without their own)'), cm),
    el('p', { class: 'small muted' }, 'Battle maps from a session pack use their prep’s “Combat loop” track. Set others in each scene’s Scene tab.'));
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
        t.asset ? el('button', { class: 'btn icon', type: 'button', title: kind === 'sfx' ? 'Play for everyone' : 'Play for everyone (crossfades)', html: ICONS.play, onclick: () => playTrack(t) })
          : el('button', { class: 'btn icon', type: 'button', title: 'Attach the audio file for this slot', html: '+', onclick: async () => { const [f] = await pickFiles({ accept: 'audio/*' }); if (f) attachTrack(t, f); } }),
        el('div', { style: { minWidth: 0 } }, el('div', { class: 'nm' }, t.name), el('div', { class: 'kind' }, t.asset ? (t.dur ? fmtDur(t.dur) : '') : 'no file yet' + (t.prompt ? ' · prompt in Prep' : ''))),
        el('div', { class: 'row', style: { gap: '4px' } }, kindSel,
          el('button', { class: 'btn icon ghost', type: 'button', title: 'Remove from library', html: ICONS.x, onclick: () => change(c => { c.audio.library = c.audio.library.filter(x => x.id !== t.id); for (const s of c.scenes) { if (s.music === t.id) s.music = null; if (s.ambience === t.id) s.ambience = null; } }) }))));
    }
  }
  if (!a.library.length) wrap.append(el('p', { class: 'small muted' }, 'Add your Suno tracks and ambience loops here (or drop audio files on the map). Music and ambience loop and crossfade; effects play once.'));
  return wrap;
}
function synthPicker() {
  const hide = new Set(S.camp.audio.hiddenSynths || []);
  const body = el('div', { class: 'stack' }, el('p', { class: 'small muted' }, 'Tick the built-in sounds to show on the board. Try one with ▶ (only you hear it here).'),
    el('div', { class: 'grid2' }, SYNTHS.map(([k, n]) => el('div', { class: 'row', style: { gap: '6px' } },
      el('label', { class: 'check grow' }, (() => { const x = el('input', { type: 'checkbox', checked: !hide.has(k) }); x.addEventListener('change', () => { if (x.checked) hide.delete(k); else hide.add(k); }); return x; })(), n),
      el('button', { class: 'btn icon ghost small', type: 'button', title: 'Preview', html: ICONS.play, onclick: () => S.audio?.synth(k) })))));
  modal({ title: 'Built-in sounds', body, actions: [{ label: 'Done', kind: 'primary', run: () => { change(c => { c.audio.hiddenSynths = [...hide]; }); } }] });
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
      el('button', { class: 'btn primary', type: 'button', onclick: () => { const h = mkHandout(); if (h) { change(c => { c.handout = h; c.handouts.unshift(h); }); if (h.title) journal('handout', h.title); } } }, 'Show to players'),
      el('button', { class: 'btn', type: 'button', onclick: () => { const h = mkHandout(); if (h) { change(c => { c.handouts.unshift(h); }); toast('Saved for later'); } } }, 'Save for later'))));
  function mkHandout() {
    if (!text.value.trim() && !img) { toast('Write something or choose an image', 'bad'); return null; }
    return { id: uid(8), title: title.value.trim(), text: text.value.trim(), style: style.value, img };
  }
  if (S.camp.handouts.length) {
    wrap.append(el('h4', {}, 'Saved'));
    for (const h of S.camp.handouts) wrap.append(el('div', { class: 'track' },
      el('button', { class: 'btn icon', type: 'button', title: 'Show to players', html: ICONS.play, onclick: () => { change(c => { c.handout = { ...h, at: Date.now() }; }); if (h.title) journal('handout', h.title); } }),
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
    el('label', { class: 'check' }, (() => { const x = el('input', { type: 'checkbox', checked: st.reactPrompts !== false }); x.addEventListener('change', () => change(() => { st.reactPrompts = x.checked; })); return x; })(), 'Ask about reactions and rerolls (Shield, Counterspell, Bardic Inspiration, Legendary Resistance…)'),
    el('label', { class: 'field' }, el('span', {}, 'Seconds to answer before the table moves on'), num(st.reactTimeout || 30, v => change(() => { st.reactTimeout = Math.max(5, Math.min(120, v || 30)); }), { min: 5, max: 120 })),
    el('label', { class: 'check' }, (() => { const x = el('input', { type: 'checkbox', checked: !!st.creatureCover }); x.addEventListener('change', () => change(() => { st.creatureCover = x.checked; })); return x; })(), 'Creatures in the way give half cover (walls always count)'),
    el('h4', {}, 'Spectacle'),
    el('label', { class: 'field' }, el('span', {}, 'Your dice'), skinSelect(st.dmDice, v => change(() => { st.dmDice = v; }))),
    el('label', { class: 'check' }, (() => { const x = el('input', { type: 'checkbox', checked: S.dice?.enabled !== false }); x.addEventListener('change', () => S.dice?.setEnabled(x.checked)); return x; })(), '3D dice on this screen'),
    el('label', { class: 'check' }, (() => { const x = el('input', { type: 'checkbox', checked: S.dice?.flourishes !== false }); x.addEventListener('change', () => S.dice?.setFlourishes(x.checked)); return x; })(), 'Natural 20s and 1s get a flourish on this screen'),
    el('label', { class: 'check' }, (() => { const x = el('input', { type: 'checkbox', checked: st.areaFx !== false }); x.addEventListener('change', () => change(() => { st.areaFx = x.checked; })); return x; })(), 'Animate areas (Fireball, Thunderwave, Cloudkill…) for everyone'),
    el('label', { class: 'check' }, (() => { const x = el('input', { type: 'checkbox', checked: st.titleCards !== false }); x.addEventListener('change', () => change(() => { st.titleCards = x.checked; })); return x; })(), 'Show a title card when you move players to a new scene'),
    el('h4', {}, 'Keyboard'),
    el('p', { class: 'small muted' }, 'V select · R ruler · P ping · C sphere · O cone · L line · B cube · F reveal · H hide · W walls · D doors · I lights · T target · N next turn · E who’s here · 1–9, 0 sound board · Delete removes · arrows nudge · Esc clears. Hold on empty map to ping; Shift+ping pulls every player’s view.'),
    el('h4', {}, 'Backups'),
    backupsBox(),
    el('h4', {}, 'Second screen and spectators'),
    screensBox(),
    el('h4', {}, 'Connections'),
    relayBox(),
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
  toast('Packing backup…');
  downloadBlob(await backup.buildZip(c), backup.fileName(c));
  autoBackup('Downloaded', true);
}

async function importBackup() {
  const [f] = await pickFiles({ accept: '.ertatable,.zip' });
  if (!f) return;
  let c;
  try { c = await backup.readZip(f); } catch (e) { console.error(e); toast('That file isn’t an Erta Table backup', 'bad'); return; }
  await restoreCampaign(c, 'the backup');
}

// Put a campaign back (from a file, a snapshot or a folder), keeping a snapshot of what it replaces.
async function restoreCampaign(c, from) {
  const existing = await campaigns.get(c.id);
  if (existing) {
    const when = new Date(c.updated || Date.now()).toLocaleString();
    if (!(await confirmBox('Replace campaign?', `Replace “${existing.name}” with ${from} from ${when}? A snapshot of how it is now is kept, so you can undo this from Settings → Backups.`, { ok: 'Replace', danger: true }))) return false;
    await backup.snapshot(existing, 'Before restore');
  }
  await campaigns.put(c);
  toast(`Restored “${c.name}”`, 'ok');
  if (S.camp) { S.host?.destroy(); S.camp = null; }
  openCampaign(c.id);
  return true;
}

// ---------------------------------------------------------------- automatic backups
// A snapshot in this browser every ten minutes of play (and on open, wrap-up and leaving),
// plus a copy in the backup folder when one is set and allowed.
const AUTO_EVERY = 10 * 60 * 1000;
async function autoBackup(label = '', force = false) {
  const c = S.camp; if (!c || S.backupBusy) return;
  if (!force && c.updated <= (S.lastSnapAt || 0)) return;
  S.backupBusy = true;
  try {
    save.flush();
    await backup.snapshot(c, label);
    S.lastSnapAt = Date.now();
    if (await backup.folderState() === 'granted') { try { await backup.backupToFolder(c, { label }); S.folderAt = Date.now(); S.folderErr = null; } catch (e) { S.folderErr = e.message; } }
  } catch (e) { console.warn('auto backup failed', e); }
  S.backupBusy = false;
  renderBackupChip();
  if (S.tab === 'settings') renderPanel();
}
setInterval(() => { if (S.camp && Date.now() - (S.lastSnapAt || 0) >= AUTO_EVERY) autoBackup(); }, 60 * 1000);
document.addEventListener('visibilitychange', () => { if (document.hidden && S.camp && Date.now() - (S.lastSnapAt || 0) > 60 * 1000) autoBackup(); });

async function renderBackupChip() {
  const b = $('#backup-chip'); if (!b || !S.camp) return;
  const st = await backup.folderState();
  b.hidden = st !== 'prompt';
}

function ago(ts) {
  if (!ts) return 'never';
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 60 * 24 ? `${Math.round(m / 60)} h ago` : new Date(ts).toLocaleDateString();
}

function backupsBox() {
  const box = el('div', { class: 'stack' });
  (async () => {
    const snaps = await backup.listSnapshots(S.camp.id);
    const st = await backup.folderState();
    const h = await backup.folderHandle();
    const last = await kv.get('backup-last:' + S.camp.id);
    box.append(
      el('div', { class: 'row' }, el('button', { class: 'btn', type: 'button', onclick: exportBackup }, 'Download a backup (.ertatable)'), el('button', { class: 'btn', type: 'button', onclick: importBackup }, 'Restore a backup file…')),
      el('div', { class: 'lbl', style: { marginTop: '6px' } }, 'Snapshots in this browser'),
      el('p', { class: 'small muted', style: { margin: 0 } }, `Taken every 10 minutes while you play, when you open the campaign and when you wrap up. The last ${24} are kept, plus named ones.`),
      snaps.length ? el('div', { class: 'snap-list' }, snaps.slice(0, 40).map(x => el('div', { class: 'snap' },
        el('span', { class: 'grow' }, new Date(x.ts).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })),
        x.label ? el('span', { class: 'chip' }, x.label) : null,
        el('span', { class: 'small muted' }, fmtBytes(x.size)),
        el('button', { class: 'btn small', type: 'button', onclick: async () => { const c = await backup.loadSnapshot(S.camp.id, x.ts); if (c) restoreCampaign(c, 'the snapshot'); else toast('That snapshot couldn’t be read', 'bad'); } }, 'Restore')))) : el('p', { class: 'small muted' }, 'None yet.'),
      el('div', { class: 'row' }, el('button', { class: 'btn small', type: 'button', onclick: async () => { await autoBackup('Saved by hand', true); toast('Snapshot taken', 'ok'); } }, 'Take a snapshot now')),
      el('div', { class: 'lbl', style: { marginTop: '6px' } }, 'Backup folder on this computer'),
      st === 'unsupported' ? el('p', { class: 'small muted' }, 'This browser can’t write to a folder. Chrome and Edge can; here, download a backup now and then.')
        : el('div', { class: 'stack', style: { gap: '6px' } },
          el('p', { class: 'small muted', style: { margin: 0 } }, st === 'none' ? 'Pick a folder (one that syncs, like Google Drive or OneDrive, is ideal). Every snapshot also lands there: pictures and tracks once, the campaign as a dated file.'
            : st === 'granted' ? `Saving to “${h?.name}” · last copy ${ago(last)}${S.folderErr ? ' · ' + S.folderErr : ''}.` : `Saving to “${h?.name}” is paused until you allow it again.`),
          el('div', { class: 'row' },
            st === 'prompt' || st === 'denied' ? el('button', { class: 'btn small primary', type: 'button', onclick: async () => { if (await backup.resumeFolder()) { await autoBackup('', true); renderPanel(); } } }, 'Allow and back up now') : null,
            st === 'granted' ? el('button', { class: 'btn small', type: 'button', onclick: async () => { try { const r = await backup.backupToFolder(S.camp); await kv.set('backup-last:' + S.camp.id, Date.now()); toast(`Backed up to “${h.name}/${r.dir}”${r.added ? `, ${r.added} new file${r.added === 1 ? '' : 's'}` : ''}`, 'ok'); renderPanel(); } catch (e) { toast(e.message, 'bad'); } } }, 'Back up now') : null,
            el('button', { class: 'btn small', type: 'button', onclick: async () => { try { await backup.chooseFolder(); await autoBackup('', true); renderPanel(); } catch (e) { if (e.name !== 'AbortError') toast(e.message, 'bad'); } } }, st === 'none' ? 'Choose a folder…' : 'Change folder…'),
            st !== 'none' ? el('button', { class: 'btn small ghost', type: 'button', onclick: async () => { await backup.forgetFolder(); renderPanel(); renderBackupChip(); } }, 'Stop') : null,
            el('button', { class: 'btn small', type: 'button', onclick: () => restoreFromFolder() }, 'Restore from a folder…'))));
  })();
  return box;
}

async function restoreFromFolder() {
  if (!backup.folderSupported()) { toast('This browser can’t read folders. Use a backup file instead.', 'bad'); return; }
  let root;
  try { root = await window.showDirectoryPicker({ id: 'erta-table-backups', mode: 'read' }); } catch { return; }
  const cat = await backup.folderCatalog(root);
  if (!cat.length) { toast('No Erta Table backups in that folder', 'bad'); return; }
  const body = el('div', { class: 'stack' });
  for (const cp of cat) {
    const sel = el('select', {}, cp.files.map(f => el('option', { value: f }, f === 'latest.json' ? 'The latest copy' : f.replace(/\.json$/, ''))));
    body.append(el('div', { class: 'stack', style: { gap: '4px' } }, el('b', {}, cp.name), el('div', { class: 'row' }, sel,
      el('button', { class: 'btn small primary', type: 'button', onclick: async () => {
        try { const r = await backup.readFolderBackup(cp.dir, sel.value); m.close(); if (r.missing) toast(`${r.missing} picture${r.missing === 1 ? ' is' : 's are'} missing from the folder`, 'bad'); await restoreCampaign(r.camp, 'the folder backup'); }
        catch (e) { toast(e.message, 'bad'); }
      } }, 'Restore'))));
  }
  const m = modal({ title: 'Restore from a folder', body, actions: [{ label: 'Close' }] });
}

// ======================================================================= boot

async function boot() {
  const m = location.hash.match(/c=([\w]+)/);
  if (m && (await campaigns.get(m[1]))) openCampaign(m[1]);
  else renderHome();
}
boot();


// ======================================================================= rules engine glue

function makeEngine() {
  S.engine = new Engine({
    camp: () => S.camp,
    scene: () => S.engScene || activeScene() || scene(),
    roll: async (formula, { label, by, hidden } = {}) => engineRoll(formula, label, by, hidden),
    card: cd => postCard(cd),
    save: () => change(() => {}, { panel: ['tokens', 'party', 'combat'].includes(S.tab) }),
    askSave: (charId, req) => sendToChar(charId, { t: 'save-req', ...req }),
    waiting: (id, name, label) => { S.pending.set(id, { name, label }); renderPending(); },
    onlineChars: () => new Set([...(S.host?.clients.values() || [])].map(c => c.info.charId)),
    summon: (A, key) => summon(A, key),
    ask: (charId, q) => askChoice(charId, q),
    event: (type, text, data) => journal(type, text, data),
    fx: (tpl, kind) => areaFx(tpl, kind),
  });
  // resolving a pending save also clears the prompt
  const orig = S.engine.resolvePendingSave.bind(S.engine);
  S.engine.resolvePendingSave = async id => {
    const p = S.engine.pending.get(id);
    if (!p) return;
    S.pending.delete(id); renderPending();
    if (p.T.kind === 'pc') sendToChar(p.T.char.id, { t: 'save-done', id });
    return orig(id);
  };
  fetch('data/srd-spells-2024.json').then(r => r.json()).then(d => { S.engine.spells = d; }).catch(() => {});
}

function engineRoll(formula, label, by, hidden = false) {
  const r = rollDice(formula, { label, hidden: !!hidden, by: by || { name: 'DM', color: DM_COLOR } });
  recordRoll(r);
  if (!hidden) S.host?.broadcast({ t: 'roll', roll: r });
  showRoll(r);
  return r;
}

function publicCard(x) {
  if (x.kind !== 'card') return x;
  const { undo, ...rest } = x;
  return rest;
}

function postCard(cd) {
  cd.kind = 'card';
  recordRoll(cd);
  S.host?.broadcast({ t: 'card', card: publicCard(cd) });
  S.log?.add(cd);
}

function undoCard(cd) {
  const real = S.camp.rolls.find(x => x.id === cd.id) || cd;
  S.engine.undo(real);
  S.log.add(real);
  S.host?.broadcast({ t: 'card', card: publicCard(real) });
  change(() => {});
  toast('Undone', 'ok');
}

function sendToChar(charId, msg) {
  for (const [pid, c] of S.host?.clients || []) if (c.info.charId === charId) S.host.send(pid, msg);
}

function renderPending() {
  const box = $('#pending'); if (!box) return;
  box.innerHTML = '';
  box.hidden = !S.pending.size && !S.asks.size;
  for (const [id, p] of S.pending) box.append(el('div', { class: 'pend' }, el('span', { class: 'grow' }, `Waiting on ${p.name}: ${p.label}`),
    el('button', { class: 'btn small', type: 'button', onclick: () => S.engine.resolvePendingSave(id) }, 'Roll for them')));
  const online = new Set([...(S.host?.clients.values() || [])].map(c => c.info.charId));
  for (const a of S.asks.values()) box.append(el('div', { class: 'pend ask' },
    el('div', { class: 'grow' }, el('b', {}, a.charId ? `${a.name}${online.has(a.charId) ? ' (asked)' : ' (not connected: you decide)'}` : 'Your call'), el('div', { class: 'small' }, a.title), a.detail ? el('div', { class: 'small muted' }, a.detail) : null),
    el('div', { class: 'row', style: { gap: '4px' } }, ...a.options.map(o => el('button', { class: 'btn small primary', type: 'button', onclick: () => a.done(o.id) }, o.label)),
      el('button', { class: 'btn small', type: 'button', onclick: () => a.done(null) }, 'No'))));
}

// The rules engine needs a decision: a reaction, a reroll, Legendary Resistance.
// Online players get the question on their screen; the DM sees it too and can answer.
function askChoice(charId, q) {
  return new Promise(res => {
    const id = uid(8);
    const secs = Math.max(5, Number(S.camp.settings.reactTimeout) || 30);
    let timer = null;
    const done = v => {
      if (!S.asks.has(id)) return;
      clearTimeout(timer); S.asks.delete(id); renderPending();
      if (charId) sendToChar(charId, { t: 'ask-done', id });
      res(v);
    };
    timer = setTimeout(() => done(null), secs * 1000);
    const ch = charId && S.camp.characters.find(c => c.id === charId);
    S.asks.set(id, { id, charId, name: ch?.name || 'DM', title: q.title, detail: q.detail || '', options: q.options || [], done });
    if (charId) sendToChar(charId, { t: 'ask', id, title: q.title, detail: q.detail || '', options: q.options || [], secs });
    $('#dock')?.classList.remove('closed');
    renderPending();
  });
}

// ---- targets
function targetMap() {
  const m = {};
  for (const [who, ids] of Object.entries(S.targets)) {
    const color = who === 'dm' ? DM_COLOR : S.camp.characters.find(c => c.id === who)?.color || '#888';
    for (const id of ids) (m[id] ||= []).push(color);
  }
  return m;
}
function pushTargets() {
  const m = targetMap();
  S.view?.setTargets(new Map(Object.entries(m)));
  S.host?.broadcast({ t: 'targets', map: m });
  S.sheetWin?.render();
}
function toggleTarget(who, tokenId, add) {
  const cur = new Set(S.targets[who] || []);
  if (!tokenId) { if (cur.size) { S.targets[who] = []; pushTargets(); } return; }
  if (cur.has(tokenId)) cur.delete(tokenId); else cur.add(tokenId);
  S.targets[who] = [...cur];
  pushTargets();
}
function validTargets(ids, sc) { return (ids || []).filter(id => sc?.tokens.some(t => t.id === id)); }

// ---- sheets
async function sheetIndex() {
  if (!S.sheetIdx) S.sheetIdx = fetch('data/sheets/index.json').then(r => r.json()).catch(() => []);
  return S.sheetIdx;
}
async function fetchSheet(file) { return (await fetch('data/sheets/' + file)).json(); }

function applySheet(ch, sheet) {
  ch.sheet = sheet;
  ch.ac = sheet.ac; ch.speed = sheet.speed; ch.size = sheet.size || 1;
  ch.init = sheetNumbers(sheet).init;
  const same = ch.hp.max === sheet.hp;
  ch.hp = { value: same ? ch.hp.value : sheet.hp, max: sheet.hp, temp: ch.hp.temp || 0 };
  ch.state ||= {}; ch.effects ||= [];
  for (const x of S.camp.combat?.list || []) if (x.charId === ch.id) x.bonus = ch.init;
}

async function autoAttachSheets() {
  const idx = await sheetIndex();
  S.sheetList = idx;
  if (S.tab === 'party') renderPanel(true);
  const todo = S.camp.characters.filter(ch => !ch.sheet && !ch.sheetDeclined).map(ch => [ch, idx.find(x => x.series === S.camp.theme && x.name.toLowerCase() === ch.name.toLowerCase())]).filter(([, x]) => x);
  if (!todo.length) return;
  const sheets = await Promise.all(todo.map(([, x]) => fetchSheet(x.file)));
  change(() => todo.forEach(([ch], i) => applySheet(ch, sheets[i])));
  toast(`Character sheets ready for ${todo.map(([ch]) => ch.name).join(', ')}`, 'ok');
}

function sheetControls(ch) {
  const row = el('div', { class: 'row' });
  if (ch.sheet) {
    const n = sheetNumbers(ch.sheet);
    row.append(el('button', { class: 'btn small primary', type: 'button', onclick: () => openSheet(ch.id) }, 'Open sheet'),
      el('span', { class: 'small muted grow' }, `${ch.sheet.classes.map(c => c.name + ' ' + c.level).join(' / ')}${n.spellDC ? ' · DC ' + n.spellDC : ''}`),
      el('button', { class: 'btn small ghost', type: 'button', title: 'Load a different sheet', onclick: () => loadSheetDialog(ch) }, 'Change'));
  } else row.append(el('button', { class: 'btn small', type: 'button', onclick: () => loadSheetDialog(ch) }, 'Add character sheet…'));
  return row;
}

async function loadSheetDialog(ch) {
  const idx = await sheetIndex();
  const sel = el('select', {}, el('option', { value: '' }, 'Choose…'), idx.map(x => el('option', { value: x.file, selected: x.name === ch.name }, `${x.name} (${x.summary})`)));
  let fromFile = null;
  const fl = el('span', { class: 'small muted' }, '');
  modal({ title: `Character sheet for ${ch.name}`, body: el('div', { class: 'stack' },
    el('p', { class: 'small muted' }, 'Sheets converted from your players’ PDFs live with the table. Loading one sets AC, HP, speed and initiative, and gives the player a full sheet with automated attacks and spells.'),
    el('label', { class: 'field' }, el('span', {}, 'Converted sheets'), sel),
    el('div', { class: 'row' }, el('button', { class: 'btn small', type: 'button', onclick: async () => { const [f] = await pickFiles({ accept: '.json,application/json' }); if (f) { try { fromFile = JSON.parse(await f.text()); fl.textContent = f.name; } catch { toast('That isn’t a sheet file', 'bad'); } } } }, 'Or load a sheet file…'), fl),
    ch.sheet ? el('button', { class: 'btn small danger', type: 'button', onclick: () => { change(() => { ch.sheet = null; ch.sheetDeclined = true; }); closeModals(); } }, 'Remove the sheet') : null),
  actions: [{ label: 'Cancel' }, { label: 'Load', kind: 'primary', run: async () => {
    const sh = fromFile || (sel.value ? await fetchSheet(sel.value) : null);
    if (!sh?.abilities) { toast('Pick a sheet first', 'bad'); return false; }
    change(() => applySheet(ch, sh));
    toast(`${ch.name}: sheet loaded`, 'ok');
  } }] });
}
function closeModals() { document.querySelectorAll('.modal-back').forEach(b => b.remove()); }

function pcView(ch) {
  return { ch: { ...ch, acShown: actorAc(ch) }, sheet: ch.sheet, state: ch.state, effects: ch.effects, concentration: ch.concentration, items: ch.items || [], reactUsed: !!(S.camp.combat && ch.reactUsed) };
}
function actorAc(ch) { let ac = ch.ac; for (const e of ch.effects || []) ac += Number(e.mods?.acBonus) || 0; return ac; }

function pcToken(charId, sc = activeScene()) { return sc?.tokens.find(t => t.charId === charId) || scene()?.tokens.find(t => t.charId === charId) || null; }

function openSheet(charId) {
  const ch = S.camp.characters.find(c => c.id === charId);
  if (!ch?.sheet) return;
  S.sheetWin.open(() => { const c = S.camp.characters.find(x => x.id === charId); return c?.sheet ? pcView(c) : null; }, {
    key: charId, isDM: true,
    targets: () => S.targets.dm || [],
    use: (entry, req) => { if (!(S.targets.dm || []).length && needsTarget(entry, req.opts?.activity || 0)) { toast('Target a creature first: hover its token and press T', 'bad'); return; } clientUse(entry, req, r => runUse(charId, r, S.targets.dm), DM_COLOR); },
    check: (kind, key, mode) => runCheck(charId, kind, key, mode),
    rest: kind => runRest(charId, kind),
    deathSave: () => runDeath(charId),
    endConc: () => runEndConc(charId),
    endEffect: id => runEndEffect(charId, id),
    setState: patch => change(() => mergeState(ch, patch)),
    party: () => S.camp.characters.map(c => ({ id: c.id, name: c.name })),
    giveItem: (itemId, to) => { const it = ch.items?.find(x => x.id === itemId), dest = S.camp.characters.find(c => c.id === to); if (it && dest) { change(() => passItem(ch, dest, it)); journal('loot', `${ch.name} gave ${it.name} to ${dest.name}`); } },
    dropItem: itemId => change(() => { ch.items = (ch.items || []).filter(x => x.id !== itemId); }),
  });
}

// Area spells: place the template first, then resolve.
function clientUse(entry, req, send, color) {
  const area = entry.area || (Array.isArray(entry.auto) ? entry.auto[req.opts?.activity || 0]?.area : entry.auto?.area);
  const shape = AREA_SHAPE(area);
  if (shape && area.size) {
    setTool('tpl:' + shape);
    S.view.myColor = color;
    S.sheetWin.stepAside(true);
    S.view.placeArea({ shape, len: Number(area.size) || 5 }, tpl => { S.sheetWin.stepAside(false); if (tpl) send({ ...req, template: tpl }); else toast('Cancelled'); });
    toast(`Place the ${area.size}-ft ${shape}: click, or drag to aim. Esc cancels.`);
    return;
  }
  send(req);
}

async function runUse(charId, req, targets) {
  const sc = activeScene()?.tokens.some(t => t.charId === charId) ? activeScene() : scene();
  const t = sc?.tokens.find(t => t.charId === charId);
  if (!t) { toast('Put that character’s token on the map first', 'bad'); return false; }
  S.engScene = sc;
  let templateId = null;
  if (req.template) { templateId = uid(8); sc.templates.push({ ...sanitizeTpl(req.template), id: templateId, owner: charId, color: S.camp.characters.find(c => c.id === charId)?.color || DM_COLOR }); }
  await S.engine.use(t, { ...req, templateId, targets: validTargets(targets, sc) });
  return true;
}

async function npcUse(sc, t, entry, i, spellId) {
  const sp = spellId ? S.engine.spells?.[spellId] : null;
  const subject = sp || { auto: entry.auto };
  const req = sp ? { src: 'npc-spell', id: spellId, opts: { activity: 0 } } : { src: 'npc', id: entry.name, opts: { activity: i } };
  const run = async r => {
    S.engScene = sc;
    let templateId = null;
    if (r.template) { templateId = uid(8); change(() => sc.templates.push({ ...sanitizeTpl(r.template), id: templateId, owner: 'dm', color: DM_COLOR }), { panel: false }); }
    await S.engine.use(t, { ...req, targets: validTargets(S.targets.dm, sc), template: r.template, templateId });
  };
  if (!(S.targets.dm || []).length && needsTarget(subject, sp ? 0 : i)) { toast('Target someone first: hover their token and press T', 'bad'); return; }
  clientUse(subject, req, run, DM_COLOR);
}

async function runCheck(charId, kind, key, mode) {
  const ch = S.camp.characters.find(c => c.id === charId); if (!ch?.sheet) return;
  const sc = activeScene() || scene(); S.engScene = sc;
  const A = actorFor(S.camp, sc, pcToken(charId, sc) || { charId, x: -99, y: -99 });
  const r = await S.engine.rollCheck(A, kind, key, mode);
  if (kind === 'init' && S.camp.combat) {
    const e = S.camp.combat.list.find(x => x.charId === charId);
    if (e) change(() => { e.init = r.total; sortCombat(S.camp.combat); if (S.camp.combat.list.every(x => x.init != null)) S.camp.combat.askInit = false; }, { panel: S.tab === 'combat' });
  }
}
async function runDeath(charId) { const sc = activeScene() || scene(); S.engScene = sc; const A = actorFor(S.camp, sc, pcToken(charId, sc) || { charId }); await S.engine.deathSave(A); }
function runRest(charId, kind) {
  const ch = S.camp.characters.find(c => c.id === charId); if (!ch) return;
  let got;
  change(() => { got = S.engine.rest(ch, kind); });
  journal('rest', `${ch.name} took a ${kind} rest`, { char: ch.name, kind });
  postCard({ id: uid(10), ts: Date.now(), by: { name: ch.name, color: ch.color, charId }, title: `${ch.name}: ${kind === 'long' ? 'Long' : 'Short'} rest`, lines: [{ t: got.length ? 'Recovered: ' + got.join(', ') : 'Nothing to recover' }, ...(kind === 'long' ? [{ t: 'HP restored to full', c: 'heal' }] : [{ t: 'Spend Hit Dice from the dice tray and add the HP in the party panel.', c: 'muted' }])], undo: [] });
}
function runEndConc(charId) {
  const sc = activeScene() || scene(); S.engScene = sc;
  const A = actorFor(S.camp, sc, pcToken(charId, sc) || { charId });
  const card = { id: uid(10), ts: Date.now(), by: { name: A.name, color: A.color, charId }, title: `${A.name}: ends concentration`, lines: [], undo: [] };
  S.engine.endConcentration(A, card);
  postCard(card);
  change(() => {});
}
function runEndEffect(charId, effId) {
  const sc = activeScene() || scene(); S.engScene = sc;
  const A = actorFor(S.camp, sc, pcToken(charId, sc) || { charId });
  const e = A?.effects.find(x => x.id === effId); if (!e) return;
  change(() => S.engine.removeEffect(A, effId));
  postCard({ id: uid(10), ts: Date.now(), by: { name: A.name, color: A.color, charId }, title: `${A.name}: ${e.name} ends`, lines: [], undo: [] });
}
function mergeState(ch, p) {
  const sh = ch.sheet; if (!sh) return;
  const st = (ch.state ||= {});
  if (p.used && typeof p.used === 'object') { st.used ||= {}; for (const [k, v] of Object.entries(p.used)) { const r = sh.resources.find(x => x.id === k); if (r) st.used[k] = clampInt(v, 0, r.max); } }
  if (p.slots && typeof p.slots === 'object') { st.slots ||= {}; for (const [k, v] of Object.entries(p.slots)) { const max = sh.spellcasting?.slots?.[Number(k) - 1]; if (max != null) st.slots[k] = clampInt(v, 0, max); } }
  if (p.pact != null && sh.spellcasting?.pact) st.pact = clampInt(p.pact, 0, sh.spellcasting.pact.max);
  if (p.prep && typeof p.prep === 'object') { st.prep ||= {}; for (const [k, v] of Object.entries(p.prep)) if (sh.spells.some(x => x.id === k)) st.prep[k] = !!v; }
}

function summon(A, key) {
  const spec = A.sheet?.summons?.[key]; if (!spec) return;
  const sc = S.engScene || activeScene(); if (!sc || !A.token) return;
  const actorId = `sum:${A.char.id}:${key}`;
  S.camp.actors[actorId] = spec;
  sc.tokens = sc.tokens.filter(t => t.actorId !== actorId);
  const tok = newToken({ name: spec.name, actorId, hp: { value: spec.hp.max, max: spec.hp.max, temp: 0 }, ac: spec.ac, size: Math.max(1, Math.round(spec.squares || 1)), disposition: 'friendly', x: A.token.x + (A.token.size || 1), y: A.token.y });
  tok.owner = A.char.id; tok.color = A.char.color; tok.img = artFor(S.camp, actorId);
  sc.tokens.push(tok);
  const c = S.camp.combat;
  if (c && c.sceneId === sc.id) { const i = c.list.findIndex(x => x.charId === A.char.id); const cb = tokenCombatant(sc, tok); cb.init = c.list[i]?.init ?? null; c.list.splice(i + 1, 0, cb); }
}

function onRulesMessage(pid, m, info) {
  const c = S.camp, sc = activeScene();
  const ch = c.characters.find(x => x.id === info.charId);
  if (!ch) return;
  switch (m.t) {
    case 'targets': {
      S.targets[ch.id] = validTargets(Array.isArray(m.ids) ? m.ids.slice(0, 20).map(String) : [], sc);
      pushTargets(); return;
    }
    case 'use': {
      if (!ch.sheet || c.paused) return;
      const q = m.req || {};
      const req = { src: ['spell', 'item'].includes(q.src) ? q.src : 'action', id: String(q.id || ''), slot: clampInt(q.slot, 0, 9), pact: !!q.pact, opts: typeof q.opts === 'object' && q.opts ? q.opts : {}, template: q.template ? sanitizeTpl(q.template) : null };
      runUse(ch.id, req, Array.isArray(q.targets) ? q.targets.map(String) : S.targets[ch.id]).then(ok => { if (!ok) S.host.send(pid, { t: 'notice', text: 'Your token isn’t on the map yet, so the DM has to place it first.' }); });
      return;
    }
    case 'check': if (ch.sheet) runCheck(ch.id, ['save', 'ability', 'skill', 'init'].includes(m.kind) ? m.kind : 'ability', m.key ? String(m.key) : null, m.mode === 'adv' || m.mode === 'dis' ? m.mode : null); return;
    case 'death': runDeath(ch.id); return;
    case 'rest': runRest(ch.id, m.kind === 'long' ? 'long' : 'short'); return;
    case 'end-conc': runEndConc(ch.id); return;
    case 'end-effect': runEndEffect(ch.id, String(m.id || '')); return;
    case 'sheet-state': change(() => mergeState(ch, m.patch || {}), { panel: false }); return;
    case 'save-roll': {
      const p = S.engine.pending.get(m.id);
      if (p && p.T.kind === 'pc' && p.T.char.id === ch.id) S.engine.resolvePendingSave(m.id);
      return;
    }
  }
}

function openWrapUp() {
  save.flush();
  wrapUpDialog({
    camp: S.camp,
    onSave: entry => { change(c => { (c.wrapups ||= []).push(entry); }); toast('Saved with the campaign', 'ok'); autoBackup('Wrap-up', true); },
    onNewSession: () => { change(c => { c.journalArchive = [...(c.journalArchive || []), ...(c.journal || [])].slice(-6000); c.journal = []; startSession(c); }); toast('A fresh session starts now', 'ok'); },
    download: (blob, name) => downloadBlob(blob, name),
    copy: async t => { if (await copyText(t)) toast('Copied the write-up', 'ok'); },
  });
}

function kitCtx() { return { camp: S.camp, change: (fn, o) => change(fn, o), setBackground, renderPanel }; }
