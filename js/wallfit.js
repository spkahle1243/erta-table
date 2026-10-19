// First-draft walls from a battle map picture. The floor is found by growing out
// from floor samples (spots you click, or the commonest floor colour near the
// middle of the map); walls go around the edge of what was reached, traced and
// straightened so they're easy to clean up by hand. Pure maths, no dependencies.

// ---------------------------------------------------------------- colour
function lab(r, g, b) {
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, Y = R * 0.2126 + G * 0.7152 + B * 0.0722, Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const dist = (p, q) => Math.hypot(p[0] - q[0], (p[1] - q[1]) * 1.2, (p[2] - q[2]) * 1.2);

// Sample the picture on a fine grid: `per` samples across each map square.
export function sampleImage(img, grid, per = 4, maxSamples = 520) {
  const step0 = grid.size / per;
  const step = Math.max(step0, Math.max(img.width, img.height) / maxSamples);
  const nx = Math.max(4, Math.round(img.width / step)), ny = Math.max(4, Math.round(img.height / step));
  const cv = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(nx, ny) : Object.assign(document.createElement('canvas'), { width: nx, height: ny });
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
  cx.drawImage(img, 0, 0, nx, ny);
  const d = cx.getImageData(0, 0, nx, ny).data;
  const L = new Array(nx * ny);
  for (let i = 0, j = 0; j < nx * ny; i += 4, j++) L[j] = lab(d[i], d[i + 1], d[i + 2]);
  // soften painted texture (grain, planks, speckle) so a floor reads as one surface
  const B = new Array(nx * ny);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const acc = [0, 0, 0]; let k = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
      const p = L[yy * nx + xx]; acc[0] += p[0]; acc[1] += p[1]; acc[2] += p[2]; k++;
    }
    B[y * nx + x] = [acc[0] / k, acc[1] / k, acc[2] / k];
  }
  return { nx, ny, sx: img.width / nx, sy: img.height / ny, L: B, raw: L, perCell: grid.size / (img.width / nx) };
}

// ---------------------------------------------------------------- floor
function model(S, idx) {
  const pts = [];
  const x = idx % S.nx, y = Math.floor(idx / S.nx);
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= S.nx || yy >= S.ny) continue;
    pts.push(S.L[yy * S.nx + xx]);
  }
  const m = [0, 1, 2].map(k => pts.reduce((s, p) => s + p[k], 0) / pts.length);
  const ds = pts.map(p => dist(p, m)).sort((a, b) => a - b);
  return { m, spread: ds[Math.floor(ds.length * 0.9)] || 0 };
}

// Flood out from one sample with that spot's colour as the model. Returns the sample list.
function grow(S, seed, s, taken) {
  const M = model(S, seed);
  return peel(S, growWith(S, seed, s, taken, M), M);
}
// Trim a thin rim that doesn't look like the floor's own colour: the painted wall face a floor can
// creep onto. At most about half a square deep, so real floor isn't eaten.
function peel(S, list, M) {
  const inSet = new Set(list), Tcore = Math.max(10, Math.min(M.spread, 22) + 7);
  const nb = i => { const x = i % S.nx, y = (i / S.nx) | 0; return [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [x + dx, y + dy]).filter(([a, b]) => a >= 0 && b >= 0 && a < S.nx && b < S.ny).map(([a, b]) => b * S.nx + a); };
  for (let pass = 0; pass < Math.max(1, Math.round(S.perCell * 0.6)); pass++) {
    const drop = [];
    for (const i of inSet) if (dist(S.raw[i], M.m) > Tcore && dist(S.L[i], M.m) > Tcore * 0.8 && nb(i).some(j => !inSet.has(j))) drop.push(i);
    if (!drop.length) break;
    for (const i of drop) inSet.delete(i);
  }
  return [...inSet];
}
function growWith(S, seed, s, taken, M) {
  const T = Math.max(8, Math.min(M.spread, 22) * (1.0 + 1.3 * s) + 5 + 9 * s);   // how far from this floor's colour
  const Tstep = 9 + 14 * s;                                                    // how sharp an edge it may cross
  const out = [seed], here = new Set([seed]);
  for (let h = 0; h < out.length; h++) {
    const i = out[h], x = i % S.nx, y = (i / S.nx) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= S.nx || yy >= S.ny) continue;
      const j = yy * S.nx + xx; if (here.has(j) || taken[j]) continue;
      const p = S.L[j];
      // smoothed colour must match; a sharp edge stops it unless it's only texture (gone once smoothed)
      if (dist(p, M.m) > T || (dist(S.raw[j], S.raw[i]) > Tstep && dist(p, S.L[i]) > Tstep * 0.45)) continue;
      here.add(j); out.push(j);
    }
  }
  return out;
}

// How thick a region is, in map squares: 2 × area ÷ perimeter. Wall bands are thin; rooms aren't.
function thickness(S, list) {
  const inSet = new Set(list); let per = 0;
  for (const i of list) { const x = i % S.nx, y = (i / S.nx) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= S.nx || yy >= S.ny || !inSet.has(yy * S.nx + xx)) per++; } }
  return per ? (2 * list.length / per) / S.perCell : 0;
}

// The floor: every broad, not-black region of a common colour, plus whatever grows from the
// spots you clicked; minus the regions you shift-clicked. sensitivity 0..1 (higher reaches further).
export function floorMask(S, seedIdx = [], sensitivity = 0.5, notIdx = []) {
  const n = S.nx * S.ny, mask = new Uint8Array(n), s = Math.max(0, Math.min(1, sensitivity));
  const cell = S.perCell * S.perCell;
  const accept = list => { for (const k of list) mask[k] = 1; };
  for (const i of seedIdx) if (!mask[i]) accept(grow(S, i, s, mask));
  // colour bins over the whole map, commonest first
  const bins = new Map();
  for (let i = 0; i < n; i++) {
    const p = S.L[i]; if (p[0] < 14) continue;           // near-black: void, not floor
    const k = `${Math.round(p[0] / 9)},${Math.round(p[1] / 9)},${Math.round(p[2] / 9)}`;
    (bins.get(k) || bins.set(k, []).get(k)).push(i);
  }
  const ranked = [...bins.values()].filter(b => b.length > cell * 2).sort((a, b) => b.length - a.length).slice(0, 8);
  const tried = new Uint8Array(n);
  for (const b of ranked) {
    for (let t = 0, step = Math.max(1, Math.floor(b.length / 40)); t < b.length; t += step) {
      const i = b[t]; if (mask[i] || tried[i]) continue;
      const list = grow(S, i, s, mask);
      for (const k of list) tried[k] = 1;
      const meanL = list.reduce((a, k) => a + S.L[k][0], 0) / list.length;
      if (list.length >= cell * 4 && meanL >= 18 && thickness(S, list) >= 1.2) accept(list);
    }
  }
  // shift-clicked spots: not floor
  for (const i of notIdx) if (mask[i]) {
    const stack = [i]; mask[i] = 0;
    while (stack.length) { const k = stack.pop(), x = k % S.nx, y = (k / S.nx) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= S.nx || yy >= S.ny) continue; const j = yy * S.nx + xx; if (mask[j]) { mask[j] = 0; stack.push(j); } } }
  }
  return clean(S, mask);
}

// Fill small holes (props, rugs, tokens' worth of clutter) and drop specks.
function clean(S, mask) {
  const { nx, ny } = S, cell = S.perCell * S.perCell;
  const out = mask.slice();
  // majority smoothing, once
  const sm = out.slice();
  for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    let c = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) c += out[(y + dy) * nx + x + dx];
    sm[y * nx + x] = c >= 5 ? 1 : 0;
  }
  const comp = (val, maxArea, setTo, keepBorder) => {
    const seen = new Uint8Array(nx * ny), stack = [];
    for (let i = 0; i < nx * ny; i++) {
      if (seen[i] || sm[i] !== val) continue;
      const list = []; let border = false; stack.push(i); seen[i] = 1;
      while (stack.length) {
        const k = stack.pop(); list.push(k);
        const x = k % nx, y = (k / nx) | 0;
        if (x === 0 || y === 0 || x === nx - 1 || y === ny - 1) border = true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
          const j = yy * nx + xx; if (!seen[j] && sm[j] === val) { seen[j] = 1; stack.push(j); }
        }
      }
      if (list.length < maxArea && !(keepBorder && border)) for (const k of list) sm[k] = setTo;
    }
  };
  comp(0, cell * 3.2, 1, true);    // holes inside the floor smaller than ~3 squares (props, furniture): floor
  comp(1, cell * 2, 0, false);     // floor specks smaller than 2 squares: not floor
  return sm;
}

// ---------------------------------------------------------------- outline → walls
// Marching squares over the mask, chained into outlines, then straightened.
export function outline(S, mask) {
  const { nx, ny } = S;
  const at = (x, y) => (x < 0 || y < 0 || x >= nx || y >= ny) ? 0 : mask[y * nx + x];
  // edges between sample centres; key them by grid points of a half-step lattice
  const segs = [];
  for (let y = -1; y < ny; y++) for (let x = -1; x < nx; x++) {
    const a = at(x, y), b = at(x + 1, y), c = at(x + 1, y + 1), d = at(x, y + 1);
    const code = a * 8 + b * 4 + c * 2 + d;
    if (code === 0 || code === 15) continue;
    // midpoints: top (x+.5,y) right (x+1,y+.5) bottom (x+.5,y+1) left (x,y+.5)
    const T = [x + 0.5, y], R = [x + 1, y + 0.5], B = [x + 0.5, y + 1], Lf = [x, y + 0.5];
    const add = (p, q) => segs.push([p, q]);
    switch (code) {
      case 1: case 14: add(Lf, B); break;
      case 2: case 13: add(B, R); break;
      case 3: case 12: add(Lf, R); break;
      case 4: case 11: add(T, R); break;
      case 5: add(Lf, T); add(B, R); break;
      case 6: case 9: add(T, B); break;
      case 7: case 8: add(Lf, T); break;
      case 10: add(T, R); add(Lf, B); break;
    }
  }
  // chain segments that share end points
  const key = p => `${p[0] * 2},${p[1] * 2}`;
  const ends = new Map();
  segs.forEach((s, i) => { for (const p of s) { const k = key(p); (ends.get(k) || ends.set(k, []).get(k)).push(i); } });
  const used = new Uint8Array(segs.length), lines = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line = [segs[i][0], segs[i][1]];
    for (const dir of [1, 0]) {
      for (;;) {
        const tip = dir ? line[line.length - 1] : line[0];
        const next = (ends.get(key(tip)) || []).find(j => !used[j]);
        if (next == null) break;
        used[next] = 1;
        const s = segs[next], far = key(s[0]) === key(tip) ? s[1] : s[0];
        if (dir) line.push(far); else line.unshift(far);
      }
    }
    lines.push(line);
  }
  return lines;
}

function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1e-9;
  let best = -1, bi = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const d = len < 1e-6 ? Math.hypot(p[0] - a[0], p[1] - a[1]) : Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
    if (d > best) { best = d; bi = i; }
  }
  if (best <= eps) return [a, b];
  return [...rdp(pts.slice(0, bi + 1), eps).slice(0, -1), ...rdp(pts.slice(bi), eps)];
}

// The whole job: { walls: [{x1,y1,x2,y2}], mask, S }. seeds: world points on the floor.
export function detectWalls(img, grid, { seeds = [], not = [], sensitivity = 0.5, per = 4, sample = null } = {}) {
  const S = sample || sampleImage(img, grid, per);
  const toIdx = p => Math.min(S.ny - 1, Math.max(0, Math.floor(p.y / S.sy))) * S.nx + Math.min(S.nx - 1, Math.max(0, Math.floor(p.x / S.sx)));
  const mask = floorMask(S, seeds.map(toIdx), sensitivity, not.map(toIdx));
  const lines = outline(S, mask);
  const eps = S.perCell * 0.3, minLen = grid.size * 0.3;
  const walls = [];
  // contour points on the picture's border sit half a sample outside the outer samples
  const onEdge = (p, q) => (p[0] <= -0.49 && q[0] <= -0.49) || (p[1] <= -0.49 && q[1] <= -0.49) || (p[0] >= S.nx - 0.51 && q[0] >= S.nx - 0.51) || (p[1] >= S.ny - 0.51 && q[1] >= S.ny - 0.51);
  for (const line of lines) {
    const closed = line.length > 3 && line[0][0] === line[line.length - 1][0] && line[0][1] === line[line.length - 1][1];
    let pts = rdp(line, eps);
    if (closed && pts.length < 3) pts = rdp(line.slice(0, Math.floor(line.length / 2) + 1), eps).concat(rdp(line.slice(Math.floor(line.length / 2)), eps).slice(1));
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      if (onEdge(p, q)) continue;       // the picture's own edge needs no wall
      const w = { x1: Math.round((p[0] + 0.5) * S.sx), y1: Math.round((p[1] + 0.5) * S.sy), x2: Math.round((q[0] + 0.5) * S.sx), y2: Math.round((q[1] + 0.5) * S.sy) };
      if (Math.hypot(w.x2 - w.x1, w.y2 - w.y1) >= minLen) walls.push(w);
    }
  }
  return { walls, mask, S, floor: mask.reduce((a, b) => a + b, 0) / mask.length };
}

// ---------------------------------------------------------------- cleanup helpers
// Cut the part of each wall inside a box; what's outside stays.
export function eraseBox(walls, box) {
  const out = [];
  for (const w of walls) {
    const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
    let t0 = 0, t1 = 1, inside = true;
    for (const [p, q] of [[-dx, w.x1 - box.x], [dx, box.x + box.w - w.x1], [-dy, w.y1 - box.y], [dy, box.y + box.h - w.y1]]) {
      if (p === 0) { if (q < 0) { inside = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { inside = false; break; } if (r > t0) t0 = r; }
      else { if (r < t0) { inside = false; break; } if (r < t1) t1 = r; }
    }
    if (!inside || t1 - t0 < 1e-6) { out.push(w); continue; }
    if (w.door) continue;           // a door touched by the eraser goes
    const pt = t => ({ x: Math.round(w.x1 + dx * t), y: Math.round(w.y1 + dy * t) });
    if (t0 > 0.001) { const a = pt(t0); out.push({ ...w, id: w.id + 'a', x2: a.x, y2: a.y }); }
    if (t1 < 0.999) { const b = pt(t1); out.push({ ...w, id: w.id + 'b', x1: b.x, y1: b.y }); }
  }
  return out;
}

// A door drawn along a wall replaces that stretch of it.
export function cutForDoor(walls, door, tol) {
  const out = [];
  const ux = door.x2 - door.x1, uy = door.y2 - door.y1, dl = Math.hypot(ux, uy) || 1;
  for (const w of walls) {
    if (w.door) { out.push(w); continue; }
    const wx = w.x2 - w.x1, wy = w.y2 - w.y1, wl = Math.hypot(wx, wy) || 1;
    const cos = Math.abs((ux * wx + uy * wy) / (dl * wl));
    const off = p => Math.abs((p.x - w.x1) * wy - (p.y - w.y1) * wx) / wl;
    if (cos < 0.985 || off({ x: door.x1, y: door.y1 }) > tol || off({ x: door.x2, y: door.y2 }) > tol) { out.push(w); continue; }
    const t = p => ((p.x - w.x1) * wx + (p.y - w.y1) * wy) / (wl * wl);
    let a = t({ x: door.x1, y: door.y1 }), b = t({ x: door.x2, y: door.y2 }); if (a > b) [a, b] = [b, a];
    if (b <= 0 || a >= 1) { out.push(w); continue; }
    const pt = s => ({ x: Math.round(w.x1 + wx * s), y: Math.round(w.y1 + wy * s) });
    if (a > 0.001) { const p = pt(a); out.push({ ...w, id: w.id + 'a', x2: p.x, y2: p.y }); }
    if (b < 0.999) { const p = pt(b); out.push({ ...w, id: w.id + 'b', x1: p.x, y1: p.y }); }
  }
  return out;
}
