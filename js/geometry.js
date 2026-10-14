// Grid geometry shared by the map and the rules engine.
import { cellDistance } from './model.js';

export const CONE_HALF = Math.atan(0.5); // 2024: a cone is as wide as it is far from its origin

export function cellCenter(grid, cx, cy) { return { x: grid.ox + (cx + 0.5) * grid.size, y: grid.oy + (cy + 0.5) * grid.size }; }
export function tplPx(grid, t) { return t.len / grid.feet * grid.size; }

export function inTemplate(grid, t, x, y) {
  const L = tplPx(grid, t), dx = x - t.x, dy = y - t.y;
  switch (t.shape) {
    case 'circle': return dx * dx + dy * dy <= L * L + 1;
    case 'cube': return x >= t.x - 0.5 && x <= t.x + L + 0.5 && y >= t.y - 0.5 && y <= t.y + L + 0.5;
    case 'cone': {
      const d = Math.hypot(dx, dy);
      if (d > L + 1 || d < 1) return false;
      let a = Math.atan2(dy, dx) - t.dir; a = Math.atan2(Math.sin(a), Math.cos(a));
      return Math.abs(a) <= CONE_HALF + 0.001;
    }
    case 'line': {
      const W = grid.size * (t.wid || grid.feet) / grid.feet;
      const ux = Math.cos(t.dir), uy = Math.sin(t.dir);
      const along = dx * ux + dy * uy, across = -dx * uy + dy * ux;
      return along >= 0 && along <= L + 0.5 && Math.abs(across) <= W / 2 + 0.5;
    }
  }
  return false;
}

export function templateCells(grid, t) {
  const L = tplPx(grid, t) + grid.size;
  const x0 = Math.floor((t.x - L - grid.ox) / grid.size), x1 = Math.ceil((t.x + L - grid.ox) / grid.size);
  const y0 = Math.floor((t.y - L - grid.oy) / grid.size), y1 = Math.ceil((t.y + L - grid.oy) / grid.size);
  const out = [];
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
    const c = cellCenter(grid, cx, cy);
    if (inTemplate(grid, t, c.x, c.y)) out.push([cx, cy]);
  }
  return out;
}

export function tokensInTemplate(grid, tokens, t) {
  const cells = new Set(templateCells(grid, t).map(c => c.join(',')));
  return tokens.filter(tk => {
    const s = tk.size || 1;
    for (let i = 0; i < s; i++) for (let j = 0; j < s; j++) if (cells.has((tk.x + i) + ',' + (tk.y + j))) return true;
    return false;
  });
}

// Feet between the nearest squares of two tokens.
export function tokenDistanceFt(grid, a, b, mode = 'equal') {
  const sa = a.size || 1, sb = b.size || 1;
  const dx = Math.max(0, Math.max(a.x - (b.x + sb - 1), b.x - (a.x + sa - 1)));
  const dy = Math.max(0, Math.max(a.y - (b.y + sb - 1), b.y - (a.y + sa - 1)));
  return cellDistance(dx, dy, mode) * grid.feet;
}
