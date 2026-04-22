// MusicAxis — relay server
// Desktop (stage) and phone (controller) meet in a session room.
// Server's only job: forward orientation from the controller to the stage.
// No audio is transmitted; all audio lives on the desktop.

const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '3000', 10);
const USE_HTTPS = process.env.HTTPS === '1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_TTL_MS = 30 * 60 * 1000;

const app = express();
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.get('/play', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'play', 'index.html')));
app.get('/healthz', (_req, res) => res.json({ ok: true, sessions: sessions.size }));

let server;
if (USE_HTTPS) {
  const certDir = path.join(__dirname, '..', 'certs');
  try {
    const key = fs.readFileSync(path.join(certDir, 'key.pem'));
    const cert = fs.readFileSync(path.join(certDir, 'cert.pem'));
    server = https.createServer({ key, cert }, app);
    console.log('[musicaxis] HTTPS mode — self-signed certs loaded');
  } catch (err) {
    console.error('[musicaxis] HTTPS requested but certs missing. Run scripts/make-certs.sh');
    process.exit(1);
  }
} else {
  server = http.createServer(app);
}

const wss = new WebSocketServer({ server, path: '/ws' });

/** @type {Map<string, { stage: Set<WebSocket>, controller: Set<WebSocket>, lastActivity: number }>} */
const sessions = new Map();

function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { stage: new Set(), controller: new Set(), lastActivity: Date.now() };
    sessions.set(id, s);
  }
  return s;
}

function broadcast(set, payload) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(data); } catch (_) { /* ignore */ }
    }
  }
}

wss.on('connection', (ws, req) => {
  ws._role = null;
  ws._session = null;
  ws._alive = true;

  ws.on('pong', () => { ws._alive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    const { type } = msg;

    // join { type:'join', role:'stage'|'controller', session:'abc123' }
    if (type === 'join') {
      const role = msg.role === 'stage' ? 'stage' : msg.role === 'controller' ? 'controller' : null;
      const sid = typeof msg.session === 'string' && msg.session.length > 0 && msg.session.length < 64
        ? msg.session.replace(/[^A-Za-z0-9_-]/g, '')
        : null;
      if (!role || !sid) { ws.close(1008, 'bad join'); return; }
      ws._role = role;
      ws._session = sid;
      const s = getSession(sid);
      s[role].add(ws);
      s.lastActivity = Date.now();
      ws.send(JSON.stringify({ type: 'joined', role, session: sid }));
      // Tell stage that a controller connected / disconnected.
      const status = role === 'controller' ? 'controller-connected' : 'stage-ready';
      broadcast(s.stage, { type: 'presence', status, controllers: s.controller.size });
      if (role === 'controller') {
        broadcast(s.controller, { type: 'presence', status: 'paired', stages: s.stage.size });
      }
      return;
    }

    // Reject traffic from unjoined sockets.
    if (!ws._session || !ws._role) return;
    const s = sessions.get(ws._session);
    if (!s) return;
    s.lastActivity = Date.now();

    // orientation { type:'orient', alpha, beta, gamma, t? }
    // Controller → stage only.
    if (type === 'orient' && ws._role === 'controller') {
      broadcast(s.stage, msg);
      return;
    }

    // tap / release gestures from controller — treat like orientation relay.
    if ((type === 'tap' || type === 'release' || type === 'strum' || type === 'ping-motion')
        && ws._role === 'controller') {
      broadcast(s.stage, msg);
      return;
    }

    // control messages from stage → controller (e.g. change instrument echo)
    if ((type === 'stage-state' || type === 'haptic') && ws._role === 'stage') {
      broadcast(s.controller, msg);
      return;
    }

    // keepalive
    if (type === 'ping') { try { ws.send(JSON.stringify({ type: 'pong', t: Date.now() })); } catch {} }
  });

  ws.on('close', () => {
    const sid = ws._session;
    if (!sid) return;
    const s = sessions.get(sid);
    if (!s) return;
    s.stage.delete(ws);
    s.controller.delete(ws);
    broadcast(s.stage, { type: 'presence', status: 'controller-disconnected', controllers: s.controller.size });
    if (s.stage.size === 0 && s.controller.size === 0) {
      sessions.delete(sid);
    }
  });
});

// Liveness + TTL sweep — every 30s, drop dead sockets and expired sessions.
setInterval(() => {
  const now = Date.now();
  wss.clients.forEach((ws) => {
    if (ws._alive === false) { try { ws.terminate(); } catch {} return; }
    ws._alive = false;
    try { ws.ping(); } catch {}
  });
  for (const [sid, s] of sessions) {
    if (now - s.lastActivity > SESSION_TTL_MS) {
      for (const ws of [...s.stage, ...s.controller]) { try { ws.close(1000, 'expired'); } catch {} }
      sessions.delete(sid);
    }
  }
}, 30_000);

server.listen(PORT, () => {
  const proto = USE_HTTPS ? 'https' : 'http';
  console.log(`[musicaxis] ${proto}://localhost:${PORT}`);
  console.log(`[musicaxis] stage: ${proto}://localhost:${PORT}/`);
  console.log(`[musicaxis] phone: ${proto}://<your-lan-ip>:${PORT}/play?session=<id>`);
});

// Expose a session-id generator to the stage via a tiny JSON endpoint (optional).
app.get('/api/session', (_req, res) => {
  const id = crypto.randomBytes(6).toString('base64url');
  res.json({ session: id });
});
