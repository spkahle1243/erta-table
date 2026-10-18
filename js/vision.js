// Walls, doors, light and sight. Pure geometry with no drawing, shared by the
// DM (who decides which tokens each player may see, and works out cover) and
// the players (who draw what their tokens can see).
//
// scene.walls:  [{ id, x1, y1, x2, y2, door?, open?, locked?, secret? }] in scene pixels
// scene.lights: [{ id, x, y, bright, dim }]  bright radius and the extra dim ring, in feet
// scene.vision: { on, light: 'bright' | 'dim' | 'dark' }

export const LIGHTS = {
  candle: { name: 'Candle', bright: 5, dim: 5 },
  torch: { name: 'Torch', bright: 20, dim: 20 },
  light: { name: 'Light (cantrip)', bright: 20, dim: 20 },
  lamp: { name: 'Lamp', bright: 15, dim: 30 },
  lantern: { name: 'Lantern', bright: 30, dim: 30 },
  daylight: { name: 'Daylight (spell)', bright: 60, dim: 60 },
};

export const visionOn = scene => !!scene?.vision?.on;
export const pxPerFt = scene => scene.grid.size / scene.grid.feet;

// What blocks sight and movement: every wall, and doors that are closed.
export function blockers(scene) { return (scene?.walls || []).filter(w => !(w.door && w.open)); }

// t along p→q where the segment crosses wall w, or -1. Touching a wall's end counts,
// so a ray can't slip through the joint where two walls meet.
function cross(px, py, qx, qy, w) {
  const rx = qx - px, ry = qy - py, sx = w.x2 - w.x1, sy = w.y2 - w.y1;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return -1;
  const t = ((w.x1 - px) * sy - (w.y1 - py) * sx) / den;
  const u = ((w.x1 - px) * ry - (w.y1 - py) * rx) / den;
  return t > 1e-6 && t < 1 - 1e-6 && u >= -1e-6 && u <= 1 + 1e-6 ? t : -1;
}
export function blocked(walls, ax, ay, bx, by) {
  for (const w of walls) if (cross(ax, ay, bx, by, w) >= 0) return true;
  return false;
}

// The area visible from (ox, oy), as a flat [x, y, ...] polygon clipped to box.
export function visPolygon(walls, ox, oy, box) {
  const x0 = Math.min(box.x0, ox - 1), y0 = Math.min(box.y0, oy - 1), x1 = Math.max(box.x1, ox + 1), y1 = Math.max(box.y1, oy + 1);
  const segs = [];
  for (const w of walls) {
    if (Math.max(w.x1, w.x2) < x0 || Math.min(w.x1, w.x2) > x1 || Math.max(w.y1, w.y2) < y0 || Math.min(w.y1, w.y2) > y1) continue;
    segs.push([w.x1, w.y1, w.x2, w.y2]);
  }
  segs.push([x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]);
  const angles = [];
  for (const s of segs) for (let k = 0; k < 4; k += 2) {
    const a = Math.atan2(s[k + 1] - oy, s[k] - ox);
    angles.push(a - 1e-4, a, a + 1e-4);
  }
  angles.sort((a, b) => a - b);
  const pts = [];
  for (const a of angles) {
    const dx = Math.cos(a), dy = Math.sin(a);
    let best = Infinity;
    for (const s of segs) {
      const sx = s[2] - s[0], sy = s[3] - s[1];
      const den = dx * sy - dy * sx;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((s[0] - ox) * sy - (s[1] - oy) * sx) / den;
      const u = ((s[0] - ox) * dy - (s[1] - oy) * dx) / den;
      if (t >= 0 && u >= -1e-9 && u <= 1 + 1e-9 && t < best) best = t;
    }
    if (best < Infinity) pts.push(ox + dx * best, oy + dy * best);
  }
  return pts;
}

export function pointInPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ------------------------------------------------------------------ senses

// "Darkvision 60 ft; Devil's Sight 120 ft" → { dv, blind, tremor, truesight, devil }
export function parseSenses(text = '') {
  const s = { dv: 0, blind: 0, tremor: 0, truesight: 0, devil: 0 };
  const t = String(text || '');
  for (const m of t.matchAll(/(darkvision|blindsight|tremorsense|truesight|devil[’']?s sight)\s*(\d+)\s*(?:ft\.?|feet)?\s*(\([^)]*\))?/gi)) {
    const k = m[1].toLowerCase(), n = Number(m[2]);
    const cond = m[3] || '';
    if (/stonecunning/i.test(cond)) { s.tremorIf = n; continue; } // only while Stonecunning is up
    if (k === 'darkvision') s.dv = Math.max(s.dv, n);
    else if (k === 'blindsight') s.blind = Math.max(s.blind, n);
    else if (k === 'tremorsense') s.tremor = Math.max(s.tremor, n);
    else if (k === 'truesight') s.truesight = Math.max(s.truesight, n);
    else s.devil = Math.max(s.devil, n);
  }
  s.dv = Math.max(s.dv, s.devil, s.truesight);
  return s;
}

// ------------------------------------------------------------------ light

// lights: [{ x, y, bright, dim }] with x/y in scene px and radii in feet.
// Returns 2 bright, 1 dim, 0 dark at the point.
export function lightLevel(scene, lights, x, y) {
  const amb = scene.vision?.light || 'bright';
  let best = amb === 'bright' ? 2 : amb === 'dim' ? 1 : 0;
  if (best === 2) return 2;
  const walls = blockers(scene), k = pxPerFt(scene);
  for (const L of lights) {
    const d = Math.hypot(x - L.x, y - L.y) / k;
    const b = Number(L.bright) || 0, r = b + (Number(L.dim) || 0);
    if (d > r || (b <= 0 && r <= 0)) continue;
    if (blocked(walls, L.x, L.y, x, y)) continue;
    best = Math.max(best, d <= b ? 2 : 1);
    if (best === 2) break;
  }
  return best;
}

// A viewer { x, y, dv, blind, tremor, truesight } sees the point if nothing blocks the
// line and the point is lit, inside darkvision, or inside blindsight.
export function seesPoint(scene, lights, v, x, y) {
  if (!visionOn(scene)) return true;
  const walls = blockers(scene), k = pxPerFt(scene);
  if (blocked(walls, v.x, v.y, x, y)) return false;
  const d = Math.hypot(x - v.x, y - v.y) / k;
  if (v.blind && d <= v.blind) return true;
  if (v.dv && d <= v.dv) return true;
  return lightLevel(scene, lights, x, y) >= 1;
}

// Sample points of a token: its centre and four points near its corners.
export function tokenPoints(scene, t, pos = t) {
  const g = scene.grid, s = t.size || 1;
  const x = g.ox + pos.x * g.size, y = g.oy + pos.y * g.size, d = s * g.size, i = d * 0.18;
  return [[x + d / 2, y + d / 2], [x + i, y + i], [x + d - i, y + i], [x + i, y + d - i], [x + d - i, y + d - i]];
}
export function tokenCentre(scene, t, pos = t) { const g = scene.grid, s = t.size || 1; return { x: g.ox + (pos.x + s / 2) * g.size, y: g.oy + (pos.y + s / 2) * g.size }; }

// Whether viewer token V (with senses) can see token T. Tremorsense finds creatures
// through walls within its range; invisible creatures need blindsight or truesight.
export function seesToken(scene, lights, V, sense, T, { invisible = false } = {}) {
  const c = tokenCentre(scene, V), k = pxPerFt(scene);
  const v = { ...sense, x: c.x, y: c.y };
  const tc = tokenCentre(scene, T);
  const d = Math.max(0, Math.hypot(tc.x - c.x, tc.y - c.y) / k - ((T.size || 1) - 1) * scene.grid.feet / 2);
  if (sense.tremor && d <= sense.tremor) return true;
  if (invisible) {
    const r = Math.max(sense.blind || 0, sense.truesight || 0);
    if (!r || d > r) return false;
    return !blocked(blockers(scene), c.x, c.y, tc.x, tc.y);
  }
  if (!visionOn(scene)) return true;
  return tokenPoints(scene, T).some(([x, y]) => seesPoint(scene, lights, v, x, y));
}

// ------------------------------------------------------------------ cover (2024 rules)

// Lines from a corner of the attacker's space to the corners of one square the target
// occupies; take the best corner and square for the attacker. 0 lines blocked: no cover;
// 1–2: half (+2); 3: three-quarters (+5); all 4: total (can't be targeted).
export function cover(scene, attacker, target, { from = null, creatures = null } = {}) {
  const walls = blockers(scene);
  if (!walls.length && !creatures?.length) return 0;
  const g = scene.grid, e = g.size * 0.02;
  const starts = [];
  if (from) starts.push([from.x, from.y]);
  else {
    const s = attacker.size || 1, ax = g.ox + attacker.x * g.size, ay = g.oy + attacker.y * g.size;
    const cx = ax + s * g.size / 2, cy = ay + s * g.size / 2;
    for (let i = 0; i <= s; i++) for (let j = 0; j <= s; j++) {
      const x = ax + i * g.size, y = ay + j * g.size;
      starts.push([x + Math.sign(cx - x) * e, y + Math.sign(cy - y) * e]);
    }
  }
  const rects = (creatures || []).map(t => { const s = t.size || 1, x = g.ox + t.x * g.size, y = g.oy + t.y * g.size, i = g.size * 0.15; return [x + i, y + i, x + s * g.size - i, y + s * g.size - i]; });
  let best = 5, bestCreature = false;
  const ts = target.size || 1;
  for (const [sx, sy] of starts) for (let i = 0; i < ts; i++) for (let j = 0; j < ts; j++) {
    const qx = g.ox + (target.x + i) * g.size, qy = g.oy + (target.y + j) * g.size;
    const corners = [[qx + e, qy + e], [qx + g.size - e, qy + e], [qx + e, qy + g.size - e], [qx + g.size - e, qy + g.size - e]];
    let n = 0, byCreature = false;
    for (const [x, y] of corners) {
      if (blocked(walls, sx, sy, x, y)) n++;
      else if (rects.some(r => segRect(sx, sy, x, y, r))) byCreature = true;
    }
    if (n < best || (n === best && !byCreature && bestCreature)) { best = n; bestCreature = byCreature; }
    if (best === 0 && !byCreature) return 0;
  }
  if (best >= 4) return Infinity;
  if (best === 3) return 5;
  if (best >= 1 || bestCreature) return 2;
  return 0;
}
export const coverName = v => (v === Infinity ? 'total cover' : v === 5 ? 'three-quarters cover' : v === 2 ? 'half cover' : 'no cover');

function segRect(ax, ay, bx, by, [x0, y0, x1, y1]) {
  const inside = (x, y) => x > x0 && x < x1 && y > y0 && y < y1;
  if (inside(ax, ay) || inside(bx, by)) return true;
  const edges = [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]];
  return edges.some(([a, b, c, d]) => cross(ax, ay, bx, by, { x1: a, y1: b, x2: c, y2: d }) >= 0);
}

// Moving a token from one cell to another along a straight line: is a wall in the way?
export function moveBlocked(scene, t, from, to) {
  const walls = blockers(scene); if (!walls.length) return false;
  const a = tokenCentre(scene, t, from), b = tokenCentre(scene, t, to);
  return blocked(walls, a.x, a.y, b.x, b.y);
}

export const doorHandle = w => ({ x: (w.x1 + w.x2) / 2, y: (w.y1 + w.y2) / 2 });
