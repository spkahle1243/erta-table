// Where the party's tokens start on a scene: a tidy row with a square between
// each token. On scene art the row sits low in the picture (lower left, bottom
// middle or lower right, whichever is quietest, so it covers the least of the
// picture); on a battle map it sits low on the map, on floor rather than void.

function zoneStats(img, zones) {
  const W = 160, H = Math.max(8, Math.round(160 * img.height / img.width));
  const cv = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0, W, H);
  const d = cx.getImageData(0, 0, W, H).data;
  const lum = (x, y) => { const i = (y * W + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
  return zones.map(z => {
    const x0 = Math.floor(z.x0 * W), x1 = Math.max(x0 + 2, Math.ceil(z.x1 * W)), y0 = Math.floor(z.y0 * H), y1 = Math.max(y0 + 2, Math.ceil(z.y1 * H));
    let edge = 0, sum = 0, n = 0;
    for (let y = y0; y < Math.min(H - 1, y1); y++) for (let x = x0; x < Math.min(W - 1, x1); x++) {
      const l = lum(x, y); sum += l; n++;
      edge += Math.abs(l - lum(x + 1, y)) + Math.abs(l - lum(x, y + 1));
    }
    return { ...z, busy: n ? edge / n : 0, light: n ? sum / n : 0 };
  });
}

// Battle maps: the lowest row of floor (from the wall finder's floor) with room for the whole row.
export function floorRow(sc, sizes, floorAt) {
  const g = sc.grid, cols = Math.max(1, Math.floor((sc.width - g.ox) / g.size)), rows = Math.max(1, Math.floor((sc.height - g.oy) / g.size));
  const gap = 1, span = sizes.reduce((a, s) => a + s, 0) + gap * Math.max(0, sizes.length - 1), h = Math.max(1, ...sizes);
  // the row and a square of floor all round it, so nobody starts against a wall
  const ok = (cx, cy) => { for (let y = cy - 1; y <= cy + h; y++) for (let x = cx - 1; x <= cx + span; x++) if (!floorAt(x, y)) return false; return true; };
  for (let cy = rows - h - 2; cy >= 1; cy--) {
    const runs = [];
    for (let cx = 1; cx + span <= cols - 2; cx++) if (ok(cx, cy)) runs.push(cx);
    if (runs.length) return { cx: runs[Math.floor(runs.length / 2)], cy, gap, zone: 'floor' };
  }
  return null;
}

// cells: how many columns the row needs (tokens plus gaps). Returns { cx, cy } of the first token, in squares.
export function partyRow(sc, sizes, img) {
  const g = sc.grid, cols = Math.max(1, Math.floor((sc.width - g.ox) / g.size)), rows = Math.max(1, Math.floor((sc.height - g.oy) / g.size));
  const gap = 1;
  const span = sizes.reduce((a, s) => a + s, 0) + gap * Math.max(0, sizes.length - 1);
  const maxSize = Math.max(1, ...sizes);
  const art = sc.kind === 'art';
  // candidate places: lower left, bottom middle, lower right (scene art); battle maps also try the low sides
  const margin = art ? Math.max(1, Math.round(cols * 0.06)) : 1;
  const y = Math.max(0, rows - maxSize - (art ? Math.max(1, Math.round(rows * 0.08)) : 1));
  const xs = { left: margin, middle: Math.max(0, Math.round((cols - span) / 2)), right: Math.max(0, cols - span - margin) };
  const order = art ? ['right', 'middle', 'left'] : ['left', 'middle', 'right'];
  let pick = order[0];
  if (img) {
    const zones = order.map(k => ({ k, x0: xs[k] / cols, x1: (xs[k] + span) / cols, y0: y / rows, y1: (y + maxSize) / rows }));
    const st = zoneStats(img, zones);
    // scene art: the calmest part of the picture; battle maps: the calmest part that isn't black void
    const usable = art ? st : st.filter(z => z.light > 28);
    const best = (usable.length ? usable : st).slice().sort((a, b) => a.busy - b.busy)[0];
    if (best) pick = best.k;
  }
  return { cx: xs[pick], cy: y, gap, zone: pick };
}

// Lay the row out: each token's square, with one empty square between neighbours.
export function rowCells(start, sizes) {
  const out = []; let x = start.cx;
  for (const s of sizes) { out.push({ x, y: start.cy + (Math.max(...sizes) - s) }); x += s + start.gap; }
  return out;
}
