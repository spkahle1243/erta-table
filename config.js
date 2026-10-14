// Connection settings shared by the DM view and every player link.
// PEER_SERVER: the free PeerJS matchmaking server that introduces players to
// the DM's browser. Game traffic itself goes browser to browser.
// ICE_SERVERS: STUN finds a direct route; add a TURN relay here for players
// on strict networks (see README, "If a player can't connect").
window.ERTA_TABLE_CONFIG = {
  PEER_SERVER: { host: '0.peerjs.com', port: 443, path: '/', secure: true },
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// Local testing override: ?peer=localhost:9000 points both sides at a local server.
(function () {
  const p = new URLSearchParams(location.search).get('peer');
  if (!p) return;
  const [host, port] = p.split(':');
  window.ERTA_TABLE_CONFIG.PEER_SERVER = { host, port: Number(port || 9000), path: '/', secure: false };
  window.ERTA_TABLE_CONFIG.ICE_SERVERS = [];
})();
