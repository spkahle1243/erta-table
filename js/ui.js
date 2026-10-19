// Shared interface pieces: modals, popovers, the token HUD, handouts, tool icons.
import { el, escapeHtml } from './util.js';
import { CONDITIONS, COND_BY_ID, condId, condLevel, iconSvg } from './conditions.js';

const S = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
export const ICONS = {
  select: S('<path d="M5 3l14 8-6 2-2 6z"/>'),
  ruler: S('<path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>'),
  ping: S('<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" opacity=".6"/>'),
  circle: S('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'),
  cone: S('<path d="M4 12L20 5v14z"/>'),
  line: S('<rect x="3" y="9.5" width="18" height="5" rx="1"/>'),
  cube: S('<rect x="5" y="5" width="14" height="14" rx="1"/>'),
  reveal: S('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  hide: S('<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.1 6.1C3.6 7.8 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 4.4-1"/>'),
  brush: S('<path d="M18 3l3 3-9 9-3-3z"/><path d="M9 12c-3 0-5 2-5 5 0 1-1 2-2 2 2 2 6 2 8 0 1.5-1.5 2-3 2-4"/>'),
  rect: S('<rect x="4" y="6" width="16" height="12" rx="1" stroke-dasharray="3 2"/>'),
  music: S('<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
  play: S('<path d="M7 4l13 8-13 8z" fill="currentColor"/>'),
  pause: S('<path d="M7 4h3v16H7zM14 4h3v16h-3z" fill="currentColor"/>'),
  stop: S('<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor"/>'),
  copy: S('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  x: S('<path d="M6 6l12 12M18 6L6 18"/>'),
  eye: S('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeoff: S('<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.1 6.1C3.6 7.8 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 4.4-1"/>'),
  fit: S('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  vol: S('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>'),
  undo: S('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  menu: S('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  wall: S('<path d="M3 6h18v12H3z"/><path d="M3 12h18M9 6v6M15 12v6"/>'),
  door: S('<path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17"/><path d="M4 21h16"/><circle cx="14.5" cy="12.5" r="1" fill="currentColor"/>'),
  light: S('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
};

export function modal({ title, body, actions = [], onClose, wide }) {
  const back = el('div', { class: 'modal-back' });
  const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', style: wide ? { width: 'min(760px,100%)' } : null });
  const close = v => { back.remove(); window.removeEventListener('keydown', esc); onClose?.(v); };
  const esc = e => { if (e.key === 'Escape') close(null); };
  window.addEventListener('keydown', esc);
  back.addEventListener('pointerdown', e => { if (e.target === back) close(null); });
  box.append(el('h2', {}, title));
  if (body) box.append(body);
  if (actions.length) {
    const foot = el('div', { class: 'foot' });
    for (const a of actions) foot.append(el('button', { class: 'btn ' + (a.kind || ''), type: 'button', onclick: async () => { const v = a.run ? await a.run() : a.value; if (a.run && v === false) return; close(v ?? a.value); } }, a.label));
    box.append(foot);
  }
  back.append(box); document.body.append(back);
  setTimeout(() => box.querySelector('input, select, textarea, .btn.primary')?.focus(), 30);
  return { close, box };
}

export function confirmBox(title, text, { ok = 'OK', danger = false } = {}) {
  return new Promise(res => modal({ title, body: el('p', { class: 'muted' }, text), onClose: v => res(!!v), actions: [
    { label: 'Cancel', value: false }, { label: ok, kind: danger ? 'danger' : 'primary', value: true },
  ] }));
}

export function promptBox(title, { label = '', value = '', placeholder = '', hint = '' } = {}) {
  return new Promise(res => {
    const inp = el('input', { type: 'text', value, placeholder });
    const body = el('div', { class: 'stack' }, el('label', { class: 'field' }, el('span', {}, label), inp), hint ? el('p', { class: 'muted small' }, hint) : null);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { m.close(inp.value); } });
    const m = modal({ title, body, onClose: v => res(v == null ? null : String(v)), actions: [
      { label: 'Cancel', value: null }, { label: 'OK', kind: 'primary', run: () => inp.value },
    ] });
  });
}

let openPop = null;
export function popover(x, y, content, { onClose } = {}) {
  closePopover();
  const p = el('div', { class: 'pop' }, content);
  document.body.append(p);
  const r = p.getBoundingClientRect();
  p.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  p.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  const off = e => { if (!p.contains(e.target)) closePopover(); };
  const esc = e => { if (e.key === 'Escape') closePopover(); };
  setTimeout(() => { document.addEventListener('pointerdown', off, true); window.addEventListener('keydown', esc); });
  openPop = { p, cleanup: () => { document.removeEventListener('pointerdown', off, true); window.removeEventListener('keydown', esc); onClose?.(); } };
  return p;
}
export function closePopover() { if (openPop) { openPop.cleanup(); openPop.p.remove(); openPop = null; } }

// HP and conditions editor. data: { name, hp, ac, conditions }; onChange(patch)
export function hpConditionsEditor(data, onChange, { showMax = true, extra } = {}) {
  const wrap = el('div', { class: 'stack' });
  const hpv = el('span', { class: 'mono' });
  const amt = el('input', { type: 'number', min: 0, placeholder: 'HP', 'aria-label': 'Amount', style: { textAlign: 'center', minWidth: '52px' } });
  const refreshHp = () => { hpv.textContent = `${data.hp.value} / ${data.hp.max}${data.hp.temp ? ` (+${data.hp.temp} temp)` : ''}`; };
  refreshHp();
  const apply = kind => {
    const n = Math.max(0, Math.floor(Number(amt.value) || 0)); if (!n && kind !== 'set') return;
    const hp = { ...data.hp };
    if (kind === 'dmg') { const t = Math.min(hp.temp || 0, n); hp.temp = (hp.temp || 0) - t; hp.value = Math.max(0, hp.value - (n - t)); }
    if (kind === 'heal') hp.value = Math.min(hp.max, hp.value + n);
    if (kind === 'temp') hp.temp = Math.max(hp.temp || 0, n);
    data.hp = hp; refreshHp(); amt.value = ''; onChange({ hp });
  };
  amt.addEventListener('keydown', e => { if (e.key === 'Enter') apply(e.shiftKey ? 'heal' : 'dmg'); });
  wrap.append(
    el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'HP'), hpv),
    el('div', { class: 'grid2', style: { gridTemplateColumns: '1fr auto auto auto' } }, amt,
      el('button', { class: 'btn small danger', type: 'button', onclick: () => apply('dmg'), title: 'Damage (Enter)' }, 'Damage'),
      el('button', { class: 'btn small', type: 'button', onclick: () => apply('heal'), title: 'Heal (Shift+Enter)' }, 'Heal'),
      el('button', { class: 'btn small', type: 'button', onclick: () => apply('temp') }, 'Temp')),
  );
  if (showMax) {
    const mx = el('input', { type: 'number', min: 1, value: data.hp.max });
    const cur = el('input', { type: 'number', min: 0, value: data.hp.value });
    const commit = () => { const hp = { ...data.hp, max: Math.max(1, Number(mx.value) || 1), value: Math.max(0, Number(cur.value) || 0) }; data.hp = hp; refreshHp(); onChange({ hp }); };
    mx.addEventListener('change', commit); cur.addEventListener('change', commit);
    wrap.append(el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', {}, 'Current'), cur), el('label', { class: 'field' }, el('span', {}, 'Max'), mx)));
  }
  if (extra) wrap.append(extra);
  wrap.append(el('div', { class: 'lbl' }, 'Conditions'), conditionGrid(data.conditions || [], conds => { data.conditions = conds; onChange({ conditions: conds }); }));
  return wrap;
}

export function conditionGrid(current, onChange) {
  let list = [...current];
  const g = el('div', { class: 'conds' });
  const render = () => {
    g.innerHTML = '';
    for (const c of CONDITIONS) {
      const idx = list.findIndex(v => condId(v) === c.id);
      const on = idx >= 0, lv = on ? condLevel(list[idx]) : 0;
      const b = el('button', { class: 'cond', type: 'button', 'aria-pressed': on ? 'true' : 'false', title: c.name + (c.levels ? ' (click to raise, right-click to lower)' : ''), style: { '--c': c.color }, html: iconSvg(c.id, 20) });
      if (lv) b.append(el('span', { class: 'lv' }, lv));
      b.addEventListener('click', () => {
        if (c.levels) {
          if (!on) list.push(c.id + ':1'); else if (lv < c.levels) list[idx] = c.id + ':' + (lv + 1); else list.splice(idx, 1);
        } else if (on) list.splice(idx, 1); else list.push(c.id);
        render(); onChange([...list]);
      });
      b.addEventListener('contextmenu', e => {
        e.preventDefault();
        if (!on) return;
        if (c.levels && lv > 1) list[idx] = c.id + ':' + (lv - 1); else list.splice(idx, 1);
        render(); onChange([...list]);
      });
      g.append(b);
    }
  };
  render();
  return g;
}

export function conditionChips(list) {
  return el('div', { class: 'row', style: { gap: '4px' } }, (list || []).map(v => {
    const c = COND_BY_ID[condId(v)]; if (!c) return null;
    const lv = condLevel(v);
    return el('span', { class: 'chip', style: { color: c.color, borderColor: c.color + '66' }, html: iconSvg(c.id, 12) + ' ' + escapeHtml(c.name + (lv ? ' ' + lv : '')) });
  }));
}

// Handout overlay (players and DM preview). h: { title, text, style, img }, imgUrl resolved by caller.
export function renderHandout(h, imgUrl, onClose) {
  const wrap = el('div', { class: 'handout-wrap' });
  const card = el('div', { class: 'handout-card' });
  card.append(el('button', { class: 'btn icon close', type: 'button', 'aria-label': 'Close', html: ICONS.x, onclick: () => onClose?.() }));
  if (h.img) {
    card.append(el('img', { class: 'handout-img', src: imgUrl || '', alt: h.title || 'Handout' }));
    if (h.title) card.append(el('div', { class: 'handout-cap' }, h.title));
  }
  if (h.text) {
    const paper = el('div', { class: 'handout-paper' + (h.style === 'ledger' ? ' ledger' : '') });
    if (h.title && !h.img) paper.append(el('div', { class: 'hl' }, h.title));
    paper.append(document.createTextNode(h.text));
    card.append(paper);
  }
  wrap.append(card);
  wrap.addEventListener('pointerdown', e => { if (e.target === wrap) onClose?.(); });
  return wrap;
}

export function avatar(name, color, url) {
  const a = el('span', { class: 'av', style: { background: url ? `url("${url}") center/cover` : (color || '#2a3133'), borderColor: color || 'var(--line)' } });
  if (!url) a.textContent = String(name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return a;
}

// A cinematic title card over the screen: the scene's name between letterbox bars.
export function titleCard({ eyebrow = '', title = '', sub = '' } = {}, { mini = false } = {}) {
  document.querySelector('.title-card' + (mini ? '.mini' : ':not(.mini)'))?.remove();
  const box = el('div', { class: 'title-card' + (mini ? ' mini' : ''), 'aria-live': 'polite' },
    mini ? null : el('div', { class: 'tc-bar top' }), mini ? null : el('div', { class: 'tc-bar bot' }),
    el('div', { class: 'tc-in' }, eyebrow ? el('div', { class: 'tc-eye' }, eyebrow) : null, el('div', { class: 'tc-t' }, title), sub ? el('div', { class: 'tc-sub' }, sub) : null));
  document.body.append(box);
  setTimeout(() => box.remove(), mini ? 3200 : 5200);
  return box;
}
