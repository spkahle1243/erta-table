// Manual fog of war. A scene's fog is an ordered list of reveal/hide shapes
// in scene pixels; the mask is rebuilt from that list (incrementally when the
// list only grew).

export class FogMask {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.key = null; this.count = 0; this.scale = 1;
    this._data = null;
  }

  // Returns the mask canvas (opaque = fogged) for the scene, at most `maxPx` on its long side.
  update(scene, maxPx = 2048) {
    const ops = scene.fog.ops;
    const key = scene.id + ':' + scene.width + 'x' + scene.height;
    const scale = Math.min(1, maxPx / Math.max(scene.width, scene.height));
    const w = Math.max(1, Math.round(scene.width * scale)), h = Math.max(1, Math.round(scene.height * scale));
    let from = 0;
    // Ops arrive as fresh objects over the network, so compare content, not identity.
    const sig = i => (i >= 0 && ops[i] ? JSON.stringify(ops[i]) : '');
    const unchanged = ops.length >= this.count && sig(0) === this._first && sig(this.count - 1) === this._last;
    if (key !== this.key || this.canvas.width !== w || !unchanged) {
      this.canvas.width = w; this.canvas.height = h;
      this.key = key; this.scale = scale; this.count = 0;
      const c = this.ctx;
      c.globalCompositeOperation = 'source-over';
      c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
    } else from = this.count;
    for (let i = from; i < ops.length; i++) drawOp(this.ctx, ops[i], scale, w, h);
    this.count = ops.length;
    this._first = sig(0); this._last = sig(this.count - 1);
    this._data = null;
    return this.canvas;
  }

  // true if the scene-pixel point is fogged
  fogged(x, y) {
    if (!this._data) this._data = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
    const px = Math.floor(x * this.scale), py = Math.floor(y * this.scale);
    if (px < 0 || py < 0 || px >= this.canvas.width || py >= this.canvas.height) return true;
    return this._data[(py * this.canvas.width + px) * 4 + 3] > 127;
  }
}

export function drawOp(c, op, s, w, h) {
  c.save();
  c.globalCompositeOperation = op.m === 'reveal' ? 'destination-out' : 'source-over';
  c.fillStyle = '#000'; c.strokeStyle = '#000';
  switch (op.s) {
    case 'all': c.fillRect(0, 0, w, h); break;
    case 'rect': c.fillRect(op.x * s, op.y * s, op.w * s, op.h * s); break;
    case 'circle': c.beginPath(); c.arc(op.x * s, op.y * s, op.r * s, 0, Math.PI * 2); c.fill(); break;
    case 'poly': {
      c.beginPath();
      for (let i = 0; i < op.pts.length; i += 2) (i ? c.lineTo : c.moveTo).call(c, op.pts[i] * s, op.pts[i + 1] * s);
      c.closePath(); c.fill(); break;
    }
    case 'brush': {
      c.lineWidth = op.r * 2 * s; c.lineCap = 'round'; c.lineJoin = 'round';
      c.beginPath();
      const p = op.pts;
      if (p.length === 2) { c.arc(p[0] * s, p[1] * s, op.r * s, 0, Math.PI * 2); c.fill(); break; }
      for (let i = 0; i < p.length; i += 2) (i ? c.lineTo : c.moveTo).call(c, p[i] * s, p[i + 1] * s);
      c.stroke(); break;
    }
  }
  c.restore();
}

// Drops points closer than `minDist` to keep brush strokes small on the wire.
export function simplify(pts, minDist) {
  if (pts.length <= 4) return pts;
  const out = [pts[0], pts[1]];
  let lx = pts[0], ly = pts[1];
  for (let i = 2; i < pts.length; i += 2) {
    const dx = pts[i] - lx, dy = pts[i + 1] - ly;
    if (dx * dx + dy * dy >= minDist * minDist || i === pts.length - 2) { out.push(Math.round(pts[i]), Math.round(pts[i + 1])); lx = pts[i]; ly = pts[i + 1]; }
  }
  return out;
}

// After a full reveal/hide, earlier ops no longer matter.
export function compact(ops) {
  for (let i = ops.length - 1; i > 0; i--) if (ops[i].s === 'all') return ops.slice(i);
  return ops;
}
