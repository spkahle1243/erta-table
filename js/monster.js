// A monster's turn in one place: what it can do, who it's aimed at and how far away they
// are, Multiattack as a single button, and its Recharge and Legendary actions tracked.
// The DM view shows it for the monster whose turn it is (or one the DM pins).

import { el, toast } from './util.js';
import { avatar } from './ui.js';
import { tokenStats } from './model.js';
import { tokenDistanceFt } from './geometry.js';
import { stripHtml } from './rules.js';
import { coverName } from './vision.js';
import { spellSlug } from './statblock.js';

const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
const baseName = e => String(e.name).replace(/\s*\(.*\)$/, '');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sign = n => (n >= 0 ? '+' : '−') + Math.abs(n);

// "The xorn makes one Bite attack and three Claw attacks." → [{ n: 1, act: Bite }, { n: 3, act: Claw }]
// "makes two attacks, using Slam or Rock Launch in any combination" → [{ n: 2, choice: [Slam, Rock Launch] }]
export function multiattackPlan(actor) {
  const ma = (actor.actions || []).find(a => /^multiattack/i.test(a.name));
  if (!ma) return null;
  const text = stripHtml(ma.text);
  const acts = [...(actor.actions || []), ...(actor.bonus || [])].filter(a => a !== ma);
  const steps = [];
  const any = text.match(/makes (\w+) attacks?,? (?:using|with) ([^.]+?)(?: in any combination|, in any combination|\.)/i);
  if (any) {
    const n = NUM[any[1].toLowerCase()] || Number(any[1]) || 2;
    const choice = acts.filter(a => a.auto?.length && new RegExp(`\\b${esc(baseName(a))}\\b`, 'i').test(any[2]));
    if (choice.length) steps.push({ n, choice, at: any.index });
  }
  if (!steps.length) for (const a of acts) {
    const nm = esc(baseName(a));
    const m = text.match(new RegExp(`\\b(\\w+|\\d+) ${nm} attacks?`, 'i'));
    if (m && a.auto?.length) { steps.push({ n: NUM[m[1].toLowerCase()] || Number(m[1]) || 1, act: a, at: m.index }); continue; }
    const u = text.match(new RegExp(`uses? (?:its |either )?${nm}\\b`, 'i'));
    if (u) steps.push({ n: 1, act: a, at: u.index, use: true });
  }
  steps.sort((a, b) => a.at - b.at);
  return steps.length ? { text, steps } : null;
}

function reachOf(e) {
  const t = stripHtml(e.text || '');
  const r = t.match(/reach (\d+) ft/i), g = t.match(/range (\d+)(?:\/(\d+))? ft/i);
  return { reach: r ? Number(r[1]) : null, range: g ? Number(g[2] || g[1]) : null, short: g ? Number(g[1]) : null };
}

let running = false;

export function renderMonsterPanel(box, ctx) {
  const c = ctx.camp, sc = ctx.scene();
  const cur = ctx.current();
  let t = null;
  if (ctx.pinned) t = sc?.tokens.find(x => x.id === ctx.pinned) || null;
  if (!t && cur && !cur.charId) t = sc?.tokens.find(x => x.id === cur.tokenId) || null;
  const actor = t?.actorId && c.actors?.[t.actorId];
  if (!t || !actor || (t.owner && !ctx.pinned)) { box.hidden = true; box.innerHTML = ''; return; }
  const keep = box.querySelector('.mp-body')?.scrollTop || 0;
  box.hidden = false; box.innerHTML = '';
  const st = tokenStats(c, t);
  const myTurn = cur && cur.tokenId === t.id;
  const A = ctx.engine?.actor(t);

  const av = avatar(st.name, '#5a3a34', null);
  if (st.img) ctx.resolveImg(st.img).then(u => { if (u) { av.style.background = `url("${u}") center/cover`; av.textContent = ''; } });
  const f = st.hp?.max ? Math.max(0, st.hp.value / st.hp.max) : 0;
  const conds = (st.conditions || []).map(x => String(x).split(':')[0]);
  box.append(el('div', { class: 'mp-head' }, av,
    el('div', { class: 'grow', style: { minWidth: 0 } },
      el('button', { class: 'mp-name', type: 'button', title: 'Find on the map', onclick: () => ctx.focus(t.id) }, st.name),
      el('div', { class: 'hpline small' }, el('span', { class: 'bar' }, el('i', { style: { width: f * 100 + '%', background: f > .5 ? '#4f9d69' : f > .25 ? '#d6a73c' : '#c8553d' } })), `${st.hp.value}/${st.hp.max}${st.hp.temp ? ' +' + st.hp.temp : ''} · AC ${st.ac} · ${actor.speed}`),
      conds.length ? el('div', { class: 'small', style: { color: 'var(--copper)' } }, conds.join(', ')) : null),
    ctx.pinned ? el('button', { class: 'btn icon ghost', type: 'button', title: 'Close', 'aria-label': 'Close', onclick: () => ctx.unpin() }, '×') : el('span', { class: 'chip', style: { color: 'var(--copper)' } }, 'its turn')));

  // who it's aimed at
  const all = [...(actor.actions || []), ...(actor.bonus || []), ...(actor.legendary || [])];
  const melee = Math.max(0, ...all.map(e => reachOf(e).reach || 0));
  const ranged = Math.max(0, ...all.map(e => reachOf(e).range || 0));
  const tg = el('div', { class: 'mp-tg' });
  const ids = ctx.targets().filter(id => sc.tokens.some(x => x.id === id));
  if (!ids.length) tg.append(el('span', { class: 'small muted' }, 'Hover a creature and press T to aim at it.'));
  for (const id of ids) {
    const x = sc.tokens.find(k => k.id === id), xs = tokenStats(c, x);
    const d = tokenDistanceFt(sc.grid, t, x, c.settings.diagonals);
    const T = ctx.engine?.actor(x);
    const cv = A && T ? ctx.engine.coverFor(A, T) : 0;
    const where = melee && d <= melee ? 'in reach' : ranged && d <= ranged ? 'in range' : 'out of reach';
    tg.append(el('span', { class: 'chip ' + (where === 'out of reach' ? 'far' : 'near'), title: cv ? coverName(cv) : '' }, `${xs.name} · ${d} ft · ${where}${cv ? ' · ' + (cv === Infinity ? 'total cover' : '+' + cv + ' cover') : ''}`));
  }
  const body = el('div', { class: 'mp-body' });
  box.append(tg, body);

  const plan = multiattackPlan(actor);
  const spent = t.spent || {};
  const section = (title, list, extra) => {
    if (!list?.length && !extra) return;
    const sec = el('div', { class: 'mp-sec' }, el('h5', {}, title));
    if (extra) sec.append(extra);
    const row = el('div', { class: 'mp-btns' });
    for (const e of list || []) {
      if (/^multiattack/i.test(e.name)) continue;
      const rech = e.name.match(/Recharge (\d)/);
      const isSpent = !!spent[e.name];
      const acts = (e.auto || []).map((a, i) => ({ a, i })).filter(({ a }) => a.attack || a.save || a.damage?.length || a.heal);
      const label = (a) => {
        const nm = baseName(e) + (a?.name ? ': ' + a.name : '');
        if (a?.attack) return `${nm} ${sign(a.attack.bonus ?? 0)}`;
        if (a?.save) return `${nm} · DC ${a.save.dc} ${a.save.abil.map(x => x.toUpperCase()).join('/')}`;
        return nm;
      };
      const tip = stripHtml(e.text).slice(0, 300);
      if (!acts.length) row.append(el('button', { class: 'btn small ghost', type: 'button', title: tip, disabled: running, onclick: () => go(() => ctx.run(sc, t, { src: 'npc', id: e.name, targets: ids })) }, baseName(e)));
      for (const { a, i } of acts) row.append(el('button', { class: 'btn small ' + (isSpent ? '' : 'primary'), type: 'button', title: tip + (isSpent ? '\n(Not recharged yet)' : ''), disabled: running, onclick: () => ctx.use(sc, t, e, i) }, label(a) + (a.area ? ' (area)' : '') + ' ▸'));
      if (rech) row.append(isSpent
        ? el('button', { class: 'btn small ghost', type: 'button', title: `Spent. It rolls to recharge (${rech[1]}+ on a d6) at the start of its turns. Click to mark it ready.`, onclick: () => ctx.change(() => { delete t.spent[e.name]; }) }, `${baseName(e)}: spent ↻`)
        : el('span', { class: 'chip ok small' }, `${baseName(e)} ready`));
    }
    sec.append(row);
    body.append(sec);
  };

  if (plan) {
    const parts = plan.steps.map(s => `${s.n > 1 ? s.n + '× ' : ''}${s.choice ? s.choice.map(baseName).join(' or ') : baseName(s.act)}`);
    body.append(el('div', { class: 'mp-sec' },
      el('button', { class: 'btn primary mp-multi', type: 'button', disabled: running || !ids.length, title: plan.text, onclick: () => go(() => multiattack(ctx, sc, t, plan)) }, `Multiattack ▸ ${parts.join(', ')}`),
      !ids.length ? el('div', { class: 'small muted' }, 'Pick a target first (T)') : null));
  }
  section('Actions', actor.actions);
  section('Bonus actions', actor.bonus);
  section('Reactions', actor.reactions);
  if (actor.legendary?.length) {
    const max = actor.legendaryUses || 3, used = t.legUsed || 0;
    section(`Legendary actions`, actor.legendary, el('div', { class: 'row small' }, el('span', { class: 'pp' }, Array.from({ length: max }, (_, i) => el('i', { class: i < max - used ? 'on' : '' }))), el('span', { class: 'muted' }, `${Math.max(0, max - used)} of ${max} left · after another creature’s turn`)));
  }
  const lr = (actor.traits || []).find(x => /^legendary resistance/i.test(x.name));
  if (lr) {
    const max = Number((lr.name.match(/(\d+)\s*\/\s*day/i) || [])[1]) || 3, used = t.legRes || 0;
    body.append(el('div', { class: 'mp-sec row small' }, el('b', {}, 'Legendary Resistance'), el('span', { class: 'mono' }, `${max - used}/${max}`),
      el('button', { class: 'btn icon ghost', type: 'button', title: 'Spend one', onclick: () => ctx.change(() => { t.legRes = Math.min(max, used + 1); }) }, '−'),
      el('button', { class: 'btn icon ghost', type: 'button', title: 'Give one back', onclick: () => ctx.change(() => { t.legRes = Math.max(0, used - 1); }) }, '+')));
  }
  const spells = (actor.spells || []).map(n => ctx.engine?.spells?.[spellSlug(n)]).filter(Boolean);
  if (spells.length) {
    const sec = el('div', { class: 'mp-sec' }, el('h5', {}, `Spells · DC ${actor.spellDC || '—'}`));
    sec.append(el('div', { class: 'mp-btns' }, spells.map(sp => el('button', { class: 'btn small', type: 'button', title: stripHtml(sp.text).slice(0, 240), disabled: running, onclick: () => ctx.use(sc, t, { name: sp.name }, 0, sp.id) }, sp.name))));
    body.append(sec);
  }
  if (myTurn) box.append(el('div', { class: 'mp-foot' }, el('button', { class: 'btn', type: 'button', disabled: ctx.busy || running, onclick: () => ctx.nextTurn() }, ctx.busy ? 'Resolving…' : 'End its turn ▸')));
  body.scrollTop = keep;

  async function go(fn) {
    if (running) return;
    running = true; renderMonsterPanel(box, ctx);
    try { await fn(); } catch (e) { console.error(e); toast(e.message, 'bad'); }
    finally { running = false; renderMonsterPanel(box, ctx); }
  }
}

// Run every attack in a Multiattack, spreading them over the targets and moving on when one drops.
async function multiattack(ctx, sc, t, plan) {
  const c = ctx.camp;
  const ids = ctx.targets();
  const alive = () => ids.map(id => sc.tokens.find(x => x.id === id)).filter(x => x && (tokenStats(c, x).hp?.value ?? 1) > 0);
  if (!alive().length) { toast('Target someone first: hover their token and press T', 'bad'); return; }
  let k = 0;
  for (const step of plan.steps) for (let i = 0; i < step.n; i++) {
    const list = alive(); if (!list.length) return;
    const target = list[k++ % list.length];
    const d = tokenDistanceFt(sc.grid, t, target, c.settings.diagonals);
    let entry = step.act;
    if (step.choice) entry = step.choice.find(e => (reachOf(e).reach || 0) >= d) || step.choice.find(e => (reachOf(e).range || 0) >= d) || step.choice[0];
    const ai = Math.max(0, (entry.auto || []).findIndex(a => a.attack || a.save || a.damage?.length));
    if (entry.auto?.[ai]?.area) continue; // areas are placed by hand
    await ctx.run(sc, t, { src: 'npc', id: entry.name, targets: [target.id], opts: { activity: ai } });
  }
}
