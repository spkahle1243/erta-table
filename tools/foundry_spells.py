#!/usr/bin/env python3
"""Convert Foundry dnd5e 2024 SRD spells (YAML pack sources) to Erta Table's
compact spell format.

Usage: foundry_spells.py <dnd5e>/packs/_source/spells24 out.json
Source: SRD 5.2 (CC-BY-4.0) via the Foundry VTT dnd5e system (MIT).
"""
import sys, os, re, json, glob
import yaml

SCHOOL = dict(abj='Abjuration', con='Conjuration', div='Divination', enc='Enchantment', evo='Evocation', ill='Illusion', nec='Necromancy', trs='Transmutation')
ABIL = dict(str='Strength', dex='Dexterity', con='Constitution', int='Intelligence', wis='Wisdom', cha='Charisma')
TIME = dict(action='Action', bonus='Bonus Action', reaction='Reaction', minute='minute', hour='hour', special='Special')
SHAPE = {'cone': 'cone', 'sphere': 'circle', 'radius': 'circle', 'cylinder': 'circle', 'emanation': 'circle', 'line': 'line', 'cube': 'cube', 'square': 'cube', 'wall': 'line'}

def title(s): return s[:1].upper() + s[1:] if s else s

def parts_of(dmg):
    out = []
    for p in (dmg or {}).get('parts') or []:
        types = p.get('types') or []
        if (p.get('custom') or {}).get('enabled') and p['custom'].get('formula'):
            out.append({'f': p['custom']['formula'], 'type': types[0] if types else '', 'types': types}); continue
        n, d = int(p.get('number') or 0), int(p.get('denomination') or 0)
        b = str(p.get('bonus') or '')
        sc = p.get('scaling') or {}
        e = {'n': n, 'd': d, 'b': b, 'type': types[0] if types else '', 'types': types}
        if sc.get('mode'): e['scale'] = {'mode': sc['mode'], 'n': int(sc.get('number') or 1)}
        out.append(e)
    return out

def render(text):
    t = text or ''
    def dmg(m):
        return m.group(2) or 'damage'
    t = re.sub(r'\[\[/damage[^\]]*?(?:\s(\d+d\d+[^\]\s]*))?[^\]]*\]\](?:\{([^}]*)\})?', lambda m: m.group(2) or (m.group(1) or 'the damage'), t)
    t = re.sub(r'\[\[/save ([a-z]+)[^\]]*\]\](?:\{([^}]*)\})?', lambda m: m.group(2) or f'{ABIL.get(m.group(1), title(m.group(1)))} saving throw', t)
    t = re.sub(r'\[\[/save[^\]]*\]\](?:\{([^}]*)\})?', lambda m: m.group(1) or 'saving throw', t)
    t = re.sub(r'\[\[/(?:attack|heal|healing|check|skill|r|roll|item)[^\]]*\]\](?:\{([^}]*)\})?', lambda m: m.group(1) or '', t)
    t = re.sub(r'\[\[lookup [^\]]*\]\](?:\{([^}]*)\})?', lambda m: m.group(1) or '', t)
    t = re.sub(r'\[\[[^\]]*\]\](?:\{([^}]*)\})?', lambda m: m.group(1) or '', t)
    t = re.sub(r'@UUID\[[^\]]*\]\{([^}]*)\}', r'\1', t)
    t = re.sub(r'@UUID\[[^\]]*\]', '', t)
    t = re.sub(r'&(?:amp;)?Reference\[([^\] ]+)[^\]]*\](?:\{([^}]*)\})?', lambda m: m.group(2) or title(m.group(1)), t)
    t = re.sub(r'@Embed\[[^\]]*\](?:\{[^}]*\})?', '', t)
    t = re.sub(r'\s(class|style|data-[\w-]+)="[^"]*"', '', t)
    t = re.sub(r'<(/?)(span|div|section)[^>]*>', '', t)
    return t.strip()

CHANGE_MAP = {
    'system.bonuses.abilities.save': 'saveBonus',
    'system.bonuses.abilities.check': 'checkBonus',
    'system.bonuses.mwak.attack': 'attackBonus', 'system.bonuses.rwak.attack': 'attackBonus',
    'system.bonuses.msak.attack': 'attackBonus', 'system.bonuses.rsak.attack': 'attackBonus',
    'system.bonuses.mwak.damage': 'damageBonus', 'system.bonuses.rwak.damage': 'damageBonus',
    'system.attributes.ac.bonus': 'acBonus',
}

def effects_of(d):
    out = []
    for e in d.get('effects') or []:
        changes = e.get('changes') or (e.get('system') or {}).get('changes') or []
        mods = {}
        for ch in changes:
            k = CHANGE_MAP.get(ch.get('key'))
            if k and k not in mods: mods[k] = ch.get('value')
            if ch.get('key') == 'system.traits.dr.value': mods.setdefault('resist', []).append(ch.get('value'))
            if ch.get('key') == 'system.traits.di.value': mods.setdefault('immune', []).append(ch.get('value'))
            if ch.get('key') == 'system.traits.ci.value': mods.setdefault('condImmune', []).append(ch.get('value'))
        dur = e.get('duration') or {}
        out.append({'id': e.get('_id'), 'name': e.get('name'), 'mods': mods, 'statuses': e.get('statuses') or [],
                    'seconds': dur.get('value') if dur.get('units') == 'seconds' else None})
    return out

def convert(d, slug):
    s = d['system']
    act = s.get('activation') or {}
    dur = s.get('duration') or {}
    rng = s.get('range') or {}
    tgt = s.get('target') or {}
    tmpl = tgt.get('template') or {}
    props = s.get('properties') or []
    out = {
        'id': slug, 'name': d['name'], 'level': s.get('level', 0), 'school': SCHOOL.get(s.get('school'), s.get('school')),
        'time': (f"{act.get('value')} " if act.get('value') and act.get('type') in ('minute', 'hour') else '') + TIME.get(act.get('type'), act.get('type') or ''),
        'trigger': act.get('condition') or '',
        'range': ('Self' if rng.get('units') == 'self' else 'Touch' if rng.get('units') == 'touch' else f"{rng.get('value')} {rng.get('units')}" if rng.get('value') else title(rng.get('units') or '')),
        'duration': ('Instantaneous' if dur.get('units') == 'inst' else f"{dur.get('value')} {dur.get('units')}" if dur.get('value') else title(dur.get('units') or '')),
        'conc': 'concentration' in props, 'ritual': 'ritual' in props,
        'comp': ''.join(c for c, p in (('V', 'vocal'), ('S', 'somatic'), ('M', 'material')) if p in props),
        'material': (s.get('materials') or {}).get('value') or '',
        'text': render((s.get('description') or {}).get('value') or ''),
    }
    num = lambda v: int(float(v)) if re.fullmatch(r'[\d.]+', str(v)) else str(v)
    if tmpl.get('type') and tmpl.get('size'):
        out['area'] = {'shape': SHAPE.get(tmpl['type'], tmpl['type']), 'size': num(tmpl['size'])}
        if tmpl.get('width'): out['area']['width'] = num(tmpl['width'])
    count = (tgt.get('affects') or {}).get('count')
    if count: out['targets'] = str(count)
    effects = effects_of(d)
    eff_by = {e['id']: e for e in effects}
    auto = []
    for a in sorted((s.get('activities') or {}).values(), key=lambda a: a.get('sort') or 0):
        t = a.get('type')
        e = {'type': t}
        if a.get('name'): e['name'] = a['name']
        at = (a.get('activation') or {})
        if at.get('override') and at.get('type'): e['time'] = TIME.get(at['type'], at['type'])
        if t == 'attack':
            ty = ((a.get('attack') or {}).get('type') or {}).get('value') or 'ranged'
            e['attack'] = {'kind': ty, 'spell': True}
            e['damage'] = parts_of(a.get('damage'))
        elif t == 'save':
            sv = a.get('save') or {}
            ab = sv.get('ability')
            e['save'] = {'abil': ab if isinstance(ab, list) else [ab] if ab else []}
            e['onSave'] = (a.get('damage') or {}).get('onSave') or 'half'
            e['damage'] = parts_of(a.get('damage'))
        elif t == 'heal':
            h = a.get('healing') or {}
            sc = h.get('scaling') or {}
            e['heal'] = {'n': int(h.get('number') or 0), 'd': int(h.get('denomination') or 0), 'b': str(h.get('bonus') or ''), 'type': ((h.get('types') or ['healing']) + ['healing'])[0]}
            if sc.get('mode'): e['heal']['scale'] = {'mode': sc['mode'], 'n': int(sc.get('number') or 1)}
        elif t == 'damage':
            e['damage'] = parts_of(a.get('damage'))
        elif t not in ('utility', 'cast', 'summon', 'enchant', 'forward', 'transform'):
            continue
        effs = [eff_by[x['_id']] for x in a.get('effects') or [] if x.get('_id') in eff_by]
        if effs: e['effects'] = [x['id'] for x in effs]
        if e.get('damage') == []: e.pop('damage')
        if t in ('utility', 'cast', 'summon', 'enchant', 'forward', 'transform') and not e.get('effects'): continue
        auto.append(e)
    if auto: out['auto'] = auto
    if effects: out['effects'] = effects
    return out

ABIL_WORD = {'Strength': 'str', 'Dexterity': 'dex', 'Constitution': 'con', 'Intelligence': 'int', 'Wisdom': 'wis', 'Charisma': 'cha'}
def fix_saves(sp):
    # a few spells leave the save ability blank in the source; read it from the text
    for a in sp.get('auto') or []:
        if a.get('type') == 'save' and not a['save'].get('abil'):
            m = re.search(r'(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) saving throw', sp.get('text', ''))
            if m: a['save']['abil'] = [ABIL_WORD[m.group(1)]]

def main(src, dst):
    res = {}
    for f in sorted(glob.glob(os.path.join(src, '**', '*.yml'), recursive=True)):
        d = yaml.safe_load(open(f))
        if not isinstance(d, dict) or d.get('type') != 'spell': continue
        slug = os.path.splitext(os.path.basename(f))[0]
        try: res[slug] = convert(d, slug)
        except Exception as e: print('skip', f, e, file=sys.stderr); continue
        fix_saves(res[slug])
    json.dump(res, open(dst, 'w'), ensure_ascii=False, separators=(',', ':'))
    print(len(res), 'spells ->', dst)

if __name__ == '__main__':
    main(*sys.argv[1:3])
