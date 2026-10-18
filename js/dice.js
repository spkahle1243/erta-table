// Dice: formula parsing, fair rolling, the shared 3D dice overlay, and the roll log.
// The roller's browser decides every face; other screens animate dice that are
// forced to land on those same faces, so everyone sees the same roll.

import { el, uid, escapeHtml } from './util.js';

// ------------------------------------------------------------------ rolling

const TERM = /([+-])?\s*(?:(\d*)d(\d+|%)((?:kh|kl|dh|dl|k)\d*)?(r[<=]?\d+)?|(\d+))/gi;

export function parseFormula(formula) {
  const src = String(formula || '').replace(/\s+/g, '').toLowerCase()
    .replace(/^d/, '1d').replace(/([+-])d/g, '$11d');
  if (!src) throw new Error('Empty formula');
  const terms = [];
  let m, pos = 0;
  TERM.lastIndex = 0;
  while ((m = TERM.exec(src))) {
    if (m.index !== pos) throw new Error('Could not read “' + formula + '”');
    pos = TERM.lastIndex;
    const sign = m[1] === '-' ? -1 : 1;
    if (m[6] != null) { terms.push({ kind: 'num', sign, v: Number(m[6]) }); continue; }
    const n = Math.min(100, Number(m[2] || 1)), sides = m[3] === '%' ? 100 : Number(m[3]);
    if (!n || !sides || sides > 1000) throw new Error('Bad dice in “' + formula + '”');
    const t = { kind: 'dice', sign, n, sides };
    if (m[4]) { const k = m[4].match(/(kh|kl|dh|dl|k)(\d*)/); t.keep = k[1] === 'k' ? 'kh' : k[1]; t.keepN = Number(k[2] || 1); }
    if (m[5]) { const r = m[5].match(/r([<=]?)(\d+)/); t.reroll = { op: r[1] || '=', v: Number(r[2]) }; }
    terms.push(t);
  }
  if (pos !== src.length || !terms.length) throw new Error('Could not read “' + formula + '”');
  return terms;
}

export function randInt(sides) {
  // tests can queue exact results: window.__forceDice = [17, 4, ...]
  const q = globalThis.__forceDice;
  if (q?.length) { const v = Math.round(Number(q.shift())); if (v >= 1 && v <= sides) return v; }
  const max = Math.floor(0x100000000 / sides) * sides;
  const buf = new Uint32Array(1);
  let x;
  do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= max);
  return (x % sides) + 1;
}

// Rolls a formula. `forced` lets tests or the DM fix results (not exposed in the UI).
export function roll(formula, opts = {}) {
  const terms = parseFormula(formula).map(t => ({ ...t }));
  let total = 0;
  for (const t of terms) {
    if (t.kind === 'num') { t.total = t.v; total += t.sign * t.v; continue; }
    t.results = [];
    for (let i = 0; i < t.n; i++) {
      let v = randInt(t.sides);
      if (t.reroll && (t.reroll.op === '<' ? v <= t.reroll.v : v === t.reroll.v)) { t.results.push({ v, dropped: true, rerolled: true }); v = randInt(t.sides); }
      t.results.push({ v });
    }
    if (t.keep) {
      const live = t.results.filter(r => !r.dropped).map((r, i) => ({ r, i }));
      const order = live.slice().sort((a, b) => a.r.v - b.r.v);
      let drop = [];
      if (t.keep === 'kh') drop = order.slice(0, Math.max(0, live.length - t.keepN));
      if (t.keep === 'kl') drop = order.slice(t.keepN);
      if (t.keep === 'dh') drop = order.slice(Math.max(0, live.length - t.keepN));
      if (t.keep === 'dl') drop = order.slice(0, t.keepN);
      for (const d of drop) d.r.dropped = true;
    }
    t.total = t.results.filter(r => !r.dropped).reduce((s, r) => s + r.v, 0);
    total += t.sign * t.total;
  }
  const r = { id: uid(10), formula: String(formula).replace(/\s+/g, ''), terms, total, ts: Date.now(), ...opts };
  const d20 = terms.find(t => t.kind === 'dice' && t.sides === 20);
  if (d20) { const kept = d20.results.filter(x => !x.dropped); if (kept.length === 1) r.nat = kept[0].v; }
  return r;
}

// "1d20+5" with advantage → "2d20kh+5"
export function withAdvantage(formula, mode) {
  if (!mode) return formula;
  return formula.replace(/(^|[+-])1?d20(?![\dk])/i, `$1${'2d20' + (mode === 'adv' ? 'kh' : 'kl')}`);
}

// Notation for the 3D box with forced faces, e.g. "2d20+1d6@17,4,3"
function boxNotation(r) {
  const sets = [], faces = [];
  for (const t of r.terms) {
    if (t.kind !== 'dice') continue;
    const shown = t.results.filter(x => !x.rerolled);
    const sides = t.sides;
    if (![2, 4, 6, 8, 10, 12, 20, 100].includes(sides)) continue;
    sets.push(`${shown.length}d${sides}`);
    for (const x of shown) faces.push(sides === 100 ? x.v : x.v);
  }
  if (!sets.length) return null;
  const total = faces.length;
  if (total > 30) return null; // too many to animate sensibly
  return sets.join('+') + '@' + faces.join(',');
}

// ------------------------------------------------------------------ 3D overlay

export class DiceOverlay {
  constructor() {
    this.layer = el('div', { id: 'dice-layer', 'aria-hidden': 'true' });
    document.body.append(this.layer);
    this.queue = [];
    this.busy = false;
    this.box = null;
    this.failed = false;
    this.enabled = localStorage.getItem('erta-dice3d') !== 'off';
    this.sound = localStorage.getItem('erta-dice-sound') !== 'off';
  }

  setEnabled(v) { this.enabled = v; localStorage.setItem('erta-dice3d', v ? 'on' : 'off'); }
  setSound(v) { this.sound = v; localStorage.setItem('erta-dice-sound', v ? 'on' : 'off'); if (this.box) this.box.sounds = v; }

  async _init() {
    if (this.box || this.failed) return !!this.box;
    try {
      const { default: DiceBox } = await import('../vendor/dice-box-threejs.es.js');
      const base = new URL('../vendor/dice/', import.meta.url).href;
      this.box = new DiceBox('#dice-layer', {
        assetPath: base, sounds: this.sound, volume: 60, shadows: true,
        theme_surface: 'default', theme_material: 'plastic', light_intensity: 0.9, baseScale: 90, strength: 1.3,
        theme_customColorset: { name: 'init', foreground: '#F2EBDD', background: '#1C6A51', outline: '#0b0f10', texture: 'none', material: 'plastic' },
      });
      await this.box.initialize();
      window.addEventListener('resize', () => { try { this.box.resizeWorld(); } catch {} });
      return true;
    } catch (e) {
      console.warn('3D dice unavailable', e);
      this.failed = true; this.box = null; return false;
    }
  }

  // Animate a roll; resolves when the dice settle (or immediately if 3D is off).
  show(r, color = '#1C6A51') {
    return new Promise(res => {
      if (!this.enabled) return res();
      const notation = boxNotation(r);
      if (!notation) return res();
      this.queue.push({ notation, color, res });
      if (this.queue.length > 3) this.queue.shift().res(); // never fall far behind
      this._next();
    });
  }

  async _next() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    const job = this.queue.shift();
    const ok = await this._init();
    if (!ok) { job.res(); this.busy = false; this.queue.splice(0).forEach(j => j.res()); return; }
    try {
      this.layer.classList.add('show');
      clearTimeout(this._hide);
      await this.box.updateConfig({ theme_customColorset: { name: 'c' + job.color.replace('#', ''), foreground: readableOn(job.color), background: job.color, outline: '#0b0f10', texture: 'none', material: 'plastic' } });
      await Promise.race([this.box.roll(job.notation), new Promise(r => setTimeout(r, 7000))]);
    } catch (e) { console.warn('dice roll failed', e); }
    job.res();
    this.busy = false;
    if (this.queue.length) this._next();
    else this._hide = setTimeout(() => { this.layer.classList.remove('show'); try { this.box.clearDice(); } catch {} }, 2600);
  }
}

function readableOn(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#1B2526' : '#F2EBDD';
}

// ------------------------------------------------------------------ roll log

export function rollEntry(r, { mine = false } = {}) {
  const who = r.by || { name: '?', color: '#888' };
  const crit = r.nat === 20, fumble = r.nat === 1;
  const dice = el('div', { class: 'faces' });
  for (const t of r.terms) {
    if (t.kind === 'num') { dice.append(el('span', { class: 'num' }, (t.sign < 0 ? '−' : '+') + t.v)); continue; }
    if (t.sign < 0) dice.append(el('span', { class: 'num' }, '−'));
    for (const x of t.results) {
      const cls = ['face', 'd' + t.sides];
      if (x.dropped) cls.push('dropped');
      if (t.sides === 20 && !x.dropped && x.v === 20) cls.push('max');
      if (t.sides === 20 && !x.dropped && x.v === 1) cls.push('min');
      dice.append(el('span', { class: cls.join(' '), title: 'd' + t.sides }, x.v));
    }
  }
  const e = el('div', { class: 'roll' + (crit ? ' crit' : '') + (fumble ? ' fumble' : '') + (r.hidden ? ' hidden' : '') + (mine ? ' mine' : ''), 'data-id': r.id, style: { '--who': who.color } },
    el('div', { class: 'rh' }, el('span', { class: 'who' }, who.name), r.hidden ? el('span', { class: 'chip' }, 'hidden') : null, el('span', { class: 'when' }, new Date(r.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))),
    r.label ? el('div', { class: 'lab', html: escapeHtml(r.label) }) : null,
    el('div', { class: 'rbody' }, el('span', { class: 'fx mono' }, r.formula), dice, el('span', { class: 'tot' }, String(r.total))),
    crit ? el('div', { class: 'tag' }, 'Natural 20') : fumble ? el('div', { class: 'tag' }, 'Natural 1') : null);
  return e;
}

// A rules card: what happened when someone attacked, cast or used something.
export function cardEntry(cd, { onUndo } = {}) {
  const who = cd.by || { name: '?', color: '#888' };
  return el('div', { class: 'roll card' + (cd.undone ? ' undone' : ''), 'data-id': cd.id, style: { '--who': who.color } },
    el('div', { class: 'rh' }, el('span', { class: 'who' }, who.name), cd.undone ? el('span', { class: 'chip' }, 'undone') : null,
      el('span', { class: 'when' }, new Date(cd.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))),
    el('div', { class: 'card-t' }, cd.title.replace(/^[^:]+:\s*/, '')),
    el('ul', { class: 'card-l' }, (cd.lines || []).map(l => el('li', { class: l.c ? 'c-' + l.c : '' }, l.t))),
    onUndo && !cd.undone && cd.undo?.length ? el('div', { class: 'card-a' }, el('button', { class: 'btn small ghost', type: 'button', title: 'Put HP, conditions, effects and spent resources back', onclick: () => onUndo(cd) }, 'Undo')) : null);
}

// The roll log + dice tray widget. onRoll(formula, {mode, hidden}) is called by the tray.
export class RollLog {
  constructor(host, { onRoll, canHide = false, myName = '', onUndo = null }) {
    this.onRoll = onRoll;
    this.onUndo = onUndo;
    this.myName = myName;
    this.mode = null;
    this.list = el('div', { class: 'roll-list', role: 'log', 'aria-live': 'polite' });
    const input = el('input', { type: 'text', placeholder: 'e.g. 1d20+5, 8d6, 4d6kh3', 'aria-label': 'Dice formula' });
    const hide = canHide ? el('label', { class: 'check small', title: 'Only you see the roll' }, el('input', { type: 'checkbox', id: 'roll-hidden' }), 'Hidden') : null;
    const go = () => { const f = input.value.trim(); if (!f) return; this.onRoll(f, { mode: this.mode, hidden: !!hide?.querySelector('input').checked, label: '' }); };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    const quick = el('div', { class: 'quick' }, ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'].map(d => el('button', { class: 'btn small', type: 'button', onclick: () => this.onRoll('1' + d, { mode: d === 'd20' ? this.mode : null, hidden: !!hide?.querySelector('input').checked }) }, d)));
    const modeBtns = ['adv', 'dis'].map(m => el('button', { class: 'btn small', type: 'button', 'aria-pressed': 'false', title: m === 'adv' ? 'Advantage on the next d20' : 'Disadvantage on the next d20', onclick: e => {
      this.mode = this.mode === m ? null : m;
      for (const b of modeBtns) b.setAttribute('aria-pressed', b.dataset.m === this.mode ? 'true' : 'false');
    } }, m === 'adv' ? 'Adv' : 'Dis'));
    modeBtns[0].dataset.m = 'adv'; modeBtns[1].dataset.m = 'dis';
    this.modeBtns = modeBtns;
    this.el = el('section', { class: 'rolls', 'aria-label': 'Dice' },
      this.list,
      el('div', { class: 'tray' }, quick, el('div', { class: 'tray-in' }, input, el('button', { class: 'btn primary small', type: 'button', onclick: go }, 'Roll')), el('div', { class: 'row' }, ...modeBtns, hide)));
    host.append(this.el);
  }
  clearMode() { this.mode = null; for (const b of this.modeBtns) b.setAttribute('aria-pressed', 'false'); }
  add(r, opts) {
    const old = this.list.querySelector(`[data-id="${r.id}"]`);
    if (old && r.kind !== 'card') return;
    const e = r.kind === 'card' ? cardEntry(r, { onUndo: this.onUndo }) : rollEntry(r, opts);
    if (old) { old.replaceWith(e); return; }
    this.list.append(e);
    while (this.list.children.length > 80) this.list.firstChild.remove();
    this.list.scrollTop = this.list.scrollHeight;
  }
  setAll(list) { this.list.innerHTML = ''; for (const r of list) this.add(r); }
}
