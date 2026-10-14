// 2024-style stat blocks with clickable rolls, plus the SRD bestiary loader.
import { el, escapeHtml } from './util.js';

const ABIL = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const AB_LABEL = { str: 'Str', dex: 'Dex', con: 'Con', int: 'Int', wis: 'Wis', cha: 'Cha' };
const sign = n => (n >= 0 ? '+' : '−') + Math.abs(n);
const mod = v => Math.floor((v - 10) / 2);

let bestiaryP = null;
export function loadBestiary() {
  if (!bestiaryP) bestiaryP = fetch(new URL('../data/srd-monsters-2024.json', import.meta.url)).then(r => r.json());
  return bestiaryP;
}

export async function searchBestiary(q, limit = 12) {
  const b = await loadBestiary();
  q = q.trim().toLowerCase();
  if (!q) return [];
  const all = Object.values(b);
  const starts = all.filter(m => m.name.toLowerCase().startsWith(q));
  const has = all.filter(m => !m.name.toLowerCase().startsWith(q) && m.name.toLowerCase().includes(q));
  return [...starts, ...has].slice(0, limit);
}

// onRoll(formula, label, extra) ; onUse(actionEntry, activity) for automation hooks
export function renderStatBlock(a, { onRoll, compact = false } = {}) {
  const roll = (f, label, extra) => onRoll && onRoll(f, `${a.name}: ${label}`, extra);
  const rb = (text, f, label, cls = '') => el('button', { class: 'rb ' + cls, type: 'button', title: 'Roll ' + f, onclick: () => roll(f, label) }, text);
  const sb = el('div', { class: 'statblock' });
  sb.append(
    el('div', { class: 'sb-name' }, a.name),
    el('div', { class: 'sb-type' }, `${a.size} ${a.type}, ${a.alignment}`),
    el('div', { class: 'sb-rule' }),
    el('div', { class: 'sb-line' }, el('b', {}, 'AC '), String(a.ac), el('span', { class: 'sp' }), el('b', {}, 'Initiative '), rb(`${sign(a.init)} (${10 + a.init})`, `1d20${a.init >= 0 ? '+' : ''}${a.init}`, 'Initiative')),
    el('div', { class: 'sb-line' }, el('b', {}, 'HP '), `${a.hp.max}`, a.hp.formula ? el('span', { class: 'muted' }, ` (${a.hp.formula})`) : null),
    el('div', { class: 'sb-line' }, el('b', {}, 'Speed '), a.speed),
  );
  const tbl = el('div', { class: 'sb-abil' });
  for (const k of ABIL) {
    const v = a.abilities[k], m = mod(v), s = a.saves?.[k] ?? m;
    tbl.append(el('div', { class: 'ab' }, el('span', { class: 'k' }, AB_LABEL[k]), el('span', { class: 'v' }, v),
      rb(sign(m), `1d20${m >= 0 ? '+' : ''}${m}`, `${AB_LABEL[k]} check`, 'm'),
      rb(sign(s), `1d20${s >= 0 ? '+' : ''}${s}`, `${AB_LABEL[k]} save`, 's' + (a.saveProf?.includes(k) ? ' prof' : ''))));
  }
  sb.append(el('div', { class: 'sb-abil-h' }, el('span', {}), el('span', {}), el('span', {}, 'Mod'), el('span', {}, 'Save')), tbl);
  const lines = [];
  if (a.skills && Object.keys(a.skills).length) lines.push(['Skills', Object.entries(a.skills).map(([k, v]) => [k, v])]);
  if (a.vuln?.length) lines.push(['Vulnerabilities', a.vuln.join(', ')]);
  if (a.resist?.length) lines.push(['Resistances', a.resist.join(', ')]);
  if (a.immune?.length || a.condImmune?.length) lines.push(['Immunities', [...(a.immune || []), ...(a.condImmune || [])].join(', ')]);
  lines.push(['Senses', a.senses], ['Languages', a.languages], ['CR', `${a.crText} (XP ${a.xp.toLocaleString()}; PB ${sign(a.pb)})`]);
  for (const [k, v] of lines) {
    const line = el('div', { class: 'sb-line' }, el('b', {}, k + ' '));
    if (Array.isArray(v)) v.forEach(([sk, n], i) => line.append(i ? ', ' : '', rb(`${sk} ${sign(n)}`, `1d20${n >= 0 ? '+' : ''}${n}`, sk)));
    else line.append(v);
    sb.append(line);
  }
  const section = (title, list, note) => {
    if (!list?.length) return;
    sb.append(el('div', { class: 'sb-h' }, title));
    if (note) sb.append(el('p', { class: 'sb-note' }, note));
    for (const e of list) sb.append(entry(a, e, roll));
  };
  section('Traits', a.traits);
  section('Actions', a.actions);
  section('Bonus Actions', a.bonus);
  section('Reactions', a.reactions);
  section('Legendary Actions', a.legendary, a.legendaryUses ? `Legendary Action Uses: ${a.legendaryUses}. Immediately after another creature's turn, the ${a.name.toLowerCase()} can expend a use to take one of the following actions. It regains all expended uses at the start of each of its turns.` : '');
  if (a.notes) sb.append(el('div', { class: 'sb-h' }, 'Reskin notes'), el('div', { class: 'sb-text', html: a.notes }));
  return sb;
}

function entry(a, e, roll) {
  const wrap = el('div', { class: 'sb-entry' });
  const head = el('span', { class: 'en' }, e.name + '. ');
  const body = el('span', { class: 'sb-text', html: stripP(e.text) });
  wrap.append(head, body);
  const btns = el('div', { class: 'sb-btns' });
  for (const act of e.auto || []) {
    if (act.attack) {
      const b = act.attack.bonus;
      btns.append(el('button', { class: 'rb big', type: 'button', onclick: () => roll(`1d20${b >= 0 ? '+' : ''}${b}`, `${e.name} (attack)`, { attack: true }) }, `Attack ${sign(b)}`));
    }
    if (act.save) btns.append(el('span', { class: 'chip' }, `DC ${act.save.dc} ${act.save.abil.map(x => x.toUpperCase()).join('/')}`));
    if (act.damage?.length) {
      const f = act.damage.map(p => p.f.replace(/\s+/g, '')).join('+').replace(/\+-/g, '-');
      const types = [...new Set(act.damage.map(p => p.type).filter(Boolean))].join(' + ');
      btns.append(el('button', { class: 'rb big', type: 'button', onclick: () => roll(f, `${e.name} (${types || 'damage'})`) }, `Damage ${f}`));
      if (act.attack) btns.append(el('button', { class: 'rb', type: 'button', title: 'Critical hit: dice doubled', onclick: () => roll(critFormula(act.damage), `${e.name} (critical ${types})`) }, 'Crit'));
    }
    if (act.heal) btns.append(el('button', { class: 'rb big', type: 'button', onclick: () => roll(act.heal.f.replace(/\s+/g, ''), `${e.name}`) }, act.heal.f));
  }
  const rech = e.name.match(/Recharge (\d)/);
  if (rech) btns.append(el('button', { class: 'rb', type: 'button', onclick: () => roll('1d6', `${e.name.replace(/ \(.*/, '')} recharge (needs ${rech[1]}+)`) }, 'Recharge d6'));
  if (btns.children.length) wrap.append(btns);
  return wrap;
}

export function critFormula(parts) {
  return parts.map(p => (p.n && p.d ? `${p.n * 2}d${p.d}` : '') + (typeof p.b === 'number' && p.b ? (p.b > 0 ? '+' : '') + p.b : '')).filter(Boolean).join('+').replace(/\+-/g, '-');
}

function stripP(html) { return String(html || '').replace(/^<p>/, '').replace(/<\/p>$/, '').replace(/<\/p>\s*<p>/g, '<br><br>'); }
