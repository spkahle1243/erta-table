#!/usr/bin/env python3
"""Stamp the build: js/version.js (what the running code thinks it is) and version.json
(what the site is now). Open tabs compare the two and offer a reload when they differ.
Run before each commit: python3 tools/stamp_version.py"""
import hashlib, json, os, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
files = sorted(['index.html', 'play.html', 'companion.html', 'image-kit.html', 'config.js', 'css/table.css', 'css/companion.css']
               + ['js/' + f for f in os.listdir(os.path.join(ROOT, 'js')) if f.endswith('.js') and f != 'version.js'])
h = hashlib.sha256()
for f in files: h.update(open(os.path.join(ROOT, f), 'rb').read())
v = time.strftime('%Y-%m-%d %H:%M', time.gmtime()) + ' ' + h.hexdigest()[:8]
open(os.path.join(ROOT, 'js/version.js'), 'w').write(f"// Written by tools/stamp_version.py. Compared with version.json to spot a newer site.\nexport const VERSION = '{v}';\n")
json.dump({'version': v, 'files': files + ['js/version.js']}, open(os.path.join(ROOT, 'version.json'), 'w'), indent=1)
print(v)
