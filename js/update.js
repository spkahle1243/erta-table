// Spot a newer version of the site and offer to load it. Browsers keep the code they
// downloaded for a while; a plain reload can bring back the old version, so this
// refetches every file fresh before reloading.
import { VERSION } from './version.js';
import { el } from './util.js';

async function latest() {
  try { const r = await fetch(new URL('../version.json', import.meta.url), { cache: 'no-store' }); return r.ok ? r.json() : null; } catch { return null; }
}

export async function refreshAndReload(files) {
  const base = new URL('../', import.meta.url);
  await Promise.all((files || []).map(f => fetch(new URL(f, base), { cache: 'reload' }).catch(() => {})));
  location.reload();
}

export function watchForUpdates({ every = 5 * 60 * 1000 } = {}) {
  const check = async () => {
    const v = await latest();
    if (!v || v.version === VERSION || document.getElementById('update-bar')) return;
    const bar = el('div', { class: 'update-bar', id: 'update-bar', role: 'status' },
      el('span', {}, 'A new version of Erta Table is ready.'),
      el('button', { class: 'btn small primary', type: 'button', onclick: e => { e.target.disabled = true; e.target.textContent = 'Loading…'; refreshAndReload(v.files); } }, 'Load it now'),
      el('button', { class: 'btn small ghost', type: 'button', onclick: () => bar.remove() }, 'Later'));
    document.body.append(bar);
  };
  setTimeout(check, 3000);
  setInterval(check, every);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}
export { VERSION };
