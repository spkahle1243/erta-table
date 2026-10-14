// The rules engine. It runs in the DM's tab, which holds every stat block,
// sheet and hidden number, so results are decided in one place. Players send
// what they want to do; the engine rolls (in the player's colour, on every
// screen), applies the outcome and writes a card to everyone's log.

import { uid } from './util.js';
import { roll as rollDice, parseFormula } from './dice.js';
import { tokenDistanceFt, tokensInTemplate } from './geometry.js';
import { condId, condLevel } from './conditions.js';

const ABIL = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const ABIL_NAME = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };
const SKILL_ABIL = { Acrobatics: 'dex', 'Animal Handling': 'wis', Arcana: 'int', Athletics: 'str', Deception: 'cha', History: 'int', Insight: 'wis', Intimidation: 'cha', Investigation: 'int', Medicine: 'wis', Nature: 'int', Perception: 'wis', Performance: 'cha', Persuasion: 'cha', Religion: 'int', 'Sleight of Hand': 'dex', Stealth: 'dex', Survival: 'wis' };
export { ABIL, ABIL_NAME, SKILL_ABIL };

const mod = v => Math.floor((v - 10) / 2);
const sgn = n => (n >= 0 ? '+' : '') + n;
export const pbFor = level => 2 + Math.floor((Math.max(1, level) - 1) / 4);
const cantripTier = level => (level >= 17 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1);

// ------------------------------------------------------------------ sheets (pure, also used by the player sheet UI)

export function sheetNumbers(sheet, eff = []) {
  const m = Object.fromEntries(ABIL.map(a => [a, mod(sheet.abilities[a])]));
  const pb = pbFor(sheet.level);
  const save = a => m[a] + (sheet.saveProf?.includes(a) ? pb : 0) + (sheet.saveBonus || 0);
  const skill = name => {
    const p = sheet.skills?.[name] || 0;
    return m[SKILL_ABIL[name]] + Math.floor(pb * p) + (sheet.checkBonus || 0);
  };
  const sc = sheet.spellcasting;
  const spellMod = sc ? m[sc.ability] : 0;
  return {
    m, pb, save, skill,
    init: m.dex + (sheet.initBonus || 0) + (sheet.checkBonus || 0),
    spellAttack: sc ? spellMod + pb + (sc.attackBonus || 0) : null,
    spellAttackBase: sc ? spellMod + pb : null,
    spellDC: sc ? 8 + spellMod + pb + (sc.dcBonus || 0) : null,
    spellMod,
    passive: 10 + skill('Perception'),
  };
}

// ------------------------------------------------------------------ actors

// A uniform view of a creature on the map: PC (character + sheet) or NPC (token + stat block).
export function actorFor(camp, scene, token) {
  if (!token) return null;
  if (token.charId) {
    const ch = camp.characters.find(c => c.id === token.charId);
    if (!ch) return null;
    const sh = ch.sheet;
    const n = sh ? sheetNumbers(sh) : null;
    return {
      key: 'c:' + ch.id, kind: 'pc', token, char: ch, sheet: sh, name: ch.name, color: ch.color,
      hp: ch.hp, setHp: hp => { ch.hp = hp; }, effects: (ch.effects ||= []), conditions: (ch.conditions ||= []),
      setConditions: v => { ch.conditions = v; },
      mod: a => (sh ? n.m[a] : 0), pb: sh ? n.pb : 2, level: sh?.level || 1,
      saveBonus: a => (sh ? n.save(a) : 0), skill: s => (sh ? n.skill(s) : 0),
      acBase: ch.ac, resist: low(sh?.resist), immune: low(sh?.immune), vuln: low(sh?.vuln), condImmune: low(sh?.condImmune),
      traits: [...(sh?.features || []).map(f => f.name.toLowerCase())], concAdv: !!sh?.concAdv,
      friendly: true, type: 'humanoid', size: ch.size || 1,
      spellAttack: n?.spellAttack, spellAttackBase: n?.spellAttackBase, spellDC: n?.spellDC, spellMod: n?.spellMod,
    };
  }
  const a = token.actorId ? camp.actors?.[token.actorId] : null;
  const ab = a?.abilities;
  return {
    key: 't:' + token.id, kind: 'npc', token, actor: a, name: token.name, color: null,
    hp: token.hp, setHp: hp => { token.hp = hp; }, effects: (token.effects ||= []), conditions: (token.conditions ||= []),
    setConditions: v => { token.conditions = v; },
    mod: k => (ab ? mod(ab[k]) : 0), pb: a?.pb || 2, level: Math.max(1, Math.round(a?.cr || 1)),
    saveBonus: k => (a?.saves?.[k] ?? (ab ? mod(ab[k]) : 0)), skill: s => (a?.skills?.[s] ?? (ab ? mod(ab[SKILL_ABIL[s]]) : 0)),
    acBase: token.ac, resist: low(a?.resist), immune: low(a?.immune), vuln: low(a?.vuln), condImmune: low(a?.condImmune),
    traits: [...['traits', 'actions', 'bonus', 'reactions'].flatMap(k => (a?.[k] || []).map(e => e.name.toLowerCase()))],
    friendly: token.disposition === 'friendly', type: (a?.type || '').toLowerCase(), size: token.size || 1,
    spellAttack: a ? mod(ab[a.spellAbility || 'int']) + a.pb : 0, spellDC: a?.spellDC || 10,
  };
}
const low = l => (l || []).map(x => String(x).toLowerCase());

export function condsOf(A) { return (A.conditions || []).map(condId); }
function has(A, c) { return condsOf(A).includes(c); }
function exhaustion(A) { const v = (A.conditions || []).find(x => condId(x) === 'exhaustion'); return v ? condLevel(v) || 1 : 0; }
function effMods(A) { return (A.effects || []).map(e => e.mods || {}); }

export function acOf(A) {
  let ac = A.acBase || 10;
  for (const m of effMods(A)) if (m.acBonus) ac += Number(m.acBonus) || 0;
  return ac;
}

// ------------------------------------------------------------------ engine

export class Engine {
  // io: { camp(), scene(), roll(formula, {label, by, hidden}) -> rollResult (shows dice), card(card), save(), refresh(),
  //       askSave(charId, req) -> Promise<{adv}> , onlineChars() -> Set, tokenFor(key) }
  constructor(io) { this.io = io; this.pending = new Map(); }

  get camp() { return this.io.camp(); }
  get scene() { return this.io.scene(); }
  actor(token) { return actorFor(this.camp, this.scene, token); }
  actorByKey(key) {
    const sc = this.scene;
    if (key.startsWith('c:')) { const t = sc.tokens.find(t => t.charId === key.slice(2)); if (t) return this.actor(t); const ch = this.camp.characters.find(c => c.id === key.slice(2)); return ch ? actorFor(this.camp, sc, { charId: ch.id, x: 0, y: 0, size: ch.size }) : null; }
    const t = sc.tokens.find(t => t.id === key.slice(2));
    return t ? this.actor(t) : null;
  }
  by(A) { return A.kind === 'pc' ? { name: A.name, color: A.color, charId: A.char.id } : { name: 'DM', color: '#E5916A' }; }

  // ---------------------------------------------------------------- d20 tests

  // Advantage/disadvantage and flat penalties for an attack from A against T.
  attackMode(A, T, kind, dist) {
    const adv = [], dis = [];
    const ac = condsOf(A), tc = condsOf(T);
    if (ac.includes('invisible')) adv.push('unseen');
    for (const c of ['blinded', 'frightened', 'poisoned', 'prone', 'restrained']) if (ac.includes(c)) dis.push(c);
    if (tc.includes('invisible')) dis.push('target unseen');
    for (const c of ['blinded', 'paralyzed', 'restrained', 'stunned', 'unconscious', 'petrified']) if (tc.includes(c)) adv.push('target ' + c);
    if (tc.includes('prone')) (kind === 'melee' && dist <= 5 ? adv : dis).push('target prone');
    if (kind === 'ranged' && dist <= 5 && this.hostilesNear(A, 5).length) dis.push('in melee');
    for (const e of T.effects || []) {
      if (e.mods?.advFrom && e.mods.advFrom === A.key) adv.push(e.name);
      if (e.mods?.attackedAdv) adv.push(e.name);
      if (e.mods?.attackedDis) dis.push(e.name);
    }
    for (const e of A.effects || []) if (e.mods?.disNextAttack) dis.push(e.name);
    return { adv, dis };
  }

  hostilesNear(A, ft) {
    const sc = this.scene; if (!A.token || !sc) return [];
    return sc.tokens.filter(t => t !== A.token && !t.hidden && (A.friendly ? t.disposition === 'hostile' && !t.charId : (t.charId || t.disposition === 'friendly')) && tokenDistanceFt(sc.grid, A.token, t) <= ft);
  }

  dist(A, T) { const sc = this.scene; return (A.token && T.token && sc) ? tokenDistanceFt(sc.grid, A.token, T.token, this.camp.settings.diagonals) : 5; }

  // Extra dice that apply to an actor's d20 rolls of a kind ('attack' | 'save' | 'check').
  bonusDice(A, kind) {
    const out = [];
    for (const e of A.effects || []) {
      const v = e.mods?.[kind + 'Bonus'];
      if (v && String(v).match(/d/)) out.push((String(v).startsWith('-') ? '' : '+') + v);
      else if (v) out.push(sgn(Number(v)));
    }
    const ex = exhaustion(A);
    if (ex) out.push(sgn(-2 * ex));
    return out.join('');
  }

  // Aura of Protection and similar: best save bonus from an ally's aura in range.
  auraBonus(A) {
    const sc = this.scene; if (!sc || !A.token) return 0;
    let best = 0;
    for (const t of sc.tokens) {
      if (!t.charId) continue;
      const ch = this.camp.characters.find(c => c.id === t.charId);
      const aura = ch?.sheet?.aura; if (!aura) continue;
      const src = this.actor(t);
      if (!A.friendly && A.kind !== 'pc') continue;
      if (src.hp.value <= 0 || ['incapacitated', 'unconscious', 'paralyzed', 'stunned', 'petrified'].some(c => has(src, c))) continue;
      if (t !== A.token && tokenDistanceFt(sc.grid, t, A.token) > aura.radius) continue;
      best = Math.max(best, src.mod(aura.saveBonus));
    }
    return best;
  }

  // ---------------------------------------------------------------- saves

  // Resolve a saving throw for target T. Players roll their own; monsters are rolled here.
  async savingThrow(T, abil, dc, { label, spell = false, conc = false } = {}) {
    const tc = condsOf(T);
    if (['str', 'dex'].includes(abil) && ['paralyzed', 'stunned', 'unconscious', 'petrified'].some(c => tc.includes(c)))
      return { total: 0, success: false, auto: true, note: 'fails automatically' };
    let adv = false, dis = false;
    if (abil === 'dex' && tc.includes('restrained')) dis = true;
    for (const e of T.effects || []) { if (e.mods?.advSave === abil || e.mods?.advSave === 'all') adv = true; }
    if (spell && T.traits.some(n => n.startsWith('magic resistance'))) adv = true;
    if (conc && T.concAdv) adv = true;
    let bonus = T.saveBonus(abil) + this.auraBonus(T);
    if (conc) for (const e of T.effects || []) if (e.mods?.concBonus) bonus += Number(e.mods.concBonus) || 0;
    const dice = (adv && !dis ? '2d20kh' : dis && !adv ? '2d20kl' : '1d20') + sgn(bonus) + this.bonusDice(T, 'save');
    const name = `${ABIL_NAME[abil]} save (DC ${dc})${label ? ' · ' + label : ''}`;
    if (T.kind === 'pc' && this.io.onlineChars().has(T.char.id)) {
      // The player clicks to roll; the DM can roll for them from the card.
      const id = uid(8);
      const p = new Promise(res => this.pending.set(id, { res, T, dice, name, dc }));
      this.io.askSave(T.char.id, { id, label: name, formula: dice });
      this.io.waiting?.(id, T.name, name);
      const r = await p;
      return { total: r.total, success: r.total >= dc, nat: r.nat };
    }
    const r = await this.io.roll(dice, { label: `${T.name}: ${name}`, by: this.by(T), hidden: T.kind === 'npc' && this.camp.settings.hideMonsterSaves });
    return { total: r.total, success: r.total >= dc, nat: r.nat };
  }

  // Called when a player clicks their save button (or the DM rolls for them).
  async resolvePendingSave(id) {
    const p = this.pending.get(id); if (!p) return;
    this.pending.delete(id);
    const r = await this.io.roll(p.dice, { label: `${p.T.name}: ${p.name}`, by: this.by(p.T) });
    p.res(r);
  }

  // ---------------------------------------------------------------- damage & healing

  // parts: [{f, type}] each with a numeric total → final damage after resistances.
  damageAfterTraits(T, parts) {
    const res = new Set(T.resist), imm = new Set(T.immune), vul = new Set(T.vuln);
    for (const e of T.effects || []) { for (const r of e.mods?.resist || []) res.add(String(r).toLowerCase()); }
    let total = 0; const notes = [];
    for (const p of parts) {
      const ty = (p.type || '').toLowerCase();
      let v = p.total;
      if (imm.has(ty)) { notes.push(`immune to ${ty}`); v = 0; }
      else {
        if (res.has(ty) || res.has('all')) { v = Math.floor(v / 2); notes.push(`resists ${ty}`); }
        if (vul.has(ty)) { v *= 2; notes.push(`vulnerable to ${ty}`); }
      }
      total += v;
    }
    return { total, notes };
  }

  // Applies damage, returns { dealt, undo, down }
  applyDamage(T, amount, card) {
    const before = { ...T.hp };
    const hp = { ...T.hp };
    const fromTemp = Math.min(hp.temp || 0, amount);
    hp.temp = (hp.temp || 0) - fromTemp;
    hp.value = Math.max(0, hp.value - (amount - fromTemp));
    T.setHp(hp);
    card.undo.push({ key: T.key, hp: before, conditions: [...(T.conditions || [])] });
    let down = false;
    if (T.kind === 'pc' && before.value === 0 && amount > 0) {
      const st = (T.char.state ||= {}); const d = (st.death ||= { s: 0, f: 0 }); d.f += 1; d.stable = false;
      card.lines.push({ t: `${T.name} takes damage while dying: a death save failure (${d.f}/3)`, c: 'bad' });
      if (d.f >= 3) T.setConditions([...new Set([...(T.conditions || []), 'dead'])]);
    }
    if (hp.value === 0 && before.value > 0) {
      down = true;
      const conds = (T.conditions || []).filter(c => condId(c) !== 'concentrating');
      if (T.kind === 'pc') { if (!conds.includes('unconscious')) conds.push('unconscious'); if (!conds.includes('prone')) conds.push('prone'); }
      else if (!conds.includes('dead')) conds.push('dead');
      T.setConditions(conds);
      this.endConcentration(T, card);
    }
    return { dealt: amount, down };
  }

  applyHeal(T, amount, card, { temp = false } = {}) {
    const before = { ...T.hp };
    const hp = { ...T.hp };
    if (temp) hp.temp = Math.max(hp.temp || 0, amount);
    else hp.value = Math.min(hp.max, hp.value + amount);
    T.setHp(hp);
    card.undo.push({ key: T.key, hp: before, conditions: [...(T.conditions || [])] });
    if (!temp && before.value === 0 && hp.value > 0 && T.kind === 'pc') T.char.state = { ...(T.char.state || {}), death: { s: 0, f: 0 } };
    if (!temp && before.value === 0 && hp.value > 0) T.setConditions((T.conditions || []).filter(c => !['unconscious', 'dead'].includes(condId(c))));
  }

  async concentrationCheck(T, dmg, card) {
    if (!has(T, 'concentrating') || dmg <= 0 || T.hp.value <= 0) return;
    const dc = Math.min(30, Math.max(10, Math.floor(dmg / 2)));
    const s = await this.savingThrow(T, 'con', dc, { label: 'concentration', conc: true });
    if (s.success) card.lines.push({ t: `${T.name} keeps concentration (${s.total} vs ${dc})` });
    else { card.lines.push({ t: `${T.name} loses concentration (${s.total} vs ${dc})`, c: 'bad' }); this.endConcentration(T, card); }
  }

  // ---------------------------------------------------------------- effects

  addEffect(T, e, card) {
    const eff = { id: uid(8), ...e };
    const list = T.effects.filter(x => !(e.key && x.key === e.key && x.origin?.key === e.origin?.key));
    list.push(eff);
    if (T.kind === 'pc') T.char.effects = list; else T.token.effects = list;
    if (eff.statuses?.length) T.setConditions([...new Set([...(T.conditions || []), ...eff.statuses])]);
    if (eff.mods?.size && T.kind === 'pc') { eff.prevSize = T.char.size || 1; T.char.size = eff.mods.size; }
    if (eff.mods?.maxHp) { const hp = { ...T.hp }; hp.max += eff.mods.maxHp; hp.value += eff.mods.maxHp; T.setHp(hp); }
    card?.undo.push({ key: T.key, removeEffect: eff.id });
    return eff;
  }

  removeEffect(T, effId) {
    const e = T.effects.find(x => x.id === effId); if (!e) return;
    const rest = T.effects.filter(x => x.id !== effId);
    if (T.kind === 'pc') T.char.effects = rest; else T.token.effects = rest;
    if (e.statuses?.length) {
      const still = new Set(rest.flatMap(x => x.statuses || []));
      T.setConditions((T.conditions || []).filter(c => !e.statuses.includes(condId(c)) || still.has(condId(c))));
    }
    if (e.prevSize && T.kind === 'pc') T.char.size = e.prevSize;
    if (e.mods?.maxHp) { const hp = { ...T.hp }; hp.max -= e.mods.maxHp; hp.value = Math.min(hp.value, hp.max); T.setHp(hp); }
  }

  allActors() { return this.scene ? this.scene.tokens.map(t => this.actor(t)).filter(Boolean) : []; }

  startConcentration(A, spellName, card) {
    if (has(A, 'concentrating')) this.endConcentration(A, card, true);
    A.setConditions([...new Set([...(A.conditions || []), 'concentrating'])]);
    A.concOn = spellName;
    if (A.kind === 'pc') A.char.concentration = spellName; else A.token.concentration = spellName;
  }

  endConcentration(A, card, quiet) {
    const was = A.kind === 'pc' ? A.char.concentration : A.token?.concentration;
    if (!has(A, 'concentrating') && !was) return;
    A.setConditions((A.conditions || []).filter(c => condId(c) !== 'concentrating'));
    if (A.kind === 'pc') A.char.concentration = null; else if (A.token) A.token.concentration = null;
    // remove every effect that depends on A's concentration, on everyone
    const ended = [];
    for (const T of this.allActors()) for (const e of [...T.effects]) if (e.conc === A.key) { this.removeEffect(T, e.id); ended.push(`${e.name} on ${T.name}`); }
    for (const ch of this.camp.characters) for (const e of [...(ch.effects || [])]) if (e.conc === A.key) { const T = this.actorByKey('c:' + ch.id); if (T) this.removeEffect(T, e.id); }
    if (card && !quiet && (was || ended.length)) card.lines.push({ t: `${A.name}'s ${was || 'concentration'} ends${ended.length ? ': ' + ended.join(', ') : ''}`, c: 'muted' });
  }

  // Start of a combatant's turn: tick down effects timed on them.
  onTurnStart(key) {
    const lines = [];
    const tick = T => {
      for (const e of [...T.effects]) {
        if (e.tickOn !== key || e.rounds == null) continue;
        e.rounds -= 1;
        if (e.rounds <= 0) { this.removeEffect(T, e.id); lines.push(`${e.name} ends on ${T.name}`); }
      }
    };
    for (const T of this.allActors()) tick(T);
    for (const ch of this.camp.characters) { if (!this.scene.tokens.some(t => t.charId === ch.id)) { const T = this.actorByKey('c:' + ch.id); if (T) tick(T); } }
    const A = this.actorByKey(key);
    if (A) A.turnFlags = {};
    if (A?.kind === 'pc') A.char.turnFlags = {}; else if (A) A.token.turnFlags = {};
    return lines;
  }

  // ---------------------------------------------------------------- resources

  spendSlot(A, level, pact) {
    const st = (A.char.state ||= {});
    if (pact) {
      const p = A.sheet.spellcasting.pact; st.pact ||= 0;
      if (!p || st.pact >= p.max) return false;
      st.pact++; return true;
    }
    st.slots ||= {};
    const max = A.sheet.spellcasting.slots?.[level - 1] || 0;
    if ((st.slots[level] || 0) >= max) return false;
    st.slots[level] = (st.slots[level] || 0) + 1;
    return true;
  }
  spendUse(A, resId, n = 1) {
    const st = (A.char.state ||= {}); st.used ||= {};
    const r = A.sheet.resources.find(x => x.id === resId); if (!r) return true;
    if ((st.used[resId] || 0) + n > r.max) return false;
    st.used[resId] = (st.used[resId] || 0) + n;
    return true;
  }

  rest(ch, kind) {
    const sh = ch.sheet; if (!sh) return [];
    const st = (ch.state ||= {}); st.used ||= {}; st.slots ||= {};
    const out = [];
    for (const r of sh.resources || []) {
      if (kind === 'long' && r.recover !== 'none') { if (st.used[r.id]) out.push(r.name); st.used[r.id] = 0; }
      else if (kind === 'short' && r.recover === 'sr') { if (st.used[r.id]) out.push(r.name); st.used[r.id] = 0; }
      else if (kind === 'short' && r.srRegain && st.used[r.id]) { st.used[r.id] = Math.max(0, st.used[r.id] - r.srRegain); out.push(r.name + ` (+${r.srRegain})`); }
    }
    if (st.pact) { st.pact = 0; out.push('Pact Magic slots'); }
    if (kind === 'long') {
      st.slots = {}; out.push('spell slots');
      ch.hp = { value: ch.hp.max, max: ch.hp.max, temp: 0 };
      const total = sh.classes.reduce((s, c) => s + c.level, 0);
      st.hd = Math.max(0, (st.hd || 0) - Math.max(1, Math.floor(total / 2)));
      ch.effects = []; ch.conditions = (ch.conditions || []).filter(c => condId(c) === 'exhaustion').map(c => { const l = condLevel(c) - 1; return l > 0 ? 'exhaustion:' + l : null; }).filter(Boolean);
      ch.concentration = null;
    }
    return out;
  }

  // ---------------------------------------------------------------- using things

  // Normalised activity list for an entry. ctx: { A (actor), level (slot level), src }
  activities(A, entry, src) {
    if (src === 'spell') return entry.auto || [];
    if (entry.auto) return entry.auto; // NPC stat block entries
    const out = [];
    if (entry.attack) out.push({ type: 'attack', attack: entry.attack, damage: entry.damage || [], weapon: entry.kind === 'weapon' });
    else if (entry.save) out.push({ type: 'save', save: entry.save, onSave: entry.onSave || 'half', damage: entry.damage || [], area: entry.area });
    return out;
  }

  // Main entry point. req: { src: 'action'|'spell'|'npc', id, targets:[tokenIds], slot, pact, opts, template }
  async use(attackerToken, req) {
    const A = this.actor(attackerToken);
    if (!A) return;
    const opts = req.opts || {};
    let entry, isSpell = req.src === 'spell';
    if (req.src === 'npc') {
      const sections = ['actions', 'bonus', 'reactions', 'legendary', 'traits'];
      entry = sections.flatMap(s => A.actor?.[s] || []).find(e => e.name === req.id);
    } else if (isSpell) entry = A.sheet?.spells.find(s => s.id === req.id);
    else entry = A.sheet?.actions.find(a => a.id === req.id);
    if (!entry) return;

    const card = { id: uid(10), ts: Date.now(), by: this.by(A), title: `${A.name}: ${entry.name.replace(/ \(.*\)$/, '')}`, lines: [], undo: [] };
    if (A.kind === 'pc') card.undo.push({ key: A.key, state: JSON.parse(JSON.stringify(A.char.state || {})) });
    const sc = this.scene;
    let targets = (req.targets || []).map(id => sc.tokens.find(t => t.id === id)).filter(Boolean).map(t => this.actor(t));

    // Items that cast a spell (Wand of Magic Missiles): charges set the level
    let level = entry.level || 0, noSlot = false;
    if (entry.castSpell) {
      const sp = A.sheet?.spells.find(s => s.id === entry.castSpell) || this.spells?.[entry.castSpell];
      if (!sp) return;
      const charges = Math.max(1, Math.min(opts.charges || 1, 7));
      if (A.kind === 'pc' && !this.spendUse(A, entry.uses, charges)) { card.lines.push({ t: `Not enough charges left`, c: 'bad' }); return this.io.card(card); }
      card.title = `${A.name}: ${sp.name} (${entry.name}, level ${charges})`;
      entry = { ...sp, uses: null }; isSpell = true; level = charges; noSlot = true;
    }
    const special = isSpell ? (SPELL_SPECIAL[entry.id] || {}) : {};
    if (special.patch) entry = { ...entry, ...special.patch };

    if (req.template) {
      const inside = tokensInTemplate(sc.grid, sc.tokens.filter(t => !t.hidden || A.kind === 'npc'), req.template).map(t => this.actor(t));
      const selfOrigin = /^self/i.test(entry.range || '') || req.template.selfOrigin;
      targets = inside.filter(T => !(selfOrigin && T.key === A.key));
    }

    // ---- nothing is spent if a needed target is missing
    const acts0 = this.activities(A, entry, isSpell ? 'spell' : req.src);
    const act0 = acts0[Math.min(opts.activity || 0, Math.max(0, acts0.length - 1))];
    const selfish = /^self/i.test(entry.range || '') && act0?.type !== 'attack';
    if (!targets.length && !req.template && !selfish && act0 && ['attack', 'save', 'damage'].includes(act0.type) && !(entry.area || act0.area)) {
      card.lines.push({ t: 'Choose a target first: hover a token and press T', c: 'bad' });
      return this.io.card(card);
    }

    // ---- costs
    if (isSpell && entry.level > 0 && !noSlot) {
      level = Math.max(entry.level, req.slot || entry.level);
      const free = opts.ritual && entry.ritual;
      if (req.pact) level = A.sheet.spellcasting.pact?.level || level;
      if (!free && A.kind === 'pc' && !this.spendSlot(A, level, req.pact)) { card.lines.push({ t: `No ${req.pact ? 'Pact Magic' : 'level ' + level} slot left`, c: 'bad' }); return this.io.card(card); }
      card.title += level > entry.level ? ` (level ${level})` : '';
      if (free) card.title += ' (ritual)';
    }
    if (entry.uses && A.kind === 'pc' && !entry.poolHeal && !this.spendUse(A, entry.uses)) { card.lines.push({ t: `No uses of ${entry.name} left`, c: 'bad' }); return this.io.card(card); }
    const conc = isSpell && entry.conc;
    const stuck = condsOf(A).filter(c => ['incapacitated', 'paralyzed', 'stunned', 'unconscious', 'petrified'].includes(c));
    if (stuck.length) card.lines.push({ t: `Note: ${A.name} is ${stuck.map(titleCase).join(', ')}`, c: 'bad' });
    if (conc) this.startConcentration(A, entry.name, card);

    // ---- simple things
    if (entry.selfHeal) { const r = await this.io.roll(entry.selfHeal.f, { label: `${A.name}: ${entry.name}`, by: card.by }); this.applyHeal(A, r.total, card); card.lines.push({ t: `${A.name} ${entry.selfHeal.label ? '— ' + r.total + ' ' + entry.selfHeal.label : 'regains ' + r.total + ' HP'}`, c: 'heal' }); }
    if (entry.selfTemp) { this.applyHeal(A, entry.selfTemp, card, { temp: true }); card.lines.push({ t: `${A.name} gains ${entry.selfTemp} temporary HP`, c: 'heal' }); }
    if (entry.restoreSlot && A.kind === 'pc') { const st = A.char.state ||= {}; st.slots ||= {}; let done = false; for (let l = entry.restoreSlot; l >= 1; l--) if (st.slots[l]) { st.slots[l]--; card.lines.push({ t: `Recovered a level ${l} slot` }); done = true; break; } if (!done) card.lines.push({ t: 'No spent slot to recover', c: 'muted' }); }
    if (entry.restorePact && A.kind === 'pc') { const st = A.char.state ||= {}; if (st.pact) { st.pact--; card.lines.push({ t: 'Recovered a Pact Magic slot' }); } else card.lines.push({ t: 'No spent Pact Magic slot', c: 'muted' }); }
    if (entry.poolHeal) {
      const T = targets[0] || A;
      if (opts.cure) {
        if (!this.spendUse(A, entry.pool, 5)) { card.lines.push({ t: 'Not enough left in the pool', c: 'bad' }); return this.io.card(card); }
        card.undo.push({ key: T.key, hp: { ...T.hp }, conditions: [...(T.conditions || [])] });
        T.setConditions((T.conditions || []).filter(c => condId(c) !== 'poisoned'));
        card.lines.push({ t: `${T.name} is no longer Poisoned (${this.poolLeft(A, entry.pool)} left in the pool)`, c: 'heal' });
      } else {
        const amt = Math.max(1, Math.min(opts.amount || 5, this.poolLeft(A, entry.pool), T.hp.max - T.hp.value || 1));
        if (!this.spendUse(A, entry.pool, amt)) { card.lines.push({ t: 'Not enough left in the pool', c: 'bad' }); return this.io.card(card); }
        this.applyHeal(T, amt, card); card.lines.push({ t: `${T.name} regains ${amt} HP (${this.poolLeft(A, entry.pool)} left in the pool)`, c: 'heal' });
      }
    }
    if (entry.selfEffect) this.applyNamedEffect(A, A, entry.selfEffect, card, conc);
    if (entry.targetEffect) for (const T of targets.length ? targets : [A]) this.applyNamedEffect(A, T, entry.targetEffect, card, conc);
    if (entry.tempHp) {
      const r = await this.io.roll(evalFormula(entry.tempHp.f, A), { label: `${A.name}: ${entry.name}`, by: card.by });
      for (const T of targets.length ? targets : [A]) { this.applyHeal(T, r.total, card, { temp: true }); card.lines.push({ t: `${T.name} gains ${r.total} temporary HP`, c: 'heal' }); }
    }
    if (special.aid) {
      const n = 5 * Math.max(1, level - 1);
      for (const T of (targets.length ? targets : [A]).slice(0, 3)) this.applyNamedEffect(A, T, { key: 'aid', name: `Aid (+${n} HP max)`, icon: 'blessed', rounds: 4800, mods: { maxHp: n } }, card, false);
    }
    if (entry.summon && A.kind === 'pc') { this.io.summon?.(A, entry.summon); card.lines.push({ t: `${A.name} creates the ${A.sheet.summons?.[entry.summon]?.name || 'summon'}` }); }
    if (special.note) card.lines.push({ t: special.note, c: 'muted' });

    // ---- one activity (attack, save, heal, damage, effect)
    const acts = this.activities(A, entry, isSpell ? 'spell' : req.src);
    const act = acts[Math.min(opts.activity || 0, Math.max(0, acts.length - 1))];
    const ctx = { level, isSpell, opts, special, conc };
    if (act) {
      if (act.type === 'attack') await this.doAttacks(A, entry, act, targets, card, ctx);
      else if (act.type === 'save') await this.doSave(A, entry, act, targets, card, ctx);
      else if (act.type === 'heal') await this.doHeal(A, entry, act, targets.length ? targets : [A], card, ctx);
      else if (act.type === 'damage' && special.darts) await this.doDarts(A, entry, act, targets, card, ctx);
      else if (act.type === 'damage') {
        if (!targets.length) card.lines.push({ t: 'No target chosen', c: 'bad' });
        await this.rollDamageToTargets(A, entry, act.damage, targets, card, ctx);
      }
      else if (act.type === 'utility' && act.effects?.length) this.applySpellEffects(A, entry, act, targets, card, ctx);
    }
    if (!act && !card.lines.length) card.lines.push({ t: stripHtml(entry.text || '').slice(0, 240), c: 'muted' });
    this.io.card(card);
    this.io.save();
    return card;
  }

  // Undo a card: restore HP/conditions, remove effects it added, give back resources.
  undo(card) {
    for (const u of [...(card.undo || [])].reverse()) {
      const T = this.actorByKey(u.key); if (!T) continue;
      if (u.removeEffect) this.removeEffect(T, u.removeEffect);
      if (u.hp) T.setHp({ ...u.hp });
      if (u.conditions) T.setConditions([...u.conditions]);
      if (u.state && T.kind === 'pc') T.char.state = u.state;
    }
    card.undone = true;
    this.io.save();
  }


  poolLeft(A, id) { const r = A.sheet.resources.find(x => x.id === id); return r.max - ((A.char.state?.used || {})[id] || 0); }

  applyNamedEffect(A, T, spec, card, conc) {
    const mods = { ...(spec.mods || {}) };
    if (mods.advFrom === 'self') mods.advFrom = A.key;
    this.addEffect(T, { key: spec.key || spec.name, name: spec.name, icon: spec.icon, mods, origin: { key: A.key, name: A.name }, conc: conc ? A.key : null, rounds: spec.rounds ?? null, tickOn: A.key, statuses: spec.statuses || [] }, card);
    card.lines.push({ t: `${spec.name} on ${T.name}${spec.rounds ? ` (${fmtRounds(spec.rounds)})` : ''}` });
  }

  // Effect from spell data, with this engine's extra mods for the spell.
  spellEffect(A, spell, e, special, conc) {
    const mods = { ...(e.mods || {}) };
    delete mods.damageBonus;
    if (special?.markTarget) mods.damageFrom = { key: A.key, f: special.markTarget.f, type: special.markTarget.type };
    if (special?.mods) Object.assign(mods, special.mods);
    return { key: spell.id, name: e.name || spell.name, icon: special?.icon || iconFor(e), mods, origin: { key: A.key, name: A.name }, conc: conc ? A.key : null,
      rounds: spell.id === 'shield' ? 1 : durationRounds(spell.duration), tickOn: A.key, statuses: e.statuses || [] };
  }

  applySpellEffects(A, spell, act, targets, card, { special, conc, opts }) {
    let list = (spell.effects || []).filter(e => act.effects.includes(e.id));
    if (list.length > 1) list = [list[Math.min(opts?.effect || 0, list.length - 1)]]; // a choice (Enhance Ability etc.)
    const selfOnly = /^self/i.test(spell.range || '');
    const tg = selfOnly || !targets.length ? [A] : targets;
    for (const T of tg) for (const e of list) {
      this.addEffect(T, this.spellEffect(A, spell, e, special, conc), card);
      card.lines.push({ t: `${e.name || spell.name} on ${T.name}` });
    }
  }

  // ---------------------------------------------------------------- attacks

  attackBonus(A, entry, act, isSpell, opts) {
    if (A.kind === 'npc') return { bonus: act.attack.bonus ?? 0, abil: null };
    if (isSpell || act.attack.spell) return { bonus: act.attack.noFocus || entry.attack?.noFocus ? A.spellAttackBase : A.spellAttack, abil: A.sheet.spellcasting.ability };
    // weapons: pick the best allowed ability (Bladework lets Int count while Bladesong is up)
    let abils = [...(act.attack.ability || ['str'])];
    if (abils.includes('bladework')) { abils = abils.filter(a => a !== 'bladework'); if ((A.effects || []).some(e => e.mods?.bladework)) abils.push('int'); }
    if (opts.trueStrike) abils = [A.sheet.spellcasting.ability];
    const abil = abils.reduce((best, a) => (A.mod(a) > A.mod(best) ? a : best), abils[0]);
    return { bonus: A.mod(abil) + A.pb + (act.attack.bonus || 0), abil };
  }

  damageParts(A, entry, act, { abil, level, isSpell, crit, opts, target }) {
    const parts = [];
    const base = act.damage || [];
    base.forEach((p, i) => {
      let n = p.n || 0, d = p.d || 0;
      let b = typeof p.b === 'number' ? p.b : 0;
      if (typeof p.b === 'string' && p.b) b = evalBonus(p.b, A, isSpell);
      if (p.ability) b += A.mod(abil);
      if (i === 0 && opts.versatile && entry.versatile) { n = entry.versatile.n; d = entry.versatile.d; if (entry.versatile.dropBonus) b -= 2; }
      if (isSpell && p.scale?.mode === 'whole') {
        if ((entry.level || 0) === 0) n = n * cantripTier(A.level);
        else n += p.scale.n * Math.max(0, level - entry.level);
      }
      if (p.f && !n) { parts.push({ f: evalFormula(p.f, A), type: opts.trueStrike && entry.kind === 'weapon' ? 'radiant' : p.type }); return; }
      const type = (opts.trueStrike && i === 0) ? 'radiant' : (opts.dmgType && p.types?.includes(opts.dmgType)) ? opts.dmgType : p.type;
      parts.push({ f: dice(crit ? n * 2 : n, d, b), type });
    });
    if (entry.vsUndead && target?.type?.includes('undead')) parts.push({ f: dice(crit ? 2 : 1, entry.vsUndead.d, 0), type: entry.vsUndead.type });
    return parts;
  }

  async doAttacks(A, entry, act, targets, card, { level, isSpell, opts, special }) {
    if (!targets.length) { card.lines.push({ t: 'No target chosen: hover a creature and press T, then use it again', c: 'bad' }); return; }
    // projectiles: Scorching Ray rays, Eldritch Blast beams
    let shots = 1;
    if (special?.rays) shots = special.rays(level, A.level);
    const list = [];
    for (let i = 0; i < shots; i++) list.push(targets[i % targets.length]);
    const { bonus, abil } = this.attackBonus(A, entry, act, isSpell, opts);
    const flags = A.kind === 'pc' ? (A.char.turnFlags ||= {}) : (A.token.turnFlags ||= {});
    for (const T of list) {
      const dist = this.dist(A, T);
      let kind = act.attack.kind;
      if (kind === 'melee' && act.attack.range && dist > (act.attack.reach || 5)) kind = 'ranged';
      const { adv, dis } = this.attackMode(A, T, kind, dist);
      if (opts.adv) adv.push('chosen'); if (opts.dis) dis.push('chosen');
      const mode = adv.length && !dis.length ? '2d20kh' : dis.length && !adv.length ? '2d20kl' : '1d20';
      let penalty = '';
      for (const e of T.effects || []) if (e.mods?.attackedPenalty) penalty += '-' + e.mods.attackedPenalty;
      const formula = mode + sgn(bonus) + this.bonusDice(A, 'attack') + penalty;
      const r = await this.io.roll(formula, { label: `${A.name}: ${entry.name} → ${T.name}`, by: card.by });
      // Sap and similar are spent on the attack
      for (const e of [...A.effects]) if (e.mods?.disNextAttack) this.removeEffect(A, e.id);
      const ac = acOf(T);
      const nat = r.nat ?? r.terms.find(t => t.kind === 'dice')?.results.find(x => !x.dropped)?.v;
      const critRange = A.kind === 'pc' && A.sheet?.critRange ? A.sheet.critRange : 20;
      let hit = nat >= critRange || (nat !== 1 && r.total >= ac);
      let crit = hit && (nat >= critRange || (kind === 'melee' && dist <= 5 && ['paralyzed', 'unconscious'].some(c => has(T, c))));
      const advTxt = mode === '1d20' ? '' : mode === '2d20kh' ? ` (adv: ${adv.join(', ')})` : ` (dis: ${dis.join(', ')})`;
      const showAc = A.kind === 'npc' || T.kind === 'pc';
      card.lines.push({ t: `${T.name}: ${r.total}${showAc ? ' vs AC ' + ac : ''} — ${crit ? 'CRITICAL HIT' : hit ? 'hit' : 'miss'}${advTxt}`, c: crit ? 'crit' : hit ? 'hit' : 'miss' });
      if (!hit) continue;
      // damage
      const parts = this.damageParts(A, entry, act, { abil, level, isSpell, crit, opts, target: T });
      const extras = [];
      for (const e of T.effects || []) if (e.mods?.damageFrom && e.mods.damageFrom.key === A.key) extras.push({ f: critDouble(e.mods.damageFrom.f, crit), type: e.mods.damageFrom.type, why: e.name });
      if (act.weapon || entry.kind === 'weapon') for (const e of A.effects || []) if (e.mods?.weaponDamage) extras.push({ f: critDouble(e.mods.weaponDamage.f, crit), type: e.mods.weaponDamage.type, why: e.name });
      if (opts.trueStrike && A.level >= 5) extras.push({ f: critDouble(A.level >= 17 ? '3d6' : A.level >= 11 ? '2d6' : '1d6', crit), type: 'radiant', why: 'True Strike' });
      // Divine Smite
      if (opts.smite && A.kind === 'pc' && kind === 'melee') {
        const lv = Math.max(1, opts.smite.level || 1);
        let ok = opts.smite.free ? this.spendUse(A, 'free-smite') : this.spendSlot(A, lv, opts.smite.pact);
        if (ok) { const n = 2 + (lv - 1) + (/fiend|undead/.test(T.type) ? 1 : 0); extras.push({ f: `${crit ? n * 2 : n}d8`, type: 'radiant', why: `Divine Smite (level ${lv})` }); opts.smite = null; }
        else card.lines.push({ t: 'No slot left for Divine Smite', c: 'bad' });
      }
      // Maneuver
      let maneuver = null;
      if (opts.maneuver && A.kind === 'pc' && this.spendUse(A, 'sd')) {
        maneuver = opts.maneuver; extras.push({ f: critDouble(A.sheet.maneuvers?.die || '1d8', crit), type: parts[0]?.type || 'slashing', why: titleCase(maneuver) + ' Attack' }); opts.maneuver = null;
      }
      if (opts.focusDamage && isSpell && A.sheet?.spellcasting?.focusDamage) { extras.push({ f: critDouble(A.sheet.spellcasting.focusDamage.f, crit), type: parts[0]?.type, why: A.sheet.spellcasting.focusDamage.label }); opts.focusDamage = false; }
      let savage = false;
      if ((act.weapon || entry.kind === 'weapon') && entry.riders?.includes('savage') && !flags.savage) { savage = true; flags.savage = true; }
      await this.rollAndApply(A, T, entry, [...parts, ...extras], card, { savage, isSpell });
      // on-hit riders that need a save
      const dcWeapon = 8 + A.mod(abil || 'str') + A.pb;
      for (const e of (entry.effects || []).filter(e => act.effects?.includes(e.id) && (e.statuses?.length || Object.keys(e.mods || {}).length)))
        this.addEffect(T, this.spellEffect(A, entry, e, special, false), card), card.lines.push({ t: `${e.name} on ${T.name}`, c: 'muted' });
      if (entry.mastery === 'topple') await this.riderSave(A, T, 'con', dcWeapon, 'Topple', 'prone', card);
      if (entry.mastery === 'sap') this.addEffect(T, { key: 'sap', name: 'Sapped', icon: 'dodging', mods: { disNextAttack: true }, origin: { key: A.key, name: A.name }, rounds: 1, tickOn: A.key }, card), card.lines.push({ t: `${T.name} is Sapped: Disadvantage on its next attack`, c: 'muted' });
      if (entry.mastery === 'slow') card.lines.push({ t: `${T.name}'s speed drops by 10 ft until your next turn (Slow)`, c: 'muted' });
      if (special?.push) card.lines.push({ t: `${T.name} is pushed ${special.push} ft`, c: 'muted' });
      if (entry.id === 'cannon-ballista') card.lines.push({ t: `${T.name} is pushed 5 ft away`, c: 'muted' });
      if (maneuver) {
        const dcM = 8 + A.pb + Math.max(A.mod('str'), A.mod('dex'));
        if (maneuver === 'trip') await this.riderSave(A, T, 'str', dcM, 'Trip Attack', T.size <= 2 ? 'prone' : null, card);
        if (maneuver === 'disarming') await this.riderSave(A, T, 'str', dcM, 'Disarming Attack', null, card, `${T.name} drops an object of ${A.name}'s choice`);
        if (maneuver === 'goading') await this.riderSave(A, T, 'wis', dcM, 'Goading Attack', null, card, `${T.name} has Disadvantage on attacks against anyone but ${A.name}`, { key: 'goaded', name: 'Goaded', icon: 'marked', mods: {}, rounds: 1 });
      }
      if (opts.shieldBash && !flags.bash && kind === 'melee') { flags.bash = true; await this.riderSave(A, T, 'str', 8 + A.pb + A.mod('str'), 'Shield Bash', 'prone', card, null, null, 'or pushed 5 ft (DM’s choice)'); }
    }
  }

  async riderSave(A, T, abil, dc, name, status, card, failText, effect, extra = '') {
    const s = await this.savingThrow(T, abil, dc, { label: name });
    if (s.success) { card.lines.push({ t: `${T.name} resists ${name} (${s.auto ? s.note : s.total + ' vs DC ' + dc})`, c: 'muted' }); return; }
    if (status && !T.condImmune.includes(status)) { T.setConditions([...new Set([...(T.conditions || []), status])]); card.undo.push({ key: T.key, hp: { ...T.hp }, conditions: (T.conditions || []).filter(c => c !== status) }); }
    if (effect) this.addEffect(T, { ...effect, origin: { key: A.key, name: A.name }, tickOn: A.key }, card);
    card.lines.push({ t: `${T.name} fails vs ${name} (${s.auto ? s.note : s.total + ' vs DC ' + dc})${status ? ': ' + titleCase(status) : ''}${failText ? ': ' + failText : ''} ${extra}`.trim(), c: 'hit' });
  }

  async rollAndApply(A, T, entry, parts, card, { savage, isSpell, half = false, none = false }) {
    const formula = parts.map(p => p.f).join('+').replace(/\+-/g, '-');
    let r = await this.io.roll(formula, { label: `${A.name}: ${entry.name} damage → ${T.name}`, by: card.by });
    if (savage) {
      const r2 = await this.io.roll(formula, { label: `${A.name}: Savage Attacker reroll`, by: card.by });
      if (r2.total > r.total) r = r2;
    }
    const totals = splitTotals(r, parts);
    let rolled = parts.map((p, i) => ({ type: p.type, total: totals[i] }));
    if (half) rolled = rolled.map(p => ({ ...p, total: Math.floor(p.total / 2) }));
    if (none) rolled = rolled.map(p => ({ ...p, total: 0 }));
    const { total, notes } = this.damageAfterTraits(T, rolled);
    const res = this.applyDamage(T, total, card);
    const types = [...new Set(parts.map(p => p.type).filter(Boolean))].join(', ');
    const why = parts.map(p => p.why).filter(Boolean);
    if (savage) why.push('Savage Attacker');
    card.lines.push({ t: `${T.name} takes ${total} ${types}${why.length ? ' with ' + why.join(', ') : ''}${notes.length ? ' (' + notes.join('; ') + ')' : ''}${res.down ? (T.kind === 'pc' ? ' and falls unconscious' : ' and drops') : ''}`, c: 'dmg' });
    await this.concentrationCheck(T, total, card);
    return total;
  }

  async rollDamageToTargets(A, entry, dmg, targets, card, { level, isSpell }) {
    if (!dmg?.length) return;
    for (const T of targets.length ? targets : []) {
      const parts = this.damageParts(A, entry, { damage: dmg }, { abil: null, level, isSpell, crit: false, opts: {} });
      await this.rollAndApply(A, T, entry, parts, card, { isSpell });
    }
  }

  // Magic Missile style: N darts that always hit, spread across targets.
  async doDarts(A, entry, act, targets, card, { level, special }) {
    if (!targets.length) { card.lines.push({ t: 'No target chosen', c: 'bad' }); return; }
    const darts = special.darts(level);
    const per = new Map();
    for (let i = 0; i < darts; i++) { const T = targets[i % targets.length]; per.set(T, (per.get(T) || 0) + 1); }
    for (const [T, n] of per) {
      const p = act.damage[0];
      const b = Number(p.b) || 0;
      const parts = Array.from({ length: n }, () => ({ f: dice(p.n, p.d, b), type: p.type }));
      card.lines.push({ t: `${n} dart${n > 1 ? 's' : ''} at ${T.name}`, c: 'muted' });
      await this.rollAndApply(A, T, entry, parts, card, { isSpell: true });
    }
  }

  async doSave(A, entry, act, targets, card, { level, isSpell, opts = {}, special, conc }) {
    if (!targets.length) { card.lines.push({ t: entry.area || act.area ? 'Nobody in the area' : 'No target chosen', c: 'muted' }); return; }
    const abil = act.save.abil?.[0] || 'dex';
    const dc = act.save.dc ?? A.spellDC;
    // 2024: roll damage once for everyone
    let dmgRoll = null, parts = [];
    if (act.damage?.length) {
      parts = this.damageParts(A, entry, act, { abil: null, level, isSpell, crit: false, opts });
      if (opts.focusDamage && isSpell && A.sheet?.spellcasting?.focusDamage) parts.push({ f: A.sheet.spellcasting.focusDamage.f, type: parts[0]?.type });
      const formula = parts.map(p => p.f).join('+').replace(/\+-/g, '-');
      dmgRoll = await this.io.roll(formula, { label: `${A.name}: ${entry.name} damage`, by: card.by });
    }
    card.lines.push({ t: `${ABIL_NAME[abil]} save, DC ${dc}${dmgRoll ? ` · ${dmgRoll.total} damage` : ''}`, c: 'muted' });
    const totals = dmgRoll ? splitTotals(dmgRoll, parts) : [];
    const effects = (entry.effects || []).filter(e => act.effects?.includes(e.id));
    const applies = act.applies || [];
    const results = await Promise.all(targets.map(T => this.savingThrow(T, abil, dc, { label: entry.name, spell: isSpell }).then(s => ({ T, s }))));
    for (const { T, s } of results) {
      const evasion = abil === 'dex' && act.onSave === 'half' && T.traits.includes('evasion');
      const interpose = abil === 'dex' && act.onSave === 'half' && T.traits.includes('shield master: interpose shield');
      const ok = s.success;
      card.lines.push({ t: `${T.name}: ${s.auto ? s.note : s.total} — ${ok ? 'saved' : 'failed'}`, c: ok ? 'miss' : 'hit' });
      if (dmgRoll) {
        let factor = ok ? (act.onSave === 'none' ? 0 : 0.5) : 1;
        if (evasion) factor = ok ? 0 : 0.5;
        else if (interpose && ok) factor = 0;
        const byType = new Map();
        parts.forEach((p, i) => byType.set(p.type, (byType.get(p.type) || 0) + totals[i]));
        const rolled = [...byType].map(([type, tot]) => ({ type, total: Math.floor(tot * factor) }));
        const { total, notes } = this.damageAfterTraits(T, rolled);
        if (factor > 0 || evasion || (interpose && ok)) {
          const res = this.applyDamage(T, total, card);
          card.lines.push({ t: `${T.name} takes ${total}${notes.length ? ' (' + notes.join('; ') + ')' : ''}${evasion ? ' (Evasion)' : interpose && ok ? ' (Interpose Shield)' : ''}${res.down ? (T.kind === 'pc' ? ' and falls unconscious' : ' and drops') : ''}`, c: 'dmg' });
          await this.concentrationCheck(T, total, card);
        }
      }
      if (!ok) {
        const st = applies.filter(x => !T.condImmune.includes(x));
        if (st.length) { T.setConditions([...new Set([...(T.conditions || []), ...st])]); }
        for (const e of effects) {
          const eff = this.spellEffect(A, entry, e, special, conc);
          eff.statuses = eff.statuses.filter(x => !T.condImmune.includes(x));
          this.addEffect(T, eff, card);
        }
        const names = [...st, ...effects.flatMap(e => e.statuses?.length ? e.statuses : [e.name])];
        if (names.length) card.lines.push({ t: `${T.name}: ${[...new Set(names)].map(titleCase).join(', ')}`, c: 'hit' });
      }
    }
  }

  async doHeal(A, entry, act, targets, card, { level, isSpell }) {
    const h = act.heal;
    let n = h.n;
    if (isSpell && h.scale?.mode === 'whole') n += h.scale.n * Math.max(0, level - entry.level);
    const b = evalBonus(h.b, A, isSpell);
    const f = h.f && !h.n ? String(h.f).replace(/\s+/g, '') : dice(n, h.d, b);
    const r = await this.io.roll(f, { label: `${A.name}: ${entry.name}`, by: card.by });
    const temp = /temp/.test(h.type || '');
    for (const T of targets) { this.applyHeal(T, r.total, card, { temp }); card.lines.push({ t: `${T.name} ${temp ? 'gains ' + r.total + ' temporary HP' : 'regains ' + r.total + ' HP'}`, c: 'heal' }); }
  }

  async rollCheck(A, kind, key, mode) {
    const { formula, label } = this.checkFormula(A, kind, key, mode);
    return this.io.roll(formula, { label: `${A.name}: ${label}`, by: this.by(A) });
  }

  async deathSave(A) {
    if (A.kind !== 'pc' || A.hp.value > 0) return null;
    const st = (A.char.state ||= {}); const d = (st.death ||= { s: 0, f: 0 });
    const r = await this.io.roll('1d20' + this.bonusDice(A, 'save'), { label: `${A.name}: Death save`, by: this.by(A) });
    const card = { id: uid(10), ts: Date.now(), by: this.by(A), title: `${A.name}: Death save`, lines: [], undo: [] };
    if (r.nat === 20) { this.applyHeal(A, 1, card); st.death = { s: 0, f: 0 }; card.lines.push({ t: `Natural 20: ${A.name} regains 1 HP and wakes up`, c: 'heal' }); }
    else if (r.nat === 1) { d.f += 2; card.lines.push({ t: 'Natural 1: two failures', c: 'bad' }); }
    else if (r.total >= 10) { d.s += 1; card.lines.push({ t: `Success (${d.s}/3)`, c: 'miss' }); }
    else { d.f += 1; card.lines.push({ t: `Failure (${d.f}/3)`, c: 'hit' }); }
    if (d.s >= 3) { card.lines.push({ t: `${A.name} is Stable`, c: 'heal' }); st.death = { s: 0, f: 0, stable: true }; }
    if (d.f >= 3) { card.lines.push({ t: `${A.name} dies`, c: 'bad' }); A.setConditions([...new Set([...(A.conditions || []), 'dead'])]); }
    this.io.card(card); this.io.save();
    return card;
  }

  // Ability checks, saves and skills rolled from a sheet (no target).
  checkFormula(A, kind, key, mode) {
    let bonus = 0, label = '';
    if (kind === 'save') { bonus = A.saveBonus(key) + this.auraBonus(A); label = `${ABIL_NAME[key]} save`; }
    else if (kind === 'ability') { bonus = A.mod(key) + (A.sheet?.checkBonus || 0); label = `${ABIL_NAME[key]} check`; }
    else if (kind === 'skill') { bonus = A.skill(key); label = key; }
    else if (kind === 'init') { bonus = A.kind === 'pc' ? sheetNumbers(A.sheet).init : (A.actor?.init ?? A.mod('dex')); label = 'Initiative'; }
    const extra = this.bonusDice(A, kind === 'save' ? 'save' : 'check');
    const d = mode === 'adv' ? '2d20kh' : mode === 'dis' ? '2d20kl' : '1d20';
    return { formula: d + sgn(bonus) + extra, label };
  }
}

// ------------------------------------------------------------------ spell specifics

export const SPELL_SPECIAL = {
  'magic-missile': { darts: lv => lv + 2 },
  'scorching-ray': { rays: lv => lv + 1 },
  'eldritch-blast': { rays: (lv, charLevel) => cantripTier(charLevel) },
  'hunters-mark': { markTarget: { f: '1d6', type: 'force' }, icon: 'marked' },
  'divine-favor': { mods: { weaponDamage: { f: '1d4', type: 'radiant' } }, icon: 'blessed' },
  'divine-smite': { note: 'Tip: cast it from your weapon’s options after a hit, so crits double the dice.' },
  'bless': { icon: 'blessed' },
  'bane': { icon: 'poisoned' },
  'shield-of-faith': { icon: 'blessed' },
  'shield': { icon: 'dodging' },
  'haste': { icon: 'hasted', mods: { advSave: 'dex' } },
  'faerie-fire': { icon: 'burning', mods: { attackedAdv: true } },
  'warding-bond': { icon: 'blessed' },
  'hold-person': { note: 'It repeats the save at the end of each of its turns.' },
  'web': { patch: { auto: [{ type: 'save', save: { abil: ['dex'] }, onSave: 'none', applies: ['restrained'] }] }, note: 'The web is Difficult Terrain and Lightly Obscured.' },
  'blur': { patch: { auto: [], selfEffect: { key: 'blur', name: 'Blur', icon: 'invisible', rounds: 10, mods: { attackedDis: true } } } },
  'mirror-image': { patch: { auto: [], selfEffect: { key: 'mirror-image', name: 'Mirror Image (3 duplicates)', icon: 'invisible', rounds: 10 } }, note: 'Each time a creature hits you, roll a d6 per duplicate; any 3+ means a duplicate is hit and destroyed instead.' },
  'heroism': { patch: { auto: [], targetEffect: { key: 'heroism', name: 'Heroism', icon: 'blessed', rounds: 10, mods: { condImmune: ['frightened'] } }, tempHp: { f: '@mod' } }, note: 'Each target gains this temporary HP again at the start of each of its turns.' },
  'aid': { aid: true, patch: { auto: [] } },
  'prayer-of-healing': { patch: { auto: [{ type: 'heal', heal: { n: 2, d: 8, b: '@mod', type: 'healing', scale: { mode: 'whole', n: 1 } } }] } },
  'elemental-weapon': { patch: { targetEffect: { key: 'elemental-weapon', name: 'Elemental Weapon', icon: 'burning', rounds: 600, mods: { attackBonus: 1, weaponDamage: { f: '1d4', type: 'fire' } } } } },
  'true-strike': { note: 'Use True Strike from a weapon’s options so the attack uses your spellcasting ability.' },
};

function iconFor(e) {
  const s = e.statuses?.[0];
  if (s) return s;
  if (e.mods?.acBonus) return 'blessed';
  if (e.mods?.attackBonus || e.mods?.saveBonus) return String(e.mods.attackBonus || e.mods.saveBonus).startsWith('-') ? 'poisoned' : 'blessed';
  return 'marked';
}

// ------------------------------------------------------------------ helpers

function dice(n, d, b) {
  const parts = [];
  if (n && d) parts.push(`${n}d${d}`);
  if (b) parts.push(String(b));
  return (parts.join('+') || '0').replace(/\+-/g, '-');
}
function critDouble(f, crit) { return crit ? String(f).replace(/(\d*)d(\d+)/g, (_, n, d) => `${(Number(n) || 1) * 2}d${d}`) : f; }
function evalBonus(b, A, isSpell) {
  if (!b) return 0;
  if (typeof b === 'number') return b;
  let s = String(b).replace(/@mod/g, String(isSpell && A.spellMod != null ? A.spellMod : 0)).replace(/@prof/g, String(A.pb)).replace(/@item\.level/g, '0');
  s = s.replace(/@abilities\.(\w+)\.mod/g, (_, a) => String(A.mod(a)));
  if (/d\d/.test(s)) return 0;
  try { return Math.round(Function('"use strict";return (' + s.replace(/[^\d+\-*/(). ]/g, '') + ')')()) || 0; } catch { return 0; }
}
function evalFormula(f, A) { return String(f).replace(/@mod/g, String(A.spellMod ?? 0)).replace(/@prof/g, String(A.pb)); }
function splitTotals(r, parts) {
  const out = []; let ti = 0;
  for (const p of parts) {
    let n; try { n = parseFormula(p.f).length; } catch { n = 1; }
    let s = 0;
    for (let k = 0; k < n; k++, ti++) { const t = r.terms[ti]; if (!t) continue; s += t.sign * t.total; }
    out.push(Math.max(0, s));
  }
  return out;
}
export function durationRounds(dur) {
  const m = String(dur || '').match(/(\d+)\s*(round|minute|hour|min)/i);
  if (!m) return null;
  const n = Number(m[1]); const u = m[2].toLowerCase();
  return u.startsWith('round') ? n : u.startsWith('min') ? n * 10 : n * 600;
}
function fmtRounds(r) { return r >= 600 ? Math.round(r / 600) + ' hr' : r >= 10 ? Math.round(r / 10) + ' min' : r + ' round' + (r > 1 ? 's' : ''); }
function titleCase(s) { return String(s).replace(/(^|[-\s])\w/g, c => c.toUpperCase()).replace(/-/g, ' '); }
export function stripHtml(h) { return String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
