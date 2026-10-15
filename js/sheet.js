// The character sheet: numbers, actions, spells, checks and resources.
// It only shows and asks; the DM's rules engine does the rolling and applying.
// handlers: { use(entry, req), check(kind, key, mode), rest(kind), setState(patch), deathSave(), endConc(), targets() }

import { el, escapeHtml } from './util.js';
import { popover, closePopover } from './ui.js';
import { sheetNumbers, ABIL, ABIL_NAME, SKILL_ABIL, stripHtml } from './rules.js';

const sgn = n => (n >= 0 ? '+' : '') + n;
const TIME = { action: 'Actions', bonus: 'Bonus actions', reaction: 'Reactions', special: 'Other' };
const TIME_OF_SPELL = t => /bonus/i.test(t) ? 'bonus' : /reaction/i.test(t) ? 'reaction' : /action/i.test(t) ? 'action' : 'special';
const SHAPES = { circle: 'circle', sphere: 'circle', radius: 'circle', cylinder: 'circle', emanation: 'circle', cone: 'cone', line: 'line', cube: 'cube', square: 'cube' };
const MANEUVER = { trip: 'Trip Attack', disarming: 'Disarming Attack', goading: 'Goading Attack' };
export const AREA_SHAPE = a => SHAPES[String(a?.shape || '').toLowerCase()] || null;

// Whether using this needs a target picked with T (attacks, single-target saves and damage).
export function needsTarget(entry, i = 0) {
  if (entry.poolHeal || entry.castSpell) return !!entry.castSpell;
  const act = entry.auto ? entry.auto[i] : entry.attack ? { type: 'attack' } : entry.save ? { type: 'save', area: entry.area } : null;
  if (!act) return !!entry.targetEffect && !/^self/i.test(entry.range || '');
  if (entry.area || act.area) return false;
  if (/^self/i.test(entry.range || '') && act.type !== 'attack') return false;
  return act.type === 'attack' || act.type === 'save' || act.type === 'damage';
}

export function isPrepared(sheet, state, s) {
  const o = state?.prep?.[s.id];
  if (o != null) return o;
  return !!(s.always || s.prepared || s.level === 0 || !sheet.spells.some(x => x.prepared));
}

// The whole sheet. view: { ch, sheet, state, effects, concentration }
export function renderSheet(view, H, ui = {}) {
  const { ch, sheet } = view;
  const state = view.state || {};
  const n = sheetNumbers(sheet);
  const mode = ui.mode || (ui.mode = { v: null });
  const tab = ui.tab || 'actions';
  const bladesong = (view.effects || []).some(e => /bladesong/i.test(e.name));
  const root = el('div', { class: 'sheet', style: { '--pc': ch.color } });

  // ---- header
  const cls = sheet.classes.map(c => `${c.name}${c.sub ? ' (' + c.sub + ')' : ''} ${c.level}`).join(' / ');
  const ac = ch.acShown ?? ch.ac;
  const stats = el('div', { class: 'sh-stats' },
    stat('AC', ac), stat('HP', `${ch.hp.value}/${ch.hp.max}${ch.hp.temp ? ' +' + ch.hp.temp : ''}`), stat('Speed', ch.speed || sheet.speed),
    btnStat('Init', sgn(n.init), () => H.check('init', null, takeMode())), stat('Prof', sgn(n.pb)),
    sheet.spellcasting ? stat('Spell', `${sgn(n.spellAttack)} · DC ${n.spellDC}`) : null);
  const modeRow = el('div', { class: 'sh-mode' }, el('span', { class: 'muted small' }, 'Next d20:'),
    ...['adv', 'dis'].map(m => el('button', { class: 'btn small', type: 'button', 'aria-pressed': mode.v === m ? 'true' : 'false', onclick: () => { mode.v = mode.v === m ? null : m; H.refresh?.(); } }, m === 'adv' ? 'Advantage' : 'Disadvantage')),
    el('span', { class: 'grow' }),
    el('span', { class: 'chip', title: 'Hover a token on the map and press T to target it' }, `🎯 ${H.targets?.().length || 0} targeted`));
  function takeMode() { const m = mode.v; if (m) { mode.v = null; H.refresh?.(); } return m; }

  const head = el('div', { class: 'sh-head' },
    el('div', { class: 'sh-name' }, ch.name),
    el('div', { class: 'sh-sub' }, `${sheet.species} · ${cls}`),
    stats, modeRow);
  // concentration and effects
  const fx = el('div', { class: 'sh-fx' });
  if (view.concentration) fx.append(el('span', { class: 'chip conc' }, `Concentrating: ${view.concentration}`, el('button', { class: 'x', type: 'button', title: 'End concentration', onclick: () => H.endConc() }, '×')));
  for (const e of view.effects || []) fx.append(el('span', { class: 'chip', title: e.origin ? 'From ' + e.origin : '' }, e.name + (e.rounds != null ? ` · ${fmtR(e.rounds)}` : '')));
  if (fx.children.length) head.append(fx);
  if (ch.hp.value <= 0) {
    const d = state.death || { s: 0, f: 0 };
    head.append(el('div', { class: 'sh-death' }, el('b', {}, 'Dying'),
      el('span', {}, 'Successes ', pips(d.s, 3, 'ok')), el('span', {}, 'Failures ', pips(d.f, 3, 'bad')),
      el('button', { class: 'btn small primary', type: 'button', onclick: () => H.deathSave() }, 'Death save')));
  }
  root.append(head);

  // ---- tabs
  const TABS = [['actions', 'Actions'], sheet.spellcasting ? ['spells', 'Spells'] : null, ['checks', 'Checks'], ['features', 'Features'], ['gear', 'Gear']].filter(Boolean);
  const tabs = el('div', { class: 'sh-tabs', role: 'tablist' }, TABS.map(([id, label]) => el('button', { type: 'button', role: 'tab', 'aria-selected': id === tab ? 'true' : 'false', onclick: () => { ui.tab = id; H.refresh?.(); } }, label)));
  root.append(tabs);
  const body = el('div', { class: 'sh-body' });
  root.append(body);

  if (tab === 'actions') {
    const groups = {};
    for (const a of sheet.actions) (groups[a.time] ||= []).push(a);
    // cantrips and spells you'd reach for in a fight also appear here
    for (const k of Object.keys(TIME)) {
      if (!groups[k]?.length) continue;
      body.append(el('h4', { class: 'sh-h' }, TIME[k]));
      for (const a of groups[k]) body.append(actionRow(a));
    }
    body.append(el('h4', { class: 'sh-h' }, 'Rest'),
      el('div', { class: 'row' }, el('button', { class: 'btn small', type: 'button', onclick: () => H.rest('short') }, 'Short rest'), el('button', { class: 'btn small', type: 'button', onclick: () => H.rest('long') }, 'Long rest')));
  }

  if (tab === 'spells') body.append(...spellsTab());

  if (tab === 'checks') {
    const grid = el('div', { class: 'sh-abil' });
    for (const a of ABIL) {
      const v = sheet.abilities[a], m = n.m[a], sv = n.save(a);
      grid.append(el('div', { class: 'ab' + (sheet.saveProf?.includes(a) ? ' prof' : '') },
        el('div', { class: 'k' }, ABIL_NAME[a]), el('div', { class: 'v' }, v),
        el('div', { class: 'row' },
          el('button', { class: 'rb', type: 'button', title: ABIL_NAME[a] + ' check', onclick: () => H.check('ability', a, takeMode()) }, 'Check ' + sgn(m + (sheet.checkBonus || 0))),
          el('button', { class: 'rb s', type: 'button', title: ABIL_NAME[a] + ' save', onclick: () => H.check('save', a, takeMode()) }, 'Save ' + sgn(sv)))));
    }
    body.append(grid);
    if (sheet.saveNotes) body.append(el('p', { class: 'sh-note' }, sheet.saveNotes));
    if (sheet.aura) body.append(el('p', { class: 'sh-note' }, `${sheet.aura.name}: added to saves automatically for anyone within ${sheet.aura.radius} ft.`));
    body.append(el('h4', { class: 'sh-h' }, 'Skills'));
    const sk = el('div', { class: 'sh-skills' });
    for (const name of Object.keys(SKILL_ABIL)) {
      const p = sheet.skills?.[name] || 0;
      sk.append(el('button', { class: 'sk' + (p ? ' prof' : '') + (p >= 2 ? ' exp' : ''), type: 'button', onclick: () => H.check('skill', name, takeMode()), title: sheet.skillNotes?.[name] || '' },
        el('span', {}, name, el('small', {}, ' ' + SKILL_ABIL[name].toUpperCase())), el('b', {}, sgn(n.skill(name)))));
    }
    body.append(sk, el('p', { class: 'sh-note' }, `Passive Perception ${n.passive}. ${sheet.senses && sheet.senses !== '—' ? sheet.senses + '.' : ''} Tools: ${sheet.tools || '—'}. Languages: ${sheet.languages || '—'}.`));
  }

  if (tab === 'features') {
    for (const f of sheet.features || []) body.append(el('details', { class: 'sh-feat' }, el('summary', {}, f.name), el('p', {}, f.text)));
    if (H.isDM && sheet.flags?.length) body.append(el('h4', { class: 'sh-h' }, 'Notes from the PDF conversion'), el('ul', { class: 'sh-flags' }, sheet.flags.map(f => el('li', {}, f))));
  }

  if (tab === 'gear') {
    body.append(el('h4', { class: 'sh-h' }, 'Resources'));
    for (const r of sheet.resources || []) {
      const used = state.used?.[r.id] || 0, left = r.max - used;
      body.append(el('div', { class: 'sh-res' }, el('span', { class: 'grow' }, r.name, el('small', { class: 'muted' }, ` · ${recov(r.recover)}`)),
        el('button', { class: 'btn small icon', type: 'button', 'aria-label': 'Use one', onclick: () => H.setState({ used: { [r.id]: Math.min(r.max, used + 1) } }) }, '−'),
        el('b', { class: 'mono' }, `${left}/${r.max}`),
        el('button', { class: 'btn small icon', type: 'button', 'aria-label': 'Get one back', onclick: () => H.setState({ used: { [r.id]: Math.max(0, used - 1) } }) }, '+')));
    }
    body.append(el('h4', { class: 'sh-h' }, 'Inventory'), el('ul', { class: 'sh-inv' }, (sheet.inventory || []).map(i => el('li', {}, i))));
    if (sheet.acNote) body.append(el('p', { class: 'sh-note' }, 'AC: ' + sheet.acNote));
  }
  return root;

  // ------------------------------------------------------------ rows

  function actionRow(a) {
    const info = [];
    if (a.attack) {
      let ab = [...(a.attack.ability || ['str'])];
      if (ab.includes('bladework')) { ab = ab.filter(x => x !== 'bladework'); if (bladesong) ab.push('int'); }
      const best = a.attack.spell ? null : ab.reduce((b, x) => (n.m[x] > n.m[b] ? x : b), ab[0]);
      const toHit = a.attack.spell ? (a.attack.noFocus ? n.spellAttackBase : n.spellAttack) : n.m[best] + n.pb + (a.attack.bonus || 0);
      info.push(sgn(toHit) + ' to hit');
      if (a.damage?.length) info.push(a.damage.map(p => dmgText(p, best ? n.m[best] : 0)).join(' + '));
    } else if (a.save) {
      info.push(`DC ${n.spellDC} ${(a.save.abil || []).map(x => x.toUpperCase()).join('/')}`);
      if (a.damage?.length) info.push(a.damage.map(p => dmgText(p, 0)).join(' + '));
      if (a.area) info.push(`${a.area.size} ft ${a.area.shape}`);
    }
    const res = a.uses ? sheet.resources.find(r => r.id === a.uses) : a.pool ? sheet.resources.find(r => r.id === a.pool) : null;
    const left = res ? res.max - (state.used?.[res.id] || 0) : null;
    if (res) info.push(`${left}/${res.max} left`);
    const hasOpts = a.kind === 'weapon' || a.poolHeal || a.castSpell;
    return row(a.name, info.join(' · '), a.text, [
      el('button', { class: 'btn small primary', type: 'button', disabled: res && left <= 0, onclick: () => H.use(a, { src: 'action', id: a.id, opts: modeOpts() }) }, a.attack ? 'Attack' : a.save ? 'Use' : a.castSpell ? 'Cast' : 'Use'),
      hasOpts ? el('button', { class: 'btn small', type: 'button', 'aria-label': 'Options', onclick: e => actionOptions(e, a) }, '⋯') : null]);
  }

  function modeOpts() { const m = takeMode(); return m === 'adv' ? { adv: true } : m === 'dis' ? { dis: true } : {}; }

  function actionOptions(e, a) {
    const o = { ...modeOpts() };
    const f = el('div', { class: 'stack sh-opts' }, el('h4', {}, a.name));
    if (a.versatile) f.append(check('Two-handed (versatile)', v => { o.versatile = v; }));
    if (a.riders?.includes('smite')) {
      const sel = el('select', { 'aria-label': 'Divine Smite' }, el('option', { value: '' }, 'No smite'));
      const slots = sheet.spellcasting?.slots || [];
      slots.forEach((max, i) => { const left = max - (state.slots?.[i + 1] || 0); if (left > 0) sel.append(el('option', { value: 'L' + (i + 1) }, `Divine Smite, level ${i + 1} slot (${left} left)`)); });
      const pact = sheet.spellcasting?.pact; if (pact && (state.pact || 0) < pact.max) sel.append(el('option', { value: 'P' }, `Divine Smite, Pact slot (level ${pact.level})`));
      const fr = sheet.resources.find(r => r.id === 'free-smite'); if (fr && !(state.used?.['free-smite'])) sel.append(el('option', { value: 'F' }, 'Divine Smite, free (once per long rest)'));
      sel.addEventListener('change', () => { const v = sel.value; o.smite = !v ? null : v === 'F' ? { level: 1, free: true } : v === 'P' ? { level: sheet.spellcasting.pact.level, pact: true } : { level: Number(v.slice(1)) }; });
      f.append(el('label', { class: 'stack' }, el('span', { class: 'small muted' }, 'On a hit'), sel), el('p', { class: 'small muted' }, 'The slot is only spent if you hit.'));
    }
    if (a.riders?.includes('shieldBash')) f.append(check('Shield Bash (once per turn, on a hit)', v => { o.shieldBash = v; }));
    if (a.riders?.includes('maneuver') && sheet.maneuvers) {
      const left = (sheet.resources.find(r => r.id === 'sd')?.max || 0) - (state.used?.sd || 0);
      const sel = el('select', { 'aria-label': 'Maneuver' }, el('option', { value: '' }, 'No maneuver'), sheet.maneuvers.list.map(m => el('option', { value: m }, `${MANEUVER[m] || m} (${sheet.maneuvers.die})`)));
      sel.disabled = left <= 0;
      sel.addEventListener('change', () => { o.maneuver = sel.value || null; });
      f.append(el('label', { class: 'stack' }, el('span', { class: 'small muted' }, `Maneuver on a hit (${left} dice left)`), sel));
    }
    if (a.riders?.includes('trueStrike')) f.append(check('Cast True Strike (use Int, Radiant)', v => { o.trueStrike = v; }));
    if (a.poolHeal) {
      const res = sheet.resources.find(r => r.id === a.pool), left = res.max - (state.used?.[res.id] || 0);
      const amt = el('input', { type: 'number', min: 1, max: left, value: Math.min(10, left), 'aria-label': 'HP to restore' });
      f.append(el('label', { class: 'stack' }, el('span', { class: 'small muted' }, `HP to restore (${left} in the pool). Target a creature, or it heals you.`), amt), check('Cure Poisoned instead (5 from the pool)', v => { o.cure = v; }));
      f.append(el('button', { class: 'btn primary', type: 'button', onclick: () => { closePopover(); H.use(a, { src: 'action', id: a.id, opts: { ...o, amount: Number(amt.value) || 1 } }); } }, 'Use'));
      return pop(e, f);
    }
    if (a.castSpell) {
      const res = sheet.resources.find(r => r.id === a.uses), left = res.max - (state.used?.[res.id] || 0);
      const ch = el('input', { type: 'number', min: 1, max: Math.max(1, left), value: 1, 'aria-label': 'Charges' });
      f.append(el('label', { class: 'stack' }, el('span', { class: 'small muted' }, `Charges to spend (${left} left): 1 charge is a level 1 spell, each extra adds a level`), ch));
      f.append(el('button', { class: 'btn primary', type: 'button', onclick: () => { closePopover(); H.use({ ...a, castLevel: Number(ch.value) || 1 }, { src: 'action', id: a.id, opts: { ...o, charges: Number(ch.value) || 1 } }); } }, 'Cast'));
      return pop(e, f);
    }
    f.append(el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'button', onclick: () => { closePopover(); H.use(a, { src: 'action', id: a.id, opts: o }); } }, 'Attack'),
      el('span', { class: 'small muted' }, 'Uses your targets')));
    pop(e, f);
  }

  function spellsTab() {
    const out = [];
    const sc = sheet.spellcasting;
    const slots = el('div', { class: 'sh-slots' });
    (sc.slots || []).forEach((max, i) => {
      const lv = i + 1, used = state.slots?.[lv] || 0;
      slots.append(el('div', { class: 'sl' }, el('span', { class: 'small muted' }, 'Level ' + lv),
        el('span', { class: 'pp' }, Array.from({ length: max }, (_, k) => el('button', { type: 'button', class: k < max - used ? 'on' : '', title: 'Click to mark spent or recovered', onclick: () => H.setState({ slots: { [lv]: k < max - used ? used + 1 : Math.max(0, used - 1) } }) })))));
    });
    if (sc.pact) {
      const used = state.pact || 0;
      slots.append(el('div', { class: 'sl pact' }, el('span', { class: 'small muted' }, `Pact (level ${sc.pact.level})`),
        el('span', { class: 'pp' }, Array.from({ length: sc.pact.max }, (_, k) => el('button', { type: 'button', class: k < sc.pact.max - used ? 'on' : '', onclick: () => H.setState({ pact: k < sc.pact.max - used ? used + 1 : Math.max(0, used - 1) }) })))));
    }
    out.push(slots);
    if (sc.attackNote) out.push(el('p', { class: 'sh-note' }, sc.attackNote));
    const prepared = sheet.spells.filter(s => isPrepared(sheet, state, s) && !s.ritualOnly);
    const rituals = sheet.spells.filter(s => s.ritualOnly);
    const others = sheet.spells.filter(s => !isPrepared(sheet, state, s) && !s.ritualOnly);
    const byLevel = {};
    for (const s of prepared) (byLevel[s.level] ||= []).push(s);
    for (const lv of Object.keys(byLevel).sort((a, b) => a - b)) {
      out.push(el('h4', { class: 'sh-h' }, lv === '0' ? 'Cantrips' : 'Level ' + lv));
      for (const s of byLevel[lv]) out.push(spellRow(s, true));
    }
    if (rituals.length) { out.push(el('h4', { class: 'sh-h' }, 'Rituals')); for (const s of rituals) out.push(spellRow(s, true, true)); }
    if (others.length) {
      const d = el('details', { class: 'sh-more' }, el('summary', {}, `Not prepared (${others.length})`));
      for (const s of others.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))) d.append(spellRow(s, false));
      out.push(d);
    }
    return out;
  }

  function spellRow(s, prepared, ritualOnly) {
    const auto = s.auto?.[0];
    const info = [s.level ? `L${s.level}` : 'Cantrip', s.time];
    if (s.conc) info.push('Conc.');
    if (s.ritual) info.push('Ritual');
    if (auto?.type === 'attack') info.push(sgn(n.spellAttack) + ' to hit');
    if (auto?.type === 'save') info.push(`DC ${n.spellDC}${auto.save.abil?.length ? ' ' + auto.save.abil.map(x => x.toUpperCase()).join('/') : ''}`);
    if (auto?.damage?.length) info.push(auto.damage.map(p => dmgText(p, n.spellMod, s.level === 0 ? cantripDice(p) : null)).join(' + '));
    if (auto?.heal) info.push(`${auto.heal.n ? auto.heal.n + 'd' + auto.heal.d : ''}${/@mod/.test(auto.heal.b) ? ' + ' + n.spellMod : auto.heal.b ? ' ' + auto.heal.b : ''} heal`);
    if (s.area) info.push(`${s.area.size} ft ${s.area.shape}`);
    if (s.range) info.push(s.range);
    const can = prepared && canCast(s);
    const star = el('button', { class: 'star' + (prepared ? ' on' : ''), type: 'button', title: prepared ? 'Prepared (click to unprepare)' : 'Prepare', 'aria-label': 'Prepared', disabled: s.always || s.level === 0, onclick: () => H.setState({ prep: { [s.id]: !prepared } }) }, '★');
    return row([star, s.name], info.join(' · '), s.text, prepared || ritualOnly ? [
      el('button', { class: 'btn small primary', type: 'button', disabled: !can && !(ritualOnly || s.ritual), onclick: e => (needsOptions(s) ? spellOptions(e, s, ritualOnly) : H.use(s, { src: 'spell', id: s.id, slot: s.level, opts: { ...modeOpts(), ritual: ritualOnly, focusDamage: !!sc().focusDamage } })) }, ritualOnly ? 'Ritual' : 'Cast'),
      el('button', { class: 'btn small', type: 'button', 'aria-label': 'Options', onclick: e => spellOptions(e, s, ritualOnly) }, '⋯')] : []);
  }
  function sc() { return sheet.spellcasting || {}; }

  function slotsLeft(lv) { return (sc().slots?.[lv - 1] || 0) - (state.slots?.[lv] || 0); }
  function pactOk(s) { const p = sc().pact; return p && (state.pact || 0) < p.max && p.level >= s.level; }
  function canCast(s) {
    if (!s.level) return true;
    for (let lv = s.level; lv <= (sc().slots?.length || 0); lv++) if (slotsLeft(lv) > 0) return true;
    return pactOk(s);
  }
  function needsOptions(s) {
    if (!s.level) return (s.auto?.[0]?.damage?.[0]?.types?.length || 0) > 1;
    if (slotsLeft(s.level) <= 0) return true; // must choose a higher slot or pact
    if ((s.auto || []).length > 1 || (s.auto?.[0]?.damage?.[0]?.types?.length || 0) > 1) return true;
    const effs = (s.effects || []).filter(e => s.auto?.[0]?.effects?.includes(e.id));
    return effs.length > 1 && !/^Level \d/.test(effs[0].name);
  }

  function spellOptions(e, s, ritualOnly) {
    const o = { ...modeOpts(), focusDamage: !!sc().focusDamage };
    let slot = s.level, pact = false;
    const f = el('div', { class: 'stack sh-opts' }, el('h4', {}, s.name));
    if (s.level && !ritualOnly) {
      const sel = el('select', { 'aria-label': 'Spell slot' });
      for (let lv = s.level; lv <= (sc().slots?.length || 0); lv++) { const left = slotsLeft(lv); sel.append(el('option', { value: 'L' + lv, disabled: left <= 0 }, `Level ${lv} slot (${left} left)`)); }
      if (pactOk(s)) sel.append(el('option', { value: 'P' }, `Pact slot, level ${sc().pact.level} (${sc().pact.max - (state.pact || 0)} left)`));
      const first = [...sel.options].find(x => !x.disabled); if (first) first.selected = true;
      const read = () => { pact = sel.value === 'P'; slot = pact ? sc().pact.level : Number(sel.value.slice(1)); };
      sel.addEventListener('change', read); read();
      f.append(el('label', { class: 'stack' }, el('span', { class: 'small muted' }, 'Cast with'), sel));
    }
    if (s.ritual && !ritualOnly) f.append(check('Cast as a ritual (10 extra minutes, no slot)', v => { o.ritual = v; }));
    if (ritualOnly) o.ritual = true;
    if ((s.auto || []).length > 1) {
      const sel = el('select', { 'aria-label': 'Which part' }, s.auto.map((a, i) => el('option', { value: i }, a.name || ['Cast', 'Second part', 'Third part'][i] || 'Part ' + (i + 1))));
      sel.addEventListener('change', () => { o.activity = Number(sel.value); });
      f.append(el('label', { class: 'stack' }, el('span', { class: 'small muted' }, 'Use'), sel));
    }
    const types = s.auto?.[0]?.damage?.[0]?.types || [];
    if (types.length > 1) {
      const sel = el('select', { 'aria-label': 'Damage type' }, types.map(t => el('option', { value: t }, cap(t))));
      o.dmgType = types[0];
      sel.addEventListener('change', () => { o.dmgType = sel.value; });
      f.append(el('label', { class: 'stack' }, el('span', { class: 'small muted' }, 'Damage type'), sel));
    }
    const effs = (s.effects || []).filter(x => s.auto?.[0]?.effects?.includes(x.id));
    if (effs.length > 1 && !/^Level \d/.test(effs[0].name)) {
      const sel = el('select', { 'aria-label': 'Option' }, effs.map((x, i) => el('option', { value: i }, x.name)));
      sel.addEventListener('change', () => { o.effect = Number(sel.value); });
      f.append(el('label', { class: 'stack' }, el('span', { class: 'small muted' }, 'Choose'), sel));
    }
    if (sc().focusDamage && s.auto?.some(a => a.damage?.length)) f.append(check(`${sc().focusDamage.label} (+${sc().focusDamage.f})`, v => { o.focusDamage = v; }, true));
    f.append(el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'button', onclick: () => { closePopover(); H.use(s, { src: 'spell', id: s.id, slot, pact, opts: o }); } }, 'Cast'),
      el('span', { class: 'small muted' }, s.area ? 'You’ll place the area next' : 'Uses your targets')));
    pop(e, f);
  }

  function row(name, info, text, buttons) {
    const det = el('details', { class: 'sh-row' },
      el('summary', {}, el('span', { class: 'nm' }, ...(Array.isArray(name) ? name : [name])), el('span', { class: 'in' }, info),
        el('span', { class: 'bt', onclick: e => e.preventDefault() }, ...buttons)),
      el('div', { class: 'tx', html: /<p>/.test(text || '') ? text : `<p>${escapeHtml(text || '')}</p>` }));
    return det;
  }
  function cantripDice(p) {
    if (p.scale?.mode !== 'whole') return null;
    const tier = sheet.level >= 17 ? 4 : sheet.level >= 11 ? 3 : sheet.level >= 5 ? 2 : 1;
    return p.n * tier;
  }
}

function dmgText(p, abilMod, nOverride) {
  const nn = nOverride ?? p.n;
  let b = typeof p.b === 'number' ? p.b : (p.b && /^-?\d+$/.test(p.b) ? Number(p.b) : 0);
  if (p.ability) b += abilMod;
  if (typeof p.b === 'string' && /@mod/.test(p.b)) b += abilMod;
  return `${nn && p.d ? nn + 'd' + p.d : ''}${b ? (nn ? (b > 0 ? '+' : '') : '') + b : ''} ${p.type || ''}`.trim();
}
function stat(k, v) { return el('div', { class: 'st' }, el('span', { class: 'k' }, k), el('b', {}, String(v ?? '—'))); }
function btnStat(k, v, fn) { return el('button', { class: 'st', type: 'button', onclick: fn, title: 'Roll ' + k }, el('span', { class: 'k' }, k), el('b', {}, String(v))); }
function pips(n, max, cls) { return el('span', { class: 'pp ' + cls }, Array.from({ length: max }, (_, i) => el('i', { class: i < n ? 'on' : '' }))); }
function check(label, fn, on = false) { const i = el('input', { type: 'checkbox', checked: on }); i.addEventListener('change', () => fn(i.checked)); return el('label', { class: 'check' }, i, label); }
function pop(e, f) { const r = e.currentTarget.getBoundingClientRect(); popover(Math.max(8, r.right - 320), r.bottom + 6, f); }
function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }
function recov(r) { return { lr: 'long rest', sr: 'short rest', dawn: 'dawn', none: 'doesn’t recover' }[r] || r; }
function fmtR(r) { return r >= 600 ? Math.round(r / 600) + ' hr' : r >= 10 ? Math.round(r / 10) + ' min' : r + ' rd'; }
export { stripHtml };

// A floating window holding one sheet; keeps its tab, scroll and open rows across refreshes.
export class SheetWindow {
  constructor(cls = '') {
    this.el = el('aside', { class: 'sheet-win ' + cls, hidden: true, 'aria-label': 'Character sheet' });
    document.body.append(this.el);
    this.ui = {};
  }
  get isOpen() { return !this.el.hidden; }
  open(getView, H) {
    if (this.key !== H.key) this.ui = {};
    this.key = H.key;
    this.getView = getView; this.H = { ...H, refresh: () => this.render() };
    this.el.hidden = false;
    this.render();
  }
  close() { this.el.hidden = true; this.getView = null; this.key = null; }
  // Step out of the way while an area is placed on the map (like Foundry minimising the sheet).
  stepAside(on) { if (!this.getView) return; this.el.hidden = !!on; if (!on) this.render(); }
  render() {
    if (!this.isOpen || !this.getView) return;
    const v = this.getView();
    if (!v?.sheet) { this.close(); return; }
    const body = this.el.querySelector('.sh-body');
    const scroll = body ? body.scrollTop : 0;
    const open = [...this.el.querySelectorAll('details')].map((d, i) => (d.open ? i : -1)).filter(i => i >= 0);
    const sameTab = this.lastTab === (this.ui.tab || 'actions');
    this.el.innerHTML = '';
    this.el.style.setProperty('--pc', v.ch.color || '');
    let sheetEl;
    try { sheetEl = renderSheet(v, this.H, this.ui); }
    catch (e) { console.error(e); sheetEl = el('div', { class: 'sh-head' }, el('p', {}, 'This sheet couldn’t be drawn: ' + e.message)); }
    this.el.append(el('button', { class: 'btn icon ghost sheet-x', type: 'button', 'aria-label': 'Close sheet', onclick: () => this.close() }, '×'), sheetEl);
    this.lastTab = this.ui.tab || 'actions';
    if (sameTab) {
      const ds = this.el.querySelectorAll('details');
      for (const i of open) if (ds[i]) ds[i].open = true;
      const nb = this.el.querySelector('.sh-body'); if (nb) nb.scrollTop = scroll;
    }
  }
}
