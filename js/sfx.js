// Built-in sound effects, synthesized on the spot with Web Audio: no files to find,
// nothing to download, and every player's browser makes the same sound.

export const SYNTHS = [
  ['thunder', 'Thunder'], ['explosion', 'Explosion'], ['clash', 'Sword clash'], ['arrow', 'Arrow'],
  ['door', 'Creaking door'], ['bell', 'Bell'], ['magic', 'Magic'], ['heartbeat', 'Heartbeat'],
  ['drums', 'War drums'], ['wind', 'Wind'], ['roar', 'Roar'], ['splash', 'Splash'],
  ['coins', 'Coins'], ['fire', 'Fire burst'], ['rumble', 'Rumble'], ['gong', 'Gong'],
];
export const synthName = k => SYNTHS.find(s => s[0] === k)?.[1] || k;

let noiseBuf = null;
function noise(ctx) {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  const len = ctx.sampleRate * 4;
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}
function brown(ctx) {
  const len = ctx.sampleRate * 5, b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
  return b;
}
let brownBuf = null;

// envelope helper: gain node that rises in `a` seconds to `peak`, then decays to silence by `t + dur`
function env(ctx, t, { a = 0.005, peak = 1, dur = 1, curve = 'exp' } = {}) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  if (curve === 'exp') g.gain.exponentialRampToValueAtTime(0.0001, t + a + dur);
  else g.gain.linearRampToValueAtTime(0, t + a + dur);
  return g;
}
function src(ctx, buf, t, dur, rate = 1) { const s = ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate; s.loop = true; s.start(t, Math.random() * 2); s.stop(t + dur + 0.1); return s; }
function osc(ctx, type, f, t, dur) { const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); o.start(t); o.stop(t + dur + 0.1); return o; }
function filt(ctx, type, f, q = 1) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
const chain = (...n) => { for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]); return n[n.length - 1]; };

export function playSynth(ctx, out, key, vol = 1) {
  const t = ctx.currentTime + 0.02;
  const master = ctx.createGain(); master.gain.value = vol; master.connect(out);
  const N = noise(ctx);
  const B = (brownBuf && brownBuf.sampleRate === ctx.sampleRate) ? brownBuf : (brownBuf = brown(ctx));
  const hit = (when, f0, f1, dur, peak = 1, type = 'sine') => {
    const o = osc(ctx, type, f0, when, dur); o.frequency.exponentialRampToValueAtTime(f1, when + dur);
    chain(o, env(ctx, when, { dur, peak }), master);
  };
  const burst = (when, dur, type, f, peak = 1, q = 1, rate = 1) => chain(src(ctx, N, when, dur, rate), filt(ctx, type, f, q), env(ctx, when, { dur, peak }), master);
  switch (key) {
    case 'thunder': {
      burst(t, 0.25, 'highpass', 1500, 0.5);
      const f = filt(ctx, 'lowpass', 900); f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(90, t + 3);
      chain(src(ctx, B, t, 3.6), f, env(ctx, t, { a: 0.05, dur: 3.4, peak: 1.6 }), master);
      chain(src(ctx, B, t + 0.6, 2.6, 0.7), filt(ctx, 'lowpass', 220), env(ctx, t + 0.6, { a: 0.3, dur: 2.4, peak: 1.2 }), master);
      break;
    }
    case 'explosion': {
      hit(t, 120, 30, 1.2, 1.4);
      const f = filt(ctx, 'lowpass', 2500); f.frequency.setValueAtTime(2500, t); f.frequency.exponentialRampToValueAtTime(120, t + 1.6);
      chain(src(ctx, N, t, 1.8), f, env(ctx, t, { dur: 1.7, peak: 1.3 }), master);
      chain(src(ctx, B, t + 0.1, 2.5), filt(ctx, 'lowpass', 160), env(ctx, t + 0.1, { a: 0.1, dur: 2.2, peak: 1 }), master);
      break;
    }
    case 'clash': {
      for (const [f, p] of [[1180, 0.5], [1870, 0.35], [2640, 0.3], [3410, 0.22], [4990, 0.15]]) chain(osc(ctx, 'sine', f, t, 1.4), env(ctx, t, { dur: 1.3 + Math.random() * 0.3, peak: p }), master);
      burst(t, 0.08, 'highpass', 3000, 0.9);
      break;
    }
    case 'arrow': {
      const f = filt(ctx, 'bandpass', 4000, 3); f.frequency.setValueAtTime(5000, t); f.frequency.exponentialRampToValueAtTime(900, t + 0.45);
      chain(src(ctx, N, t, 0.5), f, env(ctx, t, { a: 0.05, dur: 0.42, peak: 1.1 }), master);
      hit(t + 0.47, 180, 60, 0.18, 1.1, 'triangle');
      burst(t + 0.47, 0.06, 'bandpass', 1800, 0.6, 2);
      break;
    }
    case 'door': {
      const o = osc(ctx, 'sawtooth', 110, t, 1.6);
      const lfo = osc(ctx, 'sine', 7, t, 1.6), lg = ctx.createGain(); lg.gain.value = 18; chain(lfo, lg, o.frequency);
      o.frequency.setValueAtTime(95, t); o.frequency.linearRampToValueAtTime(150, t + 0.9); o.frequency.linearRampToValueAtTime(80, t + 1.5);
      chain(o, filt(ctx, 'bandpass', 900, 6), env(ctx, t, { a: 0.15, dur: 1.4, peak: 0.9, curve: 'lin' }), master);
      hit(t + 1.55, 90, 50, 0.25, 0.9);
      break;
    }
    case 'bell': case 'gong': {
      const f0 = key === 'bell' ? 523 : 98, dur = key === 'bell' ? 4 : 6;
      for (const [r, p] of (key === 'bell' ? [[1, 0.6], [2, 0.35], [2.76, 0.3], [4.07, 0.15], [5.4, 0.1]] : [[1, 0.6], [1.48, 0.4], [2.03, 0.35], [2.76, 0.25], [3.6, 0.15], [5.1, 0.1]]))
        chain(osc(ctx, 'sine', f0 * r, t, dur), env(ctx, t, { a: key === 'gong' ? 0.08 : 0.004, dur: dur * (1 - r / 12), peak: p }), master);
      if (key === 'gong') chain(src(ctx, N, t, 3), filt(ctx, 'bandpass', 400, 1), env(ctx, t, { a: 0.3, dur: 2.5, peak: 0.25 }), master);
      break;
    }
    case 'magic': {
      const notes = [880, 1109, 1319, 1760, 2217, 2637];
      notes.forEach((f, i) => chain(osc(ctx, 'sine', f, t + i * 0.07, 1.5), env(ctx, t + i * 0.07, { dur: 1.3, peak: 0.25 }), master));
      notes.forEach((f, i) => chain(osc(ctx, 'triangle', f * 2.01, t + i * 0.07, 1), env(ctx, t + i * 0.07, { dur: 0.8, peak: 0.08 }), master));
      chain(src(ctx, N, t, 1.6), filt(ctx, 'highpass', 6000), env(ctx, t, { a: 0.3, dur: 1.2, peak: 0.2 }), master);
      break;
    }
    case 'heartbeat': {
      for (let i = 0; i < 4; i++) { const w = t + i * 0.85; hit(w, 65, 40, 0.16, 1.5); hit(w + 0.24, 58, 38, 0.2, 1.1); }
      break;
    }
    case 'drums': {
      for (const [d, p] of [[0, 1], [0.5, 0.8], [1, 1], [1.25, 0.7], [1.5, 1.1]]) { hit(t + d, 95, 48, 0.5, 1.4 * p); burst(t + d, 0.05, 'bandpass', 900, 0.3 * p, 1); }
      break;
    }
    case 'wind': {
      const f = filt(ctx, 'bandpass', 600, 4);
      const lfo = osc(ctx, 'sine', 0.35, t, 4.5), lg = ctx.createGain(); lg.gain.value = 400; chain(lfo, lg, f.frequency);
      chain(src(ctx, N, t, 4.5), f, env(ctx, t, { a: 1.2, dur: 3.2, peak: 1.4, curve: 'lin' }), master);
      break;
    }
    case 'roar': {
      const o = osc(ctx, 'sawtooth', 85, t, 1.8); o.frequency.setValueAtTime(70, t); o.frequency.linearRampToValueAtTime(110, t + 0.5); o.frequency.linearRampToValueAtTime(60, t + 1.7);
      const am = osc(ctx, 'square', 31, t, 1.8), ag = ctx.createGain(); ag.gain.value = 0.4; const vca = ctx.createGain(); vca.gain.value = 0.6; chain(am, ag, vca.gain);
      chain(o, vca, filt(ctx, 'lowpass', 900, 2), env(ctx, t, { a: 0.2, dur: 1.5, peak: 1.2, curve: 'lin' }), master);
      chain(src(ctx, N, t, 1.8), filt(ctx, 'bandpass', 500, 1.5), env(ctx, t, { a: 0.2, dur: 1.5, peak: 0.6, curve: 'lin' }), master);
      break;
    }
    case 'splash': {
      const f = filt(ctx, 'bandpass', 2500, 1); f.frequency.setValueAtTime(3000, t); f.frequency.exponentialRampToValueAtTime(400, t + 0.9);
      chain(src(ctx, N, t, 1), f, env(ctx, t, { dur: 0.9, peak: 1.3 }), master);
      for (let i = 0; i < 7; i++) { const w = t + 0.2 + Math.random() * 0.8; hit(w, 500 + Math.random() * 900, 1500 + Math.random() * 900, 0.06, 0.2); }
      break;
    }
    case 'coins': {
      for (let i = 0; i < 10; i++) { const w = t + Math.random() * 0.9; const f = 3000 + Math.random() * 2500; chain(osc(ctx, 'sine', f, w, 0.3), env(ctx, w, { dur: 0.25, peak: 0.25 }), master); chain(osc(ctx, 'sine', f * 1.5, w, 0.2), env(ctx, w, { dur: 0.15, peak: 0.1 }), master); }
      break;
    }
    case 'fire': {
      const f = filt(ctx, 'lowpass', 400); f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(3500, t + 0.35); f.frequency.exponentialRampToValueAtTime(300, t + 1.5);
      chain(src(ctx, N, t, 1.6), f, env(ctx, t, { a: 0.12, dur: 1.4, peak: 1.4 }), master);
      for (let i = 0; i < 14; i++) burst(t + 0.2 + Math.random() * 1.2, 0.02, 'highpass', 2500, 0.5);
      break;
    }
    case 'rumble': {
      chain(src(ctx, B, t, 4, 0.5), filt(ctx, 'lowpass', 120), env(ctx, t, { a: 0.8, dur: 3, peak: 2, curve: 'lin' }), master);
      for (let i = 0; i < 6; i++) burst(t + 0.5 + Math.random() * 2.5, 0.15, 'bandpass', 300 + Math.random() * 400, 0.25, 2);
      break;
    }
    case 'crit': {   // a short brass flourish
      [[392, 0], [523, 0.12], [659, 0.24], [784, 0.36]].forEach(([f, d], i) => {
        const o = osc(ctx, 'sawtooth', f, t + d, 1.2), o2 = osc(ctx, 'sawtooth', f * 1.005, t + d, 1.2);
        const lp = filt(ctx, 'lowpass', 2400, 1);
        const g = env(ctx, t + d, { a: 0.03, dur: i === 3 ? 1.1 : 0.3, peak: 0.22 });
        o.connect(lp); o2.connect(lp); chain(lp, g, master);
      });
      chain(src(ctx, N, t + 0.36, 1.2), filt(ctx, 'highpass', 7000), env(ctx, t + 0.36, { a: 0.02, dur: 1, peak: 0.25 }), master);
      break;
    }
    case 'fumble': {  // a sad slide down
      const o = osc(ctx, 'triangle', 330, t, 1.4); o.frequency.setValueAtTime(330, t); o.frequency.linearRampToValueAtTime(311, t + 0.35); o.frequency.linearRampToValueAtTime(294, t + 0.7); o.frequency.exponentialRampToValueAtTime(196, t + 1.3);
      const lfo = osc(ctx, 'sine', 6, t + 0.7, 0.7), lg = ctx.createGain(); lg.gain.value = 6; chain(lfo, lg, o.frequency);
      chain(o, filt(ctx, 'lowpass', 1200), env(ctx, t, { a: 0.03, dur: 1.3, peak: 0.5, curve: 'lin' }), master);
      break;
    }
    default: return false;
  }
  setTimeout(() => master.disconnect(), 8000);
  return true;
}
