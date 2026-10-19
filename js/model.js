// Campaign data model: factories, rules helpers and the player-facing filter.
import { uid, clone } from './util.js';
import { combatView } from './combat.js';
import { COND_BY_ID, condId } from './conditions.js';
import { parseSenses, seesToken, visionOn, tokenCentre } from './vision.js';

export const THEMES = { ironclad: 'Ironclad Inquiries', erta: 'Erta' };
export const DISPOSITION_COLORS = { hostile: '#c8553d', neutral: '#d6a73c', friendly: '#4f9d69' };
export const PLAYER_COLORS = ['#B0421D', '#5A4A8C', '#8A5F0A', '#1C6A51', '#2A4865', '#94472A', '#6b3d6e', '#3c6e71'];

export function newCampaign({ name, theme = 'erta' }) {
  return {
    id: uid(12),
    hostId: uid(14),
    name, theme,
    created: Date.now(), updated: Date.now(),
    characters: [],
    scenes: [],
    activeSceneId: null,
    audio: { library: [], music: null, ambience: null },
    handout: null,
    paused: false,
    settings: { diagonals: 'equal', monsterHealth: 'bloodied' },
  };
}

export function newCharacter(c, o = {}) {
  const color = o.color || PLAYER_COLORS[c.characters.length % PLAYER_COLORS.length];
  return {
    id: uid(10), key: uid(8),
    name: o.name || 'New character', player: o.player || '',
    color, img: o.img || null,
    hp: { value: o.hp ?? 10, max: o.hp ?? 10, temp: 0 },
    ac: o.ac ?? 10, speed: o.speed || '30 ft', size: o.size || 1, init: o.init ?? 0,
    conditions: [], notes: o.notes || '',
  };
}

export function newScene(o = {}) {
  return {
    id: uid(10),
    name: o.name || 'New scene',
    kind: o.kind || 'map', // 'map' (grid, tokens, fog) or 'art' (a picture to set the scene)
    bg: o.bg || null, width: o.width || 3000, height: o.height || 2000,
    grid: { size: 100, ox: 0, oy: 0, show: true, color: '#000000', opacity: 0.28, feet: 5, ...(o.grid || {}) },
    fog: { on: o.kind === 'art' ? false : true, ops: [] },
    tokens: [], templates: [],
    music: o.music || null, ambience: o.ambience || null,
    notes: o.notes || '',
    packRef: o.packRef || null,
  };
}

export function newToken(o = {}) {
  return {
    id: uid(10),
    name: o.name || 'Token',
    x: o.x ?? 0, y: o.y ?? 0, size: o.size || 1,
    img: o.img || null, color: o.color || null,
    kind: o.charId ? 'pc' : 'npc', charId: o.charId || null,
    hp: o.hp ? { ...o.hp } : { value: 10, max: 10, temp: 0 },
    ac: o.ac ?? 10, init: o.init ?? 0, actorId: o.actorId || null,
    conditions: o.conditions ? [...o.conditions] : [],
    disposition: o.disposition || (o.charId ? 'friendly' : 'hostile'),
    hidden: !!o.hidden,
  };
}

// --- grid distance (2024: every square, diagonal included, costs 5 ft by default)

export function cellDistance(dx, dy, mode = 'equal') {
  dx = Math.abs(dx); dy = Math.abs(dy);
  const lo = Math.min(dx, dy), hi = Math.max(dx, dy);
  if (mode === 'alternate') return hi + Math.floor(lo / 2);
  if (mode === 'euclid') return Math.hypot(dx, dy);
  return hi;
}

// --- token helpers that work for PCs (data on the character) and NPCs

export function tokenStats(c, t) {
  if (t.charId) {
    const ch = c.characters.find(x => x.id === t.charId);
    if (ch) return { name: ch.name, hp: ch.hp, ac: acWith(ch.ac, ch.effects), conditions: ch.conditions, icons: iconsFor(ch.conditions, ch.effects), color: ch.color, img: ch.img || t.img, size: ch.size || t.size };
  }
  return { name: t.name, hp: t.hp, ac: acWith(t.ac, t.effects), conditions: t.conditions, icons: iconsFor(t.conditions, t.effects), color: t.color, img: t.img, size: t.size };
}

export function acWith(ac, effects) { let v = ac; for (const e of effects || []) v += Number(e.mods?.acBonus) || 0; return v; }

// Conditions plus a marker for each active effect (Bless, Hunter's Mark, ...), for drawing on tokens.
export function iconsFor(conds = [], effects = []) {
  const out = [...(conds || [])];
  const ids = new Set(out.map(condId));
  for (const e of effects || []) {
    const id = COND_BY_ID[e.icon] ? e.icon : 'marked';
    if (!ids.has(id)) { ids.add(id); out.push(id); }
  }
  return out;
}

// What a token can see with: senses from the sheet or stat block, plus effects (Lamp-Eye Drops,
// Stonecunning's tremorsense while it lasts).
export function tokenSight(c, t) {
  const ch = t.charId && c.characters.find(x => x.id === t.charId);
  const effects = (ch ? ch.effects : t.effects) || [];
  const text = ch ? (ch.sheet?.senses || ch.senses || '') : (c.actors?.[t.actorId]?.senses || t.senses || '');
  const s = parseSenses(text);
  for (const e of effects) {
    const m = e.mods || {};
    if (m.darkvision) s.dv = s.dv ? s.dv + (Number(m.darkvisionBonus) || 0) : Math.max(s.dv, Number(m.darkvision));
    if (s.tremorIf && /tremorsense/i.test(e.name || '')) s.tremor = s.tremorIf;
  }
  return s;
}
export function tokenLight(c, t) {
  const ch = t.charId && c.characters.find(x => x.id === t.charId);
  const l = ch ? ch.light : t.light;
  return l && (Number(l.bright) || Number(l.dim)) ? { bright: Number(l.bright) || 0, dim: Number(l.dim) || 0, kind: l.kind || null } : null;
}
// Every light on the scene: placed lights plus whatever tokens carry.
export function sceneLights(c, scene, { skip = null } = {}) {
  const out = (scene.lights || []).map(l => ({ x: l.x, y: l.y, bright: l.bright, dim: l.dim }));
  for (const t of scene.tokens) {
    if (t.hidden || skip?.(t)) continue;
    const l = tokenLight(c, t); if (!l) continue;
    const p = tokenCentre(scene, t); out.push({ ...l, x: p.x, y: p.y });
  }
  return out;
}
const isInvisible = (c, t) => {
  const ch = t.charId && c.characters.find(x => x.id === t.charId);
  return ((ch ? ch.conditions : t.conditions) || []).some(v => condId(v) === 'invisible');
};
// Can any of the viewer tokens see token t?
export function visibleToAny(c, scene, viewers, t, lights = sceneLights(c, scene)) {
  if (!viewers.length) return false;
  const inv = isInvisible(c, t);
  return viewers.some(v => v.id === t.id || seesToken(scene, lights, v, tokenSight(c, v), t, { invisible: inv }));
}

export function isBloodied(hp) { return hp && hp.max > 0 && hp.value > 0 && hp.value <= hp.max / 2; }

// --- what a player is allowed to see

// fogged(x, y) answers whether a scene-pixel point is under fog (DM-computed).
export function playerView(c, charId, scene, fogged) {
  const me = c.characters.find(x => x.id === charId);
  const party = c.characters.map(ch => ({
    id: ch.id, name: ch.name, player: ch.player, color: ch.color, img: ch.img,
    hp: ch.hp, ac: acWith(ch.ac, ch.effects), conditions: ch.conditions, speed: ch.speed, hasSheet: !!ch.sheet,
  }));
  let s = null;
  if (scene) {
    const g = scene.grid.size;
    const tokens = [];
    const vis = visionOn(scene);
    // a spectator (no character) sees what the whole party sees
    const mine = t => charId ? ((t.charId && t.charId === charId) || (t.owner && t.owner === charId)) : !!t.charId;
    let viewers = vis ? scene.tokens.filter(t => mine(t) && !t.hidden) : [];
    if (vis && !viewers.length) viewers = scene.tokens.filter(t => t.charId);
    const lights = vis ? sceneLights(c, scene) : [];
    const unseenLights = [];
    for (const t of scene.tokens) {
      if (t.hidden) continue;
      const st = tokenStats(c, t);
      const size = st.size || 1;
      if (!t.charId && scene.fog.on && fogged && fogged(scene.grid.ox + (t.x + size / 2) * g, scene.grid.oy + (t.y + size / 2) * g)) continue;
      if (vis && !t.charId && !mine(t) && !visibleToAny(c, scene, viewers, { ...t, size }, lights)) {
        const l = tokenLight(c, t); if (l) { const p = tokenCentre(scene, t); unseenLights.push({ ...l, x: p.x, y: p.y }); }
        continue;
      }
      const pub = { id: t.id, name: st.name, x: t.x, y: t.y, size, img: st.img, color: st.color, kind: t.kind, charId: t.charId, owner: t.owner || null, disposition: t.disposition, conditions: st.icons };
      const light = tokenLight(c, t); if (light) pub.light = light;
      if (vis && mine(t)) pub.sight = tokenSight(c, t);
      if (t.charId) { pub.hp = st.hp; pub.ac = st.ac; }
      else if (c.settings.monsterHealth === 'full') pub.hp = st.hp;
      else if (c.settings.monsterHealth === 'bloodied') pub.health = st.hp.value <= 0 ? 'down' : isBloodied(st.hp) ? 'bloodied' : 'ok';
      tokens.push(pub);
    }
    s = {
      id: scene.id, name: scene.name, kind: scene.kind, bg: scene.bg, width: scene.width, height: scene.height,
      grid: clone(scene.grid), fog: { on: scene.fog.on, ops: scene.fog.ops }, tokens, templates: scene.templates,
      // secret doors look like plain wall to players
      walls: (scene.walls || []).map(w => (w.secret ? { id: w.id, x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 } : w)),
      lights: scene.lights || [], vision: scene.vision || { on: false, light: 'bright' }, unseenLights,
    };
  }
  return {
    campaign: { name: c.name, theme: c.theme },
    you: me ? { charId: me.id, name: me.name, color: me.color, sheet: me.sheet || null, state: me.state || {}, effects: (me.effects || []).map(e => ({ id: e.id, name: e.name, rounds: e.rounds, origin: e.origin?.name, conc: !!e.conc })), concentration: me.concentration || null, items: me.items || [], light: me.light || null, reactUsed: !!me.reactUsed, dice: me.dice || null } : null,
    party, scene: s,
    audio: { music: c.audio.music, ambience: c.audio.ambience },
    handout: c.handout, paused: c.paused,
    combat: combatView(c.combat, charId),
    clocks: (c.clocks || []).filter(k => k.visible && (!c.activePack || k.pack === c.activePack)).map(k => ({ name: k.name, size: k.size, value: k.value })),
    settings: { diagonals: c.settings.diagonals },
  };
}

// Every asset id a player view needs (to pre-download).
export function viewAssets(v) {
  const ids = new Set();
  if (v.scene?.bg) ids.add(v.scene.bg);
  for (const t of v.scene?.tokens || []) if (t.img) ids.add(t.img);
  for (const p of v.party) if (p.img) ids.add(p.img);
  if (v.audio.music?.asset) ids.add(v.audio.music.asset);
  if (v.audio.ambience?.asset) ids.add(v.audio.ambience.asset);
  if (v.handout?.img) ids.add(v.handout.img);
  return [...ids];
}
