// Campaign data model: factories, rules helpers and the player-facing filter.
import { uid, clone } from './util.js';

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
    ac: o.ac ?? 10, speed: o.speed || '30 ft', size: o.size || 1,
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
    ac: o.ac ?? 10,
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
    if (ch) return { name: ch.name, hp: ch.hp, ac: ch.ac, conditions: ch.conditions, color: ch.color, img: ch.img || t.img, size: ch.size || t.size };
  }
  return { name: t.name, hp: t.hp, ac: t.ac, conditions: t.conditions, color: t.color, img: t.img, size: t.size };
}

export function isBloodied(hp) { return hp && hp.max > 0 && hp.value > 0 && hp.value <= hp.max / 2; }

// --- what a player is allowed to see

// fogged(x, y) answers whether a scene-pixel point is under fog (DM-computed).
export function playerView(c, charId, scene, fogged) {
  const me = c.characters.find(x => x.id === charId);
  const party = c.characters.map(ch => ({
    id: ch.id, name: ch.name, player: ch.player, color: ch.color, img: ch.img,
    hp: ch.hp, ac: ch.ac, conditions: ch.conditions, speed: ch.speed,
  }));
  let s = null;
  if (scene) {
    const g = scene.grid.size;
    const tokens = [];
    for (const t of scene.tokens) {
      if (t.hidden) continue;
      const st = tokenStats(c, t);
      const size = st.size || 1;
      if (!t.charId && scene.fog.on && fogged && fogged(scene.grid.ox + (t.x + size / 2) * g, scene.grid.oy + (t.y + size / 2) * g)) continue;
      const pub = { id: t.id, name: st.name, x: t.x, y: t.y, size, img: st.img, color: st.color, kind: t.kind, charId: t.charId, disposition: t.disposition, conditions: st.conditions };
      if (t.charId) { pub.hp = st.hp; pub.ac = st.ac; }
      else if (c.settings.monsterHealth === 'full') pub.hp = st.hp;
      else if (c.settings.monsterHealth === 'bloodied') pub.health = st.hp.value <= 0 ? 'down' : isBloodied(st.hp) ? 'bloodied' : 'ok';
      tokens.push(pub);
    }
    s = {
      id: scene.id, name: scene.name, kind: scene.kind, bg: scene.bg, width: scene.width, height: scene.height,
      grid: clone(scene.grid), fog: { on: scene.fog.on, ops: scene.fog.ops }, tokens, templates: scene.templates,
    };
  }
  return {
    campaign: { name: c.name, theme: c.theme },
    you: me ? { charId: me.id, name: me.name, color: me.color } : null,
    party, scene: s,
    audio: { music: c.audio.music, ambience: c.audio.ambience },
    handout: c.handout, paused: c.paused,
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
