// The DM's second screen: a tablet or second monitor beside the main DM tab.
// It shows the tracker with real HP, the clocks, the prep for the live scene,
// music and the sound board, the party and the last rolls, and sends commands
// back to the DM's tab, which stays in charge of the game.

import { $, el, toast, debounce, clamp } from './util.js';
import { Client, setRelay, decodeRelay } from './net.js';
import { watchForUpdates } from './update.js';

const C = { client: null, v: null, tab: localStorage.getItem('erta-companion-tab') || 'tracker', prep: new Map(), section: null, notesFocus: false };
window.__companion = C;

const TABS = [['tracker', 'Tracker'], ['prep', 'Prep'], ['clocks', 'Clocks'], ['sound', 'Sound'], ['party', 'Party'], ['rolls', 'Rolls']];
const cmd = (op, o = {}) => C.client?.send({ t: 'cmd', op, ...o });

function boot() {
  const h = new URLSearchParams(location.hash.slice(1));
  const hostId = h.get('h'), key = h.get('k');
  const root = $('#root');
  if (!hostId || !key) { root.append(el('div', { class: 'join' }, el('div', {}, el('h1', {}, 'This link is incomplete'), el('p', {}, 'Copy the second-screen link again from the DM’s Settings.')))); return; }
  if (h.get('r')) setRelay(decodeRelay(h.get('r')));
  root.append(el('div', { class: 'cmp' },
    el('header', { class: 'cmp-top' }, el('div', { class: 'cmp-name', id: 'name' }, 'Second screen'), el('span', { class: 'status', id: 'net' }),
      el('button', { class: 'btn small', id: 'pause', type: 'button', onclick: () => cmd('pause') }, 'Pause')),
    el('nav', { class: 'cmp-tabs', id: 'tabs' }),
    el('main', { class: 'cmp-body', id: 'body' }, el('p', { class: 'muted' }, 'Connecting to your DM tab…'))));
  const c = new Client(hostId, { key, role: 'companion' });
  C.client = c;
  c.on('status', s => {
    const map = { online: ['on', 'Connected'], connecting: ['warn', 'Connecting…'], reconnecting: ['warn', 'Reconnecting…'], waiting: ['warn', 'Open the DM tab'], denied: ['bad', 'Link not accepted'] };
    const [cls, txt] = map[s] || ['warn', s]; const n = $('#net'); n.innerHTML = ''; n.append(el('span', { class: 'dot ' + cls }), txt);
  });
  c.on('denied', reason => { $('#body').innerHTML = ''; $('#body').append(el('p', {}, reason)); });
  c.on('welcome', m => { if (m.companion) onView(m.companion); });
  c.on('message', m => {
    if (m.t === 'cstate') onView(m.view);
    else if (m.t === 'cprep') { C.prep.set(m.pack + ':' + m.id, m); if (!document.getElementById('cmp-pack-css')) document.head.append(el('style', { id: 'cmp-pack-css' }, m.css)); if (C.tab === 'prep') render(); }
  });
  c.start();
}

function onView(v) {
  const prevSection = C.v?.prep?.current;
  C.v = v;
  if (v.prep && v.prep.current !== prevSection) C.section = null;   // follow the live scene
  render();
}

function render() {
  const v = C.v; if (!v) return;
  $('#name').textContent = v.name;
  $('#pause').textContent = v.paused ? 'Resume' : 'Pause';
  $('#pause').classList.toggle('copper', !!v.paused);
  const tabs = $('#tabs'); tabs.innerHTML = '';
  for (const [id, label] of TABS) tabs.append(el('button', { class: 'tab', type: 'button', 'aria-selected': C.tab === id ? 'true' : 'false', onclick: () => { C.tab = id; localStorage.setItem('erta-companion-tab', id); render(); } },
    label, id === 'tracker' && v.combat ? el('span', { class: 'badge' }, 'R' + v.combat.round) : null));
  const body = $('#body');
  // keep typing undisturbed
  if (body.contains(document.activeElement) && document.activeElement.matches('textarea, input')) return;
  const top = body.scrollTop;
  body.innerHTML = '';
  body.append(({ tracker, prep, clocks, sound, party, rolls })[C.tab]());
  body.scrollTop = top;
}

// ---------------------------------------------------------------- tracker
function tracker() {
  const v = C.v, cb = v.combat;
  const wrap = el('div', { class: 'stack' });
  if (v.waiting.length) wrap.append(el('div', { class: 'cmp-wait' }, el('b', {}, 'Waiting on'), v.waiting.map(w => el('div', { class: 'small' }, w))));
  if (!cb) { wrap.append(el('p', { class: 'muted' }, 'No fight running. Start one from the Combat tab on your DM screen.')); return wrap; }
  wrap.append(el('div', { class: 'row' }, el('h2', { class: 'grow' }, cb.started ? `Round ${cb.round}` : 'Rolling initiative'),
    cb.started ? el('button', { class: 'btn', type: 'button', onclick: () => cmd('prev') }, '◂ Back') : null,
    el('button', { class: 'btn primary big', type: 'button', disabled: cb.busy, onclick: () => cmd('next') }, cb.busy ? 'Resolving…' : cb.started ? 'Next turn ▸' : 'Begin round 1 ▸')));
  for (const x of cb.list) {
    const hp = x.hp, f = hp?.max ? clamp(hp.value / hp.max, 0, 1) : 0;
    const amt = el('input', { type: 'number', min: 1, inputmode: 'numeric', placeholder: '±', 'aria-label': 'Amount' });
    wrap.append(el('div', { class: 'cmp-row' + (x.current ? ' cur' : '') + (x.down ? ' down' : '') + (x.hidden ? ' hid' : '') + (x.pc ? ' pc' : '') },
      el('span', { class: 'ini mono' }, x.init ?? '—'),
      el('div', { class: 'grow', style: { minWidth: 0 } },
        el('div', { class: 'nm' }, x.name, x.hidden ? el('span', { class: 'chip' }, 'hidden') : null),
        hp ? el('div', { class: 'hpline' }, el('span', { class: 'bar' }, el('i', { style: { width: f * 100 + '%', background: f > .5 ? '#4f9d69' : f > .25 ? '#d6a73c' : '#c8553d' } })), el('span', { class: 'mono' }, `${hp.value}/${hp.max}${hp.temp ? ' +' + hp.temp : ''}`), x.ac != null ? el('span', { class: 'mono muted' }, 'AC ' + x.ac) : null) : null,
        x.cond.length ? el('div', { class: 'conds' }, x.cond.map(k => el('span', { class: 'chip' }, k))) : null),
      x.token ? el('div', { class: 'hp-ctl' }, amt,
        el('button', { class: 'btn small danger', type: 'button', title: 'Damage', onclick: () => { const n = +amt.value; if (n > 0) cmd('hp', { token: x.token, delta: -n }); amt.value = ''; } }, '−'),
        el('button', { class: 'btn small', type: 'button', title: 'Heal', onclick: () => { const n = +amt.value; if (n > 0) cmd('hp', { token: x.token, delta: n }); amt.value = ''; } }, '+')) : null));
  }
  return wrap;
}

// ---------------------------------------------------------------- prep and notes
function prep() {
  const v = C.v, wrap = el('div', { class: 'stack' });
  if (v.scene) {
    const notes = el('textarea', { rows: 3, placeholder: 'Private notes for this scene' }); notes.value = v.scene.notes;
    const send = debounce(() => cmd('notes', { scene: v.scene.id, text: notes.value }), 600);
    notes.addEventListener('input', send);
    notes.addEventListener('blur', () => { send.flush?.(); setTimeout(render, 50); });
    const pick = el('select', {}, v.scenes.map(s => el('option', { value: s.id, selected: s.id === v.scene.id }, (s.live ? '● ' : '') + s.name)));
    wrap.append(el('div', { class: 'row' }, el('h2', { class: 'grow' }, v.scene.name, v.scene.live ? el('span', { class: 'chip live' }, 'live') : null)),
      el('div', { class: 'row' }, pick, el('button', { class: 'btn small primary', type: 'button', onclick: () => cmd('show', { scene: pick.value }) }, 'Show to players')),
      el('label', { class: 'field' }, el('span', {}, 'DM notes'), notes));
  }
  if (v.npcs.length) wrap.append(el('details', { class: 'cmp-npcs', open: true }, el('summary', {}, `Who’s here · ${v.npcs.length}`),
    v.npcs.map(n => el('details', { class: 'nd-card' }, el('summary', {}, el('div', { class: 'nd-t' }, el('div', { class: 'nd-nm' }, n.name), el('div', { class: 'nd-role' }, n.role))),
      n.fields.length ? el('dl', {}, n.fields.flatMap(([k, val]) => [el('dt', {}, k), el('dd', { html: val })])) : null,
      n.line ? el('p', { class: 'nd-line' }, n.line) : null))));
  const p = v.prep;
  if (!p) { wrap.append(el('p', { class: 'muted' }, 'No session pack loaded.')); return wrap; }
  const sid = C.section || p.current || p.sections.find(s => /^s\d/.test(s.id))?.id || p.sections[0]?.id;
  wrap.append(el('div', { class: 'prep-nav' }, p.sections.map(s => el('button', { class: 'chip-btn', type: 'button', 'aria-pressed': s.id === sid ? 'true' : 'false', title: s.title, onclick: () => { C.section = s.id; render(); } }, s.num && s.num !== '§' ? s.num : s.id === 'overview' ? '§' : s.id === 'prep' ? 'Prep' : s.title))));
  const got = C.prep.get(p.pack + ':' + sid);
  if (!got) { C.client.send({ t: 'prep', pack: p.pack, id: sid }); wrap.append(el('p', { class: 'muted' }, 'Loading the prep…')); return wrap; }
  const doc = el('div', { class: 'prep-doc' });
  doc.innerHTML = `<div class="wrap">${got.html}</div>`;
  for (const b of doc.querySelectorAll('button.copy, .pack-enc')) b.remove();
  for (const a of doc.querySelectorAll('.exits .lead')) a.addEventListener('click', () => { const ex = a.closest('.exits'); for (const o of ex.querySelectorAll('.lead')) { const pn = doc.querySelector('#' + o.getAttribute('aria-controls')); if (pn) pn.hidden = o !== a || !pn.hidden; } });
  wrap.append(doc);
  return wrap;
}

// ---------------------------------------------------------------- clocks
function clocks() {
  const wrap = el('div', { class: 'stack' });
  if (!C.v.clocks.length) wrap.append(el('p', { class: 'muted' }, 'No clocks.'));
  for (const k of C.v.clocks) {
    const pips = el('div', { class: 'pips big' });
    for (let i = 0; i < k.size; i++) pips.append(el('button', { class: 'pip' + (i < k.value ? ' on' : ''), type: 'button', 'aria-label': `Segment ${i + 1}`, onclick: () => cmd('clock', { id: k.id, value: k.value === i + 1 ? i : i + 1 }) }));
    wrap.append(el('div', { class: 'clockw' },
      el('div', { class: 'row' }, el('b', { class: 'grow' }, k.name), el('span', { class: 'mono' }, `${k.value} / ${k.size}`),
        el('button', { class: 'btn small ghost', type: 'button', onclick: () => cmd('clock-vis', { id: k.id }) }, k.visible ? 'Players see it' : 'Hidden')),
      pips, k.goal ? el('div', { class: 'small muted' }, k.goal) : null, k.step ? el('div', { class: 'small', style: { color: 'var(--copper)' } }, `At ${k.value}: ${k.step}`) : null));
  }
  return wrap;
}

// ---------------------------------------------------------------- sound
function sound() {
  const a = C.v.audio, wrap = el('div', { class: 'stack' });
  wrap.append(el('div', { class: 'nowplaying' },
    el('div', { class: 'np-row' }, el('span', { class: 'lbl' }, 'music'), el('span', { class: 'small' }, a.music || '—'), a.music ? el('button', { class: 'btn small', type: 'button', onclick: () => cmd('stop', { layer: 'music' }) }, 'Stop') : null),
    el('div', { class: 'np-row' }, el('span', { class: 'lbl' }, 'ambience'), el('span', { class: 'small' }, a.ambience || '—'), a.ambience ? el('button', { class: 'btn small', type: 'button', onclick: () => cmd('stop', { layer: 'ambience' }) }, 'Stop') : null)));
  wrap.append(el('h4', {}, 'Sound board'), el('div', { class: 'sfx-board' }, a.pads.map(p => el('button', { class: 'pad', type: 'button', onclick: () => cmd('pad', { i: p.i }) }, p.name))));
  for (const kind of ['music', 'ambience']) {
    const list = a.tracks.filter(t => t.kind === kind); if (!list.length) continue;
    wrap.append(el('h4', {}, kind === 'music' ? 'Music' : 'Ambience'), ...list.map(t => el('button', { class: 'cmp-track' + (t.playing ? ' playing' : ''), type: 'button', onclick: () => cmd('play', { id: t.id }) }, (t.playing ? '♪ ' : '▶ ') + t.name)));
  }
  return wrap;
}

// ---------------------------------------------------------------- party and rolls
function party() {
  const wrap = el('div', { class: 'stack' });
  for (const p of C.v.party) {
    const f = p.hp?.max ? clamp(p.hp.value / p.hp.max, 0, 1) : 0;
    wrap.append(el('div', { class: 'cmp-row pc', style: { borderLeftColor: p.color } },
      el('div', { class: 'grow' }, el('div', { class: 'nm' }, p.name, el('span', { class: 'dot ' + (p.online ? 'on' : '') })),
        el('div', { class: 'hpline' }, el('span', { class: 'bar' }, el('i', { style: { width: f * 100 + '%', background: f > .5 ? '#4f9d69' : f > .25 ? '#d6a73c' : '#c8553d' } })), el('span', { class: 'mono' }, `${p.hp.value}/${p.hp.max}${p.hp.temp ? ' +' + p.hp.temp : ''}`), el('span', { class: 'mono muted' }, 'AC ' + p.ac)),
        el('div', { class: 'conds' }, p.cond.map(k => el('span', { class: 'chip' }, k)), p.conc ? el('span', { class: 'chip' }, '◎ ' + p.conc) : null, p.react ? el('span', { class: 'chip' }, 'reaction used') : null))));
  }
  return wrap;
}
function rolls() {
  const wrap = el('div', { class: 'stack' });
  for (const r of C.v.rolls) wrap.append(r.card
    ? el('div', { class: 'roll card' }, el('div', { class: 'card-t' }, r.title), el('ul', { class: 'card-l' }, r.lines.map(l => el('li', {}, l))))
    : el('div', { class: 'roll' + (r.nat === 20 ? ' crit' : r.nat === 1 ? ' fumble' : '') + (r.hidden ? ' hidden' : '') }, el('div', { class: 'lab' }, r.title), el('div', { class: 'rbody' }, el('span', { class: 'fx mono' }, r.formula), el('span', { class: 'tot' }, String(r.total)))));
  return wrap;
}

boot();
watchForUpdates();
