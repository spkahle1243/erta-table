// The end of a session: what happened, where the clocks stand, who carries what, and the
// prep's "After the session" checklist, written up as Markdown for the DM Story Assistant
// project (where it feeds the next prep's "Previously on…").

import { el } from './util.js';
import { modal, confirmBox } from './ui.js';

const time = ts => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const list = a => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
const times = n => (n === 1 ? 'once' : n === 2 ? 'twice' : n + ' times');
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// The "After the session" list from the pack's prep page.
export function afterChecklist(pack) {
  if (!pack) return [];
  const html = (pack.sections || []).map(s => s.html).join('\n');
  const at = html.search(/<h4>\s*After the session\s*<\/h4>/i);
  if (at < 0) return [];
  const ul = html.slice(at).match(/<ul>([\s\S]*?)<\/ul>/i);
  if (!ul) return [];
  return [...ul[1].matchAll(/<li>([\s\S]*?)<\/li>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

export function sessionFacts(c) {
  const since = c.sessionStart || 0;
  const J = (c.journal || []).filter(e => e.ts >= since);
  const pack = c.packs?.[c.activePack] || null;
  const scenes = [];
  for (const e of J.filter(e => e.type === 'scene')) if (scenes[scenes.length - 1]?.name !== e.scene) scenes.push({ name: e.scene, ts: e.ts });
  const fights = [];
  for (const e of J) {
    if (e.type === 'combat-start') fights.push({ start: e.ts, scene: e.scene, foes: e.foes || [], end: null, rounds: null, defeated: [] });
    if (e.type === 'combat-end') { const f = [...fights].reverse().find(x => !x.end); if (f) { f.end = e.ts; f.rounds = e.rounds; f.defeated = e.defeated || []; } }
  }
  for (const f of fights) {
    const inFight = e => e.ts >= f.start && (!f.end || e.ts <= f.end);
    f.downs = J.filter(e => e.type === 'down' && inFight(e)).map(e => e.name);
    f.highlights = J.filter(e => ['crit', 'reaction', 'death', 'stable'].includes(e.type) && inFight(e)).map(e => e.text);
  }
  const downs = new Map();
  for (const e of J.filter(e => e.type === 'down')) downs.set(e.name, (downs.get(e.name) || 0) + 1);
  const firstTick = id => J.find(e => e.type === 'clock' && e.clock === id)?.from;
  const clocks = (c.clocks || []).filter(k => !c.activePack || k.pack === c.activePack).map(k => ({ ...k, from: c.sessionClocks?.[k.id] ?? firstTick(k.id) ?? k.value }));
  const loot = J.filter(e => e.type === 'loot' || e.type === 'item').map(e => e.text);
  const highlights = J.filter(e => ['crit', 'fumble', 'reaction', 'death', 'stable'].includes(e.type)).map(e => e.text);
  const handouts = [...new Set(J.filter(e => e.type === 'handout').map(e => e.text))];
  const rests = J.filter(e => e.type === 'rest').map(e => e.text);
  return { J, pack, scenes, fights, downs, clocks, loot, highlights, handouts, rests };
}

// A first draft of the recap the DM edits.
export function recapDraft(c, F) {
  const out = [];
  if (F.scenes.length) out.push(`The party went from ${list(F.scenes.map(s => s.name))}.`);
  for (const f of F.fights) {
    const foes = f.foes.length ? list(f.foes) : 'their enemies';
    let t = `${f.scene ? 'At ' + f.scene + ' they' : 'They'} fought ${foes}${f.rounds ? ` for ${f.rounds} round${f.rounds === 1 ? '' : 's'}` : ''}`;
    if (f.defeated.length) t += `, and ${list(f.defeated)} fell`;
    out.push(t + '.');
  }
  if (F.downs.size) out.push([...F.downs].map(([n, k]) => `${n} went down ${times(k)}`).join('; ') + '.');
  const deaths = F.J.filter(e => e.type === 'death').map(e => e.text);
  if (deaths.length) out.push(deaths.join('. ') + '.');
  const moved = F.clocks.filter(k => k.value !== k.from);
  if (moved.length) out.push(moved.map(k => `${k.name} moved from ${k.from} to ${k.value} of ${k.size}`).join('; ') + '.');
  const got = F.J.filter(e => e.type === 'loot' && / got /.test(e.text)).map(e => e.text);
  if (got.length) out.push(got.join('; ') + '.');
  return out.join(' ') || 'Write what happened here.';
}

function partyNow(c) {
  return c.characters.map(ch => {
    const bits = [`${ch.hp.value}/${ch.hp.max} HP${ch.hp.temp ? ' (+' + ch.hp.temp + ' temp)' : ''}`];
    const sh = ch.sheet, st = ch.state || {};
    if (sh?.spellcasting?.slots?.length) {
      const sl = sh.spellcasting.slots.map((max, i) => (max ? `L${i + 1} ${max - (st.slots?.[i + 1] || 0)}/${max}` : null)).filter(Boolean);
      if (sl.length) bits.push('slots ' + sl.join(', '));
    }
    if (sh?.spellcasting?.pact) bits.push(`Pact ${sh.spellcasting.pact.max - (st.pact || 0)}/${sh.spellcasting.pact.max}`);
    const used = (sh?.resources || []).filter(r => st.used?.[r.id]).map(r => `${r.name} ${r.max - st.used[r.id]}/${r.max}`);
    if (used.length) bits.push('spent: ' + used.join(', '));
    if (ch.conditions?.length) bits.push('conditions: ' + ch.conditions.join(', '));
    const items = (ch.items || []).map(i => i.name + (i.charges ? ` (${i.charges.left}/${i.charges.max} charges)` : (i.qty ?? 1) > 1 ? ` ×${i.qty}` : ''));
    return { name: ch.name, line: bits.join(' · '), items };
  });
}

// Fill in what the table already knows next to a checklist line.
function annotate(line, c, F) {
  if (/clock/i.test(line)) return F.clocks.map(k => `${k.name} ${k.value}/${k.size}${k.value !== k.from ? ` (was ${k.from})` : ''}`).join(' · ');
  if (/loot|ledger|who holds|who keeps/i.test(line)) {
    const held = c.characters.filter(ch => ch.items?.length).map(ch => `${ch.name}: ${ch.items.map(i => i.name).join(', ')}`);
    return held.join(' · ');
  }
  return '';
}

export function buildMarkdown(c, F, { recap, checks, notes }) {
  const L = [];
  const title = F.pack?.title || c.name;
  const date = new Date().toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
  L.push(`# ${title}: session wrap-up`, '', `*${c.name} · played ${date} · written by Erta Table*`, '');
  L.push('## Previously on…', '', recap.trim() || '—', '');
  if (F.scenes.length) { L.push('## Scenes played', ''); for (const s of F.scenes) L.push(`- ${time(s.ts)} · ${s.name}`); L.push(''); }
  if (F.fights.length) {
    L.push('## Fights', '');
    for (const f of F.fights) {
      L.push(`- **${f.scene || 'A fight'}**: ${f.foes.length ? list(f.foes) : 'foes'}${!f.end ? ', still going' : f.rounds ? `, ${f.rounds} round${f.rounds === 1 ? '' : 's'}` : ''}${f.defeated.length ? `; defeated ${list(f.defeated)}` : ''}${f.downs.length ? `; went down: ${list(f.downs)}` : ''}`);
      for (const h of f.highlights) L.push(`  - ${h}`);
    }
    L.push('');
  }
  if (F.clocks.length) {
    L.push('## Clocks', '');
    for (const k of F.clocks) L.push(`- **${k.name}**: ${k.from} → ${k.value} of ${k.size}${k.steps?.[k.value] ? ` · at ${k.value}: ${k.steps[k.value]}` : ''}${k.visible ? '' : ' (hidden from players)'}`);
    L.push('');
  }
  const party = partyNow(c);
  L.push('## The party at the end', '');
  for (const p of party) L.push(`- **${p.name}**: ${p.line}${p.items.length ? ` · carrying ${p.items.join(', ')}` : ''}`);
  L.push('');
  if (F.loot.length) { L.push('## Loot and items this session', ''); for (const x of F.loot) L.push(`- ${x}`); L.push(''); }
  const extra = F.highlights.filter(h => !F.fights.some(f => f.highlights.includes(h)));
  if (extra.length || F.handouts.length || F.rests.length) {
    L.push('## Also worth remembering', '');
    for (const h of extra) L.push(`- ${h}`);
    if (F.handouts.length) L.push(`- Handouts shown: ${F.handouts.join(', ')}`);
    for (const r of F.rests) L.push(`- ${r}`);
    L.push('');
  }
  if (checks.length) {
    L.push('## After the session', '');
    for (const ck of checks) L.push(`- [${ck.done ? 'x' : ' '}] ${ck.text}${ck.note ? ` — ${ck.note}` : ''}`);
    L.push('');
  }
  if (notes.trim()) L.push('## DM notes', '', notes.trim(), '');
  return L.join('\n');
}

// ctx: { camp, onSave(entry), onNewSession(), download(blob, name), copy(text) }
export function wrapUpDialog(ctx) {
  const c = ctx.camp;
  const F = sessionFacts(c);
  const recap = el('textarea', { rows: 6, 'aria-label': 'Recap' });
  recap.value = recapDraft(c, F);
  const notes = el('textarea', { rows: 4, placeholder: 'Anything the table can’t know: promises made, NPC attitudes, what the players want next…', 'aria-label': 'DM notes' });
  const checks = afterChecklist(F.pack).map(text => ({ text, done: false, note: annotate(text, c, F) }));
  const preview = el('pre', { class: 'wrap-preview' });
  const md = () => buildMarkdown(c, F, { recap: recap.value, checks, notes: notes.value });
  const refresh = () => { preview.textContent = md(); };
  recap.addEventListener('input', refresh); notes.addEventListener('input', refresh);
  const checkList = el('div', { class: 'stack' }, checks.map(ck => {
    const box = el('input', { type: 'checkbox' });
    box.addEventListener('change', () => { ck.done = box.checked; refresh(); });
    const n = el('input', { type: 'text', value: ck.note, placeholder: 'Note' });
    n.addEventListener('input', () => { ck.note = n.value; refresh(); });
    return el('div', { class: 'wrap-check' }, el('label', { class: 'check' }, box, ck.text), n);
  }));
  const started = new Date(c.sessionStart || Date.now());
  const body = el('div', { class: 'stack wrap-up' },
    el('p', { class: 'small muted' }, `Since ${started.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}: ${F.scenes.length} scene${F.scenes.length === 1 ? '' : 's'}, ${F.fights.length} fight${F.fights.length === 1 ? '' : 's'}, ${F.loot.length} item event${F.loot.length === 1 ? '' : 's'}.`),
    el('label', { class: 'field' }, el('span', {}, 'Previously on… (a first draft from what happened at the table; edit it freely)'), recap),
    checks.length ? el('div', { class: 'field' }, el('span', {}, 'After the session, from your prep'), checkList) : null,
    el('label', { class: 'field' }, el('span', {}, 'DM notes'), notes),
    el('details', {}, el('summary', { class: 'small' }, 'The whole write-up'), preview),
    el('p', { class: 'small muted' }, 'Download it and add the file to your DM Story Assistant project (for example under erta/sessions or ironclad/sessions). The next prep starts its “Previously on…” from it, and the ledgers and clocks get updated from it.'));
  refresh();
  const name = `${slug(F.pack?.title || c.name)}-wrap-up-${new Date().toISOString().slice(0, 10)}.md`;
  const m = modal({ title: 'Wrap up the session', wide: true, body, actions: [
    { label: 'Close' },
    { label: 'Copy', run: async () => { await ctx.copy(md()); return false; } },
    { label: 'Download .md', run: () => { ctx.download(new Blob([md()], { type: 'text/markdown' }), name); return false; } },
    { label: 'Save & start the next session', kind: 'primary', run: async () => {
      const text = md();
      if (!(await confirmBox('Start the next session?', 'The write-up is kept with the campaign, and the table starts a fresh journal and clock baseline. Download it first if you want it in your project.', { ok: 'Save and start fresh' }))) return false;
      ctx.onSave({ ts: Date.now(), title: F.pack?.title || c.name, md: text });
      ctx.onNewSession();
    } },
  ] });
  return m;
}
