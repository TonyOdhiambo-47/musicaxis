// MusicAxis — relay server
// Desktop (stage) and phone (controller) meet in a session room. The only
// server responsibility is to forward orientation from the controller to
// the stage. No audio is transmitted; all audio lives on the desktop.
//
// Uses Node's standard `http` + `ws` only — no express needed.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');

// Pick the first non-internal IPv4 address so we can advertise it in the QR.
function getLanHost() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return null;
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const USE_HTTPS = process.env.HTTPS === '1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_TTL_MS = 30 * 60 * 1000;
let orientFrames = 0;

// ── Static file server ──────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.wav':  'audio/wav',
  '.mp3':  'audio/mpeg',
  '.webm': 'audio/webm',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.ttf':  'font/ttf',
};

function resolvePath(urlPath) {
  // Strip query string, decode, and normalize
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  let rel = clean.replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  if (rel === 'play' || rel === 'play/') rel = 'play/index.html';
  const full = path.join(PUBLIC_DIR, rel);
  // Directory traversal guard
  if (!full.startsWith(PUBLIC_DIR + path.sep) && full !== PUBLIC_DIR) return null;
  return full;
}

function serveFile(req, res) {
  const full = resolvePath(req.url);
  if (!full) { res.writeHead(403).end('forbidden'); return; }

  fs.stat(full, (err, stat) => {
    let target = full;
    // If a directory, try index.html
    if (!err && stat.isDirectory()) target = path.join(full, 'index.html');
    fs.readFile(target, (err2, data) => {
      if (err2) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        // Disable caching during active development — stale JS on phones has
        // bitten us twice now.
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      res.end(data);
    });
  });
}

function handleRequest(req, res) {
  const url = req.url || '/';
  // JSON routes first
  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
  }
  if (url.startsWith('/api/session')) {
    const id = crypto.randomBytes(6).toString('base64url');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ session: id }));
  }
  if (url.startsWith('/api/whoami')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ lan: getLanHost(), port: PORT }));
  }
  if (url === '/api/debug') {
    let controllers = 0;
    let stages = 0;
    for (const s of sessions.values()) {
      controllers += s.controller.size;
      stages += s.stage.size;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ sessions: sessions.size, controllers, stages, orientFrames }));
  }
  // Everything else is a static asset
  serveFile(req, res);
}

// ── HTTP(S) server ──────────────────────────────────────────────────
let server;
if (USE_HTTPS) {
  const certDir = path.join(__dirname, '..', 'certs');
  try {
    const key = fs.readFileSync(path.join(certDir, 'key.pem'));
    const cert = fs.readFileSync(path.join(certDir, 'cert.pem'));
    server = https.createServer({ key, cert }, handleRequest);
    console.log('[musicaxis] HTTPS mode — self-signed certs loaded');
  } catch (err) {
    console.error('[musicaxis] HTTPS requested but certs missing. Run scripts/make-certs.sh');
    process.exit(1);
  }
} else {
  server = http.createServer(handleRequest);
}

// ── WebSocket relay ─────────────────────────────────────────────────
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

wss.on('connection', (ws) => {
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
      console.log(`[musicaxis] join role=${role} session=${sid}`);
      ws._role = role;
      ws._session = sid;
      const s = getSession(sid);
      s[role].add(ws);
      s.lastActivity = Date.now();
      ws.send(JSON.stringify({ type: 'joined', role, session: sid }));

      if (role === 'controller') {
        broadcast(s.stage, { type: 'presence', status: 'controller-connected', controllers: s.controller.size });
      }
      const peerCount = role === 'controller' ? s.stage.size : s.controller.size;
      ws.send(JSON.stringify({
        type: 'presence',
        status: peerCount > 0 ? 'paired' : (role === 'controller' ? 'waiting-for-stage' : 'waiting-for-phone'),
        peers: peerCount,
      }));
      if (role === 'stage') {
        broadcast(s.controller, { type: 'presence', status: 'paired', stages: s.stage.size });
      }
      return;
    }

    // Reject traffic from unjoined sockets.
    if (!ws._session || !ws._role) return;
    const s = sessions.get(ws._session);
    if (!s) return;
    s.lastActivity = Date.now();

    // Controller → stage
    if (type === 'orient' && ws._role === 'controller') {
      orientFrames += 1;
      broadcast(s.stage, msg); return;
    }
    if ((type === 'down' || type === 'up' || type === 'tap' || type === 'release' || type === 'strum' || type === 'ping-motion')
        && ws._role === 'controller') {
      broadcast(s.stage, msg); return;
    }
    // Stage → controller
    if ((type === 'stage-state' || type === 'haptic') && ws._role === 'stage') {
      broadcast(s.controller, msg); return;
    }
    // Keepalive
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
    if (s.stage.size === 0 && s.controller.size === 0) sessions.delete(sid);
  });
});

// Liveness + TTL sweep every 30s.
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
}, 30_000).unref();

// Bind 0.0.0.0 so phones on the LAN (IPv4) can reach us.
server.listen(PORT, '0.0.0.0', () => {
  const proto = USE_HTTPS ? 'https' : 'http';
  console.log(`[musicaxis] ${proto}://localhost:${PORT}`);
  console.log(`[musicaxis] stage: ${proto}://localhost:${PORT}/`);
  console.log(`[musicaxis] phone: open the QR shown on the stage, or visit ${proto}://<your-lan-ip>:${PORT}/play?s=<session>`);
});
