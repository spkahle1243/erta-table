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

// ================================================================ solid finder
// What blocks: the painted walls (stone bands, roofs, rock) and the dark void. The map is
// split into colour families; the dark ones and the ones that wall in rooms count as solid,
// and a click on a wall or a floor teaches it the rest. Thin solid (a stone band between
// rooms) gets one wall down its middle; thick solid (rock, a roof, the void) gets walls
// along its edge facing open ground; a pillar gets a ring.

const rng = seed => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

// Average colour of each sample cell, plus how much it varies inside (texture).
export function fineSample(img, grid, { per = 6, budget = 260000 } = {}) {
  const step = Math.max(grid.size / per, Math.sqrt(img.width * img.height / budget), 1);
  const nx = Math.max(8, Math.round(img.width / step)), ny = Math.max(8, Math.round(img.height / step));
  const W = nx * 2, H = ny * 2;
  const cv = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
  cx.drawImage(img, 0, 0, W, H);
  const d = cx.getImageData(0, 0, W, H).data;
  const n = nx * ny, C = new Float32Array(n * 3), tex = new Float32Array(n);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    let a = 0, b = 0, c = 0, s = 0, s2 = 0;
    for (let k = 0; k < 4; k++) {
      const i = ((y * 2 + (k >> 1)) * W + x * 2 + (k & 1)) * 4, p = lab(d[i], d[i + 1], d[i + 2]);
      a += p[0]; b += p[1]; c += p[2]; s += p[0]; s2 += p[0] * p[0];
    }
    const j = y * nx + x; C[j * 3] = a / 4; C[j * 3 + 1] = b / 4; C[j * 3 + 2] = c / 4;
    tex[j] = Math.sqrt(Math.max(0, s2 / 4 - (s / 4) ** 2));
  }
  return { nx, ny, sx: img.width / nx, sy: img.height / ny, C, tex, perCell: grid.size / (img.width / nx) };
}
const dC = (C, i, m, wL = 1) => Math.hypot((C[i * 3] - m[0]) * wL, (C[i * 3 + 1] - m[1]) * 1.2, (C[i * 3 + 2] - m[2]) * 1.2);
// a coloured material (blue roof tiles, green hedge) keeps its hue in light and shade, so its
// brightness counts for less; a grey one (stone) is told apart by brightness alone
const lightW = m => Math.hypot(m[1], m[2]) > 14 ? 0.55 : 1;
const feat = (F, i) => [F.C[i * 3], F.C[i * 3 + 1], F.C[i * 3 + 2], F.tex[i]];

// Colour families: k-means over a spread of samples (seeded, so the same map gives the same answer).
export function families(F, k = 14) {
  const n = F.nx * F.ny, R = rng(12345), pick = [];
  for (let t = 0; t < 8000; t++) pick.push(Math.floor(R() * n));
  const cent = [feat(F, pick[0])];
  const near = pick.map(i => dC(F.C, i, cent[0]));
  while (cent.length < k) {            // k-means++: start far from what we have
    let tot = 0; for (const v of near) tot += v * v;
    let r = R() * tot, j = 0; for (; j < near.length - 1; j++) { r -= near[j] * near[j]; if (r <= 0) break; }
    const c = feat(F, pick[j]); cent.push(c);
    pick.forEach((i, t) => { near[t] = Math.min(near[t], dC(F.C, i, c)); });
  }
  for (let it = 0; it < 14; it++) {
    const acc = cent.map(() => [0, 0, 0, 0, 0]);
    for (const i of pick) { let b = 0, bd = 1e9; cent.forEach((c, q) => { const v = dC(F.C, i, c); if (v < bd) { bd = v; b = q; } }); const A = acc[b], f = feat(F, i); for (let d = 0; d < 4; d++) A[d] += f[d]; A[4]++; }
    acc.forEach((A, q) => { if (A[4]) cent[q] = A.slice(0, 4).map(v => v / A[4]); });
  }
  return cent;
}

function label(F, protos) {          // nearest prototype for every sample
  const n = F.nx * F.ny, lab = new Int16Array(n);
  for (let i = 0; i < n; i++) { let b = 0, bd = 1e9; for (let q = 0; q < protos.length; q++) { const v = dC(F.C, i, protos[q].m) * protos[q].w; if (v < bd) { bd = v; b = q; } } lab[i] = b; }
  return lab;
}

// Flood fills over a mask: list of components.
function components(F, mask, val = 1, diag = false) {
  const { nx, ny } = F, seen = new Uint8Array(nx * ny), out = [], st = [];
  const nb = diag ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let i = 0; i < nx * ny; i++) {
    if (seen[i] || mask[i] !== val) continue;
    const list = []; let border = false, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; st.push(i); seen[i] = 1;
    while (st.length) {
      const k = st.pop(); list.push(k); const x = k % nx, y = (k / nx) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === nx - 1 || y === ny - 1) border = true;
      for (const [dx, dy] of nb) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue; const j = yy * nx + xx; if (!seen[j] && mask[j] === val) { seen[j] = 1; st.push(j); } }
    }
    out.push({ list, border, box: [x0, y0, x1, y1] });
  }
  return out;
}

// Rooms walled in by a mask: open pockets of a decent size that don't reach the picture's edge.
function pockets(F, mask) {
  const cell = F.perCell * F.perCell;
  return components(F, mask, 0).filter(c => !c.border && c.list.length >= cell * 3).length;
}

// Samples near a colour (within T), with the mortar between bricks and other one-sample gaps closed.
function near(F, protos, T, not = []) {
  const n = F.nx * F.ny, m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let best = 1e9; for (const p of protos) { const v = dC(F.C, i, p, lightW(p)); if (v < best) best = v; }
    if (best >= T) continue;
    let veto = false; for (const p of not) if (dC(F.C, i, p, lightW(p)) < best) { veto = true; break; }
    if (!veto) m[i] = 1;
  }
  return m;
}
function closeR(F, m, r) {     // dilate by r samples, then erode by r
  const n = F.nx * F.ny, D = distIn(F, m.map(v => 1 - v)), dil = new Uint8Array(n);
  for (let i = 0; i < n; i++) dil[i] = m[i] || D[i] <= r ? 1 : 0;
  const E = distIn(F, dil), o = new Uint8Array(n);
  for (let i = 0; i < n; i++) o[i] = E[i] > r ? 1 : 0;
  return o;
}
function close1(F, m) {        // dilate by one sample, then erode by one
  const { nx, ny } = F, d = m.slice(), o = new Uint8Array(nx * ny);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (!m[y * nx + x]) { for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < nx && yy < ny && m[yy * nx + xx]) { d[y * nx + x] = 1; break; } } }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { let k = d[y * nx + x]; if (k) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < nx && yy < ny && !d[yy * nx + xx]) { k = 0; break; } } o[y * nx + x] = k; }
  return o;
}

// Stonework drawn as a band: lighter (or darker) than the ground about a square around it, and
// on both sides of it across some direction (a ridge), so the lit edge of a floor beside a dark
// wall, which is only lighter on one side, doesn't count. rel[1]: light bands; rel[-1]: dark.
function relLight(F) {
  if (F.rel) return F.rel;
  const { nx, ny } = F, L = i => F.C[i * 3], n = nx * ny;
  const I = new Float64Array((nx + 1) * (ny + 1)), R = Math.max(2, Math.round(F.perCell));
  for (let y = 0; y < ny; y++) { let row = 0; for (let x = 0; x < nx; x++) { row += L(y * nx + x); I[(y + 1) * (nx + 1) + x + 1] = I[y * (nx + 1) + x + 1] + row; } }
  const up = new Float32Array(n), dn = new Float32Array(n);
  const ks = [...new Set([0.35, 0.5, 0.7].map(f => Math.max(1, Math.round(F.perCell * f))))];
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = y * nx + x, l = L(i);
    const x0 = Math.max(0, x - R), x1 = Math.min(nx, x + R + 1), y0 = Math.max(0, y - R), y1 = Math.min(ny, y + R + 1);
    const box = l - (I[y1 * (nx + 1) + x1] - I[y0 * (nx + 1) + x1] - I[y1 * (nx + 1) + x0] + I[y0 * (nx + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    let bu = 0, bd = 0;
    for (const k of ks) for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const ax = Math.min(nx - 1, Math.max(0, x + dx * k)), ay = Math.min(ny - 1, Math.max(0, y + dy * k)), bx = Math.min(nx - 1, Math.max(0, x - dx * k)), by = Math.min(ny - 1, Math.max(0, y - dy * k));
      const pa = L(ay * nx + ax), pb = L(by * nx + bx);
      bu = Math.max(bu, Math.min(l - pa, l - pb)); bd = Math.max(bd, Math.min(pa - l, pb - l));
    }
    up[i] = Math.min(box, bu * 1.6); dn[i] = Math.min(-box, bd * 1.6);
  }
  return (F.rel = { 1: up, '-1': dn });
}

// What's solid before any clicks: the very dark (void, rock), and a colour that runs as one long,
// thin network across the map (stone walls between rooms). Roofs, hedges, cliffs vary too much
// to guess; a click on them teaches it.
export function autoSolid(F, fams, T = 14) {
  const n = F.nx * F.ny, r = Math.max(1.5, F.perCell * 0.42);
  const dark = fams.filter(m => m[0] < 9).map(m => m[0]);
  const darkL = dark.length ? Math.min(12, Math.max(...dark) + 3) : 4;
  const stats = [];
  const test = (mask, st) => {
    let c = 0; for (let i = 0; i < n; i++) c += mask[i];
    const share = c / n; st.share = +share.toFixed(3); stats.push(st);
    if (share < 0.01 || share > 0.3) return st;
    const D = distIn(F, mask), comps = components(F, mask, 1, true).sort((x, y) => y.list.length - x.list.length).slice(0, 3);
    let thin = 0, tot = 0, sx = 0, sy = 0;
    for (const cp of comps) { for (const k of cp.list) { tot++; if (D[k] < r) thin++; } sx = Math.max(sx, (cp.box[2] - cp.box[0]) / F.nx); sy = Math.max(sy, (cp.box[3] - cp.box[1]) / F.ny); }
    Object.assign(st, { thin: +(thin / Math.max(1, tot)).toFixed(2), span: +Math.min(sx, sy).toFixed(2), joined: +(tot / Math.max(1, c)).toFixed(2) });
    st.ok = st.thin >= 0.6 && st.span >= 0.35 && st.joined >= 0.5;
    return st;
  };
  for (const [q, m] of fams.entries()) if (m[0] >= 25) test(close1(F, near(F, [m], T)), { q, kind: 'colour', m, L: Math.round(m[0]), a: Math.round(m[1]), b: Math.round(m[2]) });
  const rel = relLight(F);
  for (const sign of [1, -1]) { const mk = new Uint8Array(n); const R = rel[sign]; for (let i = 0; i < n; i++) mk[i] = R[i] > 9 && F.C[i * 3] > darkL + 4 ? 1 : 0; test(close1(F, mk), { kind: sign > 0 ? 'lighter' : 'darker', sign }); }
  const ok = stats.filter(t => t.ok).sort((a, b) => b.span * b.joined - a.span * a.joined);
  // banded stone (lighter or darker than its floor) beats a single colour when both fit
  const band = ok.find(t => t.kind !== 'colour');
  const net = band ? [] : ok.filter(t => t.share <= 0.15).slice(0, 1).map(t => t.m);
  return { darkL, net, band: band ? band.sign : 0, stats: stats.map(({ m, ...t }) => t) };
}

// distance (in samples) from each sample to the nearest sample where mask == 0. chamfer 3-4.
function distIn(F, mask) {
  const { nx, ny } = F, D = new Float32Array(nx * ny), BIG = 1e6;
  for (let i = 0; i < nx * ny; i++) D[i] = mask[i] ? BIG : 0;
  const g = (x, y) => (x < 0 || y < 0 || x >= nx || y >= ny) ? BIG : D[y * nx + x];
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const i = y * nx + x; if (!D[i]) continue; D[i] = Math.min(D[i], g(x - 1, y) + 3, g(x, y - 1) + 3, g(x - 1, y - 1) + 4, g(x + 1, y - 1) + 4); }
  for (let y = ny - 1; y >= 0; y--) for (let x = nx - 1; x >= 0; x--) { const i = y * nx + x; if (!D[i]) continue; D[i] = Math.min(D[i], g(x + 1, y) + 3, g(x, y + 1) + 3, g(x + 1, y + 1) + 4, g(x - 1, y + 1) + 4); }
  for (let i = 0; i < nx * ny; i++) D[i] /= 3;
  return D;
}

// Zhang–Suen thinning: a one-sample-wide centreline of the mask.
function thin(F, mask) {
  const { nx, ny } = F, m = mask.slice();
  const at = (x, y) => (x < 0 || y < 0 || x >= nx || y >= ny) ? 0 : m[y * nx + x];
  for (let changed = true, it = 0; changed && it < 200; it++) {
    changed = false;
    for (const step of [0, 1]) {
      const del = [];
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        if (!m[y * nx + x]) continue;
        const p = [at(x, y - 1), at(x + 1, y - 1), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1), at(x - 1, y + 1), at(x - 1, y), at(x - 1, y - 1)];
        const B = p.reduce((a, b) => a + b, 0); if (B < 2 || B > 6) continue;
        let A = 0; for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) A++;
        if (A !== 1) continue;
        if (step === 0 ? (p[0] * p[2] * p[4] || p[2] * p[4] * p[6]) : (p[0] * p[2] * p[6] || p[0] * p[4] * p[6])) continue;
        del.push(y * nx + x);
      }
      if (del.length) { changed = true; for (const i of del) m[i] = 0; }
    }
  }
  return m;
}

// Skeleton pixels → polylines (in sample coordinates), split at junctions.
function traceSkeleton(F, sk) {
  const { nx, ny } = F, on = (x, y) => x >= 0 && y >= 0 && x < nx && y < ny && sk[y * nx + x];
  const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const nbs = i => { const x = i % nx, y = (i / nx) | 0, o = []; for (const [dx, dy] of N8) if (on(x + dx, y + dy)) o.push((y + dy) * nx + x + dx); return o; };
  const deg = new Map(); for (let i = 0; i < nx * ny; i++) if (sk[i]) deg.set(i, nbs(i).length);
  const node = i => deg.get(i) !== 2;
  const usedE = new Set(), ek = (a, b) => a < b ? a + ',' + b : b + ',' + a, lines = [];
  const walk = (a, b) => { const line = [a, b]; usedE.add(ek(a, b)); let prev = a, cur = b;
    while (!node(cur)) { const nx2 = nbs(cur).find(j => j !== prev && !usedE.has(ek(cur, j))); if (nx2 == null) break; usedE.add(ek(cur, nx2)); line.push(nx2); prev = cur; cur = nx2; }
    return line; };
  for (const [i] of deg) if (node(i)) for (const j of nbs(i)) if (!usedE.has(ek(i, j))) lines.push(walk(i, j));
  for (const [i] of deg) for (const j of nbs(i)) if (!usedE.has(ek(i, j))) lines.push(walk(i, j));   // loops with no junction
  return { lines: lines.map(l => l.map(i => [i % nx, (i / nx) | 0])), deg, nx };
}

// The whole job, solid edition.
export function findWalls(img, grid, { walls: wallClicks = [], floors: floorClicks = [], sensitivity = 0.5, pillars = true, sample = null, fams = null } = {}) {
  const F = sample || fineSample(img, grid);
  const n = F.nx * F.ny, pc = F.perCell, cell = pc * pc, s = Math.max(0, Math.min(1, sensitivity));
  const A = F.auto || (F.auto = autoSolid(F, fams || F.fams || (F.fams = families(F))));
  const toIdx = p => Math.min(F.ny - 1, Math.max(0, Math.floor(p.y / F.sy))) * F.nx + Math.min(F.nx - 1, Math.max(0, Math.floor(p.x / F.sx)));
  const local = p => { const i = toIdx(p), x = i % F.nx, y = (i / F.nx) | 0, m = [0, 0, 0]; let k = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= F.nx || yy >= F.ny) continue; const j = yy * F.nx + xx; for (let d = 0; d < 3; d++) m[d] += F.C[j * 3 + d]; k++; } return m.map(v => v / k); };
  // reach: how far from a wall colour still counts as that wall
  const T = 8 + 16 * s;
  const floorP = floorClicks.map(local);
  let solid = new Uint8Array(n);
  if (A.net.length || A.band) {
    // guessed stonework only counts where it runs thin: a broad patch of it is lit floor
    let m;
    if (A.band) { const rel = relLight(F), th = 13 - 8 * s; m = new Uint8Array(n); const R = rel[A.band]; for (let i = 0; i < n; i++) m[i] = R[i] > th && F.C[i * 3] > A.darkL + 4 ? 1 : 0; m = closeR(F, m, 2); }
    else m = close1(F, near(F, A.net, 5 + 10 * s, floorP));
    const rb = pc * 0.75;
    const core = new Uint8Array(n), D = distIn(F, m); for (let i = 0; i < n; i++) core[i] = D[i] >= rb ? 1 : 0;
    const Dc = distIn(F, core.map(v => 1 - v)), keep = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (m[i] && Dc[i] > rb) keep[i] = 1;
    // what's left is the network itself, or a pillar standing on its own; scraps go
    for (const c of components(F, keep, 1, true)) {
      const w = (c.box[2] - c.box[0] + 1) / pc, h = (c.box[3] - c.box[1] + 1) / pc, fill = c.list.length / (cell * w * h);
      if (Math.max(w, h) >= 1.8) for (const k of c.list) solid[k] = 1;
      else if (pillars && w <= 1.6 && h <= 1.6 && Math.min(w, h) >= 0.5 && Math.max(w, h) <= Math.min(w, h) * 1.6 && fill >= 0.55 && c.list.length >= cell * 0.28)
        for (const k of c.list) { const x = k % F.nx, y = (k / F.nx) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < F.nx && yy < F.ny) solid[yy * F.nx + xx] = 1; } }   // a pillar: its lit top, and its rim
    }
  }
  if (wallClicks.length) { const m = close1(F, near(F, wallClicks.map(local), T, floorP)); for (let i = 0; i < n; i++) if (m[i]) solid[i] = 1; }
  const darkL = A.darkL + (s - 0.5) * 6;
  for (let i = 0; i < n; i++) if (F.C[i * 3] < darkL) { let veto = false; for (const p of floorP) if (dC(F.C, i, p) < 6) veto = true; if (!veto) solid[i] = 1; }
  // tidy: majority vote, specks out, pinholes filled
  const sm = solid.slice();
  // (gently: a one-sample line, like a thin cell wall, survives; a lone sample doesn't)
  for (let y = 1; y < F.ny - 1; y++) for (let x = 1; x < F.nx - 1; x++) { const i = y * F.nx + x; let c = -solid[i]; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) c += solid[(y + dy) * F.nx + x + dx]; if (solid[i] && c <= 1) sm[i] = 0; else if (!solid[i] && c >= 6) sm[i] = 1; }
  solid = sm;
  // crumbs go; a lump under a square or so stays only if it's shaped like a pillar
  for (const c of components(F, solid, 1, true)) {
    if (c.list.length >= cell * 1.2) continue;
    const w = (c.box[2] - c.box[0] + 1) / pc, h = (c.box[3] - c.box[1] + 1) / pc, fill = c.list.length / (cell * w * h);
    if (Math.max(w, h) >= 1.8) continue;      // a short thin wall piece
    if (pillars && c.list.length >= cell * 0.4 && Math.min(w, h) >= 0.6 && Math.max(w, h) <= Math.min(w, h) * 1.6 && fill >= 0.55) continue;
    for (const k of c.list) solid[k] = 0;
  }
  for (const c of components(F, solid, 0)) if (!c.border && c.list.length < cell * 0.6) for (const k of c.list) solid[k] = 1;
  { // pockets too narrow to stand in (lettering, cracks) are part of the wall
    const Do = distIn(F, solid.map(v => 1 - v));
    for (const c of components(F, solid, 0)) if (!c.border) { let mx = 0; for (const k of c.list) if (Do[k] > mx) mx = Do[k]; if (mx < pc * 0.3) for (const k of c.list) solid[k] = 1; }
  }
  // what was clicked as floor stays floor, what was clicked as wall stays wall
  const flood = (p, val) => { const i = toIdx(p); if (solid[i] === val) return; const st = [i], from = solid[i]; solid[i] = val; let c = 0; while (st.length && c++ < cell * 400) { const k = st.pop(), x = k % F.nx, y = (k / F.nx) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= F.nx || yy >= F.ny) continue; const j = yy * F.nx + xx; if (solid[j] === from) { solid[j] = val; st.push(j); } } } };
  for (const p of floorClicks) flood(p, 0);
  // thick vs thin
  const D = distIn(F, solid), r = Math.max(1.5, pc * 0.42);
  const core = new Uint8Array(n); for (let i = 0; i < n; i++) core[i] = D[i] >= r ? 1 : 0;
  // columns: small, compact lumps count as thick whatever their width
  for (const c of components(F, solid, 1)) {
    const w = (c.box[2] - c.box[0] + 1) / pc, h = (c.box[3] - c.box[1] + 1) / pc;
    if (pillars && w <= 2.2 && h <= 2.2 && c.list.length >= cell * 0.25) for (const k of c.list) core[k] = 1;
  }
  const notCore = core.map(v => 1 - v), Dc = distIn(F, notCore);   // distance to the nearest core sample
  const thick = new Uint8Array(n), thinM = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (solid[i]) { if (Dc[i] <= r * 1.25 + 1) thick[i] = 1; else thinM[i] = 1; }
  // outline the thick, centreline the thin
  const walls = [], eps = pc * 0.28, minLen = grid.size * 0.3;
  const toW = (p, q, off) => ({ x1: Math.round((p[0] + off) * F.sx), y1: Math.round((p[1] + off) * F.sy), x2: Math.round((q[0] + off) * F.sx), y2: Math.round((q[1] + off) * F.sy) });
  const e = 1.6, onEdge = (p, q) => (p[0] <= e && q[0] <= e) || (p[1] <= e && q[1] <= e) || (p[0] >= F.nx - 1 - e && q[0] >= F.nx - 1 - e) || (p[1] >= F.ny - 1 - e && q[1] >= F.ny - 1 - e);
  for (const line of outline(F, thick)) {
    const closed = line.length > 3 && line[0][0] === line[line.length - 1][0] && line[0][1] === line[line.length - 1][1];
    let pts = rdp(line, eps);
    if (closed && pts.length < 4) { const h = Math.floor(line.length / 2); pts = rdp(line.slice(0, h + 1), eps).concat(rdp(line.slice(h), eps).slice(1)); }
    for (let i = 0; i < pts.length - 1; i++) { const p = pts[i], q = pts[i + 1]; if (onEdge(p, q)) continue; const w = toW(p, q, 0.5); if (Math.hypot(w.x2 - w.x1, w.y2 - w.y1) >= minLen * 0.5) walls.push(w); }
  }
  const sk = thin(F, thinM), TS = traceSkeleton(F, sk);
  for (const line of TS.lines) {
    let len = 0; for (let i = 1; i < line.length; i++) len += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
    const a = line[0], b = line[line.length - 1], free = p => TS.deg.get(p[1] * TS.nx + p[0]) === 1;
    if (len < pc * 0.6 && (free(a) || free(b))) continue;       // spurs and crumbs
    const pts = rdp(line, eps);
    for (let i = 0; i < pts.length - 1; i++) { const w = toW(pts[i], pts[i + 1], 0.5); if (Math.hypot(w.x2 - w.x1, w.y2 - w.y1) >= 1) walls.push(w); }
  }
  const out = joinEnds(walls, grid.size * 0.45);
  return { walls: out, solid, thick, thin: thinM, F, auto: A, open: 1 - solid.reduce((a, b) => a + b, 0) / n };
}

// Close the little gaps: an end near another wall moves onto it (end to end first, else onto the line).
function joinEnds(walls, tol) {
  const ends = []; walls.forEach((w, i) => { ends.push([i, 1]); ends.push([i, 2]); });
  const P = (w, k) => k === 1 ? [w.x1, w.y1] : [w.x2, w.y2];
  const set = (w, k, p) => { if (k === 1) { w.x1 = p[0]; w.y1 = p[1]; } else { w.x2 = p[0]; w.y2 = p[1]; } };
  const key = p => p[0] + ',' + p[1], count = new Map();
  for (const [i, k] of ends) { const q = key(P(walls[i], k)); count.set(q, (count.get(q) || 0) + 1); }
  for (const [i, k] of ends) {
    const w = walls[i], p = P(w, k); if (count.get(key(p)) > 1) continue;      // already joined
    let best = null, bd = tol;
    walls.forEach((v, j) => { if (j === i) return; for (const kk of [1, 2]) { const q = P(v, kk), d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd * 0.8) { bd = d / 0.8; best = q; } } });
    if (!best) walls.forEach((v, j) => { if (j === i) return; const dx = v.x2 - v.x1, dy = v.y2 - v.y1, L2 = dx * dx + dy * dy; if (!L2) return; const t = Math.max(0, Math.min(1, ((p[0] - v.x1) * dx + (p[1] - v.y1) * dy) / L2)), q = [Math.round(v.x1 + dx * t), Math.round(v.y1 + dy * t)], d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = q; } });
    if (best) { count.set(key(p), (count.get(key(p)) || 1) - 1); set(w, k, best); count.set(key(best), (count.get(key(best)) || 0) + 1); }
  }
  return walls.filter(w => Math.hypot(w.x2 - w.x1, w.y2 - w.y1) >= 1);
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
