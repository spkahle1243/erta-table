#!/usr/bin/env python3
"""Turn a session prep page (built from the DM's one-shot / session template)
into an Erta Table session pack.

    prep_to_pack.py <session.html> <case.config.json> <srd-monsters.json> <out.json>

The page supplies the prose (overview, scenes, read-alouds, checks, NPC cards),
its own styles, and every art / battle-map / soundtrack / portrait prompt and
handout. The config supplies what the page can't express as data: monster
reskins, encounters and clocks.
"""
import sys, re, json, copy
from bs4 import BeautifulSoup, NavigableString

def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')[:48]

# --------------------------------------------------------------- CSS scoping
def split_rules(css):
    """Yield (prelude, body) for top-level blocks, handling nested braces."""
    i, n = 0, len(css)
    while i < n:
        j = css.find('{', i)
        if j < 0: break
        prelude = css[i:j].strip()
        depth, k = 1, j + 1
        while k < n and depth:
            if css[k] == '{': depth += 1
            elif css[k] == '}': depth -= 1
            k += 1
        yield prelude, css[j + 1:k - 1]
        i = k

def scope_selector(sel, root):
    out = []
    for s in sel.split(','):
        s = s.strip()
        if not s: continue
        if s in (':root', 'html', 'body', ':root[data-theme="dark"]', ':root:not([data-theme="light"])'): out.append(root); continue
        if s.startswith(':root'): s = s.replace(':root', '', 1).strip() or root
        if s.startswith('html') or s.startswith('body'): s = s.split(' ', 1)[1] if ' ' in s else ''
        out.append(f'{root} {s}'.strip() if s else root)
    return ', '.join(dict.fromkeys(out))

def scope_css(css, root='.prep-doc'):
    css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
    base, dark, rest = [], [], []
    for pre, body in split_rules(css):
        if pre.startswith('@media') and 'prefers-color-scheme' in pre:
            for p2, b2 in split_rules(body): dark.append(f'{root}{{{b2}}}')
        elif pre.startswith('@media') or pre.startswith('@supports'):
            inner = ''.join(f'{scope_selector(p2, root)}{{{b2}}}' for p2, b2 in split_rules(body))
            rest.append(f'{pre}{{{inner}}}')
        elif pre.startswith('@'):
            rest.append(f'{pre}{{{body}}}')
        elif pre.startswith(':root[data-theme="dark"]'):
            dark.append(f'{root}{{{body}}}')
        else:
            base.append(f'{scope_selector(pre, root)}{{{body}}}')
    # The table is always dark: dark tokens override the light ones.
    return '\n'.join(base + dark + rest)

# --------------------------------------------------------------- page parsing
def text_with_breaks(node):
    out = []
    for el in node.descendants:
        if isinstance(el, NavigableString):
            if el.parent.name in ('script', 'style'): continue
            if el.parent.get('class') and 'hl' in el.parent.get('class'): continue
            out.append(re.sub(r'\s+', ' ', str(el)))
        elif el.name == 'br': out.append('\n')
    t = ''.join(out)
    t = re.sub(r'[ \t]+', ' ', t)
    t = re.sub(r' *\n *', '\n', t)
    return t.strip()

def main(page_path, cfg_path, srd_path, out_path):
    html = open(page_path, encoding='utf-8').read()
    cfg = json.load(open(cfg_path, encoding='utf-8'))
    srd = json.load(open(srd_path, encoding='utf-8'))
    soup = BeautifulSoup(html, 'lxml')

    css = '\n'.join(s.get_text() for s in soup.find_all('style'))
    for tag in soup.find_all(['script', 'style', 'link', 'title']): tag.decompose()
    nav = soup.find('nav', class_='rail')
    if nav: nav.decompose()
    for b in soup.select('button.fx'): b.decompose()
    for f in soup.select('.fx-row, .fx-inline'):
        if not f.get_text(strip=True): f.decompose()

    mast = soup.select_one('header.mast')
    title = mast.find('h1').get_text(strip=True) if mast else cfg.get('title', 'Session')
    eyebrow = mast.select_one('.eyebrow').get_text(strip=True) if mast and mast.select_one('.eyebrow') else ''
    sub = mast.select_one('.sub').get_text(strip=True) if mast and mast.select_one('.sub') else ''

    scenes, music, handouts, portraits = [], [], [], []
    seen_keys = set()
    def ukey(base):
        k, n = base, 2
        while k in seen_keys: k = f'{base}-{n}'; n += 1
        seen_keys.add(k); return k

    section_nodes = []
    if mast: section_nodes.append(('overview', 'Overview', '§', mast, None))
    prep = soup.select_one('section#prep')
    if prep: section_nodes.append(('prep', 'Before the session', '§', prep, mast))
    for sec in soup.select('section.scene'):
        num = sec.select_one('.scene-num').get_text(strip=True) if sec.select_one('.scene-num') else ''
        h2 = sec.select_one('.scene-head h2')
        section_nodes.append((sec.get('id') or slug(h2.get_text()), h2.get_text(strip=True) if h2 else sec.get('id'), num, sec, None))

    sections = []
    for sid, stitle, num, node, _ in section_nodes:
        # prompts
        for d in node.select('details.art'):
            summ = d.find('summary')
            label_el = summ.find('span') if summ else None
            label = label_el.get_text(strip=True) if label_el else ''
            p = d.select_one('.artp')
            prompt = p.get_text(' ', strip=True) if p else ''
            if 'leads' in d.get('class', []): continue
            if 'music' in d.get('class', []):
                name = re.sub(r'^Soundtrack prompt\s*·\s*', '', label)
                kind = 'music'
                key = ukey('m-' + slug(name))
                music.append({'key': key, 'name': name, 'kind': kind, 'prompt': prompt, 'section': sid, 'combat': name.lower().startswith('combat loop'), 'cue': name.lower().startswith('cue')})
                d['data-music'] = key
            elif 'map' in d.get('class', []):
                m = re.search(r'\((\d+)\s*[×x]\s*(\d+)\s*squares\)', label)
                name = re.sub(r'^Battle map prompt\s*·\s*', '', label)
                name = re.sub(r'\s*\(\d+\s*[×x]\s*\d+\s*squares\)', '', name).strip()
                key = ukey('map-' + slug(name))
                scenes.append({'key': key, 'name': name + ' (battle map)', 'kind': 'map', 'section': sid, 'squares': [int(m.group(1)), int(m.group(2))] if m else None, 'prompt': prompt})
                d['data-scene'] = key
            elif label.startswith('Portrait prompt'):
                name = re.sub(r'^Portrait prompt\s*·\s*', '', label)
                name = re.sub(r'\s*\(.*\)$', '', name)
                portraits.append({'name': name, 'prompt': prompt, 'section': sid})
            elif label.startswith('Art prompt'):
                name = re.sub(r'^Art prompt\s*·\s*', '', label).replace('&amp;', '&')
                key = ukey('art-' + slug(name))
                scenes.append({'key': key, 'name': name, 'kind': 'art', 'section': sid, 'prompt': prompt})
                d['data-scene'] = key
        # handouts
        for h in node.select('.handout'):
            hl = h.select_one('.hl')
            htitle = re.sub(r'^Handout\s*·\s*', '', hl.get_text(strip=True)) if hl else 'Handout'
            key = ukey('h-' + slug(htitle))
            handouts.append({'key': key, 'title': htitle[:1].upper() + htitle[1:], 'text': text_with_breaks(h), 'style': 'ledger' if 'ledger' in h.get('class', []) else 'paper', 'section': sid})
            h['data-handout'] = key
        sections.append({'id': sid, 'title': stitle, 'num': num, 'node': node})

    # Clock containers
    for cid in ('dawnclock', 'clocks'):
        el = soup.find(id=cid)
        if el: el['data-clocks'] = cfg.get('clockContainers', {}).get(cid, cid)

    # Encounter anchors
    for enc in cfg.get('encounters', []):
        target = soup.select_one(enc['anchor']) if enc.get('anchor') else None
        if target is None:
            print('warning: no anchor for encounter', enc['key'], file=sys.stderr); continue
        marker = soup.new_tag('div'); marker['class'] = 'pack-enc'; marker['data-encounter'] = enc['key']
        target.insert_after(marker)

    # Scene defaults: music for art scenes, combat loop for battle maps (same section)
    for s in scenes:
        same = [m for m in music if m['section'] == s['section']]
        if s['kind'] == 'map':
            loop = next((m for m in same if m['combat']), None) or next((m for m in same if not m['cue']), None)
            if loop: s['music'] = loop['key']
        else:
            first = next((m for m in same if not m['combat'] and not m['cue']), None)
            if first: s['music'] = first['key']
    for s in scenes:
        s.update(cfg.get('sceneOverrides', {}).get(s['key'], {}))

    # Actors: SRD bases with reskins, or fully custom
    actors = {}
    for key, a in cfg.get('actors', {}).items():
        if a.get('base'):
            base = copy.deepcopy(srd[a['base']])
            for k, v in a.get('set', {}).items(): base[k] = v
            for sec, entries in a.get('add', {}).items(): base.setdefault(sec, []).extend(entries)
            for sec, names in a.get('remove', {}).items(): base[sec] = [e for e in base.get(sec, []) if e['name'] not in names]
            base['name'] = a.get('name', base['name'])
            base['srd'] = a['base']
            if a.get('notes'): base['notes'] = a['notes']
            actors[key] = base
        else:
            actors[key] = a['actor']
        actors[key]['id'] = key

    out_sections = [{'id': s['id'], 'title': s['title'], 'num': s['num'], 'html': str(s['node'])} for s in sections]
    pack = {
        'format': 'erta-table-pack', 'version': 1,
        'id': cfg['id'], 'title': title, 'eyebrow': eyebrow, 'subtitle': sub,
        'series': cfg.get('series', 'erta'), 'built': cfg.get('built', ''),
        'css': scope_css(css),
        'sections': out_sections,
        'scenes': scenes, 'music': music, 'handouts': handouts, 'portraits': portraits,
        'actors': actors, 'encounters': cfg.get('encounters', []), 'clocks': cfg.get('clocks', []),
        'styleLocks': cfg.get('styleLocks', {}),
    }
    json.dump(pack, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print(f"{title}: {len(out_sections)} sections, {len(scenes)} scenes, {len(music)} tracks, {len(handouts)} handouts, {len(portraits)} portraits, {len(actors)} actors, {len(pack['encounters'])} encounters -> {out_path}")

if __name__ == '__main__':
    main(*sys.argv[1:5])
