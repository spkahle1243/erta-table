// Browser-to-browser networking with PeerJS.
// The DM's tab is the host: it owns the game state, and every player connects
// straight to it. The PeerJS server only introduces the browsers.

import { Emitter } from './util.js';
import { assets } from './store.js';

const CFG = () => window.ERTA_TABLE_CONFIG;
const PREFIX = 'erta-table-';
const CHUNK = 192 * 1024;

function peerOptions() {
  const c = CFG();
  return { ...c.PEER_SERVER, config: { iceServers: c.ICE_SERVERS }, debug: 1 };
}

async function waitForBuffer(conn) {
  const dc = conn.dataChannel;
  if (!dc) return;
  while (dc.bufferedAmount > 4 * 1024 * 1024 && dc.readyState === 'open') {
    await new Promise(r => setTimeout(r, 30));
  }
}

// ---------------------------------------------------------------- Host (DM)

export class Host extends Emitter {
  // authorize(hello) -> { ok, info } where info is attached to the client.
  constructor(hostId, authorize) {
    super();
    this.hostId = hostId;
    this.authorize = authorize;
    this.clients = new Map(); // peerId -> { conn, info }
    this.status = 'starting';
    this._retry = 0;
    this._destroyed = false;
  }

  start() {
    if (this.peer) try { this.peer.destroy(); } catch {}
    this._setStatus('starting');
    const peer = new window.Peer(PREFIX + this.hostId, peerOptions());
    this.peer = peer;
    peer.on('open', () => { this._retry = 0; this._setStatus('online'); });
    peer.on('connection', conn => this._accept(conn));
    clearInterval(this._hb);
    this._hb = setInterval(() => {
      const now = Date.now();
      for (const [pid, c] of this.clients) {
        if (now - (c.seen || now) > 12000) { try { c.conn.close(); } catch {} this.clients.delete(pid); this.emit('leave', pid, c.info); this.emit('clients'); continue; }
        if (c.conn.open) try { c.conn.send({ t: 'hb' }); } catch {}
      }
    }, 2500);
    peer.on('disconnected', () => {
      if (this._destroyed || peer.destroyed) return;
      this._setStatus('reconnecting');
      setTimeout(() => { if (!peer.destroyed) try { peer.reconnect(); } catch { this._restart(); } }, 1500);
    });
    peer.on('error', err => {
      console.warn('[host] peer error', err.type, err);
      if (err.type === 'unavailable-id') { this._setStatus('taken'); this._restart(8000); return; }
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) this._restart();
    });
  }

  _restart(delay) {
    if (this._destroyed) return;
    this._setStatus(this.status === 'taken' ? 'taken' : 'reconnecting');
    const d = delay ?? Math.min(15000, 1000 * 2 ** this._retry++);
    clearTimeout(this._rt);
    this._rt = setTimeout(() => this.start(), d);
  }

  _setStatus(s) { this.status = s; this.emit('status', s); }

  _accept(conn) {
    let authed = false;
    conn.on('data', async msg => {
      if (!msg || typeof msg !== 'object') return;
      const known = this.clients.get(conn.peer); if (known) known.seen = Date.now();
      if (msg.t === 'hb') return;
      if (!authed) {
        if (msg.t !== 'hello') return;
        const res = await this.authorize(msg, conn.peer);
        if (!res.ok) { conn.send({ t: 'denied', reason: res.reason || 'This link is not valid.' }); setTimeout(() => conn.close(), 500); return; }
        authed = true;
        // One live connection per character: a reload replaces the old one.
        for (const [pid, c] of this.clients) {
          if (c.info.charId && c.info.charId === res.info.charId && pid !== conn.peer) { try { c.conn.close(); } catch {} this.clients.delete(pid); }
        }
        this.clients.set(conn.peer, { conn, info: res.info, seen: Date.now() });
        this.emit('join', conn.peer, res.info);
        this.emit('clients');
        return;
      }
      if (msg.t === 'tsync') { conn.send({ t: 'tsync', c: msg.c, s: Date.now() }); return; }
      if (msg.t === 'asset-req') { this.sendAsset(conn.peer, msg.id); return; }
      this.emit('message', conn.peer, msg, this.clients.get(conn.peer)?.info);
    });
    const drop = () => {
      if (this.clients.get(conn.peer)?.conn === conn) {
        const info = this.clients.get(conn.peer).info;
        this.clients.delete(conn.peer);
        this.emit('leave', conn.peer, info);
        this.emit('clients');
      }
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  send(peerId, msg) {
    const c = this.clients.get(peerId);
    if (c && c.conn.open) try { c.conn.send(msg); } catch (e) { console.warn(e); }
  }

  broadcast(msgOrFn, except) {
    for (const [pid, c] of this.clients) {
      if (pid === except || !c.conn.open) continue;
      const m = typeof msgOrFn === 'function' ? msgOrFn(c.info, pid) : msgOrFn;
      if (m) try { c.conn.send(m); } catch (e) { console.warn(e); }
    }
  }

  async sendAsset(peerId, id) {
    const c = this.clients.get(peerId);
    if (!c) return;
    const a = await assets.get(id);
    if (!a) { this.send(peerId, { t: 'asset-missing', id }); return; }
    const buf = await a.blob.arrayBuffer();
    const n = Math.max(1, Math.ceil(buf.byteLength / CHUNK));
    for (let i = 0; i < n; i++) {
      if (!c.conn.open) return;
      await waitForBuffer(c.conn);
      c.conn.send({ t: 'chunk', id, i, n, type: a.type, name: a.name, size: buf.byteLength, data: buf.slice(i * CHUNK, (i + 1) * CHUNK) });
    }
  }

  kick(charId) {
    for (const [pid, c] of this.clients) if (c.info.charId === charId) { try { c.conn.close(); } catch {} }
  }

  destroy() { this._destroyed = true; clearTimeout(this._rt); clearInterval(this._hb); try { this.peer?.destroy(); } catch {} }
}

// ------------------------------------------------------------ Client (player)

export class Client extends Emitter {
  constructor(hostId, hello) {
    super();
    this.hostId = hostId;
    this.hello = hello;
    this.status = 'connecting';
    this.offset = 0; this._bestRtt = Infinity;
    this._pending = new Map(); // asset id -> { resolve, reject, parts[], got }
    this._retry = 0;
  }

  now() { return Date.now() + this.offset; }

  start() {
    this._setStatus('connecting');
    if (this.peer && !this.peer.destroyed) { this._dial(); return; }
    const peer = new window.Peer(undefined, peerOptions());
    this.peer = peer;
    peer.on('open', () => this._dial());
    peer.on('error', err => {
      console.warn('[client] peer error', err.type, err);
      if (err.type === 'peer-unavailable') { this._setStatus('waiting'); this._later(4000); return; }
      if (['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'].includes(err.type)) {
        try { peer.destroy(); } catch {}
        this.peer = null; this._later();
      }
    });
    peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch {} }, 1500); });
  }

  _later(ms) {
    clearTimeout(this._rt);
    const d = ms ?? Math.min(15000, 1000 * 2 ** this._retry++);
    this._rt = setTimeout(() => this.start(), d);
  }

  _setStatus(s) { this.status = s; this.emit('status', s); }

  _dial() {
    if (this.conn) { try { this.conn.close(); } catch {} }
    const conn = this.peer.connect(PREFIX + this.hostId, { reliable: true, serialization: 'binary' });
    this.conn = conn;
    const openTimer = setTimeout(() => { if (!conn.open) { try { conn.close(); } catch {} this._setStatus('waiting'); this._later(4000); } }, 15000);
    conn.on('open', () => {
      clearTimeout(openTimer);
      this._retry = 0;
      this._seen = Date.now();
      conn.send({ t: 'hello', ...this.hello });
      this._syncClock();
      clearInterval(this._ti);
      let n = 0;
      this._ti = setInterval(() => {
        if (this.conn !== conn) return;
        if (Date.now() - this._seen > 9000) { // the DM's tab went quiet: start over
          try { conn.close(); } catch {}
          this._lost(conn);
          return;
        }
        try { conn.send({ t: 'hb' }); } catch {}
        if (++n % 7 === 0) this._syncClock();
      }, 3000);
    });
    conn.on('data', msg => { this._seen = Date.now(); this._onData(msg); });
    conn.on('close', () => this._lost(conn));
    conn.on('error', e => console.warn('[client] conn error', e));
  }

  _lost(conn) {
    if (this.conn !== conn) return;
    clearInterval(this._ti);
    this.conn = null;
    if (this.status === 'denied') return;
    this._setStatus('reconnecting');
    for (const p of this._pending.values()) p.reject(new Error('disconnected'));
    this._pending.clear();
    this._later(1500);
  }

  _syncClock() { if (this.conn?.open) this.conn.send({ t: 'tsync', c: Date.now() }); }

  async _onData(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hb': return;
      case 'tsync': {
        const now = Date.now(), rtt = now - msg.c;
        if (rtt <= this._bestRtt * 1.5) { this._bestRtt = Math.min(this._bestRtt, rtt); this.offset = msg.s - (msg.c + now) / 2; }
        return;
      }
      case 'denied': this._setStatus('denied'); this.emit('denied', msg.reason); return;
      case 'welcome': this._setStatus('online'); this.emit('welcome', msg); return;
      case 'chunk': {
        const p = this._pending.get(msg.id);
        if (!p) return;
        p.parts[msg.i] = msg.data; p.got++;
        this.emit('progress', msg.id, p.got / msg.n);
        if (p.got === msg.n) {
          this._pending.delete(msg.id);
          await assets.putRaw(msg.id, msg.type, msg.name, new Blob(p.parts));
          p.resolve();
        }
        return;
      }
      case 'asset-missing': { const p = this._pending.get(msg.id); if (p) { this._pending.delete(msg.id); p.reject(new Error('missing')); } return; }
      default: this.emit('message', msg);
    }
  }

  send(msg) { if (this.conn?.open) try { this.conn.send(msg); } catch (e) { console.warn(e); } }

  // Resolves once the asset is in this browser's store (downloading if needed).
  async ensureAsset(id) {
    if (!id) return;
    if (await assets.has(id)) return;
    if (this._pending.has(id)) return this._pending.get(id).promise;
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    this._pending.set(id, { resolve, reject, promise, parts: [], got: 0 });
    this.send({ t: 'asset-req', id });
    return promise;
  }
}
