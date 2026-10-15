#!/usr/bin/env python3
"""Build character sheets for the table from tools/chars/*.json + SRD 2024 spells.

    build_sheets.py tools/chars data/srd-spells-2024.json data/sheets
"""
import sys, os, json, glob

def main(src, spells_path, out_dir):
    spells = json.load(open(spells_path, encoding='utf-8'))
    index = []
    for f in sorted(glob.glob(os.path.join(src, '*.json'))):
        c = json.load(open(f, encoding='utf-8'))
        resolved = []
        for s in c.get('spells', []):
            if isinstance(s, str): s = {'id': s}
            if 'custom' in s:
                base = dict(c['customSpells'][s['custom']]); base['id'] = s['custom']
            else:
                if s['id'] not in spells: raise SystemExit(f"{c['name']}: unknown spell {s['id']}")
                base = dict(spells[s['id']])
            for k in ('always', 'prepared', 'pact', 'ritualOnly', 'atWill'):
                if s.get(k): base[k] = True
            resolved.append(base)
        c['spells'] = resolved
        c.pop('customSpells', None)
        c['level'] = sum(k['level'] for k in c['classes'])
        c['format'] = 'erta-table-sheet'; c['version'] = 1
        json.dump(c, open(os.path.join(out_dir, c['id'] + '.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
        index.append({'id': c['id'], 'name': c['name'], 'player': c.get('player', ''), 'series': c.get('series', ''), 'file': c['id'] + '.json',
                      'summary': ' / '.join(f"{k['name']} ({k['sub']}) {k['level']}" for k in c['classes'])})
        print(f"{c['name']}: {len(resolved)} spells, {len(c.get('actions', []))} actions, {len(c.get('resources', []))} resources")
    json.dump(index, open(os.path.join(out_dir, 'index.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

if __name__ == '__main__':
    main(*sys.argv[1:4])
