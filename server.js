/* ============================================================
   RoFrontier — zero-dependency static server + lobby relay
   ------------------------------------------------------------
   node server.js  [port]        (default 3000, binds 0.0.0.0)

   * Serves the PWA over HTTP from this directory.
   * Implements the WebSocket protocol natively (RFC 6455 text
     frames, ping/pong/close, masked client payloads) at /ws —
     no `ws` package / npm install required.
   * Rooms are ephemeral in-memory state. The client keeps a full
     local simulation fallback when no relay is reachable.

   Client → server:  hello, subscribe, relay, create_room, join_room,
                      ready, chat, start, leave, ping
   Server → client:  hello_ack, room_state, chat, match_start, relay,
                     error, pong

   `subscribe` + `relay` implement a dumb broadcast bus (channels keyed by
   room code) used by the lockstep mesh. It works alongside the free public
   MQTT relay in free-relay.js so mixed hosting setups still interoperate.
   ============================================================ */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 3000);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.md': 'text/markdown; charset=utf-8'
};

/* ─────────────────────── static files ──────────────────────── */
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, channels: channels.size, uptime: process.uptime() }));
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch (_) { res.writeHead(400); return res.end('Bad request'); }
  if (pathname === '/') pathname = '/index.html';
  const target = path.resolve(ROOT, '.' + pathname);
  if (!target.startsWith(ROOT + path.sep) && target !== path.join(ROOT, 'index.html')) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback — the service worker handles this offline too.
      const fallback = path.join(ROOT, 'index.html');
      return fs.readFile(fallback, (e, data) => {
        if (e) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(data);
      });
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/'
    });
    fs.createReadStream(target).pipe(res);
  });
});

/* ─────────────────────── lobby state ───────────────────────── */
const rooms = new Map();       // code -> { code, host, max, difficulty, players: [], clients: Set }
const peers = new Map();       // socket -> { id, name, room, buffer, fragments, channels: Set }
const channels = new Map();    // room code -> Set<socket> (dumb broadcast bus)

function newCode() {
  let code;
  do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
  return code;
}
function publicRoom(room) {
  return {
    code: room.code, host: room.host, max: room.max, difficulty: room.difficulty,
    players: room.players.map((p) => ({ id: p.id, name: p.name, ready: p.ready, color: p.color }))
  };
}
function send(socket, obj) { sendFrame(socket, JSON.stringify(obj), 0x1); }
function broadcast(room, obj) {
  const text = JSON.stringify(obj);
  room.clients.forEach((sock) => { try { sendFrame(sock, text, 0x1); } catch (_) { /* dropped */ } });
}
function roomState(room) { broadcast(room, { type: 'room_state', room: publicRoom(room) }); }
function fail(socket, message) { send(socket, { type: 'error', message }); }
function relayToChannel(code, data) {
  const set = channels.get(code);
  if (!set) return;
  const text = JSON.stringify({ type: 'relay', code, data });
  set.forEach((sock) => { try { sendFrame(sock, text, 0x1); } catch (_) { /* dropped */ } });
}

function leaveRoom(peer, socket) {
  const room = peer.room;
  if (!room) return;
  room.clients.delete(socket);
  room.players = room.players.filter((p) => p.id !== peer.id);
  peer.room = null;
  if (!room.players.length) { rooms.delete(room.code); return; }
  if (room.host === peer.id) room.host = room.players[0].id;
  roomState(room);
}

function handleMessage(socket, raw) {
  const peer = peers.get(socket);
  if (!peer) return;
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return fail(socket, 'Malformed JSON message.'); }
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'subscribe': {
      const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
      if (!code) return fail(socket, 'Invalid room code.');
      peer.channels.forEach((c) => {
        const set = channels.get(c);
        if (set) { set.delete(socket); if (!set.size) channels.delete(c); }
      });
      peer.channels = new Set([code]);
      if (!channels.has(code)) channels.set(code, new Set());
      channels.get(code).add(socket);
      send(socket, { type: 'subscribed', code });
      break;
    }
    case 'relay': {
      const code = String(msg.code || '').toUpperCase();
      if (!code || !msg.data || typeof msg.data !== 'object') return;
      if (!peer.channels.has(code)) return fail(socket, 'Subscribe to that room first.');
      relayToChannel(code, msg.data); // includes the sender; the client de-dupes
      break;
    }
    case 'hello': {
      peer.name = String(msg.name || 'Commander').slice(0, 20);
      peer.id = String(msg.id || peer.id).slice(0, 40);
      send(socket, { type: 'hello_ack', id: peer.id, name: peer.name });
      break;
    }
    case 'create_room': {
      leaveRoom(peer, socket);
      const room = {
        code: newCode(), host: peer.id,
        max: Math.max(2, Math.min(6, Number(msg.max) || 4)),
        difficulty: ['easy', 'normal', 'hard', 'insane'].includes(msg.difficulty) ? msg.difficulty : 'normal',
        players: [{ id: peer.id, name: peer.name, ready: false, color: '#56dce2' }],
        clients: new Set([socket])
      };
      rooms.set(room.code, room);
      peer.room = room;
      roomState(room);
      broadcast(room, { type: 'chat', name: 'RoFrontier', text: `Room ${room.code} created. Share the code!`, system: true });
      break;
    }
    case 'join_room': {
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return fail(socket, `Room ${code} does not exist.`);
      if (room.players.length >= room.max) return fail(socket, 'Room is full.');
      if (room.players.some((p) => p.id === peer.id)) return fail(socket, 'Already in that room.');
      leaveRoom(peer, socket);
      room.clients.add(socket);
      room.players.push({ id: peer.id, name: peer.name, ready: false, color: '#f5be4a' });
      peer.room = room;
      roomState(room);
      broadcast(room, { type: 'chat', name: 'RoFrontier', text: `${peer.name} joined the room.`, system: true });
      break;
    }
    case 'ready': {
      const room = peer.room;
      if (!room) return fail(socket, 'Join a room first.');
      const p = room.players.find((x) => x.id === peer.id);
      if (p) p.ready = !p.ready;
      roomState(room);
      break;
    }
    case 'chat': {
      const room = peer.room;
      if (!room) return fail(socket, 'Join a room first.');
      broadcast(room, {
        type: 'chat', name: peer.name,
        text: String(msg.text || '').slice(0, 140), ts: Date.now()
      });
      break;
    }
    case 'start': {
      const room = peer.room;
      if (!room) return fail(socket, 'Join a room first.');
      if (room.host !== peer.id) return fail(socket, 'Only the host can start the match.');
      if (room.players.length < 2) return fail(socket, 'Need at least 2 commanders (or use Quick Match locally).');
      room.players.forEach((p) => { p.ready = true; });
      roomState(room);
      broadcast(room, { type: 'match_start', room: publicRoom(room) });
      break;
    }
    case 'leave': leaveRoom(peer, socket); break;
    case 'ping': send(socket, { type: 'pong', ts: Date.now() }); break;
    case 'subscribed': break;
    default: fail(socket, `Unknown message type: ${msg.type}`);
  }
}

/* ─────────────── WebSocket framing (RFC 6455) ──────────────── */
function sendFrame(socket, text, opcode = 0x1) {
  if (socket.destroyed) return;
  const payload = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function consumeFrames(peer, socket, chunk) {
  peer.buffer = Buffer.concat([peer.buffer, chunk]);
  let buf = peer.buffer;
  let offset = 0;
  while (true) {
    if (buf.length - offset < 2) break;
    const b0 = buf[offset], b1 = buf[offset + 1];
    const fin = !!(b0 & 0x80);
    const opcode = b0 & 0x0f;
    const masked = !!(b1 & 0x80);
    let len = b1 & 0x7f;
    let headerLen = 2;
    if (len === 126) {
      if (buf.length - offset < 4) break;
      len = buf.readUInt16BE(offset + 2); headerLen = 4;
    } else if (len === 127) {
      if (buf.length - offset < 10) break;
      const big = buf.readBigUInt64BE(offset + 2);
      if (big > BigInt(MAX_FRAME)) { socket.destroy(); return; }
      len = Number(big); headerLen = 10;
    }
    if (len > MAX_FRAME) { socket.destroy(); return; }
    const maskLen = masked ? 4 : 0;
    if (buf.length - offset < headerLen + maskLen + len) break;
    const mask = masked ? buf.subarray(offset + headerLen, offset + headerLen + 4) : null;
    const payload = Buffer.from(buf.subarray(offset + headerLen + maskLen, offset + headerLen + maskLen + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    offset += headerLen + maskLen + len;

    if (opcode === 0x8) { socket.end(); return; }
    if (opcode === 0x9) { sendFrame(socket, payload, 0xA); continue; }  // ping → pong
    if (opcode === 0xA) continue;                                        // pong
    if (opcode === 0x0 || opcode === 0x1) {
      peer.fragments += payload.toString('utf8');
      if (fin) {
        const text = peer.fragments;
        peer.fragments = '';
        handleMessage(socket, text);
      }
    }
  }
  peer.buffer = buf.subarray(offset);
}

server.on('upgrade', (req, socket, head) => {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) { /* ignore */ }
  if (pathname !== '/ws' || req.headers['sec-websocket-key'] === undefined) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  const accept = crypto.createHash('sha1')
    .update(String(req.headers['sec-websocket-key']) + GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  const peer = {
    id: 'p-' + crypto.randomBytes(6).toString('hex'),
    name: 'Commander', room: null, channels: new Set(),
    buffer: Buffer.alloc(0), fragments: ''
  };
  peers.set(socket, peer);
  if (head && head.length) consumeFrames(peer, socket, head);

  socket.on('data', (chunk) => consumeFrames(peer, socket, chunk));
  socket.on('error', () => { /* close handler cleans up */ });
  socket.on('close', () => {
    leaveRoom(peer, socket);
    peer.channels.forEach((code) => {
      const set = channels.get(code);
      if (set) { set.delete(socket); if (!set.size) channels.delete(code); }
    });
    peers.delete(socket);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`RoFrontier serving on http://0.0.0.0:${PORT}`);
  console.log(`WebSocket lobby relay available at ws://0.0.0.0:${PORT}/ws`);
});

process.on('SIGINT', () => { server.close(() => process.exit(0)); });
