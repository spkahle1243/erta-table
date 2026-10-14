#!/usr/bin/env python3
"""Convert Foundry dnd5e 2024 SRD actors (YAML pack sources) into Erta Table's
compact actor format: finished stat-block text plus machine-readable actions.

Usage: foundry_actors.py <dnd5e>/packs/_source/actors24 out.json
Source data: SRD 5.2, CC-BY-4.0 (Wizards of the Coast), via the Foundry VTT
dnd5e system (MIT).
"""
import sys, os, re, json, glob, html, math
import yaml

ABIL = ['str', 'dex', 'con', 'int', 'wis', 'cha']
ABIL_NAME = dict(str='Strength', dex='Dexterity', con='Constitution', int='Intelligence', wis='Wisdom', cha='Charisma')
SKILLS = dict(acr=('Acrobatics', 'dex'), ani=('Animal Handling', 'wis'), arc=('Arcana', 'int'), ath=('Athletics', 'str'),
              dec=('Deception', 'cha'), his=('History', 'int'), ins=('Insight', 'wis'), itm=('Intimidation', 'cha'),
              inv=('Investigation', 'int'), med=('Medicine', 'wis'), nat=('Nature', 'int'), prc=('Perception', 'wis'),
              prf=('Performance', 'cha'), per=('Persuasion', 'cha'), rel=('Religion', 'int'), slt=('Sleight of Hand', 'dex'),
              ste=('Stealth', 'dex'), sur=('Survival', 'wis'))
SIZES = dict(tiny=('Tiny', 0.5), sm=('Small', 1), med=('Medium', 1), lg=('Large', 2), huge=('Huge', 3), grg=('Gargantuan', 4))
XP = {0: 10, 0.125: 25, 0.25: 50, 0.5: 100, 1: 200, 2: 450, 3: 700, 4: 1100, 5: 1800, 6: 2300, 7: 2900, 8: 3900, 9: 5000, 10: 5900,
      11: 7200, 12: 8400, 13: 10000, 14: 11500, 15: 13000, 16: 15000, 17: 18000, 18: 20000, 19: 22000, 20: 25000, 21: 33000,
      22: 41000, 23: 50000, 24: 62000, 25: 75000, 26: 90000, 27: 105000, 28: 120000, 29: 135000, 30: 155000}
COND_REF = {'prone', 'grappled', 'restrained', 'poisoned', 'frightened', 'charmed', 'blinded', 'deafened', 'incapacitated',
            'invisible', 'paralyzed', 'petrified', 'stunned', 'unconscious', 'exhaustion'}


def mod(score): return (score - 10) // 2
def sign(n): return f'+{n}' if n >= 0 else f'−{-n}'
def cr_str(cr): return {0.125: '1/8', 0.25: '1/4', 0.5: '1/2'}.get(cr, str(int(cr)) if cr == int(cr) else str(cr))
def prof_for(cr): return 2 if cr < 5 else 3 if cr < 9 else 4 if cr < 13 else 5 if cr < 17 else 6 if cr < 21 else 7 if cr < 25 else 8 if cr < 29 else 9
def title(s): return s[:1].upper() + s[1:] if s else s


class Ctx:
    def __init__(self, d):
        self.d = d
        s = d['system']
        self.ab = {a: s['abilities'][a]['value'] for a in ABIL}
        self.m = {a: mod(v) for a, v in self.ab.items()}
        self.cr = s['details'].get('cr') or 0
        self.pb = prof_for(self.cr)
        self.spell_abil = s['attributes'].get('spellcasting') or 'int'
        self.name = d['name']
        self.items = {it['_id']: it for it in d.get('items', [])}

    def eval(self, expr, m=0):
        """Evaluate a Foundry roll-data expression; returns (int_constant, dice_terms)."""
        if expr is None or expr == '': return 0
        e = str(expr)
        e = e.replace('@mod', str(m)).replace('@prof', str(self.pb))
        e = re.sub(r'@abilities\.(\w+)\.mod', lambda k: str(self.m.get(k.group(1), 0)), e)
        e = re.sub(r'@abilities\.(\w+)\.value', lambda k: str(self.ab.get(k.group(1), 10)), e)
        e = re.sub(r'@attributes\.prof', str(self.pb), e)
        e = re.sub(r'@details\.cr', str(self.cr), e)
        e = re.sub(r'@[\w.]+', '0', e)
        if re.search(r'\dd\d', e): return e  # dice inside a bonus: leave as text
        try: return int(eval(re.sub(r'[^\d+\-*/(). ]', '', e) or '0', {'__builtins__': {}}, {'floor': math.floor, 'ceil': math.ceil}))
        except Exception: return 0


def dice_formula(n, d, bonus):
    parts = []
    if n and d: parts.append(f'{n}d{d}')
    if isinstance(bonus, str): parts.append(bonus)
    elif bonus: parts.append(str(bonus))
    f = ' + '.join(parts) if parts else '0'
    return f.replace('+ -', '- ')


def avg(n, d, bonus):
    b = bonus if isinstance(bonus, int) else 0
    return math.floor((n or 0) * ((d or 0) + 1) / 2) + b


def dmg_text(p, word=True):
    w = ' damage' if word else ''
    if p['n'] and p['d']:
        b = p['b'] if isinstance(p['b'], int) else 0
        tail = (f' + {b}' if b > 0 else f' − {-b}' if b < 0 else '')
        return f"{avg(p['n'], p['d'], p['b'])} ({p['n']}d{p['d']}{tail}) {title(p['type'])}{w}"
    return f"{p['b']} {title(p['type'])}{w}"


def weapon_ability(ctx, item, act):
    a = (act.get('attack') or {}).get('ability')
    if a and a != 'none':
        return ctx.spell_abil if a == 'spellcasting' else a
    sysi = item['system']
    props = sysi.get('properties') or []
    atype = ((act.get('attack') or {}).get('type') or {}).get('value') or ''
    wtype = (sysi.get('type') or {}).get('value') or ''
    if item['type'] == 'spell' or (act.get('attack') or {}).get('type', {}).get('classification') == 'spell':
        return ctx.spell_abil
    if 'fin' in props: return 'str' if ctx.m['str'] >= ctx.m['dex'] else 'dex'
    if atype == 'ranged' or wtype.endswith('R'): return 'dex'
    return 'str'


def parse_parts(ctx, parts, m):
    out = []
    for p in parts or []:
        types = p.get('types') or []
        t = types[0] if types else ''
        if (p.get('custom') or {}).get('enabled') and p['custom'].get('formula'):
            f = re.sub(r'@mod', str(m), p['custom']['formula'])
            f = re.sub(r'@prof', str(ctx.pb), f)
            out.append({'n': 0, 'd': 0, 'b': f, 'type': t, 'f': f})
            continue
        n, d = p.get('number') or 0, p.get('denomination') or 0
        b = ctx.eval(p.get('bonus'), m)
        out.append({'n': n, 'd': d, 'b': b, 'type': t, 'f': dice_formula(n, d, b), 'types': types})
    return out


def activity_data(ctx, item, act):
    """Machine-readable summary of one Foundry activity."""
    t = act.get('type')
    out = {'type': t, 'name': act.get('name') or ''}
    acti = act.get('activation') or {}
    out['time'] = acti.get('type') or ''
    if acti.get('value'): out['cost'] = acti['value']
    if acti.get('condition'): out['trigger'] = acti['condition']
    tmpl = ((act.get('target') or {}).get('template') or {})
    if tmpl.get('type') and tmpl.get('size'):
        shape = {'cone': 'cone', 'sphere': 'circle', 'radius': 'circle', 'cylinder': 'circle', 'emanation': 'circle', 'line': 'line', 'cube': 'cube', 'square': 'cube', 'wall': 'line'}.get(tmpl['type'], tmpl['type'])
        out['area'] = {'shape': shape, 'size': int(float(tmpl['size'])), **({'width': int(float(tmpl['width']))} if tmpl.get('width') else {})}
    sysi = item['system']
    if t == 'attack':
        ab = weapon_ability(ctx, item, act)
        m = ctx.m[ab]
        atk = act.get('attack') or {}
        bonus = m + ctx.pb + (ctx.eval(atk.get('bonus'), m) if not isinstance(ctx.eval(atk.get('bonus'), m), str) else 0) + (sysi.get('magicalBonus') or 0)
        if atk.get('flat'): bonus = ctx.eval(atk.get('bonus'), m) if not isinstance(ctx.eval(atk.get('bonus'), m), str) else 0
        kind = (atk.get('type') or {}).get('value') or 'melee'
        rng = sysi.get('range') or act.get('range') or {}
        out['attack'] = {'bonus': bonus, 'kind': kind, 'spell': item['type'] == 'spell' or (atk.get('type') or {}).get('classification') == 'spell'}
        if rng.get('reach'): out['attack']['reach'] = rng['reach']
        if rng.get('value'): out['attack']['range'] = [int(float(rng['value'])), int(float(rng['long'])) if rng.get('long') else None]
        dmg = act.get('damage') or {}
        parts = []
        if dmg.get('includeBase', True) and (sysi.get('damage') or {}).get('base'):
            base = sysi['damage']['base']
            if base.get('number') and base.get('denomination'):
                b = m + (ctx.eval(base.get('bonus'), m) if not isinstance(ctx.eval(base.get('bonus'), m), str) else 0) + (sysi.get('magicalBonus') or 0)
                types = base.get('types') or []
                parts.append({'n': base['number'], 'd': base['denomination'], 'b': b, 'type': types[0] if types else '', 'types': types, 'f': dice_formula(base['number'], base['denomination'], b)})
            vers = sysi['damage'].get('versatile') or {}
            if vers.get('number') and vers.get('denomination') and 'ver' in (sysi.get('properties') or []):
                out['versatile'] = dice_formula(vers['number'], vers['denomination'], m + (sysi.get('magicalBonus') or 0))
        parts += parse_parts(ctx, dmg.get('parts'), m)
        out['damage'] = parts
    elif t == 'save':
        sv = act.get('save') or {}
        calc = (sv.get('dc') or {}).get('calculation') or ''
        if calc == 'spellcasting': dab = ctx.spell_abil
        elif calc in ABIL: dab = calc
        else: dab = None
        dc = 8 + ctx.m[dab] + ctx.pb if dab else ctx.eval((sv.get('dc') or {}).get('formula'), 0)
        m = ctx.m[dab] if dab else ctx.m[ctx.spell_abil]
        out['save'] = {'abil': sv.get('ability') or [], 'dc': dc}
        dmg = act.get('damage') or {}
        out['onSave'] = dmg.get('onSave') or 'half'
        out['damage'] = parse_parts(ctx, dmg.get('parts'), m)
    elif t == 'heal':
        h = act.get('healing') or {}
        m = ctx.m.get(weapon_ability(ctx, item, act), 0)
        b = ctx.eval(h.get('bonus'), m)
        out['heal'] = {'n': h.get('number') or 0, 'd': h.get('denomination') or 0, 'b': b, 'f': dice_formula(h.get('number'), h.get('denomination'), b)}
    elif t == 'damage':
        m = ctx.m.get(weapon_ability(ctx, item, act), 0)
        out['damage'] = parse_parts(ctx, (act.get('damage') or {}).get('parts'), m)
    # conditions applied
    eff_ids = [e.get('_id') for e in act.get('effects') or []]
    statuses = []
    for e in item.get('effects') or []:
        if e.get('_id') in eff_ids: statuses += e.get('statuses') or []
    if statuses: out['applies'] = sorted(set(statuses))
    return out


def uses_suffix(item):
    u = item['system'].get('uses') or {}
    rec = u.get('recovery') or []
    for r in rec:
        if r.get('period') == 'recharge':
            f = str(r.get('formula') or '6')
            return f' (Recharge {f}–6)' if f != '6' else ' (Recharge 6)'
    if u.get('max') and rec:
        per = rec[0].get('period')
        lbl = {'day': 'Day', 'lr': 'Day', 'sr': 'Short Rest', 'dawn': 'Day'}.get(per)
        if lbl and str(u['max']).isdigit(): return f' ({u["max"]}/{lbl})'
    return ''


def render_desc(ctx, item, text):
    acts = list((item['system'].get('activities') or {}).values())
    acts_by_id = {a.get('_id'): a for a in acts}
    first = lambda k: next((a for a in acts if a.get('type') == k), None)

    def attack_txt(_m):
        a = first('attack')
        if not a: return ''
        d = activity_data(ctx, item, a)['attack']
        kind = d['kind']
        lbl = 'Melee or Ranged' if kind == 'melee' and d.get('range') else 'Melee' if kind == 'melee' else 'Ranged'
        spell = ' Spell' if d.get('spell') else ''
        bits = []
        if kind == 'melee' or lbl.startswith('Melee'): bits.append(f"reach {d.get('reach') or 5} ft.")
        if d.get('range'): bits.append(f"range {d['range'][0]}{('/' + str(d['range'][1])) if d['range'][1] else ''} ft.")
        return f"<em>{lbl}{spell} Attack Roll:</em> {sign(d['bonus'])}, {' or '.join(bits)}".rstrip('.')

    def damage_txt(mm):
        args = mm.group(0)
        a = first('attack') or first('damage') or first('save')
        if not a: return ''
        d = activity_data(ctx, item, a)
        parts = d.get('damage') or []
        if not parts: return ''
        ext = 'extended' in args
        s = dmg_text(parts[0], ext)
        for p in parts[1:]: s += ' plus ' + dmg_text(p, ext)
        if d.get('versatile'): s += f", or {avg(*[int(x) for x in re.findall(r'\d+', d['versatile'])[:2]], 0) + ctx.m[weapon_ability(ctx, item, a)] if False else d['versatile']} with two hands"
        prefix = '<em>Hit:</em> ' if 'extended' in args and a.get('type') == 'attack' else ''
        return prefix + s

    def save_txt(mm):
        a = first('save')
        if not a: return ''
        d = activity_data(ctx, item, a)['save']
        ab = ' or '.join(ABIL_NAME[x] for x in d['abil']) or 'Saving'
        return f"<em>{ab} Saving Throw:</em> DC {d['dc']}"

    def heal_txt(mm):
        a = first('heal')
        if not a: return ''
        h = activity_data(ctx, item, a)['heal']
        b = h['b'] if isinstance(h['b'], int) else 0
        return f"{avg(h['n'], h['d'], h['b'])} ({h['n']}d{h['d']}{(' + ' + str(b)) if b > 0 else (' − ' + str(-b)) if b < 0 else ''})"

    def lookup(mm):
        expr, label = mm.group(1), mm.group(2)
        if expr.startswith('@name'): return ctx.name.lower() if 'lowercase' in expr else ctx.name
        if expr.startswith('@attributes.spell.dc'): return str(8 + ctx.m[ctx.spell_abil] + ctx.pb)
        if expr.startswith('@attributes.spell.attack'): return sign(ctx.m[ctx.spell_abil] + ctx.pb)
        m2 = re.match(r'@([\w.]+)(?: activity=(\w+))?', expr)
        if m2:
            path, aid = m2.group(1), m2.group(2)
            act = acts_by_id.get(aid) if aid else (acts[0] if acts else None)
            if path == 'save.dc.value' and act: return str(activity_data(ctx, item, act).get('save', {}).get('dc', ''))
            mm2 = re.match(r'skills\.(\w+)\.passive', path)
            if mm2:
                nm = SKILLS.get(mm2.group(1), ('', 'wis'))
                v = (ctx.d['system'].get('skills') or {}).get(mm2.group(1), {}).get('value') or 0
                return str(10 + ctx.m[nm[1]] + math.floor(ctx.pb * v))
            mm2 = re.match(r'abilities\.(\w+)\.mod', path)
            if mm2: return sign(ctx.m.get(mm2.group(1), 0))
            if path == 'item.level': return str(item['system'].get('level', ''))
            if act:
                cur = act
                for k in path.split('.'):
                    cur = cur.get(k) if isinstance(cur, dict) else None
                    if cur is None: break
                if cur not in (None, '') and not isinstance(cur, dict):
                    return str(cur)
        return label or ''

    t = text or ''
    t = re.sub(r'\[\[lookup ([^\]]+)\]\](?:\{([^}]*)\})?', lookup, t)
    t = re.sub(r'\[\[/attack[^\]]*\]\](?:\{[^}]*\})?', attack_txt, t)
    t = re.sub(r'\[\[/damage[^\]]*\]\](?:\{[^}]*\})?', damage_txt, t)
    t = re.sub(r'\[\[/save[^\]]*\]\](?:\{[^}]*\})?', save_txt, t)
    t = re.sub(r'\[\[/healing[^\]]*\]\](?:\{[^}]*\})?', heal_txt, t)
    t = re.sub(r'\[\[/item \.(\w+)\]\](?:\{([^}]*)\})?', lambda mm: mm.group(2) or (ctx.items.get(mm.group(1)) or {}).get('name', ''), t)
    t = re.sub(r'\[\[/item ([^\]]+)\]\](?:\{([^}]*)\})?', lambda mm: mm.group(2) or mm.group(1), t)
    t = re.sub(r'\[\[/check (\w+)(?: (\d+))?[^\]]*\]\](?:\{([^}]*)\})?', lambda mm: mm.group(3) or f"DC {mm.group(2)} {ABIL_NAME.get(mm.group(1), title(mm.group(1)))} check" if mm.group(2) else mm.group(1), t)
    t = re.sub(r'\[\[/r(?:oll)? ([^\]]+)\]\](?:\{([^}]*)\})?', lambda mm: mm.group(2) or mm.group(1).strip(), t)
    t = re.sub(r'\[\[/gmr ([^\]]+)\]\](?:\{([^}]*)\})?', lambda mm: mm.group(2) or mm.group(1).strip(), t)
    t = re.sub(r'\[\[(?:floor|ceil)?\(?([^\]]*)\)?\]\]', lambda mm: str(ctx.eval(mm.group(1))), t)
    t = re.sub(r'@UUID\[[^\]]*\]\{([^}]*)\}', r'\1', t)
    t = re.sub(r'@UUID\[[^\]]*\]', '', t)
    t = re.sub(r'&(?:amp;)?Reference\[([^\] ]+)[^\]]*\](?:\{([^}]*)\})?', lambda mm: mm.group(2) or title(mm.group(1)), t)
    t = re.sub(r'@Embed\[[^\]]*\](?:\{[^}]*\})?', '', t)
    t = re.sub(r'\s(class|style)="[^"]*"', '', t)
    t = re.sub(r'<(/?)(span|div|section)[^>]*>', '', t)
    t = t.replace(' .', '.').replace('..', '.')
    return t.strip()


def convert(d, src):
    ctx = Ctx(d)
    s = d['system']
    at, tr, det = s['attributes'], s['traits'], s['details']
    m, pb = ctx.m, ctx.pb
    # AC
    ac_d = at.get('ac') or {}
    calc = ac_d.get('calc')
    for e in d.get('effects') or []:
        if e.get('disabled'): continue
        for ch in (e.get('changes') or (e.get('system') or {}).get('changes') or []):
            if ch.get('key') == 'system.attributes.ac.calc': calc = ch.get('value')
            if ch.get('key') == 'system.attributes.ac.flat': ac_d = {**ac_d, 'flat': int(ch.get('value') or 10)}
    ac_note = ''
    armor_items = [it for it in d.get('items', []) if it['type'] == 'equipment' and it['system'].get('equipped') and (it['system'].get('type') or {}).get('value') in ('light', 'medium', 'heavy', 'shield')]
    if calc in ('flat', 'natural'): ac = ac_d.get('flat') or 10
    elif calc == 'mage': ac = 13 + m['dex']
    else:
        ac = 10 + m['dex']
        for it in armor_items:
            ty = it['system']['type']['value']; v = (it['system'].get('armor') or {}).get('value') or 0; mb = it['system'].get('magicalBonus') or 0
            if ty == 'light': ac = v + m['dex'] + mb
            elif ty == 'medium': ac = v + min(2, m['dex']) + mb
            elif ty == 'heavy': ac = v + mb
        for it in armor_items:
            if it['system']['type']['value'] == 'shield': ac += ((it['system'].get('armor') or {}).get('value') or 2) + (it['system'].get('magicalBonus') or 0)
    # init
    ib = ctx.eval((at.get('init') or {}).get('bonus'), 0)
    init = m['dex'] + (ib if isinstance(ib, int) else 0)
    # speed
    mv = at.get('movement') or {}
    sp = [f"{mv.get('walk') or 0} ft."]
    for k in ('burrow', 'climb', 'fly', 'swim'):
        if mv.get(k): sp.append(f"{k.title()} {mv[k]} ft.{' (hover)' if k == 'fly' and mv.get('hover') else ''}")
    # saves & skills
    saves = {a: m[a] + (pb if s['abilities'][a].get('proficient') else 0) for a in ABIL}
    save_prof = [a for a in ABIL if s['abilities'][a].get('proficient')]
    skills = {}
    for k, (nm, ab) in SKILLS.items():
        v = (s.get('skills') or {}).get(k, {}).get('value') or 0
        if v: skills[nm] = m[ab] + math.floor(pb * v)
    sen = (at.get('senses') or {}).get('ranges') or {}
    senses = [f"{k.title()} {v} ft." for k, v in sen.items() if v]
    pp = 10 + skills.get('Perception', m['wis'])
    langs = [title(x) if x != 'cant' else "Thieves' Cant" for x in (tr.get('languages') or {}).get('value') or []]
    if (tr.get('languages') or {}).get('custom'): langs.append(tr['languages']['custom'])
    lst = lambda k: [title(x) for x in (tr.get(k) or {}).get('value') or []] + ([tr[k]['custom']] if (tr.get(k) or {}).get('custom') else [])
    cr = ctx.cr
    size = SIZES.get(tr.get('size'), ('Medium', 1))
    typ = (det.get('type') or {}).get('value') or ''
    sub = (det.get('type') or {}).get('subtype') or ''
    sections = {'traits': [], 'actions': [], 'bonus': [], 'reactions': [], 'legendary': []}
    spells = []
    for it in d.get('items', []):
        sysi = it['system']
        if it['type'] == 'spell':
            spells.append(it['name']); continue
        if it['type'] == 'equipment' and (sysi.get('type') or {}).get('value') in ('light', 'medium', 'heavy', 'shield', 'clothing', 'trinket', ''):
            if not (sysi.get('activities') or {}): continue
        if it['type'] in ('loot', 'container', 'consumable', 'tool') and not sysi.get('activities'): continue
        acts = sorted((sysi.get('activities') or {}).values(), key=lambda a: a.get('sort') or 0)
        times = [((a.get('activation') or {}).get('type') or '') for a in acts]
        tm = next((x for x in times if x), '')
        sec = {'action': 'actions', 'bonus': 'bonus', 'reaction': 'reactions', 'legendary': 'legendary'}.get(tm, 'traits')
        if it['type'] == 'equipment' and sec == 'traits': continue
        desc = render_desc(ctx, it, (sysi.get('description') or {}).get('value') or '')
        if not desc and it['type'] == 'equipment': continue
        entry = {'name': it['name'] + uses_suffix(it), 'text': desc}
        auto = [activity_data(ctx, it, a) for a in acts if a.get('type') in ('attack', 'save', 'heal', 'damage')]
        if auto: entry['auto'] = auto
        u = sysi.get('uses') or {}
        if u.get('max') and str(u['max']).isdigit(): entry['uses'] = int(u['max'])
        if tm == 'legendary' and acts: entry['cost'] = (acts[0].get('activation') or {}).get('value') or 1
        sections[sec].append(entry)
    out = {
        'id': os.path.splitext(os.path.basename(src))[0],
        'name': d['name'], 'kind': 'npc',
        'size': size[0], 'squares': size[1], 'type': title(typ) + (f' ({sub})' if sub else ''), 'alignment': det.get('alignment') or '',
        'ac': ac, 'hp': {'max': (at.get('hp') or {}).get('max') or 1, 'formula': (at.get('hp') or {}).get('formula') or ''},
        'init': init, 'speed': ', '.join(sp), 'abilities': ctx.ab, 'saves': saves, 'saveProf': save_prof,
        'skills': skills, 'senses': '; '.join([', '.join(senses)] if senses else []) + ('; ' if senses else '') + f'Passive Perception {pp}',
        'languages': ', '.join(langs) or '—', 'resist': lst('dr'), 'immune': lst('di'), 'vuln': lst('dv'), 'condImmune': lst('ci'),
        'cr': cr, 'crText': cr_str(cr), 'xp': XP.get(cr, 0), 'pb': pb,
        'spellAbility': ctx.spell_abil, 'spellDC': 8 + m[ctx.spell_abil] + pb, 'spells': spells,
        **{k: v for k, v in sections.items() if v},
    }
    legact = (s.get('resources') or {}).get('legact') or {}
    if legact.get('max'): out['legendaryUses'] = legact['max']
    if (det.get('habitat') or {}).get('value'): out['habitat'] = [h.get('type') for h in det['habitat']['value']]
    return out


def main():
    src, dst = sys.argv[1], sys.argv[2]
    res = {}
    for f in sorted(glob.glob(os.path.join(src, '**', '*.yml'), recursive=True)):
        rel = os.path.relpath(f, src)
        if rel.split(os.sep)[0] in ('premades', 'summons', 'conjurations', 'companions', 'vehicles', 'magic-items'): continue
        d = yaml.safe_load(open(f))
        if not isinstance(d, dict) or d.get('type') != 'npc': continue
        try:
            a = convert(d, f)
            res[a['id']] = a
        except Exception as e:
            print('skip', rel, e, file=sys.stderr)
    json.dump(res, open(dst, 'w'), ensure_ascii=False, separators=(',', ':'))
    print(len(res), 'monsters ->', dst)


if __name__ == '__main__':
    main()
