// Build a session pack in the browser, straight from a prep page (.html) made
// from the session or one-shot template. The page supplies the prose, styles,
// prompts, handouts, NPC cards and item cards. Its embedded data block
//   <script type="application/json" id="erta-table">{ … }</script>
// supplies what prose can't: monster reskins, encounters, clocks and item
// overrides. Pages without the block still build; encounters, clocks and
// monsters are then read from the page itself as well as they can be.
// tools/prep_to_pack.py does the same job offline.

export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

// ---------------------------------------------------------------- CSS scoping
function splitRules(css) {
  const out = []; let i = 0; const n = css.length;
  while (i < n) {
    const j = css.indexOf('{', i); if (j < 0) break;
    const prelude = css.slice(i, j).trim();
    let depth = 1, k = j + 1;
    while (k < n && depth) { if (css[k] === '{') depth++; else if (css[k] === '}') depth--; k++; }
    out.push([prelude, css.slice(j + 1, k - 1)]);
    i = k;
  }
  return out;
}
const ROOTS = new Set([':root', 'html', 'body', ':root[data-theme="dark"]', ':root:not([data-theme="light"])']);
function scopeSelector(sel, root) {
  const out = [];
  for (let s of sel.split(',')) {
    s = s.trim(); if (!s) continue;
    if (ROOTS.has(s)) { out.push(root); continue; }
    if (s.startsWith(':root')) s = s.replace(':root', '').trim() || root;
    if (s.startsWith('html') || s.startsWith('body')) s = s.includes(' ') ? s.slice(s.indexOf(' ') + 1) : '';
    out.push(s && s !== root ? `${root} ${s}`.trim() : root);
  }
  return [...new Set(out)].join(', ');
}
export function scopeCss(css, root = '.prep-doc') {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const base = [], dark = [], rest = [];
  for (const [pre, body] of splitRules(css)) {
    if (pre.startsWith('@media') && pre.includes('prefers-color-scheme')) { for (const [, b2] of splitRules(body)) dark.push(`${root}{${b2}}`); }
    else if (pre.startsWith('@media') || pre.startsWith('@supports')) rest.push(`${pre}{${splitRules(body).map(([p2, b2]) => `${scopeSelector(p2, root)}{${b2}}`).join('')}}`);
    else if (pre.startsWith('@')) rest.push(`${pre}{${body}}`);
    else if (pre.startsWith(':root[data-theme="dark"]')) dark.push(`${root}{${body}}`);
    else base.push(`${scopeSelector(pre, root)}{${body}}`);
  }
  return [...base, ...dark, ...rest].join('\n');   // the table is always dark
}

// ---------------------------------------------------------------- text helpers
// Like BeautifulSoup's get_text(' ', strip=True): text pieces, trimmed, joined.
function getText(node, sep = ' ') {
  const parts = [];
  const walk = n => {
    for (const ch of n.childNodes) {
      if (ch.nodeType === 3) { const t = ch.textContent.replace(/\s+/g, ' ').trim(); if (t) parts.push(t); }
      else if (ch.nodeType === 1 && !['SCRIPT', 'STYLE'].includes(ch.tagName)) walk(ch);
    }
  };
  if (node) walk(node);
  return parts.join(sep);
}
const strip = n => (n?.textContent || '').replace(/\s+/g, ' ').trim();
function textWithBreaks(node) {
  const out = [];
  const walk = n => {
    for (const ch of n.childNodes) {
      if (ch.nodeType === 3) out.push(ch.textContent.replace(/\s+/g, ' '));
      else if (ch.nodeType === 1) {
        if (ch.tagName === 'BR') out.push('\n');
        else if (!['SCRIPT', 'STYLE'].includes(ch.tagName) && !ch.classList.contains('hl')) walk(ch);
      }
    }
  };
  walk(node);
  return out.join('').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

// ---------------------------------------------------------------- items
const ABIL = { strength: 'str', dexterity: 'dex', constitution: 'con', intelligence: 'int', wisdom: 'wis', charisma: 'cha', str: 'str', dex: 'dex', con: 'con', int: 'int', wis: 'wis', cha: 'cha' };
const SHAPE = { radius: 'sphere', sphere: 'sphere', cone: 'cone', line: 'line', cube: 'cube' };

export function itemAuto(name, typ, text, spells = {}) {
  const a = {};
  const potion = /potion/i.test(typ);
  let m = text.match(/Regain\s+(\d+d\d+(?:\s*[+-]\s*\d+)?)\s*HP/i);
  if (m) a.heal = m[1].replace(/\s+/g, '');
  m = text.match(/fail an? ([A-Za-z, ]+?) sav(?:e|ing throw)[^.]*?reroll/i);
  if (m) { const save = (m[1].match(/[A-Za-z]+/g) || []).map(w => ABIL[w.toLowerCase()]).filter(Boolean); if (save.length) a.reroll = { save }; }
  m = text.match(/Darkvision (\d+) ft for (\d+) hours?/i);
  if (m) {
    const bonus = text.match(/\+(\d+) ft if you have it/i);
    a.selfEffect = { key: slug(name), name, icon: 'marked', rounds: +m[2] * 600, mods: { darkvision: +m[1], darkvisionBonus: bonus ? +bonus[1] : 0 } };
  }
  m = text.match(/(\d+)d(\d+)\s+([a-z]+)(?:\s*\+\s*([a-z]+))?(\s*\(half each\))?\s+in a (\d+)-ft\.? (radius|sphere|cone|line|cube)[^.]*?DC (\d+) ([A-Za-z]+)/i);
  if (m) {
    const [, ns, ds, t1, t2, halfEach, size, shape, dc, ab] = m; const n = +ns, d = +ds;
    const dmg = t2 && halfEach ? [{ n: Math.floor(n / 2), d, type: t1.toLowerCase() }, { n: n - Math.floor(n / 2), d, type: t2.toLowerCase() }]
      : [{ n, d, type: t1.toLowerCase() }, ...(t2 ? [{ n, d, type: t2.toLowerCase() }] : [])];
    Object.assign(a, { save: { abil: [ABIL[ab.toLowerCase()] || 'dex'], dc: +dc }, onSave: 'half', damage: dmg, area: { shape: SHAPE[shape.toLowerCase()], size: +size } });
  }
  m = text.match(/extra (\d+d\d+) ([a-z]+)(?: damage)? on (?:the|its) next hit/i);
  if (m) a.selfEffect = { key: slug(name), name, icon: 'poisoned', rounds: 600, mods: { weaponDamage: { f: m[1], type: m[2].toLowerCase() }, oneHit: true } };
  m = text.match(/\(as ([a-z][a-z '’-]+?)\)|cast ([a-z][a-z '’-]+?)[.,;]/i);
  if (m) { const sid = slug((m[1] || m[2]).replace(/[’']/g, '')); if (spells[sid]) a.castSpell = sid; }
  if (!Object.keys(a).length && /consumable/i.test(typ)) {
    const h = text.match(/(\d+) hours?/);
    a.selfEffect = { key: slug(name), name, icon: 'blessed', rounds: h ? +h[1] * 600 : 10 };
  }
  const side = text.match(/Side effect:\s*([^<]+?)(?:$|(?<=\.)\s)/i);
  const any = Object.keys(a).length > 0;
  if (side && any) a.note = 'Side effect: ' + side[1].trim();
  if ((any && /^\s*Bonus action/i.test(text)) || (any && potion)) a.time = 'bonus';
  return any ? a : null;
}

export function parseItems(root, spells, overrides = {}) {
  const items = [], seen = new Set();
  for (const card of root.querySelectorAll('.itm')) {
    const nm = card.querySelector('.in'), ty = card.querySelector('.it'), de = card.querySelector('.id');
    if (!nm) continue;
    const name = getText(nm); if (seen.has(name)) continue; seen.add(name);
    const typ = ty ? getText(ty) : '', text = de ? getText(de) : '';
    const it = { key: 'i-' + slug(name), name, type: typ, text: de ? de.outerHTML : '' };
    const q = typ.match(/×\s*(\d+)/), c = typ.match(/\((\d+) charges?\)/);
    it.qty = q ? +q[1] : 1;
    if (c) it.charges = +c[1];
    const auto = itemAuto(name, typ, text, spells);
    if (auto) it.auto = auto;
    Object.assign(it, overrides[name] || {});
    items.push(it);
  }
  return items;
}

// ---------------------------------------------------------------- NPCs
const TITLES = new Set(['the', 'of', 'and', 'high', 'priestess', 'director', 'mayor', 'sgt', 'sergeant', 'foreman', 'brother', 'sister', 'old', 'master', 'mother', 'father', 'lady', 'lord', 'captain', 'corporal', 'herald', 'two', 'thumbs']);
export const nameTokens = s => (String(s).toLowerCase().replace(/&amp;/g, '&').match(/[a-z][a-z'’-]+/g) || []).map(w => w.replace(/[’']s$/, '')).filter(w => w.length > 2 && !TITLES.has(w));
// A name matches a list entry when its first proper word (the given name) appears in it.
export const namedIn = (name, entry) => { const p = nameTokens(String(name).split(',')[0])[0]; return !!p && nameTokens(entry).includes(p); };

function parseNpcs(sections) {
  const npcs = [], byKey = new Map();
  const add = n => { if (byKey.has(n.key)) return byKey.get(n.key); byKey.set(n.key, n); npcs.push(n); return n; };
  for (const s of sections) {
    for (const card of s.node.querySelectorAll('.npc')) {
      const nmEl = card.querySelector('.nm'); if (!nmEl) continue;
      const nm = nmEl.cloneNode(true); for (const x of nm.querySelectorAll('.new, .open')) x.remove();
      const name = strip(nm);
      const fields = [];
      for (const dt of card.querySelectorAll(':scope > dl > dt')) {
        const dd = dt.nextElementSibling; if (dd?.tagName !== 'DD') continue;
        fields.push([strip(dt), dd.innerHTML.trim()]);
      }
      const art = [...card.querySelectorAll('details.art')].find(d => /^Portrait prompt/.test(strip(d.querySelector('summary span'))));
      const portrait = art ? strip(art.querySelector('summary span')).replace(/^Portrait prompt\s*·\s*/, '').replace(/\s*\(.*\)$/, '') : null;
      add({ key: 'npc-' + slug(name), name, role: strip(card.querySelector('.role')), fields, line: strip(card.querySelector('.line')), portrait, section: s.id, card: true });
    }
  }
  // walk-ons from the quick-reference "Who's here" rows
  for (const s of sections) for (const span of s.node.querySelectorAll('td.who > span')) for (const b of span.querySelectorAll(':scope > b')) {
    const name = strip(b);
    if (/see (their|his|her) cards?/i.test(span.textContent)) continue;
    const known = npcs.find(n => n.card && (namedIn(n.name, name) || namedIn(name, n.name)));
    const desc = strip(span).split(':').slice(1).join(':').trim() || strip(span).replace(name, '').replace(/^[\s:,·–-]+/, '');
    if (known) { if (!known.walkOn) known.walkOn = desc; continue; }
    add({ key: 'npc-' + slug(name), name, role: desc, fields: [], line: '', portrait: null, section: s.id, card: false });
  }
  // who is present in each scene: its own cards and walk-ons, plus anyone named on its "Who:" line
  for (const s of sections) {
    const whoEl = [...s.node.querySelectorAll('.scene-sub > span')].find(sp => /^Who:/.test(strip(sp)));
    const whoText = whoEl ? strip(whoEl).replace(/^Who:\s*/, '') : '';
    s.whoText = whoText;
    const entries = whoText.split(/[,;]| and /).map(x => x.trim()).filter(Boolean);
    const present = new Set(npcs.filter(n => n.section === s.id).map(n => n.key));
    for (const e of entries) for (const n of npcs) if (namedIn(n.name, e)) present.add(n.key);
    s.who = [...present];
  }
  return npcs;
}

// ---------------------------------------------------------------- fallbacks for pages without a data block
// Clocks from the page's own clock script: object literals with id, name, size and start.
function scriptClocks(doc) {
  const out = [];
  for (const sc of doc.querySelectorAll('script:not([type="application/json"])')) {
    const src = sc.textContent;
    const vars = {};
    for (const m of src.matchAll(/(?:var|let|const)\s+(\w+)\s*=\s*document\.getElementById\(\s*['"]([\w-]+)['"]\s*\)/g)) vars[m[1]] = m[2];
    const lastHost = Object.values(vars).pop() || 'clocks';
    for (const m of src.matchAll(/\{([^{}]*\bid\s*:[^{}]*\bsize\s*:[^{}]*)\}/g)) {
      const o = {};
      for (const kv of m[1].matchAll(/(\w+)\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|-?\d+|true|false)/g)) {
        const v = kv[2]; o[kv[1]] = /^['"]/.test(v) ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v === 'true' ? true : v === 'false' ? false : +v;
      }
      if (!o.id || !o.name || !o.size) continue;
      const before = src.slice(Math.max(0, m.index - 80), m.index);
      const call = before.match(/(\w+)\s*\(\s*(\w+)\s*,\s*$/);
      const host = call && vars[call[2]] ? vars[call[2]] : (vars.host || lastHost);
      out.push({ key: o.id, name: o.name, size: o.size, start: o.start || 0, goal: o.goal || '', host });
    }
  }
  return out;
}
function clockDetails(doc, clocks) {
  const byHost = {};
  for (const k of clocks) (byHost[k.host] ||= []).push(k);
  for (const [host, ks] of Object.entries(byHost)) {
    const el = doc.getElementById(host); if (!el) continue;
    const panel = el.closest('.panel') || el.parentElement;
    const text = strip(panel);
    for (const k of ks) k.visible = /\bvisible\b/i.test(text) && !/hidden|reveal their effects/i.test(text);
    if (ks.length === 1) {
      const steps = {};
      for (const tr of panel.querySelectorAll('table tr')) {
        const [a, b] = tr.querySelectorAll('td');
        if (a && b && /^\d+$/.test(strip(a))) steps[strip(a)] = strip(b).replace(/\s+/g, ' ');
      }
      if (Object.keys(steps).length) ks[0].steps = steps;
    }
  }
  return clocks;
}

// Encounters from the page's .enc cards: monster names in bold, matched against the SRD.
function pageEncounters(doc, sections, scenes, srd) {
  const byName = new Map(Object.entries(srd).map(([k, a]) => [a.name.toLowerCase(), k]));
  const srdKey = t => byName.get(t.toLowerCase()) || byName.get(t.toLowerCase().replace(/s$/, '')) || null;
  const actors = {}, encounters = [];
  for (const enc of doc.querySelectorAll('.enc')) {
    const head = enc.querySelector('.enc-h');
    const name = strip(head?.querySelector('.t')).replace(/^Encounter\s*·\s*/i, '') || 'Encounter';
    const chips = [...(head?.querySelectorAll('.chip') || [])].map(strip);
    const xpChip = chips.find(c => /XP/.test(c)) || '';
    const xp = +(xpChip.match(/([\d,]+)\s*XP/)?.[1] || '0').replace(/,/g, '');
    const difficulty = (xpChip.split('·')[1] || '').trim();
    const dt = [...enc.querySelectorAll('dt')].find(d => /^Foes$/i.test(strip(d)));
    const dd = dt?.nextElementSibling;
    if (!dd) continue;
    const foes = [];
    let pending = null;
    const countAfter = b => { let t = ''; for (let n = b.nextSibling; n && t.length < 12; n = n.nextSibling) { if (n.nodeType === 1 && n.tagName === 'B') break; t += n.textContent; } return +(t.match(/^\s*[×x]\s*(\d+)/)?.[1] || 0); };
    for (const b of dd.querySelectorAll('b')) {
      const t = strip(b).replace(/\s*\(SRD\)\s*/i, '');
      const key = srdKey(t);
      if (!key) { if (!/^\d/.test(t) && !/HP|AC/.test(t)) pending = { name: t, count: countAfter(b) }; continue; }
      const count = pending?.count || countAfter(b) || 1;
      const label = pending?.name || srd[key].name;
      const akey = slug(label);
      if (!actors[akey]) actors[akey] = pending ? { base: key, name: label.replace(/s$/, '') } : { base: key };
      foes.push({ actor: akey, count });
      pending = null;
    }
    if (!foes.length) continue;
    const sec = sections.find(s => s.node.contains(enc));
    const maps = scenes.filter(s => s.kind === 'map' && s.section === sec?.id);
    const before = maps.filter(s => s.el && (s.el.compareDocumentPosition(enc) & 4));
    const scene = (before.pop() || maps[0])?.key || null;
    encounters.push({ key: slug(name), name, section: sec?.id || null, scene, xp, difficulty, el: enc, groups: [{ label: name, foes }] });
  }
  return { actors, encounters };
}

// ---------------------------------------------------------------- the build
// opts: { srd: {key: actor}, spells: {id: spell}, config: object (overrides the page's data block) }
export function readConfig(doc) {
  const s = doc.querySelector('script#erta-table[type="application/json"], script[type="application/json"][data-erta-table]');
  if (!s) return null;
  try { return JSON.parse(s.textContent); } catch (e) { throw new Error('The page’s erta-table data block isn’t valid JSON: ' + e.message); }
}

export function buildPack(html, { srd = {}, spells = {}, config = null } = {}) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const block = readConfig(doc);
  const cfg = { ...(block || {}), ...(config || {}) };
  const warnings = [];
  const autoClocks = clockDetails(doc, scriptClocks(doc));

  const css = [...doc.querySelectorAll('style')].map(s => s.textContent).join('\n');
  for (const t of doc.querySelectorAll('script, style, link, title, meta')) t.remove();
  doc.querySelector('nav.rail')?.remove();
  for (const b of doc.querySelectorAll('button.fx')) b.remove();
  for (const f of doc.querySelectorAll('.fx-row, .fx-inline')) if (!f.textContent.trim()) f.remove();

  const mast = doc.querySelector('header.mast');
  const title = strip(mast?.querySelector('h1')) || cfg.title || strip(doc.querySelector('h1')) || 'Session';
  const eyebrow = strip(mast?.querySelector('.eyebrow'));
  const subtitle = strip(mast?.querySelector('.sub'));
  const id = cfg.id || slug(title);

  const scenes = [], music = [], handouts = [], portraits = [];
  const seen = new Set();
  const ukey = base => { let k = base, n = 2; while (seen.has(k)) k = `${base}-${n++}`; seen.add(k); return k; };

  const nodes = [];
  if (mast) nodes.push(['overview', 'Overview', '§', mast]);
  const prep = doc.querySelector('section#prep');
  if (prep) nodes.push(['prep', 'Before the session', '§', prep]);
  for (const sec of doc.querySelectorAll('section.scene')) {
    const h2 = sec.querySelector('.scene-head h2');
    nodes.push([sec.id || slug(strip(h2)), strip(h2) || sec.id, strip(sec.querySelector('.scene-num')), sec]);
  }
  if (!nodes.length) throw new Error('No scenes found. A prep page has a header.mast and section.scene blocks.');

  const sections = [];
  for (const [sid, stitle, num, node] of nodes) {
    for (const d of node.querySelectorAll('details.art')) {
      if (d.classList.contains('leads')) continue;
      const label = strip(d.querySelector('summary span'));
      const p = d.querySelector('.artp');
      const prompt = p ? getText(p) : '';
      if (d.classList.contains('music')) {
        const name = label.replace(/^Soundtrack prompt\s*·\s*/, '');
        const key = ukey('m-' + slug(name));
        music.push({ key, name, kind: 'music', prompt, section: sid, combat: /^combat loop/i.test(name), cue: /^cue/i.test(name) });
        d.dataset.music = key;
      } else if (d.classList.contains('map')) {
        const m = label.match(/\((\d+)\s*[×x]\s*(\d+)\s*squares\)/);
        const name = label.replace(/^Battle map prompt\s*·\s*/, '').replace(/\s*\(\d+\s*[×x]\s*\d+\s*squares\)/, '').trim();
        const key = ukey('map-' + slug(name));
        scenes.push({ key, name: name + ' (battle map)', kind: 'map', section: sid, squares: m ? [+m[1], +m[2]] : null, prompt, el: d });
        d.dataset.scene = key;
      } else if (/^Portrait prompt/.test(label)) {
        portraits.push({ name: label.replace(/^Portrait prompt\s*·\s*/, '').replace(/\s*\(.*\)$/, ''), prompt, section: sid });
      } else if (/^Art prompt/.test(label)) {
        const name = label.replace(/^Art prompt\s*·\s*/, '');
        const key = ukey('art-' + slug(name));
        scenes.push({ key, name, kind: 'art', section: sid, prompt, el: d });
        d.dataset.scene = key;
      }
    }
    for (const h of node.querySelectorAll('.handout')) {
      const t = strip(h.querySelector('.hl')).replace(/^Handout\s*·\s*/, '') || 'Handout';
      const key = ukey('h-' + slug(t));
      handouts.push({ key, title: t[0].toUpperCase() + t.slice(1), text: textWithBreaks(h), style: h.classList.contains('ledger') ? 'ledger' : 'paper', section: sid });
      h.dataset.handout = key;
    }
    sections.push({ id: sid, title: stitle, num, node });
  }

  // clocks: the data block's, else the page script's
  let clocks = cfg.clocks, containers = cfg.clockContainers;
  if (!clocks) {
    clocks = autoClocks.map(({ host, ...k }) => k);
    containers = {};
    for (const k of autoClocks) containers[k.host] = containers[k.host] ? containers[k.host] + ',' + k.key : k.key;
  }
  for (const [cid, keys] of Object.entries(containers || {})) { const e = doc.getElementById(cid); if (e) e.dataset.clocks = keys; }
  for (const cid of ['dawnclock', 'clocks']) { const e = doc.getElementById(cid); if (e && !e.dataset.clocks && clocks.length) e.dataset.clocks = cid === 'clocks' ? clocks.map(k => k.key).join(',') : cid; }

  // encounters and monsters: the data block's, else the page's own .enc cards
  let encounters = cfg.encounters, actorCfg = cfg.actors || {};
  if (!encounters) {
    const auto = pageEncounters(doc, sections, scenes, srd);
    encounters = auto.encounters; actorCfg = { ...auto.actors, ...actorCfg };
  }
  for (const enc of encounters) {
    const target = enc.el || (enc.anchor ? doc.querySelector(enc.anchor) : null);
    if (!target) { warnings.push(`No place on the page for the encounter “${enc.name}”.`); continue; }
    const marker = doc.createElement('div'); marker.className = 'pack-enc'; marker.dataset.encounter = enc.key;
    target.after(marker);
  }
  encounters = encounters.map(({ el, ...e }) => e);

  // scene music: a battle map gets its section's combat loop, scene art the section's first track
  for (const s of scenes) {
    const same = music.filter(m => m.section === s.section);
    const pick = s.kind === 'map' ? (same.find(m => m.combat) || same.find(m => !m.cue)) : same.find(m => !m.combat && !m.cue);
    if (pick) s.music = pick.key;
    if (s.kind === 'map') { const loop = same.find(m => m.combat); if (loop) s.combatMusic = loop.key; }
    Object.assign(s, cfg.sceneOverrides?.[s.key] || {});
  }

  const actors = {};
  for (const [key, a] of Object.entries(actorCfg)) {
    let out;
    if (a.base) {
      if (!srd[a.base]) { warnings.push(`“${a.name || key}” is based on “${a.base}”, which isn’t in the SRD list.`); continue; }
      out = structuredClone(srd[a.base]);
      for (const [k, v] of Object.entries(a.set || {})) out[k] = v;
      for (const [sec, entries] of Object.entries(a.add || {})) (out[sec] ||= []).push(...entries);
      for (const [sec, names] of Object.entries(a.remove || {})) out[sec] = (out[sec] || []).filter(e => !names.includes(e.name));
      out.name = a.name || out.name;
      out.srd = a.base;
      if (a.notes) out.notes = a.notes;
    } else if (a.actor) out = a.actor;
    else { warnings.push(`“${key}” has no base monster or stat block.`); continue; }
    out.id = key;
    if (a.token) out.token = a.token;
    actors[key] = out;
  }
  for (const enc of encounters) for (const g of enc.groups) for (const f of g.foes) if (!actors[f.actor]) warnings.push(`The encounter “${enc.name}” uses “${f.actor}”, which has no stat block.`);

  const npcs = parseNpcs(sections);
  for (const n of npcs) { const a = Object.entries(actors).find(([, x]) => namedIn(n.name, x.name)); if (a) n.actor = a[0]; }
  const items = parseItems(doc, spells, cfg.items || {});
  const outSections = sections.map(s => ({ id: s.id, title: s.title, num: s.num, html: s.node.outerHTML, who: s.who, whoText: s.whoText || '' }));
  for (const s of scenes) delete s.el;

  return {
    pack: {
      format: 'erta-table-pack', version: 1,
      id, title, eyebrow, subtitle,
      series: cfg.series || (/ironclad/i.test(eyebrow) ? 'ironclad' : 'erta'),
      built: cfg.built || new Date().toISOString().slice(0, 10),
      css: scopeCss(css),
      sections: outSections,
      scenes, music, handouts, portraits, npcs,
      actors, encounters, clocks: clocks || [],
      styleLocks: cfg.styleLocks || {},
      items,
    },
    warnings,
    fromBlock: !!block,
  };
}

// The same NPC reading for packs built before NPCs were part of the format.
export function npcsForPack(pack) {
  if (pack.npcs) return pack;
  const doc = new DOMParser().parseFromString(`<div>${pack.sections.map(s => s.html).join('')}</div>`, 'text/html');
  const roots = [...doc.body.firstElementChild.children];
  const sections = pack.sections.map((s, i) => ({ id: s.id, node: roots[i] || doc.createElement('div') }));
  pack.npcs = parseNpcs(sections);
  for (const n of pack.npcs) { const a = Object.entries(pack.actors || {}).find(([, x]) => namedIn(n.name, x.name)); if (a) n.actor = a[0]; }
  pack.sections.forEach((s, i) => { s.who = sections[i].who; s.whoText = sections[i].whoText || ''; });
  return pack;
}
