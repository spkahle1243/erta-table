// Combat tracker: initiative order, rounds and turns.
import { el, uid } from './util.js';
import { avatar } from './ui.js';

export function newCombat(entries) {
  return { id: uid(8), round: 1, turn: 0, started: false, askInit: false, list: entries };
}

export function combatant(o) {
  return { id: uid(8), tokenId: o.tokenId || null, charId: o.charId || null, name: o.name, img: o.img || null, color: o.color || null,
    init: o.init ?? null, bonus: o.bonus ?? 0, hidden: !!o.hidden, defeated: false, kind: o.charId ? 'pc' : 'npc' };
}

// Highest first; ties go to the higher bonus, then PCs, then name.
export function sortCombat(c) {
  const cur = c.list[c.turn]?.id;
  c.list.sort((a, b) => (b.init ?? -99) - (a.init ?? -99) || b.bonus - a.bonus || (a.kind === 'pc' ? -1 : 1) - (b.kind === 'pc' ? -1 : 1) || a.name.localeCompare(b.name));
  if (cur) c.turn = Math.max(0, c.list.findIndex(x => x.id === cur));
}

export function current(c) { return c?.started ? c.list[c.turn] || null : null; }

export function advance(c, dir = 1) {
  if (!c.list.length) return;
  if (!c.started) { c.started = true; c.turn = 0; c.round = 1; skipDefeated(c, 1); return; }
  let guard = c.list.length + 1;
  do {
    c.turn += dir;
    if (c.turn >= c.list.length) { c.turn = 0; c.round++; }
    if (c.turn < 0) { if (c.round > 1) { c.turn = c.list.length - 1; c.round--; } else { c.turn = 0; break; } }
  } while (c.list[c.turn]?.defeated && --guard > 0);
}
function skipDefeated(c) { let g = c.list.length; while (c.list[c.turn]?.defeated && g-- > 0) c.turn = (c.turn + 1) % c.list.length; }

// What a player sees of the combat.
export function combatView(c, charId) {
  if (!c) return null;
  const cur = current(c);
  const list = c.list.filter(x => !x.hidden).map(x => ({ id: x.id, name: x.name, img: x.img, color: x.color, kind: x.kind, charId: x.charId, init: x.init, defeated: x.defeated, tokenId: x.tokenId }));
  const mine = c.list.find(x => x.charId === charId);
  return { round: c.round, started: c.started, current: cur && !cur.hidden ? cur.id : null, currentToken: cur && !cur.hidden ? cur.tokenId : null,
    list, needInit: !!(c.askInit && mine && mine.init == null), myBonus: mine?.bonus ?? 0, myTurn: !!(cur && cur.charId === charId) };
}

// The strip of portraits across the top of the map.
export function renderStrip(host, view, { resolveImg, onClick } = {}) {
  host.innerHTML = '';
  if (!view || !view.list.length) { host.hidden = true; return; }
  host.hidden = false;
  host.append(el('div', { class: 'round' }, view.started ? `Round ${view.round}` : 'Rolling initiative'));
  const row = el('div', { class: 'order' });
  for (const x of view.list) {
    const a = avatar(x.name, x.color || (x.kind === 'pc' ? '#1C6A51' : '#5a3a34'), null);
    if (x.img && resolveImg) resolveImg(x.img).then(u => { if (u) { a.style.background = `url("${u}") center/cover`; a.textContent = ''; } });
    row.append(el('button', { class: 'cb' + (x.id === view.current ? ' now' : '') + (x.defeated ? ' down' : ''), type: 'button', title: `${x.name}${x.init != null ? ' · ' + x.init : ''}`, onclick: () => onClick?.(x) },
      a, el('span', { class: 'ini' }, x.init ?? '–'), el('span', { class: 'nm' }, x.name)));
  }
  host.append(row);
}
