// Short animations for areas: a Fireball blooms, Thunderwave rings out, Cloudkill rolls in.
// Drawn on the map canvas, clipped to the area's shape, about a second and a half long.

const PAL = {
  fire: { core: '#FFF4C2', mid: '#FF9A2E', edge: '#C2310F', parts: '#FFC861', style: 'bloom' },
  cold: { core: '#FFFFFF', mid: '#A9E2FF', edge: '#3D8CC4', parts: '#E8F8FF', style: 'shards' },
  lightning: { core: '#FFFFFF', mid: '#BFD8FF', edge: '#5B7CFF', parts: '#FFFFFF', style: 'bolts' },
  thunder: { core: '#F2F6FF', mid: '#9DB7E6', edge: '#4A63A8', parts: '#DDE7FF', style: 'rings' },
  acid: { core: '#E9FFB0', mid: '#9BDB2E', edge: '#4F7D0E', parts: '#C8F56A', style: 'bubbles' },
  poison: { core: '#D8F7A8', mid: '#6FAF3C', edge: '#2E5A21', parts: '#A6D86E', style: 'cloud' },
  necrotic: { core: '#C9A8FF', mid: '#5B2C8C', edge: '#1A0B2B', parts: '#9C6BE0', style: 'cloud' },
  radiant: { core: '#FFFFFF', mid: '#FFE38A', edge: '#E0A526', parts: '#FFF1B8', style: 'rays' },
  force: { core: '#F3E8FF', mid: '#B79CFF', edge: '#6A47D9', parts: '#E2D4FF', style: 'rings' },
  psychic: { core: '#FFE8FA', mid: '#FF8AD8', edge: '#A3368B', parts: '#FFC4EE', style: 'rings' },
  bludgeoning: { core: '#E9DCC6', mid: '#A88A62', edge: '#5B4630', parts: '#CDB894', style: 'dust' },
  piercing: { core: '#F2F2F2', mid: '#B9C2C7', edge: '#5F6B72', parts: '#E3E8EA', style: 'shards' },
  slashing: { core: '#F2F2F2', mid: '#C7B9B9', edge: '#6B5050', parts: '#EFE3E3', style: 'shards' },
  arcane: { core: '#FFFFFF', mid: '#9FD6C2', edge: '#2B7A61', parts: '#D7FFF0', style: 'rings' },
};
export const FX_KINDS = Object.keys(PAL);

// What an area looks like, from its damage type or its name.
export function fxKindFor(entry = {}, act = {}) {
  const t = (act.damage?.[0]?.type || act.damage?.[0]?.types?.[0] || '').toLowerCase();
  if (PAL[t]) return t;
  const n = `${entry.name || ''} ${entry.id || ''}`.toLowerCase();
  if (/fire|flame|burn|inferno|blast/.test(n)) return 'fire';
  if (/ice|frost|cold|sleet|snow/.test(n)) return 'cold';
  if (/lightning|storm|shock/.test(n)) return 'lightning';
  if (/thunder|shatter|boom/.test(n)) return 'thunder';
  if (/acid/.test(n)) return 'acid';
  if (/poison|stinking|cloudkill|toxic|spore/.test(n)) return 'poison';
  if (/necro|blight|death|shadow|darkness/.test(n)) return 'necrotic';
  if (/radiant|sun|light|daylight|guardian|sacred/.test(n)) return 'radiant';
  if (/psychic|mind|fear|laughter/.test(n)) return 'psychic';
  if (/web|grease|entangle|plant|spike/.test(n)) return 'bludgeoning';
  return 'arcane';
}

// a tiny seeded random, so every screen draws the same sparks
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

export function makeFx(tpl, kind, L, now = performance.now()) {
  const seed = Math.floor((tpl.x * 73856093) ^ (tpl.y * 19349663) ^ (L * 83492791)) >>> 0;
  const r = rng(seed);
  const parts = Array.from({ length: 46 }, () => ({ a: r() * Math.PI * 2, d: 0.2 + r() * 0.85, s: 0.4 + r() * 0.9, w: r() }));
  return { tpl, kind: PAL[kind] ? kind : 'arcane', L, t0: now, dur: kind === 'poison' || kind === 'necrotic' ? 2100 : 1500, parts, seed };
}

const easeOut = p => 1 - Math.pow(1 - p, 3);

// origin and reach of the animation for each shape
function frame(tpl, L) {
  if (tpl.shape === 'cube') return { ox: tpl.x + L / 2, oy: tpl.y + L / 2, R: L * 0.75, dir: null };
  if (tpl.shape === 'circle') return { ox: tpl.x, oy: tpl.y, R: L, dir: null };
  return { ox: tpl.x, oy: tpl.y, R: L, dir: tpl.dir || 0, cone: tpl.shape === 'cone' };
}

// pathFn(c, tpl) traces the area's outline (so the effect is clipped to it).
export function drawFx(c, fx, now, pathFn) {
  const p = Math.min(1, (now - fx.t0) / fx.dur);
  if (p >= 1) return false;
  const P = PAL[fx.kind], { ox, oy, R, dir } = frame(fx.tpl, fx.L);
  const grow = easeOut(Math.min(1, p / 0.45));
  const fade = p < 0.55 ? 1 : 1 - (p - 0.55) / 0.45;
  const pt = (part, reach) => {
    if (dir == null) return [ox + Math.cos(part.a) * part.d * reach, oy + Math.sin(part.a) * part.d * reach];
    const spread = fx.tpl.shape === 'cone' ? (part.w - 0.5) * 1.0 : (part.w - 0.5) * 0.12;
    const a = dir + spread, d = part.d * reach;
    return [ox + Math.cos(a) * d, oy + Math.sin(a) * d];
  };
  c.save();
  pathFn(c, fx.tpl); c.clip();
  c.globalCompositeOperation = 'lighter';
  const reach = R * (0.15 + 0.95 * grow);
  // the main wash
  const g = c.createRadialGradient(ox, oy, 0, ox, oy, Math.max(1, reach));
  g.addColorStop(0, P.core); g.addColorStop(0.35, P.mid); g.addColorStop(1, 'rgba(0,0,0,0)');
  c.globalAlpha = 0.85 * fade * (P.style === 'cloud' ? 0.7 : 1);
  c.fillStyle = g; c.fillRect(ox - R * 1.6, oy - R * 1.6, R * 3.2, R * 3.2);
  c.globalAlpha = fade;
  switch (P.style) {
    case 'bloom': case 'dust': {
      for (const q of fx.parts) {
        const [x, y] = pt(q, R * (0.2 + 1.0 * easeOut(p)));
        const rad = (P.style === 'dust' ? 0.09 : 0.035) * R * q.s * (1 - p * 0.5);
        c.fillStyle = P.parts; c.globalAlpha = fade * (0.5 + 0.5 * Math.sin(now / 60 + q.a * 9));
        c.beginPath(); c.arc(x, y, Math.max(1, rad), 0, 7); c.fill();
      }
      break;
    }
    case 'rings': {
      c.strokeStyle = P.parts; c.lineWidth = Math.max(2, R * 0.04);
      for (let i = 0; i < 3; i++) {
        const q = Math.min(1, Math.max(0, p * 1.4 - i * 0.18));
        if (q <= 0) continue;
        c.globalAlpha = (1 - q) * 0.9;
        c.beginPath(); c.arc(ox, oy, Math.max(1, R * easeOut(q)), 0, 7); c.stroke();
      }
      break;
    }
    case 'shards': {
      c.strokeStyle = P.parts; c.lineWidth = Math.max(1.5, R * 0.015);
      for (const q of fx.parts) {
        const [x1, y1] = pt(q, R * 0.15 * grow), [x2, y2] = pt(q, R * (0.25 + 0.8 * easeOut(p)) * q.s);
        c.globalAlpha = fade * 0.9; c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
      }
      break;
    }
    case 'bolts': {
      const r = rng(fx.seed + Math.floor(now / 70));
      c.strokeStyle = P.core; c.lineWidth = Math.max(2, R * 0.02); c.shadowColor = P.edge; c.shadowBlur = 18;
      for (let b = 0; b < 5; b++) {
        const q = fx.parts[b * 7 % fx.parts.length];
        const [tx, ty] = pt(q, R * (0.6 + 0.4 * q.s));
        c.globalAlpha = fade * (r() > 0.25 ? 1 : 0.3);
        c.beginPath(); c.moveTo(ox, oy);
        for (let s = 1; s <= 7; s++) { const f = s / 7; c.lineTo(ox + (tx - ox) * f + (r() - 0.5) * R * 0.12, oy + (ty - oy) * f + (r() - 0.5) * R * 0.12); }
        c.stroke();
      }
      break;
    }
    case 'rays': {
      c.fillStyle = P.parts;
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2 + p * 0.6, w = 0.06;
        c.globalAlpha = fade * 0.55;
        c.beginPath(); c.moveTo(ox, oy); c.arc(ox, oy, reach * 1.1, a - w, a + w); c.closePath(); c.fill();
      }
      break;
    }
    case 'bubbles': case 'cloud': {
      for (const q of fx.parts) {
        const [x, y] = pt(q, R * (0.15 + 0.85 * grow));
        const rad = R * (P.style === 'cloud' ? 0.16 : 0.05) * q.s * (0.6 + 0.4 * grow);
        const gg = c.createRadialGradient(x, y - p * R * 0.1, 0, x, y - p * R * 0.1, Math.max(1, rad));
        gg.addColorStop(0, P.parts); gg.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = gg; c.globalAlpha = fade * 0.7;
        c.beginPath(); c.arc(x, y - p * R * 0.1, Math.max(1, rad), 0, 7); c.fill();
      }
      break;
    }
  }
  // a bright flash at the start
  if (p < 0.12) { c.globalAlpha = (1 - p / 0.12) * 0.6; c.fillStyle = P.core; c.fillRect(ox - R * 1.6, oy - R * 1.6, R * 3.2, R * 3.2); }
  c.restore();
  return true;
}
