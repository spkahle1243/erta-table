// 2024 conditions plus common table markers, with icons for tokens.
import { ICON_PATHS } from './icon-paths.js';

export const CONDITIONS = [
  { id: 'blinded', name: 'Blinded', color: '#7a7f86' },
  { id: 'charmed', name: 'Charmed', color: '#d36aa8' },
  { id: 'deafened', name: 'Deafened', color: '#7a7f86' },
  { id: 'exhaustion', name: 'Exhaustion', color: '#a0703a', levels: 6 },
  { id: 'frightened', name: 'Frightened', color: '#8c5bd6' },
  { id: 'grappled', name: 'Grappled', color: '#b08a3e' },
  { id: 'incapacitated', name: 'Incapacitated', color: '#a4554a' },
  { id: 'invisible', name: 'Invisible', color: '#7fb7d9' },
  { id: 'paralyzed', name: 'Paralyzed', color: '#5aa6c9' },
  { id: 'petrified', name: 'Petrified', color: '#8d8a80' },
  { id: 'poisoned', name: 'Poisoned', color: '#5fae4a' },
  { id: 'prone', name: 'Prone', color: '#b8893a' },
  { id: 'restrained', name: 'Restrained', color: '#a86a3a' },
  { id: 'stunned', name: 'Stunned', color: '#e2b84a' },
  { id: 'unconscious', name: 'Unconscious', color: '#6b6f8a' },
  { id: 'concentrating', name: 'Concentrating', color: '#66c39d', marker: true },
  { id: 'marked', name: 'Marked', color: '#e5916a', marker: true },
  { id: 'blessed', name: 'Blessed', color: '#f2d27a', marker: true },
  { id: 'hasted', name: 'Hasted', color: '#93b5d8', marker: true },
  { id: 'raging', name: 'Raging', color: '#d9534f', marker: true },
  { id: 'dodging', name: 'Dodging', color: '#93b5d8', marker: true },
  { id: 'burning', name: 'Burning', color: '#ff7a3a', marker: true },
  { id: 'hidden', name: 'Hidden', color: '#6f7d79', marker: true },
  { id: 'surprised', name: 'Surprised', color: '#e2b84a', marker: true },
  { id: 'dead', name: 'Dead', color: '#c0392b', marker: true },
];
export const COND_BY_ID = Object.fromEntries(CONDITIONS.map(c => [c.id, c]));

// Condition values on tokens are strings ("prone") or, for exhaustion, "exhaustion:3".
export function condId(v) { return String(v).split(':')[0]; }
export function condLevel(v) { const n = Number(String(v).split(':')[1]); return Number.isFinite(n) ? n : 0; }

const pathCache = new Map();
export function iconPaths(id) {
  if (pathCache.has(id)) return pathCache.get(id);
  const body = ICON_PATHS[id] || ICON_PATHS.marked;
  const ds = [...body.matchAll(/\sd="([^"]+)"/g)].map(m => new Path2D(m[1]));
  pathCache.set(id, ds);
  return ds;
}

// Inline SVG for HTML buttons.
export function iconSvg(id, size = 18) {
  const body = (ICON_PATHS[id] || ICON_PATHS.marked).replace(/fill="[^"]*"/g, 'fill="currentColor"');
  return `<svg viewBox="0 0 512 512" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
}
