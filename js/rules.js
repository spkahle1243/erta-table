// The rules engine. It runs in the DM's tab, which holds every stat block,
// sheet and hidden number, so results are decided in one place. Players send
// what they want to do; the engine rolls (in the player's colour, on every
// screen), applies the outcome and writes a card to everyone's log.

import { uid } from './util.js';
import { roll as rollDice, parseFormula } from './dice.js';
import { tokenDistanceFt, tokensInTemplate } from './geometry.js';
import { condId, condLevel } from './conditions.js';
import { cover, coverName, seesToken, visionOn, tokenCentre, moveBlocked, blockers } from './vision.js';
import { tokenSight, sceneLights } from './model.js';

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
    return m[SKILL_ABIL[name]] + Math.floor(pb * p) + (sheet.checkBonus || 0) + (sheet.skillBonus?.[name] || 0);
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
    passive: 10 + skill('Perception') + (sheet.passiveBonus || 0),
  };
}

export function isPrepared(sheet, state, s) {
  const o = state?.prep?.[s.id];
  if (o != null) return o;
  return !!(s.always || s.prepared || s.level === 0 || !sheet.spells.some(x => x.prepared));
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
    spellDC: a?.spellDC || (a ? 8 + mod(ab[a.spellAbility || 'int']) + a.pb : 10),
    spellAttack: a?.spellDC ? a.spellDC - 8 : a ? mod(ab[a.spellAbility || 'int']) + a.pb : 0,
    spellMod: a ? mod(ab[a.spellAbility || 'int']) : 0,
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
  attackMode(A, T, kind, dist, spell = false) {
    const adv = [], dis = [];
    const ac = condsOf(A), tc = condsOf(T);
    if (!this.canSee(T, A)) adv.push(ac.includes('invisible') ? 'unseen (invisible)' : 'unseen (it can’t see the attacker)');
    for (const c of ['blinded', 'frightened', 'poisoned', 'prone', 'restrained']) if (ac.includes(c)) dis.push(c);
    if (!this.canSee(A, T)) dis.push(tc.includes('invisible') ? 'target invisible' : 'can’t see the target');
    for (const c of ['blinded', 'paralyzed', 'restrained', 'stunned', 'unconscious', 'petrified']) if (tc.includes(c)) adv.push('target ' + c);
    if (tc.includes('prone')) (kind === 'melee' && dist <= 5 ? adv : dis).push('target prone');
    if (kind === 'ranged' && dist <= 5 && this.hostilesNear(A, 5).length && !(spell && A.traits.includes('spell sniper'))) dis.push('in melee');
    for (const e of T.effects || []) {
      if (e.mods?.advFrom && e.mods.advFrom === A.key) adv.push(e.name);
      if (e.mods?.attackedAdv) adv.push(e.name);
      if (e.mods?.attackedDis) dis.push(e.name);
    }
    for (const e of A.effects || []) if (e.mods?.disNextAttack) dis.push(e.name);
    return { adv, dis };
  }

  // Whether A can see T: walls, light and darkvision when vision is on; invisibility always.
  canSee(A, T) {
    const sc = this.scene;
    const inv = condsOf(T).includes('invisible');
    if (!sc || !A.token || !T.token || A.token.x == null || T.token.x == null || A.token.x < -50) return !inv;
    if (!inv && !visionOn(sc)) return true;
    return seesToken(sc, visionOn(sc) ? sceneLights(this.camp, sc) : [], A.token, tokenSight(this.camp, A.token), T.token, { invisible: inv });
  }

  // Cover from walls (and, if the DM turns it on, from creatures in the way). 0, 2, 5 or Infinity.
  coverFor(A, T, from = null) {
    const sc = this.scene; if (!sc || !T.token) return 0;
    const useCreatures = !!this.camp.settings.creatureCover;
    if (!blockers(sc).length && !useCreatures) return 0;
    const creatures = useCreatures ? sc.tokens.filter(t => t !== A?.token && t !== T.token && !t.hidden && !this.actor(t)?.conditions?.some(c => condId(c) === 'dead')) : null;
    if (!from && !A?.token) return 0;
    return cover(sc, A?.token, T.token, { from, creatures });
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
  async savingThrow(T, abil, dc, o = {}) {
    let res = await this.rollSave(T, abil, dc, o);
    if (!res.auto) res = await this.afterSave(T, abil, dc, res, o);
    return res;
  }

  async rollSave(T, abil, dc, { label, spell = false, conc = false, skills = null, bonus: extraBonus = 0, adv: forceAdv = false } = {}) {
    const tc = condsOf(T);
    if (['str', 'dex'].includes(abil) && ['paralyzed', 'stunned', 'unconscious', 'petrified'].some(c => tc.includes(c)))
      return { total: 0, success: false, auto: true, note: 'fails automatically' };
    let adv = false, dis = false;
    if (abil === 'dex' && tc.includes('restrained')) dis = true;
    const hit = (v, a) => v === a || v === 'all' || (Array.isArray(v) && v.includes(a));
    for (const e of T.effects || []) { if (hit(e.mods?.advSave, abil)) adv = true; if (hit(e.mods?.disSave, abil)) dis = true; }
    if (spell && T.traits.some(n => n.startsWith('magic resistance'))) adv = true;
    if (conc && T.concAdv) adv = true;
    if (forceAdv) adv = true;
    let bonus = (skills ? Math.max(...skills.map(sk => T.skill(sk))) : T.saveBonus(abil) + this.auraBonus(T)) + (extraBonus || 0);
    if (conc) for (const e of T.effects || []) if (e.mods?.concBonus) bonus += Number(e.mods.concBonus) || 0;
    const dice = (adv && !dis ? '2d20kh' : dis && !adv ? '2d20kl' : '1d20') + sgn(bonus) + this.bonusDice(T, skills ? 'check' : 'save');
    const name = `${skills ? skills.join(' or ') + ' check' : ABIL_NAME[abil] + ' save'} (DC ${dc})${label ? ' · ' + label : ''}`;
    if (T.kind === 'pc' && this.io.onlineChars().has(T.char.id)) {
      // The player clicks to roll; the DM can roll for them from the card.
      const id = uid(8);
      const p = new Promise(res => this.pending.set(id, { res, T, dice, name, dc }));
      this.io.askSave(T.char.id, { id, label: name, formula: dice });
      this.io.waiting?.(id, T.name, name);
      const r = await p;
      return { total: r.total, success: r.total >= dc, nat: r.nat, dice, name, why: [] };
    }
    const r = await this.io.roll(dice, { label: `${T.name}: ${name}`, by: this.by(T), hidden: T.kind === 'npc' && this.camp.settings.hideMonsterSaves });
    return { total: r.total, success: r.total >= dc, nat: r.nat, dice, name, why: [] };
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
  damageAfterTraits(T, parts, { resistAll = false } = {}) {
    const res = new Set(T.resist), imm = new Set(T.immune), vul = new Set(T.vuln);
    if (resistAll) res.add('all');
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
      if (d.f >= 3) { T.setConditions([...new Set([...(T.conditions || []), 'dead'])]); this.event('death', `${T.name} died`); }
    }
    if (hp.value === 0 && before.value > 0) {
      down = true;
      this.event(T.kind === 'pc' ? 'down' : 'defeat', T.kind === 'pc' ? `${T.name} dropped to 0 HP` : `${T.name} was defeated`, { key: T.key, name: T.name });
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
    if (s.success) card.lines.push({ t: `${T.name} keeps concentration (${fmtSave(s)} vs ${dc})` });
    else { card.lines.push({ t: `${T.name} loses concentration (${fmtSave(s)} vs ${dc})`, c: 'bad' }); this.endConcentration(T, card); }
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

  removeEffect(T, effId, card = null) {
    const e = T.effects.find(x => x.id === effId); if (!e) return;
    if (card) card.undo.push({ key: T.key, restoreEffect: JSON.parse(JSON.stringify(e)) });
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
    for (const sc of this.camp.scenes) {
      const gone = (sc.templates || []).filter(t => t.conc === A.key);
      if (gone.length) { sc.templates = sc.templates.filter(t => t.conc !== A.key); ended.push(...gone.map(t => (t.zone?.name || 'its area') + ' (area)')); }
    }
    if (card && !quiet && (was || ended.length)) card.lines.push({ t: `${A.name}'s ${was || 'concentration'} ends${ended.length ? ': ' + ended.join(', ') : ''}`, c: 'muted' });
  }

  // ---------------------------------------------------------------- turns

  newCard(title, by = { name: 'DM', color: '#E5916A' }) { return { id: uid(10), ts: Date.now(), by, title, lines: [], undo: [] }; }
  flagsOf(A) { return A.kind === 'pc' ? (A.char.turnFlags ||= {}) : (A.token.turnFlags ||= {}); }
  isTurnOf(A) { const c = this.camp.combat; const cur = c?.started ? c.list[c.turn] : null; return !!cur && ((A.kind === 'pc' && cur.charId === A.char.id) || (A.token && cur.tokenId === A.token.id)); }
  event(type, text, data) { this.io.event?.(type, text, data); }

  // Start of a combatant's turn: durations timed on them run down, their reaction comes back,
  // monsters roll to recharge and regain legendary actions, and anything that happens "at the
  // start of each of its turns" happens (Heroism, zones like Stinking Cloud, ongoing damage).
  async onTurnStart(key, { round = null } = {}) {
    const card = this.newCard('Start of turn');
    const tick = T => {
      for (const e of [...T.effects]) {
        if (e.tickOn !== key || e.rounds == null) continue;
        e.rounds -= 1;
        if (e.rounds <= 0) { this.removeEffect(T, e.id); card.lines.push({ t: `${e.name} ends on ${T.name}`, c: 'muted' }); }
      }
    };
    for (const T of this.allActors()) tick(T);
    for (const ch of this.camp.characters) { if (!this.scene.tokens.some(t => t.charId === ch.id)) { const T = this.actorByKey('c:' + ch.id); if (T) tick(T); } }
    for (const sc of this.camp.scenes) for (const tp of [...(sc.templates || [])]) {
      if (tp.tickOn !== key || tp.rounds == null) continue;
      tp.rounds -= 1;
      if (tp.rounds <= 0) { sc.templates = sc.templates.filter(x => x !== tp); card.lines.push({ t: `${tp.zone?.name || 'An area'} ends`, c: 'muted' }); }
    }
    const A = this.actorByKey(key);
    if (!A) return card;
    card.title = `${round ? 'Round ' + round + ': ' : ''}${A.name}`;
    if (A.kind === 'pc') { A.char.turnFlags = {}; A.char.reactUsed = false; }
    else if (A.token) {
      A.token.turnFlags = {};
      A.token.reactUsed = false;
      if (A.token.legUsed) { A.token.legUsed = 0; card.lines.push({ t: `${A.name} regains its Legendary Actions`, c: 'muted' }); }
      for (const name of Object.keys(A.token.spent || {})) {
        const need = Number((name.match(/Recharge (\d)/) || [])[1]) || 6;
        const r = await this.io.roll('1d6', { label: `${A.name}: ${shortName(name)} recharge (${need}+)`, by: this.by(A), hidden: true });
        if (r.total >= need) { delete A.token.spent[name]; card.lines.push({ t: `${shortName(name)} recharges (rolled ${r.total})`, c: 'heal' }); }
        else card.lines.push({ t: `${shortName(name)} doesn’t recharge (rolled ${r.total}, needs ${need}+)`, c: 'muted' });
      }
    }
    for (const e of A.effects) {
      const n = Number(e.mods?.turnStartTemp) || 0;
      if (n > (A.hp.temp || 0)) { this.applyHeal(A, n, card, { temp: true }); card.lines.push({ t: `${A.name} gains ${n} temporary HP (${e.name})`, c: 'heal' }); }
    }
    for (const e of [...A.effects]) if (e.mods?.turnStartDamage) await this.ongoingDamage(A, e, e.mods.turnStartDamage, card);
    await this.zoneTrigger(A, 'start', card);
    for (const e of [...A.effects]) if (e.repeat?.when === 'start' && A.effects.includes(e)) await this.repeatSave(A, e, card);
    return card;
  }

  // End of a combatant's turn: repeat saves ("at the end of each of its turns"), zones that
  // bite when you end your turn in them (Grease, Spirit Guardians), effects that last
  // "until the end of the current turn".
  async onTurnEnd(key) {
    const card = this.newCard('End of turn');
    const A = this.actorByKey(key);
    if (!A) return card;
    card.title = `End of ${A.name}'s turn`;
    for (const e of [...A.effects]) if (e.repeat?.when === 'end' && A.effects.includes(e)) await this.repeatSave(A, e, card);
    for (const e of [...A.effects]) if (e.mods?.turnEndDamage) await this.ongoingDamage(A, e, e.mods.turnEndDamage, card);
    await this.zoneTrigger(A, 'end', card);
    for (const T of this.allActors()) for (const e of [...T.effects]) if (e.untilTurnEnd === key) { this.removeEffect(T, e.id, card); card.lines.push({ t: `${e.name} ends on ${T.name}`, c: 'muted' }); }
    return card;
  }

  async repeatSave(T, e, card) {
    const r = e.repeat;
    const s = await this.savingThrow(T, r.abil, r.dc, { label: `${e.name} (repeat)`, spell: !!r.spell, adv: !!r.adv });
    const vs = s.auto ? s.note : `${fmtSave(s)} vs DC ${r.dc}`;
    if (r.count) {
      r.s = (r.s || 0) + (s.success ? 1 : 0); r.f = (r.f || 0) + (s.success ? 0 : 1);
      if (r.f >= r.count) {
        this.removeEffect(T, e.id, card);
        card.undo.push({ key: T.key, hp: { ...T.hp }, conditions: [...(T.conditions || [])] });
        T.setConditions([...new Set([...(T.conditions || []), ...(r.final || ['petrified'])])]);
        card.lines.push({ t: `${T.name} fails ${e.name} a third time (${vs}): ${(r.final || ['petrified']).map(titleCase).join(', ')} for good`, c: 'bad' });
      } else if (r.s >= r.count) { this.removeEffect(T, e.id, card); card.lines.push({ t: `${T.name} succeeds a third time (${vs}): ${e.name} ends`, c: 'miss' }); }
      else card.lines.push({ t: `${T.name}: ${e.name} ${s.success ? 'success' : 'failure'} (${vs}) · ${r.s} succeeded, ${r.f} failed`, c: s.success ? 'miss' : 'hit' });
      return;
    }
    if (s.success) { this.removeEffect(T, e.id, card); card.lines.push({ t: `${T.name} shakes off ${e.name} (${vs})`, c: 'miss' }); return; }
    card.lines.push({ t: `${T.name} is still under ${e.name} (${vs})`, c: 'hit' });
    if (r.failDamage) {
      const O = this.actorByKey(e.origin?.key) || { name: e.origin?.name || '?', key: '', kind: 'npc' };
      await this.rollAndApply({ ...O, name: O.name }, T, { name: e.name }, r.failDamage.map(p => ({ ...p })), card, {});
    }
  }

  // Hideous Laughter and similar: taking damage gives another save, with advantage.
  async damagedRepeat(T, dmg, card) {
    if (dmg <= 0) return;
    // a copy carries the advantage; the stored effect is removed by id on a success
    for (const e of [...(T.effects || [])]) if (e.repeat?.onDamage && T.effects.includes(e)) await this.repeatSave(T, { ...e, repeat: { ...e.repeat, adv: true } }, card);
  }

  async ongoingDamage(T, e, spec, card) {
    const O = this.actorByKey(e.origin?.key) || { name: e.origin?.name || 'It', key: '' };
    let half = false;
    if (spec.save) {
      const sv = await this.savingThrow(T, spec.save, spec.dc, { label: e.name });
      card.lines.push({ t: `${T.name}: ${sv.auto ? sv.note : fmtSave(sv)} vs DC ${spec.dc} — ${sv.success ? 'saved' : 'failed'}`, c: sv.success ? 'miss' : 'hit' });
      if (sv.success && spec.endOnSave) { this.removeEffect(T, e.id, card); card.lines.push({ t: `${e.name} ends on ${T.name}`, c: 'muted' }); return; }
      half = sv.success && spec.onSave === 'half';
      if (sv.success && spec.onSave !== 'half') return;
    }
    await this.rollAndApply({ ...O, name: O.name }, T, { name: e.name }, [{ f: spec.f, type: spec.type }], card, { half });
  }

  // ---------------------------------------------------------------- zones (areas that linger)

  // A spell area that keeps working after it's cast: who it affects, and when.
  zoneFor(A, entry, act, level, special) {
    const id = entry.id || '';
    let spec = ZONES[id];
    const text = stripHtml(entry.text || '');
    if (!spec && act?.type === 'save' && !/instantaneous/i.test(entry.duration || '')) {
      const start = /starts? (?:its|their) turn (?:in|there|inside|within)/i.test(text);
      const endT = /ends? (?:its|their) turn (?:in|there|inside|within)/i.test(text);
      const enter = /enters? (?:the|that|its|this) (?:area|sphere|cube|cylinder|emanation|cloud|line|wall|space)/i.test(text);
      if (start || endT || enter) spec = { start, end: endT, enter, damage: !!act.damage?.length, onSave: act.onSave || 'half' };
    }
    if (!spec) return null;
    const z = { ...spec, name: entry.name.replace(/ \(.*\)$/, ''), spell: id, owner: A.key, ownerName: A.name };
    z.dc = act?.save?.dc ?? A.spellDC;
    if (!z.nosave) z.save = spec.save || act?.save?.abil?.[0] || null;
    if (spec.damage && act?.damage?.length) z.damage = this.damageParts(A, entry, act, { abil: null, level, isSpell: true, crit: false, opts: {} }).map(p => ({ f: p.f, type: p.type, half: p.half }));
    if (!spec.applies && act?.applies?.length) z.applies = act.applies;
    return z;
  }

  inTemplate(token, tpl, pos = token) { const sc = this.scene; return tokensInTemplate(sc.grid, [{ ...token, x: pos.x, y: pos.y }], tpl).length > 0; }

  async zoneTrigger(T, when, card, onlyId = null, pos = null) {
    const sc = this.scene; if (!sc || !T.token) return;
    for (const tpl of [...(sc.templates || [])]) {
      const z = tpl.zone;
      if (!z || !z[when] || (onlyId && tpl.id !== onlyId)) continue;
      if (!this.inTemplate(T.token, tpl, pos || T.token)) continue;
      if (z.notSelf && T.key === z.owner) continue;
      if (z.hostileOnly) { const O = this.actorByKey(z.owner); if (O && !!O.friendly === !!T.friendly) continue; }
      const flags = this.flagsOf(T), fk = 'zone:' + tpl.id;
      if (flags[fk]) continue; // once per turn
      flags[fk] = true;
      if (z.skipIf?.length && z.skipIf.every(st => condsOf(T).includes(st))) continue;
      await this.resolveZone(T, tpl, card);
    }
  }

  async resolveZone(T, tpl, card) {
    const z = tpl.zone;
    const O = this.actorByKey(z.owner) || { name: z.ownerName || 'The area', key: z.owner || '', kind: 'npc', mod: () => 0, pb: 2, level: 1, traits: [], effects: [] };
    let ok = false;
    if (z.save) {
      const sv = await this.savingThrow(T, z.save, z.dc, { label: z.name, spell: true });
      ok = sv.success;
      card.lines.push({ t: `${T.name} in ${z.name}: ${sv.auto ? sv.note : fmtSave(sv)} vs DC ${z.dc} — ${ok ? 'saved' : 'failed'}`, c: ok ? 'miss' : 'hit' });
    } else card.lines.push({ t: `${T.name} is caught in ${z.name}`, c: 'muted' });
    if (z.damage?.length && (!ok || z.onSave === 'half')) await this.rollAndApply(O, T, { name: z.name }, z.damage.map(p => ({ ...p })), card, { half: ok });
    if (!ok) {
      const st = (z.applies || []).filter(x => !T.condImmune.includes(x));
      if (st.length) { card.undo.push({ key: T.key, hp: { ...T.hp }, conditions: [...(T.conditions || [])] }); T.setConditions([...new Set([...(T.conditions || []), ...st])]); card.lines.push({ t: `${T.name}: ${st.map(titleCase).join(', ')}`, c: 'hit' }); }
      if (z.effect) { this.addEffect(T, { ...z.effect, key: 'zone:' + z.spell, origin: { key: z.owner, name: z.ownerName }, untilTurnEnd: z.effect.untilTurnEnd ? T.key : null, statuses: (z.effect.statuses || []).filter(x => !T.condImmune.includes(x)) }, card); card.lines.push({ t: `${T.name}: ${z.effect.name}`, c: 'hit' }); }
      if (z.note) card.lines.push({ t: `${T.name} is ${z.note}`, c: 'muted' });
    }
  }

  // A token moved (dropped on a new square). Booming Blade goes off if it moved on its own
  // turn, zones entered take effect, and emanations follow their caster.
  async onMoved(token, from) {
    const T = this.actor(token); if (!T) return null;
    const sc = this.scene;
    const card = this.newCard(`${T.name} moves`);
    for (const tpl of sc.templates || []) if (tpl.follow && tpl.follow === token.id) { const c = tokenCentre(sc, token); tpl.x = Math.round(c.x); tpl.y = Math.round(c.y); }
    const bb = (T.effects || []).find(e => e.key === 'booming-blade');
    if (bb && this.isTurnOf(T)) {
      const O = this.actorByKey(bb.origin?.key) || { name: bb.origin?.name || '?', key: bb.origin?.key || '', level: 1, kind: 'pc' };
      this.removeEffect(T, bb.id, card);
      await this.rollAndApply(O, T, { name: 'Booming Blade' }, [{ f: cantripTier(O.level || 1) + 'd8', type: 'thunder' }], card, {});
    }
    if (this.camp.combat) for (const tpl of [...(sc.templates || [])]) {
      if (!tpl.zone?.enter || tpl.follow === token.id) continue;
      if (this.inTemplate(token, tpl, from)) continue;
      await this.zoneTrigger(T, 'enter', card, tpl.id);
    }
    return card.lines.length ? card : null;
  }

  // ---------------------------------------------------------------- reactions and other choices

  promptsOn() { return this.camp.settings.reactPrompts !== false && !!this.io.ask; }
  ask(P, q) { if (!this.promptsOn()) return Promise.resolve(null); return this.io.ask(P ? P.char.id : null, q); }
  partyActors() { return (this.scene?.tokens || []).filter(t => t.charId).map(t => this.actor(t)).filter(P => P?.sheet); }
  canReact(P) {
    if (!P || P.kind !== 'pc' || !P.sheet || P.hp.value <= 0) return false;
    if (condsOf(P).some(c => ['incapacitated', 'unconscious', 'paralyzed', 'stunned', 'petrified', 'dead'].includes(c))) return false;
    if ((P.effects || []).some(e => e.mods?.noReactions)) return false;
    return !(this.camp.combat && P.char.reactUsed);
  }
  markReaction(P, card) { if (P.kind !== 'pc') return; card?.undo.push({ key: P.key, flagsOf: { reactUsed: !!P.char.reactUsed } }); P.char.reactUsed = true; }
  near(P, X, ft) { return !!(P.token && X.token) && (P === X || P.key === X.key || this.dist(P, X) <= ft); }
  hasAction(P, id) { return P.sheet?.actions.find(a => a.id === id) || null; }
  usesLeft(P, resId) { if (!resId) return Infinity; const r = P.sheet.resources.find(x => x.id === resId); return r ? r.max - (P.char.state?.used?.[resId] || 0) : Infinity; }
  lowestSlot(P, min = 1) {
    const sc = P.sheet?.spellcasting; if (!sc) return null;
    const st = P.char.state || {};
    for (let l = min; l <= (sc.slots?.length || 0); l++) if ((sc.slots[l - 1] || 0) - (st.slots?.[l] || 0) > 0) return { level: l, pact: false };
    if (sc.pact && (st.pact || 0) < sc.pact.max && sc.pact.level >= min) return { level: sc.pact.level, pact: true };
    return null;
  }
  spellReady(P, id, min = 1) {
    const sp = P.sheet?.spells?.find(x => x.id === id);
    if (!sp || !isPrepared(P.sheet, P.char.state, sp)) return null;
    const slot = this.lowestSlot(P, Math.max(min, sp.level || 1));
    return slot ? { sp, ...slot } : null;
  }
  saveUndo(P, card) { if (P.kind === 'pc') card.undo.push({ key: P.key, state: JSON.parse(JSON.stringify(P.char.state || {})), items: JSON.parse(JSON.stringify(P.char.items || [])) }); }

  // Someone was just hit. Returns { acBonus, resist, after: [async fns], who, what }.
  async hitReactions(A, T, info, card) {
    const out = { acBonus: 0, resist: false, after: [] };
    if (!this.promptsOn()) return out;
    const couldMiss = b => !info.auto && info.total < info.ac + out.acBonus + b;
    const take = (P, what) => { out.who = P.name; out.what = what; };
    if (T.kind === 'pc' && this.canReact(T)) {
      const opts = [];
      const sh = this.spellReady(T, 'shield');
      if (sh && couldMiss(5)) opts.push({ id: 'shield', label: `Shield: +5 AC (level ${sh.level}${sh.pact ? ' Pact' : ''} slot)` });
      const parry = this.hasAction(T, 'parry'), pb = Number(parry?.selfEffect?.mods?.acBonus) || T.pb;
      if (parry && info.kind === 'melee' && couldMiss(pb)) opts.push({ id: 'parry', label: `Parry: +${pb} AC` });
      const ward = this.hasAction(T, 'warding-maneuver');
      if (ward && this.usesLeft(T, ward.uses) > 0) opts.push({ id: 'ward', label: 'Warding Maneuver: +1d8 AC (resistance if it still hits)' });
      const rep = this.hasAction(T, 'repulsion');
      if (rep && info.kind === 'melee' && this.usesLeft(T, rep.uses) > 0 && (!/large or smaller/i.test(rep.text || '') || (A.size || 1) <= 2)) opts.push({ id: 'repulse', label: `Repulsion Shield: push ${A.name} 15 ft` });
      if (opts.length) {
        const pick = await this.ask(T, { title: `${A.name} hits you`, detail: `${info.total} to hit against your AC ${info.ac}. Use your reaction?`, options: opts });
        if (pick) { this.saveUndo(T, card); this.markReaction(T, card); }
        if (pick === 'shield') {
          this.spendSlot(T, sh.level, sh.pact);
          this.addEffect(T, { key: 'shield', name: 'Shield', icon: 'dodging', mods: { acBonus: 5 }, origin: { key: T.key, name: T.name }, rounds: 1, tickOn: T.key }, card);
          out.acBonus += 5; take(T, 'Shield');
          card.lines.push({ t: `${T.name} casts Shield (+5 AC until their next turn)`, c: 'muted' });
        } else if (pick === 'parry') {
          this.addEffect(T, { key: 'parry', name: 'Parry', icon: 'dodging', mods: { acBonus: pb }, origin: { key: T.key, name: T.name }, rounds: 1, tickOn: T.key }, card);
          out.acBonus += pb; take(T, 'Parry');
          card.lines.push({ t: `${T.name} parries (+${pb} AC until their next turn)`, c: 'muted' });
        } else if (pick === 'ward') {
          this.spendUse(T, ward.uses);
          const r = await this.io.roll('1d8', { label: `${T.name}: Warding Maneuver`, by: this.by(T) });
          out.acBonus += r.total; out.resist = true; take(T, 'Warding Maneuver');
          card.lines.push({ t: `${T.name} uses Warding Maneuver (+${r.total} AC)`, c: 'muted' });
        } else if (pick === 'repulse') {
          this.spendUse(T, rep.uses);
          out.after.push(async () => this.push(A, T, 15, card, 'Repulsion Shield'));
        }
      }
    }
    // a guardian next to the target (Warding Maneuver within 5 ft)
    if (couldMiss(1) || !out.resist) for (const P of this.partyActors()) {
      if (P.key === T.key || P.key === A.key || !(T.kind === 'pc' || T.friendly) || !this.canReact(P)) continue;
      const ward = this.hasAction(P, 'warding-maneuver');
      if (!ward || this.usesLeft(P, ward.uses) <= 0 || !this.near(P, T, 5)) continue;
      const pick = await this.ask(P, { title: `${A.name} hits ${T.name}`, detail: `${info.total} to hit against AC ${info.ac + out.acBonus}. Use Warding Maneuver?`, options: [{ id: 'ward', label: 'Warding Maneuver: +1d8 to their AC (resistance if it still hits)' }] });
      if (pick !== 'ward') continue;
      this.saveUndo(P, card); this.markReaction(P, card); this.spendUse(P, ward.uses);
      const r = await this.io.roll('1d8', { label: `${P.name}: Warding Maneuver for ${T.name}`, by: this.by(P) });
      out.acBonus += r.total; out.resist = true; take(P, 'Warding Maneuver');
      card.lines.push({ t: `${P.name} guards ${T.name} with Warding Maneuver (+${r.total} AC)`, c: 'muted' });
      break;
    }
    // a party member hits: Crash (Marcato) knocks the target down
    if (A.kind === 'pc' && !T.friendly && T.kind !== 'pc') for (const P of this.partyActors()) {
      if (P.key === A.key || !this.canReact(P)) continue;
      const crash = this.hasAction(P, 'crash');
      if (!crash || this.usesLeft(P, crash.uses) <= 0 || !this.near(P, A, 60)) continue;
      const pick = await this.ask(P, { title: `${A.name} hits ${T.name}`, detail: 'Use Crash (Marcato)? It spends a Bardic Inspiration die.', options: [{ id: 'crash', label: `Crash: ${T.name} saves (Strength) or falls Prone` }] });
      if (pick !== 'crash') continue;
      this.markReaction(P, card);
      out.after.push(async () => { await this.use(P.token, { src: 'action', id: 'crash', targets: [T.token.id] }); });
      break;
    }
    return out;
  }

  // Someone in the party is about to take damage. Returns { reduce, after }.
  async damageReactions(A, T, total, card) {
    const out = { reduce: 0, after: null };
    if (T.kind !== 'pc' || total <= 0 || !this.canReact(T) || !this.promptsOn()) return out;
    const opts = [];
    const st = this.hasAction(T, 'stone');
    if (st && this.usesLeft(T, st.uses) > 0) opts.push({ id: 'stone', label: `Stone’s Endurance: reduce it by ${st.selfHeal?.f || '1d12 + Con'}` });
    const hr = A && A.key !== T.key && A.token && this.scene?.tokens.includes(A.token) && this.near(T, A, 60) && this.canSee(T, A) ? this.spellReady(T, 'hellish-rebuke') : null;
    if (hr) opts.push({ id: 'rebuke', label: `Hellish Rebuke at ${A.name} (level ${hr.level}${hr.pact ? ' Pact' : ''} slot)` });
    if (!opts.length) return out;
    const pick = await this.ask(T, { title: `You take ${total} damage`, detail: `${A?.name ? 'From ' + A.name + '. ' : ''}Use your reaction?`, options: opts });
    if (!pick) return out;
    this.saveUndo(T, card); this.markReaction(T, card);
    if (pick === 'stone') {
      this.spendUse(T, st.uses);
      const r = await this.io.roll(String(st.selfHeal?.f || '1d12'), { label: `${T.name}: Stone’s Endurance`, by: this.by(T) });
      out.reduce = Math.min(total, r.total);
      card.lines.push({ t: `${T.name} braces with Stone’s Endurance (−${out.reduce})`, c: 'muted' });
    }
    if (pick === 'rebuke') out.after = async () => { await this.use(T.token, { src: 'spell', id: 'hellish-rebuke', targets: [A.token.id], slot: hr.level, pact: hr.pact, reaction: true }); };
    return out;
  }

  // After a save is rolled: Bardic Inspiration, rerolls from items, Flash of Genius and
  // Legendary Resistance can turn a failure into a success; Dissonance can do the opposite.
  async afterSave(T, abil, dc, res, { label = '', skills = null } = {}) {
    if (!this.promptsOn()) return res;
    const what = skills ? skills.join(' or ') + ' check' : ABIL_NAME[abil] + ' save';
    if (T.kind === 'pc' && res.total < dc) {
      const opts = [];
      const bi = (T.effects || []).find(e => e.key === 'bardic-inspiration');
      const die = Number((bi?.name.match(/d(\d+)/) || [])[1]) || 8;
      if (bi && dc - res.total <= die) opts.push({ id: 'bi', label: `Add your Bardic Inspiration (d${die})` });
      if (!skills) for (const it of (T.char.items || []).filter(i => i.qty > 0 && i.auto?.reroll?.save?.includes(abil))) opts.push({ id: 'item:' + it.id, label: `${it.name}: reroll (${it.qty} left)` });
      if (opts.length) {
        const pick = await this.ask(T, { title: `You fail: ${what}`, detail: `${res.total} against DC ${dc}${label ? ' · ' + label : ''}.`, options: opts });
        if (pick === 'bi') {
          const r = await this.io.roll('1d' + die, { label: `${T.name}: Bardic Inspiration`, by: this.by(T) });
          this.removeEffect(T, bi.id); res.total += r.total; res.why.push(`Bardic Inspiration +${r.total}`);
        } else if (pick?.startsWith('item:')) {
          const it = T.char.items.find(i => 'item:' + i.id === pick);
          if (it) {
            it.qty -= 1; if (it.qty <= 0) T.char.items = T.char.items.filter(i => i !== it);
            const r = await this.io.roll(res.dice, { label: `${T.name}: ${res.name} (reroll, ${it.name})`, by: this.by(T) });
            res.total = r.total; res.nat = r.nat; res.why.push(`rerolled with ${it.name}`);
            this.event('item', `${T.name} used ${it.name} to reroll a failed ${what}`);
          }
        }
      }
      if (res.total < dc && !skills) for (const P of this.partyActors()) {
        const fl = this.hasAction(P, 'flash');
        if (!fl || !this.canReact(P) || this.usesLeft(P, fl.uses) <= 0 || !this.near(P, T, 30)) continue;
        const n = P.mod('int'); if (dc - res.total > n) continue;
        const pick = await this.ask(P, { title: `${P.key === T.key ? 'You fail' : T.name + ' fails'}: ${what}`, detail: `${res.total} against DC ${dc}. Flash of Genius adds +${n}.`, options: [{ id: 'flash', label: `Flash of Genius (+${n})` }] });
        if (pick !== 'flash') continue;
        this.markReaction(P); this.spendUse(P, fl.uses);
        res.total += n; res.why.push(`Flash of Genius +${n}`);
        this.event('reaction', `${P.name}'s Flash of Genius saved ${T.name} (${what})`);
        break;
      }
    }
    if (T.kind === 'npc' && !T.friendly && res.total >= dc && res.total - dc <= 3) for (const P of this.partyActors()) {
      const ds = this.hasAction(P, 'dissonance');
      if (!ds || !this.canReact(P) || this.usesLeft(P, ds.uses) <= 0 || !this.near(P, T, 60)) continue;
      const pick = await this.ask(P, { title: `${T.name} makes a ${what}`, detail: 'Use Dissonance before the DM says how it went? It spends a Bardic Inspiration die.', options: [{ id: 'dis', label: 'Dissonance: lower the save by half a d8' }] });
      if (pick !== 'dis') continue;
      this.markReaction(P); this.spendUse(P, ds.uses);
      const r = await this.io.roll('1d8', { label: `${P.name}: Dissonance`, by: this.by(P) });
      res.total -= Math.floor(r.total / 2); res.why.push(`Dissonance −${Math.floor(r.total / 2)}`);
      break;
    }
    if (T.kind === 'npc' && res.total < dc && this.io.ask) {
      const lr = legendaryRes(T);
      if (lr.left > 0) {
        const pick = await this.io.ask(null, { title: `${T.name} fails: ${what}`, detail: `${res.total} against DC ${dc}${label ? ' · ' + label : ''}. ${lr.left} Legendary Resistance left today.`, options: [{ id: 'lr', label: 'Use Legendary Resistance (it succeeds)' }] });
        if (pick === 'lr') { T.token.legRes = (T.token.legRes || 0) + 1; res.legendary = true; res.why.push('Legendary Resistance'); this.event('reaction', `${T.name} used Legendary Resistance against ${label || what}`); }
      }
    }
    res.success = res.legendary || res.total >= dc;
    return res;
  }

  // Shove a creature straight away from another (Repulsion Shield), stopping at walls.
  push(T, from, ft, card, why) {
    const sc = this.scene; if (!T.token || !from.token) return;
    const a = tokenCentre(sc, from.token), b = tokenCentre(sc, T.token);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const steps = Math.round(ft / sc.grid.feet);
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const start = { x: T.token.x, y: T.token.y };
    let pos = { ...start };
    for (let i = 1; i <= steps; i++) {
      const next = { x: Math.round(start.x + ux * i), y: Math.round(start.y + uy * i) };
      if (moveBlocked(sc, T.token, pos, next)) break;
      pos = next;
    }
    card.undo.push({ key: T.key, token: { x: T.token.x, y: T.token.y } });
    T.token.x = pos.x; T.token.y = pos.y;
    const moved = Math.max(Math.abs(pos.x - start.x), Math.abs(pos.y - start.y)) * sc.grid.feet;
    card.lines.push({ t: `${why}: ${T.name} is pushed ${moved} ft away${moved < ft ? ' (a wall stops it)' : ''}`, c: 'muted' });
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
    else if (entry.save) out.push({ type: 'save', save: entry.save, onSave: entry.onSave || 'half', damage: entry.damage || [], area: entry.area, applies: entry.applies || [] });
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
    } else if (req.src === 'npc-spell') { entry = this.spells?.[req.id]; isSpell = true; }
    else if (req.src === 'item') {
      const it = A.char?.items?.find(i => i.id === req.id);
      if (!it) return;
      entry = itemEntry(it, this.spells);
      if (!entry) return;
      if (entry.isSpell) isSpell = true;
    }
    else if (isSpell) entry = A.sheet?.spells.find(s => s.id === req.id);
    else entry = A.sheet?.actions.find(a => a.id === req.id);
    if (!entry) return;

    const card = { id: uid(10), ts: Date.now(), by: this.by(A), title: `${A.name}: ${entry.name.replace(/ \(.*\)$/, '')}`, lines: [], undo: [] };
    if (A.kind === 'pc') card.undo.push({ key: A.key, state: JSON.parse(JSON.stringify(A.char.state || {})), items: JSON.parse(JSON.stringify(A.char.items || [])) });
    // reactions used from the sheet count as this round's reaction
    if (A.kind === 'pc' && (/reaction/i.test(entry.time || '') || req.reaction)) { card.undo.push({ key: A.key, flagsOf: { reactUsed: !!A.char.reactUsed } }); A.char.reactUsed = true; }
    // monsters: Recharge abilities are spent, legendary actions count down
    if (A.kind === 'npc' && req.src === 'npc' && A.token) {
      if (/Recharge \d/.test(entry.name)) {
        if (A.token.spent?.[entry.name]) card.lines.push({ t: `Note: ${shortName(entry.name)} hasn’t recharged`, c: 'bad' });
        card.undo.push({ key: A.key, token: { spent: { ...(A.token.spent || {}) } } });
        A.token.spent = { ...(A.token.spent || {}), [entry.name]: true };
      }
      if ((A.actor?.legendary || []).includes(entry)) {
        card.undo.push({ key: A.key, token: { legUsed: A.token.legUsed || 0 } });
        A.token.legUsed = (A.token.legUsed || 0) + 1;
        const max = A.actor.legendaryUses || 3;
        card.lines.push({ t: `Legendary action ${A.token.legUsed} of ${max}`, c: A.token.legUsed > max ? 'bad' : 'muted' });
      }
    }
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
      if (special.hostileOnly) targets = targets.filter(T => !!T.friendly !== !!A.friendly);
      const sheltered = targets.filter(T => this.coverFor(null, T, { x: req.template.x, y: req.template.y }) === Infinity);
      if (sheltered.length) { card.lines.push({ t: `Behind total cover, out of the area: ${sheltered.map(T => T.name).join(', ')}`, c: 'muted' }); targets = targets.filter(T => !sheltered.includes(T)); }
    }

    // ---- a party member may Counterspell a monster's spell
    if (isSpell && A.kind === 'npc' && this.promptsOn()) {
      for (const P of this.partyActors()) {
        if (!this.canReact(P) || !this.near(P, A, 60) || !this.canSee(P, A)) continue;
        const cs = this.spellReady(P, 'counterspell', 3); if (!cs) continue;
        const pick = await this.ask(P, { title: `${A.name} is casting ${entry.name}`, detail: 'Counterspell it? It makes a Constitution save against your spell DC.', options: [{ id: 'cs', label: `Counterspell (level ${cs.level}${cs.pact ? ' Pact' : ''} slot)` }] });
        if (pick !== 'cs') continue;
        this.saveUndo(P, card); this.markReaction(P, card); this.spendSlot(P, cs.level, cs.pact);
        card.lines.push({ t: `${P.name} casts Counterspell`, c: 'muted' });
        const sv = await this.savingThrow(A, 'con', P.spellDC, { label: 'Counterspell', spell: true });
        if (!sv.success) {
          card.lines.push({ t: `${A.name} fails (${sv.auto ? sv.note : fmtSave(sv)} vs DC ${P.spellDC}): ${entry.name} fizzles`, c: 'hit' });
          this.event('reaction', `${P.name} counterspelled ${A.name}'s ${entry.name}`);
          this.io.card(card); this.io.save(); return card;
        }
        card.lines.push({ t: `${A.name} pushes through (${fmtSave(sv)} vs DC ${P.spellDC})`, c: 'miss' });
        break;
      }
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
    if (entry.atWill) noSlot = true;
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
    if (entry.selfHeal) {
      const who = req.src === 'item' && targets[0] && (targets[0].kind === 'pc' || targets[0].friendly) ? targets[0] : A;
      const r = await this.io.roll(entry.selfHeal.f, { label: `${A.name}: ${entry.name}`, by: card.by });
      this.applyHeal(who, r.total, card);
      card.lines.push({ t: `${who.name} ${entry.selfHeal.label ? '— ' + r.total + ' ' + entry.selfHeal.label : 'regains ' + r.total + ' HP'}`, c: 'heal' });
    }
    if (entry.note) card.lines.push({ t: entry.note, c: 'muted' });
    if (entry.rollOnly) { const r = await this.io.roll(entry.rollOnly.f, { label: `${A.name}: ${entry.name}`, by: card.by }); card.lines.push({ t: `${entry.name}: ${r.total}${entry.rollOnly.label ? ' · ' + entry.rollOnly.label.replace('{half}', Math.floor(r.total / 2)) : ''}` }); }
    if (entry.selfTempPerLevel) { const n = entry.selfTempPerLevel * Math.max(1, level); this.applyHeal(A, n, card, { temp: true }); card.lines.push({ t: `${A.name} gains ${n} temporary HP`, c: 'heal' }); }
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
    const ctx = { level, isSpell, opts, special, conc, template: req.template };
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
    // a lingering area: remember what it does to whoever starts, ends or enters it later
    if (req.templateId && (isSpell || entry.zone)) {
      const tpl = sc.templates.find(t => t.id === req.templateId);
      const z = tpl && this.zoneFor(A, entry, act, level, special);
      if (z) {
        tpl.zone = z;
        tpl.conc = conc ? A.key : null;
        const dur = durationRounds(entry.duration);
        if (dur && !conc) { tpl.rounds = dur; tpl.tickOn = A.key; }
        if (special.follow || z.follow) tpl.follow = A.token.id;
        const when = [z.start && 'starts a turn in it', z.enter && 'enters it', z.end && 'ends a turn in it'].filter(Boolean);
        card.lines.push({ t: `${z.name} lingers: it affects anyone who ${when.join(when.length > 2 ? ', ' : ' or ').replace(/, ([^,]*)$/, ' or $1')}`, c: 'muted' });
      }
    }
    if (req.src === 'item' && A.kind === 'pc') {
      const it = A.char.items.find(i => i.id === req.id);
      if (it) {
        if (it.charges) it.charges.left = Math.max(0, it.charges.left - 1);
        else it.qty = (it.qty || 1) - 1;
        const gone = it.charges ? false : it.qty <= 0;
        card.lines.push({ t: gone ? `${it.name} is used up` : it.charges ? `${it.charges.left} of ${it.charges.max} charges left` : `${it.qty} left`, c: 'muted' });
        if (gone) A.char.items = A.char.items.filter(i => i !== it);
        this.event('item', `${A.name} used ${it.name}`);
      }
    }
    this.io.card(card);
    this.io.save();
    return card;
  }

  // Undo a card: restore HP/conditions, remove effects it added, give back resources.
  undo(card) {
    for (const u of [...(card.undo || [])].reverse()) {
      const T = this.actorByKey(u.key); if (!T) continue;
      if (u.removeEffect) this.removeEffect(T, u.removeEffect);
      if (u.restoreEffect && !T.effects.some(x => x.id === u.restoreEffect.id)) { const list = [...T.effects, u.restoreEffect]; if (T.kind === 'pc') T.char.effects = list; else T.token.effects = list; }
      if (u.items && T.kind === 'pc') T.char.items = u.items;
      if (u.token && T.token) Object.assign(T.token, u.token);
      if (u.flagsOf && T.kind === 'pc') T.char.reactUsed = u.flagsOf.reactUsed;
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
    for (const [k, v] of Object.entries(mods)) if (v === '@mod') mods[k] = A.spellMod ?? 0;
    if (mods.advFrom === 'self') mods.advFrom = A.key;
    if (mods.damageFrom?.key === 'self') mods.damageFrom = { ...mods.damageFrom, key: A.key };
    if (mods.critFrom?.key === 'self') mods.critFrom = { ...mods.critFrom, key: A.key };
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
      rounds: e.rounds ?? (spell.id === 'shield' ? 1 : durationRounds(spell.duration)), tickOn: A.key, statuses: e.statuses || [] };
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
    if (A.kind === 'npc') return { bonus: act.attack.bonus ?? (isSpell ? A.spellAttack : 0), abil: null };
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
      parts.push({ f: dice(crit ? n * 2 : n, d, b), type, half: !!p.half });
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
      const { adv, dis } = this.attackMode(A, T, kind, dist, isSpell || !!act.attack.spell);
      if (opts.adv) adv.push('chosen'); if (opts.dis) dis.push('chosen');
      if (entry.advantage) adv.push(entry.advantage === true ? entry.name : entry.advantage);
      const mode = adv.length && !dis.length ? '2d20kh' : dis.length && !adv.length ? '2d20kl' : '1d20';
      let penalty = '';
      for (const e of T.effects || []) if (e.mods?.attackedPenalty) penalty += '-' + e.mods.attackedPenalty;
      const formula = mode + sgn(bonus) + this.bonusDice(A, 'attack') + penalty;
      const r = await this.io.roll(formula, { label: `${A.name}: ${entry.name} → ${T.name}`, by: card.by });
      // Sap and similar are spent on the attack
      for (const e of [...A.effects]) if (e.mods?.disNextAttack) this.removeEffect(A, e.id);
      let cv = this.coverFor(A, T);
      const ignores = (isSpell || act.attack.spell) ? A.traits.includes('spell sniper') : kind === 'ranged' && A.traits.includes('sharpshooter');
      if (cv === Infinity) { card.lines.push({ t: `${T.name} has total cover: the attack can’t reach it`, c: 'miss' }); continue; }
      if (ignores) cv = 0;
      let ac = acOf(T) + cv;
      const nat = r.nat ?? r.terms.find(t => t.kind === 'dice')?.results.find(x => !x.dropped)?.v;
      let critRange = A.kind === 'pc' && A.sheet?.critRange ? A.sheet.critRange : 20;
      for (const e of T.effects || []) if (e.mods?.critFrom?.key === A.key) critRange = Math.min(critRange, e.mods.critFrom.range || 19);
      let total = r.total;
      let hit = nat >= critRange || (nat !== 1 && total >= ac);
      let crit = hit && (nat >= critRange || (kind === 'melee' && dist <= 5 && ['paralyzed', 'unconscious'].some(c => has(T, c))));
      const advTxt = mode === '1d20' ? '' : mode === '2d20kh' ? ` (adv: ${adv.join(', ')})` : ` (dis: ${dis.join(', ')})`;
      const cvTxt = cv ? ` (${coverName(cv)} +${cv})` : '';
      const showAc = A.kind === 'npc' || T.kind === 'pc';
      // a Bardic Inspiration die can turn a near miss into a hit
      if (!hit && nat !== 1 && A.kind === 'pc') {
        const bi = (A.effects || []).find(e => e.key === 'bardic-inspiration');
        const die = Number((bi?.name.match(/d(\d+)/) || [])[1]) || 8;
        if (bi && ac - total <= die && this.promptsOn()) {
          const pick = await this.ask(A, { title: `You miss ${T.name}`, detail: `You rolled ${total}. Add your Bardic Inspiration die?`, options: [{ id: 'bi', label: `Add d${die}` }] });
          if (pick === 'bi') {
            const b = await this.io.roll('1d' + die, { label: `${A.name}: Bardic Inspiration`, by: card.by });
            this.removeEffect(A, bi.id, card); total += b.total;
            card.lines.push({ t: `${A.name} adds Bardic Inspiration (+${b.total})`, c: 'muted' });
            hit = total >= ac;
          }
        }
      }
      card.lines.push({ t: `${T.name}: ${total}${showAc ? ' vs AC ' + ac : ''} — ${crit ? 'CRITICAL HIT' : hit ? 'hit' : 'miss'}${advTxt}${cvTxt}`, c: crit ? 'crit' : hit ? 'hit' : 'miss' });
      if (!hit) { if (nat === 1) this.event('fumble', `${A.name} rolled a natural 1 attacking ${T.name}`); continue; }
      // reactions to being hit (Shield, Parry, Warding Maneuver, Repulsion Shield) and to an ally's hit (Crash)
      const rx = await this.hitReactions(A, T, { total, ac, auto: nat >= critRange, kind, dist }, card);
      if (rx.acBonus && !(nat >= critRange) && total < ac + rx.acBonus) {
        card.lines.push({ t: `${T.name}'s AC becomes ${ac + rx.acBonus}: the attack misses`, c: 'miss' });
        this.event('reaction', `${rx.who || T.name}'s ${rx.what || 'reaction'} turned ${A.name}'s hit on ${T.name} into a miss`);
        for (const f of rx.after) await f();
        continue;
      }
      if (rx.acBonus) card.lines.push({ t: `Still a hit against AC ${ac + rx.acBonus}`, c: 'hit' });
      if (crit) this.event('crit', `${A.name} landed a critical hit on ${T.name} (${entry.name.replace(/ \(.*\)$/, '')})`);
      // damage
      const parts = this.damageParts(A, entry, act, { abil, level, isSpell, crit, opts, target: T });
      const extras = [];
      for (const e of T.effects || []) if (e.mods?.damageFrom && e.mods.damageFrom.key === A.key) extras.push({ f: critDouble(e.mods.damageFrom.f, crit), type: e.mods.damageFrom.type, why: e.name });
      if (act.weapon || entry.kind === 'weapon') for (const e of A.effects || []) if (e.mods?.weaponDamage) extras.push({ f: critDouble(e.mods.weaponDamage.f, crit), type: e.mods.weaponDamage.type, why: e.name });
      if (entry.oncePerTurn && !flags['once:' + entry.id]) { flags['once:' + entry.id] = true; extras.push({ f: critDouble(entry.oncePerTurn.f, crit), type: entry.oncePerTurn.type, why: entry.oncePerTurn.label }); }
      if (opts.boomingBlade) {
        const n = cantripTier(A.level) - 1;
        if (n > 0) extras.push({ f: critDouble(n + 'd8', crit), type: 'thunder', why: 'Booming Blade' });
        this.addEffect(T, { key: 'booming-blade', name: 'Booming Blade', icon: 'burning', mods: {}, origin: { key: A.key, name: A.name }, rounds: 1, tickOn: A.key }, card);
        card.lines.push({ t: `${T.name} is sheathed in booming energy: if it moves willingly before ${A.name}'s next turn it takes ${cantripTier(A.level)}d8 thunder`, c: 'muted' });
      }
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
      await this.rollAndApply(A, T, entry, [...parts, ...extras], card, { savage, isSpell, resistAll: rx.resist });
      if (act.weapon || entry.kind === 'weapon') for (const e of [...(A.effects || [])]) if (e.mods?.oneHit) { this.removeEffect(A, e.id, card); card.lines.push({ t: `${e.name} is used up`, c: 'muted' }); }
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
      for (const f of rx.after) await f();
    }
  }

  async riderSave(A, T, abil, dc, name, status, card, failText, effect, extra = '') {
    const s = await this.savingThrow(T, abil, dc, { label: name });
    if (s.success) { card.lines.push({ t: `${T.name} resists ${name} (${s.auto ? s.note : fmtSave(s) + ' vs DC ' + dc})`, c: 'muted' }); return; }
    if (status && !T.condImmune.includes(status)) { T.setConditions([...new Set([...(T.conditions || []), status])]); card.undo.push({ key: T.key, hp: { ...T.hp }, conditions: (T.conditions || []).filter(c => c !== status) }); }
    if (effect) this.addEffect(T, { ...effect, origin: { key: A.key, name: A.name }, tickOn: A.key }, card);
    card.lines.push({ t: `${T.name} fails vs ${name} (${s.auto ? s.note : fmtSave(s) + ' vs DC ' + dc})${status ? ': ' + titleCase(status) : ''}${failText ? ': ' + failText : ''} ${extra}`.trim(), c: 'hit' });
  }

  async rollAndApply(A, T, entry, parts, card, { savage, isSpell, half = false, none = false, resistAll = false }) {
    const formula = parts.map(p => p.f).join('+').replace(/\+-/g, '-');
    let r = await this.io.roll(formula, { label: `${A.name}: ${entry.name} damage → ${T.name}`, by: card.by });
    if (savage) {
      const r2 = await this.io.roll(formula, { label: `${A.name}: Savage Attacker reroll`, by: card.by });
      if (r2.total > r.total) r = r2;
    }
    const totals = splitTotals(r, parts).map((t, i) => (parts[i].half ? Math.floor(t / 2) : t));
    let rolled = parts.map((p, i) => ({ type: p.type, total: totals[i] }));
    if (half) rolled = rolled.map(p => ({ ...p, total: Math.floor(p.total / 2) }));
    if (none) rolled = rolled.map(p => ({ ...p, total: 0 }));
    let { total, notes } = this.damageAfterTraits(T, rolled, { resistAll });
    const rx = await this.damageReactions(A, T, total, card);
    if (rx.reduce) { total = Math.max(0, total - rx.reduce); notes.push(`${rx.reduce} prevented`); }
    const res = this.applyDamage(T, total, card);
    const types = [...new Set(parts.map(p => p.type).filter(Boolean))].join(', ');
    const why = parts.map(p => p.why).filter(Boolean);
    if (savage) why.push('Savage Attacker');
    card.lines.push({ t: `${T.name} takes ${total} ${types}${why.length ? ' with ' + why.join(', ') : ''}${notes.length ? ' (' + notes.join('; ') + ')' : ''}${res.down ? (T.kind === 'pc' ? ' and falls unconscious' : ' and drops') : ''}`, c: 'dmg' });
    await this.concentrationCheck(T, total, card);
    await this.damagedRepeat(T, total, card);
    if (rx.after) await rx.after();
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

  async doSave(A, entry, act, targets, card, ctx0) {
    const { level, isSpell, opts = {}, special, conc } = ctx0;
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
    card.lines.push({ t: `${act.save.skills ? act.save.skills.join(' or ') + ' check' : ABIL_NAME[abil] + ' save'}, DC ${dc}${dmgRoll ? ` · ${dmgRoll.total} damage` : ''}`, c: 'muted' });
    const totals = dmgRoll ? splitTotals(dmgRoll, parts).map((t, i) => (parts[i].half ? Math.floor(t / 2) : t)) : [];
    const effects = (entry.effects || []).filter(e => act.effects?.includes(e.id));
    const applies = act.applies || [];
    if (special?.onlyType) {
      const out = targets.filter(T => !T.type.includes(special.onlyType) && T.kind !== 'pc');
      for (const T of out) card.lines.push({ t: `${T.name} is unaffected (not a ${titleCase(special.onlyType)})`, c: 'muted' });
      targets = targets.filter(T => !out.includes(T));
      if (!targets.length) return;
    }
    const tpl = ctx0.template;
    const coverOf = T => (abil === 'dex' && tpl ? this.coverFor(null, T, { x: tpl.x, y: tpl.y }) : 0);
    const results = await Promise.all(targets.map(T => { const cv = coverOf(T); return this.savingThrow(T, abil, dc, { label: entry.name, spell: isSpell, skills: act.save.skills || null, bonus: cv === Infinity ? 0 : cv }).then(s => ({ T, s, cv })); }));
    for (const { T, s, cv } of results) {
      const evasion = abil === 'dex' && act.onSave === 'half' && T.traits.includes('evasion');
      const interpose = abil === 'dex' && act.onSave === 'half' && T.traits.includes('shield master: interpose shield');
      const ok = s.success;
      card.lines.push({ t: `${T.name}: ${s.auto ? s.note : fmtSave(s)} — ${ok ? 'saved' : 'failed'}${cv && cv !== Infinity ? ` (${coverName(cv)} +${cv})` : ''}`, c: ok ? 'miss' : 'hit' });
      if (dmgRoll) {
        let factor = ok ? (act.onSave === 'none' ? 0 : 0.5) : 1;
        if (evasion) factor = ok ? 0 : 0.5;
        else if (interpose && ok) factor = 0;
        const byType = new Map();
        parts.forEach((p, i) => byType.set(p.type, (byType.get(p.type) || 0) + totals[i]));
        const rolled = [...byType].map(([type, tot]) => ({ type, total: Math.floor(tot * factor) }));
        let { total, notes } = this.damageAfterTraits(T, rolled);
        if (factor > 0 || evasion || (interpose && ok)) {
          const rx = total > 0 ? await this.damageReactions(A, T, total, card) : {};
          if (rx.reduce) { total = Math.max(0, total - rx.reduce); notes.push(`${rx.reduce} prevented`); }
          const res = this.applyDamage(T, total, card);
          card.lines.push({ t: `${T.name} takes ${total}${notes.length ? ' (' + notes.join('; ') + ')' : ''}${evasion ? ' (Evasion)' : interpose && ok ? ' (Interpose Shield)' : ''}${res.down ? (T.kind === 'pc' ? ' and falls unconscious' : ' and drops') : ''}`, c: 'dmg' });
          await this.concentrationCheck(T, total, card);
          await this.damagedRepeat(T, total, card);
          if (rx.after) await rx.after();
        }
      }
      if (!ok) {
        const st = applies.filter(x => !T.condImmune.includes(x));
        const rep = repeatFor(entry, abil, dc, special);
        if (st.length && rep && !effects.length) {
          // a condition that ends on a later save becomes an effect, so the repeat save can end it
          this.addEffect(T, { key: (entry.id || entry.name) + ':cond', name: entry.name.replace(/ \(.*\)$/, ''), icon: st[0], mods: {}, origin: { key: A.key, name: A.name }, conc: conc ? A.key : null, rounds: durationRounds(entry.duration), tickOn: A.key, statuses: st, repeat: rep }, card);
        } else if (st.length) { card.undo.push({ key: T.key, hp: { ...T.hp }, conditions: [...(T.conditions || [])] }); T.setConditions([...new Set([...(T.conditions || []), ...st])]); }
        const names = [...st];
        for (const e of effects) {
          const eff = this.spellEffect(A, entry, e, special, conc);
          if (rep) eff.repeat = rep;
          const imm = eff.statuses.filter(x => T.condImmune.includes(x));
          eff.statuses = eff.statuses.filter(x => !T.condImmune.includes(x));
          if (imm.length) card.lines.push({ t: `${T.name} is immune to ${imm.map(titleCase).join(', ')}`, c: 'muted' });
          if (e.statuses?.length && !eff.statuses.length) continue;
          this.addEffect(T, eff, card);
          names.push(...(eff.statuses.length ? eff.statuses : [e.name]));
        }
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
    if (A.kind === 'npc' && /reduce/i.test(act.name || '')) { card.lines.push({ t: `${A.name} reduces the damage by ${r.total}`, c: 'muted' }); return; }
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
    if (d.f >= 3) { card.lines.push({ t: `${A.name} dies`, c: 'bad' }); A.setConditions([...new Set([...(A.conditions || []), 'dead'])]); this.event('death', `${A.name} died`); }
    if (r.nat === 20) this.event('stable', `${A.name} rolled a natural 20 on a death save and got back up`);
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
  'hold-person': { onlyType: 'humanoid', repeat: { when: 'end' } },
  'hold-monster': { repeat: { when: 'end' } },
  'hideous-laughter': { repeat: { when: 'end', onDamage: true } },
  'phantasmal-killer': { repeat: { when: 'end', failDamage: 'scale' } },
  'spirit-guardians': { hostileOnly: true, follow: true },
  'charm-person': { onlyType: 'humanoid' },
  'grease': { patch: { auto: [{ type: 'save', save: { abil: ['dex'] }, onSave: 'none', applies: ['prone'] }] }, note: 'The grease is Difficult Terrain; anyone entering it or ending a turn there saves again.' },
  'web': { patch: { auto: [{ type: 'save', save: { abil: ['dex'] }, onSave: 'none', applies: ['restrained'] }] }, note: 'The web is Difficult Terrain and Lightly Obscured.' },
  'blur': { patch: { auto: [], selfEffect: { key: 'blur', name: 'Blur', icon: 'invisible', rounds: 10, mods: { attackedDis: true } } } },
  'mirror-image': { patch: { auto: [], selfEffect: { key: 'mirror-image', name: 'Mirror Image (3 duplicates)', icon: 'invisible', rounds: 10 } }, note: 'Each time a creature hits you, roll a d6 per duplicate; any 3+ means a duplicate is hit and destroyed instead.' },
  'heroism': { patch: { auto: [], targetEffect: { key: 'heroism', name: 'Heroism', icon: 'blessed', rounds: 10, mods: { condImmune: ['frightened'], turnStartTemp: '@mod' } }, tempHp: { f: '@mod' } } },
  'aid': { aid: true, patch: { auto: [] } },
  'prayer-of-healing': { patch: { auto: [{ type: 'heal', heal: { n: 2, d: 8, b: '@mod', type: 'healing', scale: { mode: 'whole', n: 1 } } }] } },
  'elemental-weapon': { patch: { targetEffect: { key: 'elemental-weapon', name: 'Elemental Weapon', icon: 'burning', rounds: 600, mods: { attackBonus: 1, weaponDamage: { f: '1d4', type: 'fire' } } } } },
  'flesh-to-stone': { repeat: { when: 'end', count: 3, final: ['petrified'] } },
  'counterspell': { note: 'On a failed save the spell fails and the slot isn’t spent.' },
  'true-strike': { note: 'Use True Strike from a weapon’s options so the attack uses your spellcasting ability.' },
};

// Spell areas that keep working after they're cast. start / end: a creature that starts or ends
// its turn there; enter: a creature that moves in. Each creature is affected once per turn.
export const ZONES = {
  'web': { start: true, enter: true, save: 'dex', applies: ['restrained'], skipIf: ['restrained'] },
  'grease': { enter: true, end: true, save: 'dex', applies: ['prone'], skipIf: ['prone'] },
  'stinking-cloud': { start: true, save: 'con', effect: { name: 'Stinking Cloud (no action or Bonus Action)', icon: 'poisoned', statuses: ['poisoned'], untilTurnEnd: true } },
  'spirit-guardians': { enter: true, end: true, damage: true, onSave: 'half', notSelf: true, hostileOnly: true, follow: true },
  'moonbeam': { enter: true, end: true, damage: true, onSave: 'half' },
  'cloud-of-daggers': { enter: true, end: true, damage: true, nosave: true },
  'cloudkill': { enter: true, end: true, damage: true, onSave: 'half' },
  'insect-plague': { enter: true, end: true, damage: true, onSave: 'half' },
  'sickening-radiance': { start: true, enter: true, damage: true, onSave: 'none' },
  'tidal-barrier': { start: true, enter: true, save: 'str', note: 'pushed 10 ft away, and its speed is 0 until the start of its next turn' },
};

// "At the end of each of its turns, the target repeats the save": a save that can end the effect later.
export function repeatFor(entry, abil, dc, special = {}) {
  const sp = special?.repeat;
  const text = stripHtml(entry.text || '');
  let r = null;
  if (sp) r = { ...sp };
  else if (/at the end of each of (?:its|their) turns?[^.]*(?:repeat|makes? (?:a|another)[^.]*sav)/i.test(text) || /repeats? the sav[^.]*at the end of each of (?:its|their) turns/i.test(text)) r = { when: 'end' };
  else if (/at the start of each of (?:its|their) turns?[^.]*repeat[^.]*sav/i.test(text)) r = { when: 'start' };
  if (!r) return null;
  r.abil = r.abil || abil; r.dc = dc; r.spell = true;
  if (r.failDamage === 'scale') {
    const d = (entry.auto?.[0]?.damage || [])[0];
    r.failDamage = d ? [{ f: `${d.n}d${d.d}`, type: d.type }] : null;
  }
  return r;
}

function legendaryRes(T) {
  const tr = (T.actor?.traits || []).find(t => /^legendary resistance/i.test(t.name));
  if (!tr) return { max: 0, left: 0 };
  const max = Number((tr.name.match(/\((\d+)\s*\/\s*day/i) || tr.text?.match(/(\d+)\s*\/\s*day/i) || [])[1]) || 3;
  return { max, left: max - (T.token?.legRes || 0) };
}

const shortName = n => String(n).replace(/\s*\(.*\)$/, '');

// The engine entry for an item someone carries (a potion, a charge to cast a spell, a bomb).
export function itemEntry(it, spells) {
  const a = it.auto || {};
  if (a.castSpell && spells?.[a.castSpell]) return { ...spells[a.castSpell], name: `${spells[a.castSpell].name} (${it.name})`, uses: null, atWill: true, isSpell: true };
  const e = { id: 'item:' + it.id, name: it.name, text: it.text, kind: 'item', time: a.time || 'action' };
  if (a.heal) e.selfHeal = { f: a.heal };
  if (a.selfEffect) e.selfEffect = a.selfEffect;
  if (a.save) { e.save = a.save; e.onSave = a.onSave || 'half'; e.damage = a.damage || []; e.area = a.area || null; e.applies = a.applies || []; }
  if (a.note) e.note = a.note;
  if (!e.selfHeal && !e.selfEffect && !e.save && !e.note) e.note = stripHtml(it.text || '').slice(0, 220);
  return e;
}

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
export function fmtSave(s) { return `${s.total}${s.why?.length ? ' (' + s.why.join(', ') + ')' : ''}`; }
function fmtRounds(r) { return r >= 600 ? Math.round(r / 600) + ' hr' : r >= 10 ? Math.round(r / 10) + ' min' : r + ' round' + (r > 1 ? 's' : ''); }
function titleCase(s) { return String(s).replace(/(^|[-\s])\w/g, c => c.toUpperCase()).replace(/-/g, ' '); }
export function stripHtml(h) { return String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
