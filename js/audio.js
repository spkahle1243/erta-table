// Three audio layers: music and ambience (looping, crossfaded) and one-shot SFX.
// The DM sets what plays and when it started; every browser computes the same
// playback position from the shared clock, so everyone hears the same moment.

import { playSynth } from './sfx.js';

const FADE = 1.6; // seconds

export class AudioEngine {
  constructor(resolveUrl, now = () => Date.now()) {
    this.resolveUrl = resolveUrl; // async (assetId) => objectURL
    this.now = now;
    this.ctx = null;
    this.vol = { master: 0.8, music: 0.8, ambience: 0.6, sfx: 0.9 };
    this.layers = { music: null, ambience: null };
    this.want = { music: null, ambience: null };
    this._gen = { music: 0, ambience: 0 };
  }

  get unlocked() { return !!this.ctx && this.ctx.state === 'running'; }

  // Must be called from a click or key press (browser autoplay rules).
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain(); this.master.connect(this.ctx.destination);
      this.bus = {};
      for (const k of ['music', 'ambience', 'sfx']) { const g = this.ctx.createGain(); g.connect(this.master); this.bus[k] = g; }
      this._applyVolumes();
    }
    if (this.ctx.state !== 'running') this.ctx.resume();
    for (const k of ['music', 'ambience']) if (this.want[k]) this.set(k, this.want[k], true);
  }

  setVolume(k, v) { this.vol[k] = v; this._applyVolumes(); }
  _applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.vol.master, t, 0.05);
    for (const k of ['music', 'ambience', 'sfx']) this.bus[k].gain.setTargetAtTime(this.vol[k], t, 0.05);
  }

  _same(a, b) { return a && b && a.asset === b.asset && a.startedAt === b.startedAt && !!a.paused === !!b.paused && (a.vol ?? 1) === (b.vol ?? 1); }

  // state: null to stop, or { asset, startedAt, loop, paused, pausedAt, vol }
  async set(layer, state, force = false) {
    const prev = this.want[layer];
    this.want[layer] = state;
    if (!this.ctx) return;
    if (!force && (this._same(prev, state) || (!prev && !state))) return;
    const gen = ++this._gen[layer];
    const cur = this.layers[layer];
    // Same track, just a pause/volume change: adjust in place.
    if (cur && state && cur.asset === state.asset && cur.startedAt === state.startedAt) {
      cur.gain.gain.setTargetAtTime(state.paused ? 0 : (state.vol ?? 1), this.ctx.currentTime, 0.3);
      if (state.paused) setTimeout(() => { if (this.want[layer]?.paused) cur.el.pause(); }, 1200);
      else { this._seek(cur.el, state); cur.el.play().catch(() => {}); }
      return;
    }
    if (cur) this._fadeOut(cur);
    this.layers[layer] = null;
    if (!state || state.paused) return;
    const url = await this.resolveUrl(state.asset).catch(() => null);
    if (!url || gen !== this._gen[layer]) return;
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.src = url; el.loop = state.loop !== false; el.preload = 'auto';
    const src = this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain(); gain.gain.value = 0;
    src.connect(gain); gain.connect(this.bus[layer]);
    const node = { el, gain, asset: state.asset, startedAt: state.startedAt };
    this.layers[layer] = node;
    await new Promise(r => { if (el.readyState >= 1) r(); else { el.addEventListener('loadedmetadata', r, { once: true }); el.addEventListener('error', r, { once: true }); } });
    if (gen !== this._gen[layer]) { el.pause(); return; }
    if (!this._seek(el, state)) { this.layers[layer] = null; return; }
    try { await el.play(); } catch (e) { console.warn('audio play blocked', e); }
    gain.gain.setValueAtTime(0, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(state.vol ?? 1, this.ctx.currentTime + FADE);
  }

  // Positions the element where the shared clock says it should be. False if a non-looping track already ended.
  _seek(el, state) {
    const d = el.duration;
    let pos = Math.max(0, (this.now() - state.startedAt) / 1000);
    if (Number.isFinite(d) && d > 0) {
      if (state.loop !== false) pos = pos % d;
      else if (pos >= d) return false;
    }
    if (Math.abs(el.currentTime - pos) > 0.4) { try { el.currentTime = pos; } catch {} }
    return true;
  }

  _fadeOut(node) {
    const t = this.ctx.currentTime;
    node.gain.gain.cancelScheduledValues(t);
    node.gain.gain.setValueAtTime(node.gain.gain.value, t);
    node.gain.gain.linearRampToValueAtTime(0, t + FADE);
    setTimeout(() => { node.el.pause(); node.el.removeAttribute('src'); node.el.load(); }, FADE * 1000 + 200);
  }

  // A built-in, synthesized effect (js/sfx.js).
  synth(key, vol = 1) { if (this.ctx) playSynth(this.ctx, this.bus.sfx, key, vol); }

  async sfx(asset, vol = 1) {
    if (!this.ctx) return;
    const url = await this.resolveUrl(asset).catch(() => null);
    if (!url) return;
    const el = new Audio(url);
    const src = this.ctx.createMediaElementSource(el);
    const g = this.ctx.createGain(); g.gain.value = vol;
    src.connect(g); g.connect(this.bus.sfx);
    el.addEventListener('ended', () => { src.disconnect(); g.disconnect(); }, { once: true });
    el.play().catch(() => {});
  }
}

// Track length helper for the DM's library.
export function audioDuration(url) {
  return new Promise(res => {
    const a = new Audio(); a.preload = 'metadata'; a.src = url;
    a.onloadedmetadata = () => res(a.duration); a.onerror = () => res(null);
  });
}
