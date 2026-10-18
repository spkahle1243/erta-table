// The map: background, grid, fog, templates, tokens, rulers and pings, with
// pan/zoom and the pointer tools. Used by both the DM and the player views.

import { FogMask, simplify } from './fog.js';
import { iconPaths, COND_BY_ID, condId, condLevel } from './conditions.js';
import { DISPOSITION_COLORS, cellDistance } from './model.js';
import { clamp } from './util.js';
import * as geo from './geometry.js';
import { blockers, visPolygon, pointInPoly, pxPerFt, doorHandle } from './vision.js';

const CONE_HALF = geo.CONE_HALF;
const BACKDROP = '#0d1213';

export class MapView {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.o = opts;
    this.role = opts.role;
    this.scene = null;
    this.cam = { x: 0, y: 0, z: 1 };
    this.tool = 'select';
    this.fogBrush = 90;
    this.selected = new Set();
    this.selectedTpl = null;
    this.hover = null;
    this.images = new Map();
    this.fog = new FogMask();
    this.fogTint = document.createElement('canvas');
    this.remoteRulers = new Map(); // key -> { pts, color, name, t }
    this.remoteDrags = new Map();  // tokenId -> { x, y, t }
    this.pings = [];
    this.targets = new Map(); // tokenId -> [colors]
    this.placing = null;     // { shape, len, cb } while placing a spell's area
    this.action = null;
    this.pointers = new Map();
    this.myColor = opts.color || '#66C39D';
    this.showWalls = false;      // DM: draw walls and lights even outside the wall tools
    this.previewVision = false;  // DM: show what the party's tokens can see
    this.visMask = document.createElement('canvas');
    this.visTint = document.createElement('canvas');
    this.explored = new Map();   // sceneId -> canvas of everywhere this viewer has seen
    this._visPolys = [];
    this._visKey = null;
    this.dirty = true;
    this._bind();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas);
    const loop = () => { this._frame(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------ state in

  setScene(scene) {
    const changed = !this.scene || this.scene.id !== scene?.id || this.scene.bg !== scene?.bg || this.scene.width !== scene?.width;
    this.scene = scene;
    if (scene) {
      for (const [id] of this.remoteDrags) if (!scene.tokens.some(t => t.id === id)) this.remoteDrags.delete(id);
      if (this.selectedTpl && !scene.templates.some(t => t.id === this.selectedTpl)) this.selectedTpl = null;
      for (const id of [...this.selected]) if (!scene.tokens.some(t => t.id === id)) this.selected.delete(id);
      if (scene.fog.on) this._updateFog();
    }
    if (changed) { this.remoteDrags.clear(); this.fit(); }
    this.dirty = true;
  }

  _updateFog() {
    const s = this.scene;
    this.fog.update(s, 2048);
    const m = this.fog.canvas, t = this.fogTint;
    t.width = m.width; t.height = m.height;
    const c = t.getContext('2d');
    c.clearRect(0, 0, t.width, t.height);
    c.globalCompositeOperation = 'source-over';
    c.drawImage(m, 0, 0);
    c.globalCompositeOperation = 'source-in';
    c.fillStyle = this.role === 'dm' ? '#05090a' : '#0b1112';
    c.fillRect(0, 0, t.width, t.height);
    c.globalCompositeOperation = 'source-over';
  }

  isFogged(x, y) { return !!this.scene?.fog.on && this.fog.fogged(x, y); }

  setTool(t) { this.tool = t; this.action = null; this.canvas.dataset.tool = t; if (!t.startsWith('tpl:')) this._cancelPlacing(); this.dirty = true; }
  resetExplored(sceneId) { if (sceneId) this.explored.delete(sceneId); else this.explored.clear(); this._visKey = null; this.dirty = true; }
  setTargets(map) { this.targets = map || new Map(); this.dirty = true; }

  // Place a fixed-size area for a spell or action; cb(template) on release, cb(null) if cancelled.
  placeArea(spec, cb) {
    this._cancelPlacing();
    this.setTool('tpl:' + spec.shape);
    this.placing = { ...spec, cb };
    this.dirty = true;
  }
  _cancelPlacing() { const p = this.placing; this.placing = null; if (p) p.cb(null); }
  _finishPlacing(tpl) { const p = this.placing; this.placing = null; this.tool = 'select'; this.canvas.dataset.tool = 'select'; this.o.onToolChange?.('select'); p.cb(tpl); }

  // ------------------------------------------------------------ geometry

  get g() { return this.scene?.grid.size || 100; }
  toWorld(sx, sy) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (sx - r.left - r.width / 2) / this.cam.z + this.cam.x, y: (sy - r.top - r.height / 2) / this.cam.z + this.cam.y };
  }
  cellAt(wx, wy) { const gr = this.scene.grid; return { cx: Math.floor((wx - gr.ox) / gr.size), cy: Math.floor((wy - gr.oy) / gr.size) }; }
  cellCenter(cx, cy) { const gr = this.scene.grid; return { x: gr.ox + (cx + 0.5) * gr.size, y: gr.oy + (cy + 0.5) * gr.size }; }
  snapCorner(wx, wy) { const gr = this.scene.grid; return { x: gr.ox + Math.round((wx - gr.ox) / gr.size) * gr.size, y: gr.oy + Math.round((wy - gr.oy) / gr.size) * gr.size }; }
  tokenPos(t) {
    const d = this.action?.kind === 'drag' && this.action.id === t.id ? this.action : this.remoteDrags.get(t.id);
    return d ? { x: d.x, y: d.y } : { x: t.x, y: t.y };
  }
  tokenCenter(t) { const gr = this.scene.grid, p = this.tokenPos(t), s = t.size || 1; return { x: gr.ox + (p.x + s / 2) * gr.size, y: gr.oy + (p.y + s / 2) * gr.size }; }

  fit() {
    const s = this.scene; if (!s) return;
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) { this._fitted = false; return; }
    this._fitted = true;
    this.cam.z = Math.min(r.width / s.width, r.height / s.height) * 0.96;
    this.cam.x = s.width / 2; this.cam.y = s.height / 2;
    this.dirty = true;
  }
  centerOn(x, y, z) { this.cam.x = x; this.cam.y = y; if (z) this.cam.z = z; this.dirty = true; }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    if (this.scene && !this._fitted && r.width && r.height) this.fit();
    this.dirty = true;
  }

  // ------------------------------------------------------------ images

  _img(id) {
    if (!id) return null;
    let e = this.images.get(id);
    if (!e) {
      e = { img: null };
      this.images.set(id, e);
      this.o.getUrl(id).then(url => {
        if (!url) { this.images.delete(id); return; }
        const img = new Image();
        img.onload = () => { e.img = img; this.dirty = true; };
        img.onerror = () => this.images.delete(id);
        img.src = url;
      }).catch(() => this.images.delete(id));
    }
    return e.img;
  }

  // ------------------------------------------------------------ remote overlays

  addPing(x, y, color, pull = false) {
    this.pings.push({ x, y, color: color || this.myColor, t: performance.now(), pull });
    if (pull) this.centerOn(x, y);
    this.dirty = true;
  }
  setRemoteRuler(key, data) { if (data) this.remoteRulers.set(key, { ...data, t: performance.now() }); else this.remoteRulers.delete(key); this.dirty = true; }
  setRemoteDrag(id, x, y) { if (x == null) this.remoteDrags.delete(id); else this.remoteDrags.set(id, { x, y, t: performance.now() }); this.dirty = true; }

  // ------------------------------------------------------------ input

  _bind() {
    const c = this.canvas;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => this._down(e));
    c.addEventListener('pointermove', e => this._move(e));
    c.addEventListener('pointerup', e => this._up(e));
    c.addEventListener('pointercancel', e => { this.pointers.delete(e.pointerId); this.action = null; this.dirty = true; });
    c.addEventListener('pointerleave', () => { if (this.hover) { this.hover = null; this.dirty = true; } });
    c.addEventListener('wheel', e => this._wheel(e), { passive: false });
    c.addEventListener('dblclick', e => {
      const w = this.toWorld(e.clientX, e.clientY);
      const t = this.hitToken(w.x, w.y);
      if (t) this.o.onTokenDblClick?.(t.id);
    });
    c.addEventListener('dragover', e => { e.preventDefault(); });
    c.addEventListener('drop', e => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files || []);
      const w = this.toWorld(e.clientX, e.clientY);
      if (files.length) this.o.onDropFiles?.(files, w.x, w.y);
      const data = e.dataTransfer?.getData('text/erta-token');
      if (data) this.o.onDropData?.(data, w.x, w.y);
    });
    window.addEventListener('keydown', e => this._key(e));
  }

  _wheel(e) {
    e.preventDefault();
    const before = this.toWorld(e.clientX, e.clientY);
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    this.cam.z = clamp(this.cam.z * f, 0.05, 6);
    const after = this.toWorld(e.clientX, e.clientY);
    this.cam.x += before.x - after.x; this.cam.y += before.y - after.y;
    this.dirty = true;
  }

  _down(e) {
    if (!this.scene) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) { // pinch
      const [a, b] = [...this.pointers.values()];
      this.action = { kind: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), z: this.cam.z, mid: this.toWorld((a.x + b.x) / 2, (a.y + b.y) / 2) };
      return;
    }
    const w = this.toWorld(e.clientX, e.clientY);
    const start = { sx: e.clientX, sy: e.clientY, wx: w.x, wy: w.y };
    if (e.button === 2 && this.role === 'dm') {
      if (this.tool === 'wall' || this.tool === 'door') { const wl = this.hitWall(w.x, w.y); if (wl) { this.o.onWallRemove?.(wl.id); this.action = { kind: 'none' }; return; } }
      if (this.tool === 'light') { const l = this.hitLight(w.x, w.y); if (l) { this.o.onLightRemove?.(l.id); this.action = { kind: 'none' }; return; } }
      const d = this.hitDoor(w.x, w.y);
      if (d) { this.o.onDoorContext?.(d.id, e.clientX, e.clientY); this.action = { kind: 'none' }; return; }
    }
    if (e.button === 1 || e.button === 2) {
      const t = e.button === 2 ? this.hitToken(w.x, w.y) : null;
      this.action = { kind: 'pan', ...start, cx: this.cam.x, cy: this.cam.y, ctxToken: t?.id, button: e.button };
      return;
    }
    const tool = this.tool;
    if (tool === 'wall' || tool === 'door') {
      const p = this.snapWall(w.x, w.y, e.shiftKey);
      this.action = { kind: 'wall', door: tool === 'door', x1: p.x, y1: p.y, x2: p.x, y2: p.y, free: e.shiftKey };
      this.dirty = true; return;
    }
    if (tool === 'light') {
      const { cx, cy } = this.cellAt(w.x, w.y);
      const p = e.shiftKey ? w : this.cellCenter(cx, cy);
      this.o.onLightAdd?.(Math.round(p.x), Math.round(p.y));
      this.action = { kind: 'none' }; return;
    }
    if (tool === 'select') {
      const door = this.hitDoor(w.x, w.y);
      if (door) { this.o.onDoor?.(door.id); this.action = { kind: 'none' }; return; }
      // template delete handle
      if (this.selectedTpl) {
        const tp = this.scene.templates.find(x => x.id === this.selectedTpl);
        if (tp && this._hitTplClose(tp, w.x, w.y)) { this.o.onTemplateRemove?.(tp.id); this.selectedTpl = null; this.dirty = true; return; }
      }
      const t = this.hitToken(w.x, w.y);
      if (t) {
        if (e.shiftKey) { this.selected.has(t.id) ? this.selected.delete(t.id) : this.selected.add(t.id); }
        else if (!this.selected.has(t.id)) { this.selected.clear(); this.selected.add(t.id); }
        this.selectedTpl = null;
        this.o.onSelect?.([...this.selected]);
        if (this.o.canMoveToken(t)) {
          const p = this.tokenPos(t);
          this.action = { kind: 'drag', id: t.id, ...start, ox: p.x, oy: p.y, x: p.x, y: p.y, size: t.size || 1, moved: false };
        }
        this.dirty = true;
        return;
      }
      const tp = this.hitTemplate(w.x, w.y);
      if (tp) { this.selectedTpl = tp.id; this.selected.clear(); this.o.onSelect?.([]); this.dirty = true; this.action = { kind: 'none' }; return; }
      if (this.selected.size || this.selectedTpl) { this.selected.clear(); this.selectedTpl = null; this.o.onSelect?.([]); this.dirty = true; }
      this.action = { kind: 'pan', ...start, cx: this.cam.x, cy: this.cam.y, longPress: setTimeout(() => {
        if (this.action?.kind === 'pan' && !this.action.moved) { this._ping(w.x, w.y, e.shiftKey); this.action = { kind: 'none' }; }
      }, 550) };
      return;
    }
    if (tool === 'ping') { this._ping(w.x, w.y, e.shiftKey); this.action = { kind: 'none' }; return; }
    if (tool === 'ruler') {
      const { cx, cy } = this.cellAt(w.x, w.y);
      const p = this.cellCenter(cx, cy);
      this.action = { kind: 'ruler', pts: [p.x, p.y, p.x, p.y] };
      this.dirty = true; return;
    }
    if (tool.startsWith('tpl:')) {
      const shape = tool.slice(4);
      const o = this.snapCorner(w.x, w.y);
      const P = this.placing;
      this.action = { kind: 'tpl', tpl: { shape, x: o.x, y: o.y, dir: 0, len: P ? P.len : 5, color: this.myColor }, sx: o.x, sy: o.y };
      this.dirty = true; return;
    }
    if (tool.startsWith('fog:')) {
      const [mode, shape] = tool.slice(4).split('-');
      this.action = shape === 'brush' ? { kind: 'fogbrush', m: mode, pts: [w.x, w.y] } : { kind: 'fogrect', m: mode, x0: w.x, y0: w.y, x1: w.x, y1: w.y };
      this.dirty = true; return;
    }
  }

  _move(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const w = this.toWorld(e.clientX, e.clientY);
    this.cursor = w;
    const a = this.action;
    if (!a) {
      const h = this.scene ? this.hitToken(w.x, w.y)?.id || null : null;
      if (h !== this.hover) { this.hover = h; this.dirty = true; }
      if (this.tool.startsWith('fog:') || this.placing) this.dirty = true;
      return;
    }
    if (a.kind === 'pinch' && this.pointers.size === 2) {
      const [p, q] = [...this.pointers.values()];
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      this.cam.z = clamp(a.z * d / a.d, 0.05, 6);
      const mid = this.toWorld((p.x + q.x) / 2, (p.y + q.y) / 2);
      this.cam.x += a.mid.x - mid.x; this.cam.y += a.mid.y - mid.y;
      this.dirty = true; return;
    }
    const moved = Math.hypot(e.clientX - (a.sx ?? e.clientX), e.clientY - (a.sy ?? e.clientY)) > 6;
    if (a.kind === 'pan') {
      if (moved) { a.moved = true; clearTimeout(a.longPress); }
      if (a.moved) { this.cam.x = a.cx - (e.clientX - a.sx) / this.cam.z; this.cam.y = a.cy - (e.clientY - a.sy) / this.cam.z; this.dirty = true; }
      return;
    }
    if (a.kind === 'drag') {
      if (!moved && !a.moved) return;
      a.moved = true;
      const gr = this.scene.grid;
      a.x = a.ox + (w.x - a.wx) / gr.size; a.y = a.oy + (w.y - a.wy) / gr.size;
      this.o.onTokenDrag?.(a.id, a.x, a.y, false);
      this.dirty = true; return;
    }
    if (a.kind === 'ruler') {
      const { cx, cy } = this.cellAt(w.x, w.y);
      const p = this.cellCenter(cx, cy);
      if (a.pts[2] !== p.x || a.pts[3] !== p.y) { a.pts[2] = p.x; a.pts[3] = p.y; this.o.onRuler?.(a.pts.slice()); this.dirty = true; }
      return;
    }
    if (a.kind === 'tpl') {
      const t = a.tpl, gr = this.scene.grid;
      const dx = w.x - a.sx, dy = w.y - a.sy;
      if (this.placing) {
        if (Math.hypot(dx, dy) > 4) t.dir = Math.atan2(dy, dx);
        if (t.shape === 'cube') { const side = t.len / gr.feet * gr.size; t.x = dx < 0 ? a.sx - side : a.sx; t.y = dy < 0 ? a.sy - side : a.sy; }
        this.dirty = true; return;
      }
      const distFt = Math.hypot(dx, dy) / gr.size * gr.feet;
      t.len = Math.max(gr.feet, Math.round(distFt / gr.feet) * gr.feet);
      t.dir = Math.atan2(dy, dx);
      if (t.shape === 'cube') {
        const side = Math.max(1, Math.round(Math.max(Math.abs(dx), Math.abs(dy)) / gr.size)) * gr.size;
        t.len = side / gr.size * gr.feet;
        t.x = dx < 0 ? a.sx - side : a.sx; t.y = dy < 0 ? a.sy - side : a.sy;
      }
      this.dirty = true; return;
    }
    if (a.kind === 'wall') { const p = this.snapWall(w.x, w.y, e.shiftKey || a.free); a.x2 = p.x; a.y2 = p.y; this.dirty = true; return; }
    if (a.kind === 'fogrect') { a.x1 = w.x; a.y1 = w.y; this.dirty = true; return; }
    if (a.kind === 'fogbrush') { a.pts.push(w.x, w.y); this.dirty = true; return; }
  }

  _up(e) {
    this.pointers.delete(e.pointerId);
    const a = this.action;
    this.action = null;
    if (!a) return;
    const gr = this.scene?.grid;
    if (a.kind === 'pan') {
      clearTimeout(a.longPress);
      if (a.button === 2 && !a.moved && a.ctxToken) this.o.onTokenContext?.(a.ctxToken, e.clientX, e.clientY);
      return;
    }
    if (a.kind === 'drag') {
      if (a.moved) {
        const x = Math.round(a.x), y = Math.round(a.y);
        const t = this.scene.tokens.find(t => t.id === a.id);
        if (t) { t.x = x; t.y = y; }
        this.o.onTokenDrag?.(a.id, x, y, true);
      }
      this.dirty = true; return;
    }
    if (a.kind === 'ruler') { this.o.onRuler?.(null); this.dirty = true; return; }
    if (a.kind === 'tpl') {
      const t = a.tpl;
      if (t.shape === 'cube' && t.len < gr.feet) t.len = gr.feet;
      if (this.placing) { this._finishPlacing({ shape: t.shape, x: Math.round(t.x), y: Math.round(t.y), dir: +t.dir.toFixed(4), len: t.len, color: t.color }); this.dirty = true; return; }
      this.o.onTemplateAdd?.({ shape: t.shape, x: Math.round(t.x), y: Math.round(t.y), dir: +t.dir.toFixed(4), len: t.len, color: t.color });
      this.dirty = true; return;
    }
    if (a.kind === 'wall') {
      if (Math.hypot(a.x2 - a.x1, a.y2 - a.y1) >= this.g * 0.2) this.o.onWallAdd?.({ x1: Math.round(a.x1), y1: Math.round(a.y1), x2: Math.round(a.x2), y2: Math.round(a.y2), door: a.door });
      this.dirty = true; return;
    }
    if (a.kind === 'fogrect') {
      const x = Math.min(a.x0, a.x1), y = Math.min(a.y0, a.y1), w = Math.abs(a.x1 - a.x0), h = Math.abs(a.y1 - a.y0);
      if (w > 4 && h > 4) this.o.onFog?.({ m: a.m, s: 'rect', x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
      this.dirty = true; return;
    }
    if (a.kind === 'fogbrush') {
      this.o.onFog?.({ m: a.m, s: 'brush', r: Math.round(this.fogBrush), pts: simplify(a.pts.map(Math.round), this.fogBrush / 4) });
      this.dirty = true; return;
    }
  }

  _ping(x, y, pull) {
    const p = pull && this.role === 'dm';
    this.addPing(x, y, this.myColor, false);
    this.o.onPing?.(x, y, p);
  }

  _key(e) {
    if (!this.scene || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'Escape' && this.placing) { this._cancelPlacing(); this.setTool('select'); this.o.onToolChange?.('select'); return; }
    if (e.key === 'Escape') { this.selected.clear(); this.selectedTpl = null; this.action = null; this.o.onSelect?.([]); this.dirty = true; return; }
    if ((e.key === 'Delete' || e.key === 'Backspace')) {
      if (this.selectedTpl) { this.o.onTemplateRemove?.(this.selectedTpl); this.selectedTpl = null; e.preventDefault(); return; }
      if (this.selected.size) { this.o.onTokenDelete?.([...this.selected]); e.preventDefault(); }
      return;
    }
    const arrows = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (arrows[e.key] && this.selected.size) {
      const [dx, dy] = arrows[e.key];
      for (const id of this.selected) {
        const t = this.scene.tokens.find(t => t.id === id);
        if (t && this.o.canMoveToken(t)) { t.x += dx; t.y += dy; this.o.onTokenDrag?.(id, t.x, t.y, true); }
      }
      e.preventDefault(); this.dirty = true;
    }
  }

  // ------------------------------------------------------------ hit tests

  hitToken(wx, wy) {
    const s = this.scene; if (!s) return null;
    for (let i = s.tokens.length - 1; i >= 0; i--) {
      const t = s.tokens[i];
      const c = this.tokenCenter(t), r = (t.size || 1) * s.grid.size / 2;
      if (Math.hypot(wx - c.x, wy - c.y) <= r * 0.95) return t;
    }
    return null;
  }
  hitDoor(wx, wy) {
    const s = this.scene; if (!s?.walls) return null;
    const r = this.g * 0.3;
    for (const w of s.walls) {
      if (!w.door) continue;
      const h = doorHandle(w);
      if (Math.hypot(wx - h.x, wy - h.y) > r) continue;
      if (this.role !== 'dm' && !this.doorVisible(w)) continue;
      return w;
    }
    return null;
  }
  doorVisible(w) {
    const s = this.scene, h = doorHandle(w);
    if (this.role === 'dm') return true;
    if (this.isFogged(h.x, h.y)) return false;
    if (!s.vision?.on) return true;
    return this._visPolys.some(p => pointInPoly(p, h.x, h.y));
  }
  hitWall(wx, wy) {
    const s = this.scene; let best = null, bd = this.g * 0.25;
    for (const w of s.walls || []) { const d = segDist(wx, wy, w); if (d < bd) { bd = d; best = w; } }
    return best;
  }
  hitLight(wx, wy) {
    const s = this.scene; let best = null, bd = this.g * 0.45;
    for (const l of s.lights || []) { const d = Math.hypot(wx - l.x, wy - l.y); if (d < bd) { bd = d; best = l; } }
    return best;
  }
  // Wall ends snap to an existing wall's end, else a grid corner (Shift: no snap).
  snapWall(wx, wy, free) {
    const s = this.scene, r = this.g * 0.25;
    for (const w of s.walls || []) for (const [x, y] of [[w.x1, w.y1], [w.x2, w.y2]]) if (Math.hypot(wx - x, wy - y) < r) return { x, y };
    if (free) return { x: Math.round(wx), y: Math.round(wy) };
    return this.snapCorner(wx, wy);
  }

  hitTemplate(wx, wy) {
    const s = this.scene;
    for (let i = s.templates.length - 1; i >= 0; i--) if (this.inTemplate(s.templates[i], wx, wy)) return s.templates[i];
    return null;
  }
  _hitTplClose(t, wx, wy) { const p = this._tplHandle(t); return Math.hypot(wx - p.x, wy - p.y) < this.g * 0.3; }
  _tplHandle(t) { return t.shape === 'cube' ? { x: t.x, y: t.y } : { x: t.x, y: t.y }; }

  tplPx(t) { return geo.tplPx(this.scene.grid, t); }
  inTemplate(t, x, y) { return geo.inTemplate(this.scene.grid, t, x, y); }
  templateCells(t) { return geo.templateCells(this.scene.grid, t); }
  tokensInTemplate(t) { return geo.tokensInTemplate(this.scene.grid, this.scene.tokens, t); }

  // ------------------------------------------------------------ drawing

  _frame() {
    const now = performance.now();
    this.pings = this.pings.filter(p => now - p.t < 1800);
    for (const [k, r] of this.remoteRulers) if (now - r.t > 8000) this.remoteRulers.delete(k);
    for (const [k, d] of this.remoteDrags) if (now - d.t > 4000) this.remoteDrags.delete(k);
    if (!this.dirty && !this.pings.length) return;
    this.dirty = false;
    this._draw();
  }

  _draw() {
    const c = this.ctx, cv = this.canvas, dpr = window.devicePixelRatio || 1;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = BACKDROP; c.fillRect(0, 0, cv.width, cv.height);
    const s = this.scene;
    if (!s) return;
    const z = this.cam.z * dpr;
    c.setTransform(z, 0, 0, z, cv.width / 2 - this.cam.x * z, cv.height / 2 - this.cam.y * z);
    const gr = s.grid;

    // background
    const bg = this._img(s.bg);
    if (bg) c.drawImage(bg, 0, 0, s.width, s.height);
    else { c.fillStyle = '#1b2224'; c.fillRect(0, 0, s.width, s.height); }

    // grid
    if (gr.show && s.kind !== 'art') this._drawGrid(c, s);

    // fog (players: opaque; DM: translucent so you can still see what's under it)
    if (s.fog.on && s.kind !== 'art') {
      c.save();
      c.globalAlpha = this.role === 'dm' ? 0.5 : 1;
      c.imageSmoothingEnabled = true;
      c.drawImage(this.fogTint, 0, 0, s.width, s.height);
      c.restore();
    }

    // templates
    for (const t of s.templates) this._drawTemplate(c, t, t.id === this.selectedTpl);
    if (this.action?.kind === 'tpl') this._drawTemplate(c, this.action.tpl, true, true);
    else if (this.placing && this.cursor) { const o = this.snapCorner(this.cursor.x, this.cursor.y); this._drawTemplate(c, { shape: this.placing.shape, x: o.x, y: o.y, dir: 0, len: this.placing.len, color: this.myColor }, true, true); }

    // what the party can see (players always when vision is on; the DM when previewing)
    if (s.vision?.on && s.kind !== 'art' && (this.role !== 'dm' || this.previewVision)) {
      this._updateVision();
      c.save(); c.globalAlpha = this.role === 'dm' ? 0.75 : 1; c.drawImage(this.visTint, 0, 0, s.width, s.height); c.restore();
    } else this._visPolys = [];
    // walls, doors and lights
    this._drawWalls(c, s);

    // tokens
    const order = s.tokens.slice().sort((a, b) => (b.size || 1) - (a.size || 1));
    const dragId = this.action?.kind === 'drag' ? this.action.id : null;
    for (const t of order) if (t.id !== dragId) this._drawToken(c, t);
    if (dragId) { const t = s.tokens.find(t => t.id === dragId); if (t) this._drawToken(c, t, true); }

    // drag distance
    if (this.action?.kind === 'drag' && this.action.moved) {
      const a = this.action, sz = a.size;
      const from = { x: gr.ox + (a.ox + sz / 2) * gr.size, y: gr.oy + (a.oy + sz / 2) * gr.size };
      const to = { x: gr.ox + (Math.round(a.x) + sz / 2) * gr.size, y: gr.oy + (Math.round(a.y) + sz / 2) * gr.size };
      this._drawRuler(c, [from.x, from.y, to.x, to.y], this.myColor);
    }
    // rulers
    if (this.action?.kind === 'ruler') this._drawRuler(c, this.action.pts, this.myColor);
    for (const r of this.remoteRulers.values()) this._drawRuler(c, r.pts, r.color, r.name);

    // fog tool previews
    const a = this.action;
    if (a?.kind === 'fogrect') {
      c.save(); c.fillStyle = a.m === 'reveal' ? 'rgba(102,195,157,.25)' : 'rgba(229,145,106,.3)';
      c.strokeStyle = a.m === 'reveal' ? '#66C39D' : '#E5916A'; c.lineWidth = 2 / this.cam.z; c.setLineDash([8 / this.cam.z, 6 / this.cam.z]);
      const x = Math.min(a.x0, a.x1), y = Math.min(a.y0, a.y1);
      c.fillRect(x, y, Math.abs(a.x1 - a.x0), Math.abs(a.y1 - a.y0)); c.strokeRect(x, y, Math.abs(a.x1 - a.x0), Math.abs(a.y1 - a.y0)); c.restore();
    }
    if (a?.kind === 'fogbrush') {
      c.save(); c.strokeStyle = a.m === 'reveal' ? 'rgba(102,195,157,.35)' : 'rgba(229,145,106,.4)';
      c.lineWidth = this.fogBrush * 2; c.lineCap = 'round'; c.lineJoin = 'round'; c.beginPath();
      for (let i = 0; i < a.pts.length; i += 2) (i ? c.lineTo : c.moveTo).call(c, a.pts[i], a.pts[i + 1]);
      c.stroke(); c.restore();
    }
    if (this.tool.endsWith('-brush') && this.cursor && !a) {
      c.save(); c.strokeStyle = 'rgba(255,255,255,.6)'; c.lineWidth = 1.5 / this.cam.z;
      c.beginPath(); c.arc(this.cursor.x, this.cursor.y, this.fogBrush, 0, Math.PI * 2); c.stroke(); c.restore();
    }

    // pings
    const now = performance.now();
    for (const p of this.pings) {
      const k = (now - p.t) / 1800;
      for (let i = 0; i < 3; i++) {
        const kk = (k * 1.6 - i * 0.22); if (kk < 0 || kk > 1) continue;
        c.save(); c.globalAlpha = 1 - kk; c.strokeStyle = p.color; c.lineWidth = (5 - 3 * kk) / this.cam.z * 1.4;
        c.beginPath(); c.arc(p.x, p.y, (12 + kk * 70) / this.cam.z, 0, Math.PI * 2); c.stroke(); c.restore();
      }
      c.save(); c.fillStyle = p.color; c.globalAlpha = Math.max(0, 1 - k);
      c.beginPath(); c.arc(p.x, p.y, 6 / this.cam.z, 0, Math.PI * 2); c.fill(); c.restore();
    }
  }

  // ------------------------------------------------------------ vision

  _viewers() {
    const s = this.scene;
    return s.tokens.filter(t => t.sight && (this.role !== 'dm' || t.kind === 'pc'));
  }

  _updateVision() {
    const s = this.scene;
    const viewers = this._viewers();
    const pos = viewers.map(t => { const p = this.tokenPos(t); return `${t.id}:${p.x.toFixed(2)},${p.y.toFixed(2)}:${t.sight.dv}:${t.sight.blind}`; }).join('|');
    const lit = s.tokens.filter(t => t.light).map(t => { const p = this.tokenPos(t); return `${p.x.toFixed(2)},${p.y.toFixed(2)},${t.light.bright},${t.light.dim}`; }).join('|');
    const key = [s.id, s.width, s.height, s.grid.size, s.grid.ox, s.grid.oy, s.vision?.light, JSON.stringify(s.walls || []), JSON.stringify(s.lights || []), JSON.stringify(s.unseenLights || []), pos, lit].join('#');
    if (key === this._visKey) return;
    this._visKey = key;
    const k = Math.min(1, 1600 / Math.max(s.width, s.height));
    const W = Math.max(1, Math.round(s.width * k)), H = Math.max(1, Math.round(s.height * k));
    const m = this.visMask; m.width = W; m.height = H;
    const c = m.getContext('2d');
    c.setTransform(k, 0, 0, k, 0, 0);
    c.clearRect(0, 0, s.width, s.height);
    c.fillStyle = '#000';
    const walls = blockers(s), box = { x0: 0, y0: 0, x1: s.width, y1: s.height }, ft = pxPerFt(s);
    const lights = [...(s.lights || []), ...(s.unseenLights || []), ...s.tokens.filter(t => t.light).map(t => ({ ...this.tokenCenter(t), ...t.light }))];
    const lightPolys = s.vision?.light === 'dark' ? lights.map(L => {
      const r = ((Number(L.bright) || 0) + (Number(L.dim) || 0)) * ft;
      return { L, r, poly: r > 0 ? visPolygon(walls, L.x, L.y, { x0: Math.max(0, L.x - r), y0: Math.max(0, L.y - r), x1: Math.min(s.width, L.x + r), y1: Math.min(s.height, L.y + r) }) : null };
    }) : [];
    const path = pts => { c.beginPath(); for (let i = 0; i < pts.length; i += 2) (i ? c.lineTo : c.moveTo).call(c, pts[i], pts[i + 1]); c.closePath(); };
    this._visPolys = [];
    for (const t of viewers) {
      const o = this.tokenCenter(t);
      const poly = visPolygon(walls, o.x, o.y, box);
      this._visPolys.push(poly);
      c.save(); path(poly); c.clip();
      if (s.vision?.light !== 'dark') c.fillRect(0, 0, s.width, s.height);
      else {
        const r = Math.max(t.sight.dv || 0, t.sight.blind || 0) * ft;
        if (r > 0) { c.beginPath(); c.arc(o.x, o.y, r, 0, Math.PI * 2); c.fill(); }
        for (const lp of lightPolys) { if (!lp.poly) continue; c.save(); path(lp.poly); c.clip(); c.beginPath(); c.arc(lp.L.x, lp.L.y, lp.r, 0, Math.PI * 2); c.fill(); c.restore(); }
      }
      c.restore();
    }
    // remember where this viewer has been
    let ex = this.explored.get(s.id);
    if (!ex || ex.width !== W || ex.height !== H) { ex = document.createElement('canvas'); ex.width = W; ex.height = H; this.explored.set(s.id, ex); }
    if (this.role !== 'dm') ex.getContext('2d').drawImage(m, 0, 0);
    const t = this.visTint; t.width = W; t.height = H;
    const tc = t.getContext('2d');
    tc.globalCompositeOperation = 'source-over'; tc.fillStyle = '#05090a'; tc.fillRect(0, 0, W, H);
    tc.globalCompositeOperation = 'destination-out';
    if (this.role !== 'dm') { tc.globalAlpha = 0.42; tc.drawImage(ex, 0, 0); }
    tc.globalAlpha = 1; tc.drawImage(m, 0, 0);
    tc.globalCompositeOperation = 'source-over';
  }

  _drawWalls(c, s) {
    const dm = this.role === 'dm';
    const showAll = dm && (this.showWalls || this.tool === 'wall' || this.tool === 'door' || this.tool === 'light');
    const z = this.cam.z, g = s.grid.size;
    if (showAll) {
      c.save(); c.lineCap = 'round';
      for (const w of s.walls || []) {
        c.strokeStyle = 'rgba(0,0,0,.6)'; c.lineWidth = 7 / z; c.beginPath(); c.moveTo(w.x1, w.y1); c.lineTo(w.x2, w.y2); c.stroke();
        c.strokeStyle = w.door ? (w.secret ? '#a98bd6' : w.open ? '#66C39D' : '#d6a73c') : '#E2E8E4';
        c.lineWidth = 3.5 / z; if (w.door && w.open) c.setLineDash([8 / z, 6 / z]);
        c.beginPath(); c.moveTo(w.x1, w.y1); c.lineTo(w.x2, w.y2); c.stroke(); c.setLineDash([]);
        c.fillStyle = '#E2E8E4'; for (const [x, y] of [[w.x1, w.y1], [w.x2, w.y2]]) { c.beginPath(); c.arc(x, y, 3.2 / z, 0, Math.PI * 2); c.fill(); }
      }
      const a = this.action;
      if (a?.kind === 'wall') { c.strokeStyle = a.door ? '#d6a73c' : '#66C39D'; c.lineWidth = 3.5 / z; c.setLineDash([6 / z, 5 / z]); c.beginPath(); c.moveTo(a.x1, a.y1); c.lineTo(a.x2, a.y2); c.stroke(); c.setLineDash([]); }
      const ft = pxPerFt(s);
      for (const l of s.lights || []) {
        c.strokeStyle = 'rgba(242,210,122,.75)'; c.lineWidth = 1.5 / z;
        c.setLineDash([5 / z, 5 / z]); c.beginPath(); c.arc(l.x, l.y, (Number(l.bright) || 0) * ft, 0, Math.PI * 2); c.stroke();
        c.strokeStyle = 'rgba(242,210,122,.35)'; c.beginPath(); c.arc(l.x, l.y, ((Number(l.bright) || 0) + (Number(l.dim) || 0)) * ft, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
        c.fillStyle = '#F2D27A'; c.beginPath(); c.arc(l.x, l.y, g * 0.14, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#111718'; c.lineWidth = g * 0.03; c.stroke();
      }
      c.restore();
    }
    // door handles: everyone can click these to open and close
    for (const w of s.walls || []) {
      if (!w.door || (!dm && !this.doorVisible(w))) continue;
      const h = doorHandle(w), ang = Math.atan2(w.y2 - w.y1, w.x2 - w.x1);
      const L = g * 0.42, T = g * 0.16;
      c.save(); c.translate(h.x, h.y); c.rotate(ang);
      c.fillStyle = w.open ? 'rgba(17,23,24,.85)' : (w.secret ? '#6b5591' : '#8a5f2a');
      c.strokeStyle = w.open ? '#66C39D' : '#F2D27A'; c.lineWidth = Math.max(1.5 / z, g * 0.025);
      roundRect(c, -L / 2, -T / 2, L, T, T / 3); c.fill(); c.stroke();
      if (w.locked) { c.fillStyle = '#F2D27A'; c.beginPath(); c.arc(0, 0, T * 0.28, 0, Math.PI * 2); c.fill(); }
      c.restore();
    }
  }

  _drawGrid(c, s) {
    const gr = s.grid, z = this.cam.z, dpr = window.devicePixelRatio || 1;
    const W = this.canvas.width / (z * dpr), H = this.canvas.height / (z * dpr);
    const x0 = Math.max(0, this.cam.x - W / 2), x1 = Math.min(s.width, this.cam.x + W / 2);
    const y0 = Math.max(0, this.cam.y - H / 2), y1 = Math.min(s.height, this.cam.y + H / 2);
    if (gr.size * z < 4) return;
    c.save();
    c.strokeStyle = gr.color; c.globalAlpha = gr.opacity; c.lineWidth = Math.max(1 / z, gr.size * 0.012);
    c.beginPath();
    for (let x = gr.ox + Math.ceil((x0 - gr.ox) / gr.size) * gr.size; x <= x1; x += gr.size) { c.moveTo(x, y0); c.lineTo(x, y1); }
    for (let y = gr.oy + Math.ceil((y0 - gr.oy) / gr.size) * gr.size; y <= y1; y += gr.size) { c.moveTo(x0, y); c.lineTo(x1, y); }
    c.stroke(); c.restore();
  }

  _drawTemplate(c, t, selected, preview) {
    const gr = this.scene.grid, L = this.tplPx(t), col = t.color || '#E5916A';
    // affected squares
    c.save();
    c.fillStyle = col; c.globalAlpha = preview || selected ? 0.22 : 0.14;
    for (const [cx, cy] of this.templateCells(t)) c.fillRect(gr.ox + cx * gr.size + 1, gr.oy + cy * gr.size + 1, gr.size - 2, gr.size - 2);
    c.restore();
    // outline
    c.save();
    c.strokeStyle = col; c.lineWidth = 3 / this.cam.z; c.globalAlpha = 0.95;
    c.fillStyle = col;
    c.beginPath();
    if (t.shape === 'circle') c.arc(t.x, t.y, L, 0, Math.PI * 2);
    else if (t.shape === 'cube') c.rect(t.x, t.y, L, L);
    else if (t.shape === 'cone') { c.moveTo(t.x, t.y); c.arc(t.x, t.y, L, t.dir - CONE_HALF, t.dir + CONE_HALF); c.closePath(); }
    else if (t.shape === 'line') {
      const W = gr.size * (t.wid || gr.feet) / gr.feet, ux = Math.cos(t.dir), uy = Math.sin(t.dir), px = -uy * W / 2, py = ux * W / 2;
      c.moveTo(t.x + px, t.y + py); c.lineTo(t.x + px + ux * L, t.y + py + uy * L); c.lineTo(t.x - px + ux * L, t.y - py + uy * L); c.lineTo(t.x - px, t.y - py); c.closePath();
    }
    c.globalAlpha = 0.12; c.fill(); c.globalAlpha = 0.95; c.stroke();
    c.restore();
    // label
    const label = `${t.len} ft ${({ circle: 'radius', cone: 'cone', line: 'line', cube: 'cube' })[t.shape]}`;
    const lp = t.shape === 'circle' ? { x: t.x, y: t.y } : t.shape === 'cube' ? { x: t.x + L / 2, y: t.y + L / 2 } : { x: t.x + Math.cos(t.dir) * L * 0.55, y: t.y + Math.sin(t.dir) * L * 0.55 };
    if (preview || selected) this._pill(c, lp.x, lp.y, label, col);
    // tokens caught
    if (preview || selected) {
      for (const tk of this.tokensInTemplate(t)) {
        const cc = this.tokenCenter(tk), r = (tk.size || 1) * gr.size / 2;
        c.save(); c.strokeStyle = col; c.lineWidth = 4 / this.cam.z; c.setLineDash([6 / this.cam.z, 4 / this.cam.z]);
        c.beginPath(); c.arc(cc.x, cc.y, r * 1.02, 0, Math.PI * 2); c.stroke(); c.restore();
      }
    }
    if (selected && !preview) {
      const h = this._tplHandle(t), r = gr.size * 0.22;
      c.save(); c.fillStyle = '#182022'; c.strokeStyle = col; c.lineWidth = 2 / this.cam.z;
      c.beginPath(); c.arc(h.x, h.y, r, 0, Math.PI * 2); c.fill(); c.stroke();
      c.strokeStyle = '#E2E8E4'; c.lineWidth = r * 0.22; c.lineCap = 'round';
      c.beginPath(); c.moveTo(h.x - r * 0.4, h.y - r * 0.4); c.lineTo(h.x + r * 0.4, h.y + r * 0.4); c.moveTo(h.x + r * 0.4, h.y - r * 0.4); c.lineTo(h.x - r * 0.4, h.y + r * 0.4); c.stroke();
      c.restore();
    }
  }

  _drawRuler(c, pts, color, name) {
    const gr = this.scene.grid;
    const [ax, ay, bx, by] = pts;
    const cells = cellDistance(Math.round((bx - ax) / gr.size), Math.round((by - ay) / gr.size), this.o.getDiagonals?.() || 'equal');
    const ft = Math.round(cells * gr.feet);
    c.save();
    c.lineCap = 'round';
    c.strokeStyle = 'rgba(0,0,0,.55)'; c.lineWidth = 9 / this.cam.z; c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke();
    c.strokeStyle = color; c.lineWidth = 5 / this.cam.z; c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke();
    c.fillStyle = color;
    for (const [x, y] of [[ax, ay], [bx, by]]) { c.beginPath(); c.arc(x, y, 7 / this.cam.z, 0, Math.PI * 2); c.fill(); }
    c.restore();
    this._pill(c, bx, by - 26 / this.cam.z, (name ? name + ' · ' : '') + ft + ' ft', color);
  }

  _pill(c, x, y, text, color) {
    const z = this.cam.z, fs = 14 / z;
    c.save();
    c.font = `600 ${fs}px "IBM Plex Sans", system-ui, sans-serif`;
    const w = c.measureText(text).width + 14 / z, h = fs + 10 / z;
    c.fillStyle = 'rgba(17,23,24,.92)'; c.strokeStyle = color; c.lineWidth = 1.5 / z;
    roundRect(c, x - w / 2, y - h / 2, w, h, h / 2); c.fill(); c.stroke();
    c.fillStyle = '#E2E8E4'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, x, y + 0.5 / z);
    c.restore();
  }

  _drawToken(c, t, lifted) {
    const gr = this.scene.grid, s = t.size || 1;
    const p = this.tokenPos(t);
    const x = gr.ox + p.x * gr.size, y = gr.oy + p.y * gr.size, d = s * gr.size;
    const cx = x + d / 2, cy = y + d / 2, r = d / 2 * 0.9;
    const conds = (t.conditions || []).map(condId);
    const down = (t.hp && t.hp.value <= 0) || t.health === 'down' || conds.includes('dead') || conds.includes('unconscious');
    const ring = t.kind === 'pc' ? (t.color || '#66C39D') : (DISPOSITION_COLORS[t.disposition] || '#c8553d');
    c.save();
    if (t.hidden) c.globalAlpha = 0.45;
    if (lifted) { c.shadowColor = 'rgba(0,0,0,.6)'; c.shadowBlur = 18; c.shadowOffsetY = 6; }
    // body
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fillStyle = t.kind === 'pc' ? (t.color || '#333') : '#2a3133'; c.fill();
    c.shadowColor = 'transparent';
    const img = this._img(t.img);
    if (img) {
      c.save(); c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.clip();
      const k = Math.max(2 * r / img.width, 2 * r / img.height);
      if (down) c.filter = 'grayscale(1) brightness(.6)';
      c.drawImage(img, cx - img.width * k / 2, cy - img.height * k / 2, img.width * k, img.height * k);
      c.restore();
    } else {
      c.fillStyle = '#F2EBDD';
      c.font = `600 ${r * 0.72}px "IM Fell English SC", Georgia, serif`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(initials(t.name), cx, cy + r * 0.05);
    }
    // whose turn it is
    if (this.activeToken === t.id) {
      c.save(); c.shadowColor = '#F2D27A'; c.shadowBlur = gr.size * 0.35; c.lineWidth = Math.max(3, gr.size * 0.08); c.strokeStyle = '#F2D27A';
      c.beginPath(); c.arc(cx, cy, r + gr.size * 0.1, 0, Math.PI * 2); c.stroke(); c.restore();
    }
    // ring
    c.lineWidth = Math.max(2, gr.size * 0.06);
    c.strokeStyle = ring; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
    if (this.selected.has(t.id)) {
      c.lineWidth = Math.max(2, gr.size * 0.035); c.strokeStyle = '#F2EBDD'; c.setLineDash([gr.size * 0.08, gr.size * 0.06]);
      c.beginPath(); c.arc(cx, cy, r + gr.size * 0.06, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
    }
    // targets: corner brackets in each targeter's colour
    const tg = this.targets.get(t.id);
    if (tg?.length) {
      tg.forEach((col, i) => {
        const m = r + gr.size * (0.14 + i * 0.07), L = Math.max(6, d * 0.18);
        c.save(); c.strokeStyle = col; c.lineWidth = Math.max(2.5, gr.size * 0.045); c.lineCap = 'round';
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const px = cx + sx * m, py = cy + sy * m;
          c.beginPath(); c.moveTo(px - sx * L, py); c.lineTo(px, py); c.lineTo(px, py - sy * L); c.stroke();
        }
        c.restore();
      });
    }
    if (t.health === 'bloodied' || (t.hp && t.hp.max && t.hp.value > 0 && t.hp.value <= t.hp.max / 2 && t.kind !== 'pc' && this.role === 'dm')) {
      this._icon(c, 'bloodied', cx - r * 0.72, cy + r * 0.62, gr.size * 0.15, '#c0392b');
    }
    if (down) {
      c.strokeStyle = 'rgba(192,57,43,.9)'; c.lineWidth = gr.size * 0.07; c.lineCap = 'round';
      if (conds.includes('dead') || t.health === 'down' && t.kind !== 'pc') {
        c.beginPath(); c.moveTo(cx - r * 0.6, cy - r * 0.6); c.lineTo(cx + r * 0.6, cy + r * 0.6); c.moveTo(cx + r * 0.6, cy - r * 0.6); c.lineTo(cx - r * 0.6, cy + r * 0.6); c.stroke();
      }
    }
    // conditions along the top edge
    const shown = (t.conditions || []).filter(v => condId(v) !== 'dead');
    const ir = gr.size * 0.16 * Math.min(1.4, Math.sqrt(s));
    shown.slice(0, 6).forEach((v, i) => {
      const n = Math.min(shown.length, 6);
      const ang = -Math.PI / 2 + (i - (n - 1) / 2) * 0.52 / Math.sqrt(s);
      const ix = cx + Math.cos(ang) * r * 1.0, iy = cy + Math.sin(ang) * r * 1.0;
      const id = condId(v), def = COND_BY_ID[id];
      this._icon(c, id, ix, iy, ir, def?.color || '#888', condLevel(v));
    });
    // HP bar
    if (t.hp && t.hp.max > 0) {
      const bw = d * 0.78, bh = Math.max(4, gr.size * 0.09), bx = cx - bw / 2, by = y + d - bh * 0.4;
      const f = clamp(t.hp.value / t.hp.max, 0, 1);
      c.fillStyle = 'rgba(10,14,15,.85)'; roundRect(c, bx - 1.5, by - 1.5, bw + 3, bh + 3, bh / 2); c.fill();
      c.fillStyle = f > 0.5 ? '#4f9d69' : f > 0.25 ? '#d6a73c' : '#c8553d';
      if (f > 0) { roundRect(c, bx, by, bw * f, bh, bh / 2); c.fill(); }
      if (t.hp.temp > 0) { c.fillStyle = '#7fb7d9'; roundRect(c, bx, by - bh * 0.55, Math.min(bw, bw * t.hp.temp / t.hp.max), bh * 0.45, bh / 4); c.fill(); }
    }
    // hidden marker for DM
    if (t.hidden && this.role === 'dm') { c.globalAlpha = 1; this._icon(c, 'invisible', cx + r * 0.72, cy + r * 0.62, gr.size * 0.15, '#7fb7d9'); }
    // name
    if (this.hover === t.id || this.selected.has(t.id) || lifted) {
      c.globalAlpha = 1;
      this._pill(c, cx, y + d + Math.max(16 / this.cam.z, gr.size * 0.18), t.name, ring);
    }
    c.restore();
  }

  _icon(c, id, x, y, r, color, level = 0) {
    c.save();
    c.fillStyle = '#111718'; c.strokeStyle = color; c.lineWidth = r * 0.16;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); c.stroke();
    const k = (r * 1.25) / 512;
    c.translate(x - r * 0.625, y - r * 0.625); c.scale(k, k);
    c.fillStyle = color;
    for (const p of iconPaths(id)) c.fill(p);
    c.restore();
    if (level) {
      c.save(); c.fillStyle = color; c.font = `700 ${r * 0.9}px "IBM Plex Mono", monospace`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = '#111718'; c.beginPath(); c.arc(x + r * 0.8, y + r * 0.7, r * 0.55, 0, Math.PI * 2); c.fill();
      c.fillStyle = color; c.fillText(String(level), x + r * 0.8, y + r * 0.72); c.restore();
    }
  }
}

function initials(name) {
  const w = String(name || '?').trim().split(/\s+/);
  return (w.length > 1 ? w[0][0] + w[1][0] : w[0].slice(0, 2)).toUpperCase();
}

function segDist(px, py, w) {
  const dx = w.x2 - w.x1, dy = w.y2 - w.y1, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - w.x1) * dx + (py - w.y1) * dy) / L)) : 0;
  return Math.hypot(px - (w.x1 + t * dx), py - (w.y1 + t * dy));
}

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
