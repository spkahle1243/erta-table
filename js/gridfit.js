// Find the grid printed on a battle map: the square size and where the lines fall.
// Edges are summed along each column and each row; the printed grid shows up as a
// strong repeating pulse, found by autocorrelation and then folded to get its phase.

function profiles(img, maxW = 1200) {
  const k = Math.min(1, maxW / img.width);
  const W = Math.max(8, Math.round(img.width * k)), H = Math.max(8, Math.round(img.height * k));
  const cv = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0, W, H);
  const d = cx.getImageData(0, 0, W, H).data;
  const g = new Float32Array(W * H);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const col = new Float64Array(W), row = new Float64Array(H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const gx = Math.abs(g[i + 1] - g[i - 1]), gy = Math.abs(g[i + W] - g[i - W]);
    // a vertical grid line is a strong horizontal gradient that is weak vertically
    col[x] += Math.max(0, gx - gy * 0.5);
    row[y] += Math.max(0, gy - gx * 0.5);
  }
  return { col, row, k, W, H };
}

function detrend(p, win) {
  const n = p.length, out = new Float64Array(n);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + p[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - win), b = Math.min(n, i + win + 1);
    out[i] = Math.max(0, p[i] - (pre[b] - pre[a]) / (b - a));
  }
  return out;
}

function autocorr(p, lag) {
  let s = 0, a = 0, b = 0;
  for (let i = 0; i + lag < p.length; i++) { s += p[i] * p[i + lag]; a += p[i] * p[i]; b += p[i + lag] * p[i + lag]; }
  return a && b ? s / Math.sqrt(a * b) : 0;
}

// Fold the profile at period p and find where the lines fall (sub-pixel).
function phase(p, period) {
  const bins = Math.max(4, Math.round(period));
  const acc = new Float64Array(bins);
  for (let i = 0; i < p.length; i++) acc[Math.floor(((i % period) / period) * bins) % bins] += p[i];
  let best = 0;
  for (let i = 1; i < bins; i++) if (acc[i] > acc[best]) best = i;
  // centre of mass around the peak
  let m = 0, w = 0;
  for (let d = -1; d <= 1; d++) { const j = (best + d + bins) % bins; m += (best + d) * acc[j]; w += acc[j]; }
  const at = w ? m / w : best;
  const ratio = acc[best] / (acc.reduce((x, y) => x + y, 0) / bins || 1);
  return { off: ((at + 0.5) / bins) * period, ratio };
}

// Returns { size, ox, oy, cols, rows, confidence } in image pixels, or null when no grid is printed.
export function detectGrid(img, { minSquares = 6, maxSquares = 80 } = {}) {
  const { col, row, k, W, H } = profiles(img);
  const c = detrend(col, 6), r = detrend(row, 6);
  const lo = Math.max(6, Math.floor(Math.max(W, H) / maxSquares)), hi = Math.floor(Math.max(W, H) / minSquares);
  const scores = [];
  for (let lag = lo; lag <= hi; lag++) scores.push([lag, (autocorr(c, lag) + autocorr(r, lag)) / 2]);
  if (!scores.length) return null;
  // local peaks; prefer the smallest period that is nearly as strong as the best (harmonics repeat it)
  const peaks = scores.filter(([, v], i) => i > 0 && i < scores.length - 1 && v >= scores[i - 1][1] && v >= scores[i + 1][1]);
  if (!peaks.length) return null;
  const top = Math.max(...peaks.map(p => p[1]));
  const pick = peaks.find(p => p[1] >= top * 0.85);
  // refine to a fractional period: average the lag over the whole length
  let period = pick[0];
  let bestR = -1;
  for (let f = period - 1; f <= period + 1; f += 0.05) {
    const pc = phase(c, f).ratio + phase(r, f).ratio;
    if (pc > bestR) { bestR = pc; period = f; }
  }
  const pc = phase(c, period), pr = phase(r, period);
  const confidence = Math.min(1, (pick[1] - 0.1) / 0.5) * Math.min(1, (Math.min(pc.ratio, pr.ratio) - 1) / 2);
  if (pick[1] < 0.22 || pc.ratio < 1.8 || pr.ratio < 1.8) return null;
  const size = period / k;
  const ox = (pc.off / k) % size, oy = (pr.off / k) % size;
  return { size, ox, oy, cols: Math.round((img.width - ox) / size), rows: Math.round((img.height - oy) / size), confidence: Math.max(0, confidence) };
}

// From a box the DM drew over a known number of squares.
export function gridFromBox(box, across, down) {
  const size = (box.w / across + box.h / down) / 2;
  return { size, ox: ((box.x % size) + size) % size, oy: ((box.y % size) + size) % size };
}

// Guess how many squares a drawn box covers, for the prompt's starting values.
export function guessCount(box, size) {
  return { across: Math.max(1, Math.round(box.w / size)), down: Math.max(1, Math.round(box.h / size)) };
}

// For the Image Kit: crop a picture (centre) to exactly cols:rows, sized so each square is whole pixels.
export function cropToSquares(img, cols, rows, maxW = 2048) {
  const target = cols / rows, have = img.width / img.height;
  let sw = img.width, sh = img.height, sx = 0, sy = 0;
  if (have > target) { sw = img.height * target; sx = (img.width - sw) / 2; }
  else { sh = img.width / target; sy = (img.height - sh) / 2; }
  const cell = Math.max(8, Math.floor(Math.min(maxW, sw) / cols));
  return { sx, sy, sw, sh, w: cell * cols, h: cell * rows, cell };
}
