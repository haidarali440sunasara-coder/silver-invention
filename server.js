import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const publicRoot = fileURLToPath(new URL('./public/', import.meta.url));
const ROOM_TTL = 6 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEMO = { url: '/media/together.mp4', title: 'Our little universe', kind: 'demo' };
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp4': 'video/mp4', '.ico': 'image/x-icon' };

export function createApp({ now = Date.now, publicOrigin = process.env.PUBLIC_ORIGIN } = {}) {
  const rooms = new Map();
  const creationLimits = new Map();
  const connections = new Map();
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  const send = (ws, payload) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); };
  const broadcast = (room, payload, except) => { for (const client of room.clients.values()) if (client.ws !== except) send(client.ws, payload); };
  const participants = room => [...room.clients.values()].map(({ id, name, video, audio }) => ({ id, name, video, audio }));
  const snapshot = room => ({ id: room.id, participants: participants(room), media: room.media, playback: room.playback, serverTime: now() });
  const error = (ws, code, message) => send(ws, { type: 'error', code, message });
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const allowedOrigin = req => {
    if (!req.headers.origin) return false;
    try {
      const origin = new URL(req.headers.origin);
      if (!['http:', 'https:'].includes(origin.protocol)) return false;
      // TLS commonly terminates at a reverse proxy, leaving this socket HTTP.
      // Compare the browser's host, or use an explicitly configured public origin.
      return publicOrigin ? origin.origin === new URL(publicOrigin).origin : origin.host === req.headers.host;
    }
    catch { return false; }
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' https: blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { return json(res, 400, { error: 'Invalid URL.' }); }
    if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
    if (pathname === '/api/rooms' && req.method === 'POST') {
      if (!allowedOrigin(req)) return json(res, 403, { error: 'Open Closer in your browser to create a room.' });
      const ip = req.socket.remoteAddress;
      const limit = creationLimits.get(ip);
      if (limit && limit.reset > now() && limit.count >= 20) return json(res, 429, { error: 'Please wait a few minutes before making another room.' });
      creationLimits.set(ip, { count: limit?.reset > now() ? limit.count + 1 : 1, reset: limit?.reset > now() ? limit.reset : now() + 10 * 60 * 1000 });
      if (rooms.size >= 1000) return json(res, 503, { error: 'All our rooms are busy. Please try again soon.' });
      let id;
      do { id = [...randomBytes(10)].map(n => CODE_ALPHABET[n % CODE_ALPHABET.length]).join(''); } while (rooms.has(id));
      const room = { id, createdAt: now(), clients: new Map(), media: { ...DEMO }, playback: { paused: true, time: 0, updatedAt: now(), revision: 0 } };
      rooms.set(id, room);
      return json(res, 201, { roomId: id, expiresAt: room.createdAt + ROOM_TTL });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
    try {
      const path = await realpath(resolve(publicRoot, `.${pathname === '/' ? '/index.html' : pathname}`));
      if (!path.startsWith(publicRoot.endsWith(sep) ? publicRoot : publicRoot + sep)) return json(res, 403, { error: 'Forbidden.' });
      const info = await stat(path);
      if (!info.isFile()) return json(res, 404, { error: 'Not found.' });
      const headers = { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': extname(path) === '.mp4' ? 'public, max-age=86400' : 'no-cache' };
      let start = 0, end = info.size - 1, status = 200;
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end(); }
        start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
        if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end(); }
        status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      }
      headers['Content-Length'] = end - start + 1;
      res.writeHead(status, headers);
      if (req.method === 'HEAD') return res.end();
      const stream = createReadStream(path, { start, end });
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch { json(res, 404, { error: 'Not found.' }); }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws' || !allowedOrigin(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const ip = req.socket.remoteAddress;
    if ((connections.get(ip) || 0) >= 30) { socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => { connections.set(ip, (connections.get(ip) || 0) + 1); wss.emit('connection', ws, req); });
  });
  wss.on('connection', (ws, req) => {
    let room, client, messages = 0, windowStart = now();
    ws.alive = true;
    const joinTimer = setTimeout(() => { if (!room) ws.close(1008, 'Join a room first.'); }, 10000);
    joinTimer.unref();
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', raw => {
      if (now() - windowStart >= 10000) { messages = 0; windowStart = now(); }
      if (++messages > 150) { ws.close(1008, 'Too many messages.'); return; }
      let message;
      try { message = JSON.parse(raw); } catch { return error(ws, 'invalid-message', 'Invalid message.'); }
      if (!message || typeof message !== 'object') return;
      if (message.type === 'join' && !room) {
        const code = String(message.roomId || '').toUpperCase().replace(/[\s-]/g, '');
        const candidate = rooms.get(code);
        if (!candidate || now() - candidate.createdAt >= ROOM_TTL) return error(ws, 'room-missing', 'That room has expired or does not exist. Check your invitation.');
        if (candidate.clients.size >= 2) return error(ws, 'room-full', 'This room already has two people. Create a new room for yourselves.');
        room = candidate;
        client = { id: randomBytes(8).toString('hex'), name: String(message.name || 'My love').trim().slice(0, 32) || 'My love', video: false, audio: false, ws };
        room.clients.set(client.id, client);
        clearTimeout(joinTimer);
        send(ws, { type: 'joined', selfId: client.id, room: snapshot(room), iceServers, relayAvailable: iceServers.length > 1 });
        broadcast(room, { type: 'presence', participants: participants(room) }, ws);
        return;
      }
      if (!room) return error(ws, 'not-joined', 'Join a room first.');
      if (message.type === 'ping') return send(ws, { type: 'pong', sentAt: message.sentAt, serverTime: now() });
      if (message.type === 'chat') {
        const body = typeof message.text === 'string' ? message.text.trim().slice(0, 1000) : '';
        if (body) broadcast(room, { type: 'chat', id: randomBytes(6).toString('hex'), from: client.id, name: client.name, text: body, at: now() });
      } else if (message.type === 'reaction' && ['heart', 'sparkle', 'kiss', 'clap'].includes(message.reaction)) {
        broadcast(room, { type: 'reaction', from: client.id, reaction: message.reaction });
      } else if (message.type === 'media') {
        let media;
        if (message.kind === 'demo') media = { ...DEMO };
        else {
          try {
            const url = new URL(message.url);
            if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048) throw new Error();
            media = { url: url.href, title: String(message.title || 'Our movie').trim().slice(0, 80) || 'Our movie', kind: 'url' };
          } catch { return error(ws, 'invalid-media', 'Use a direct HTTPS link to a video file.'); }
        }
        room.media = media;
        room.playback = { paused: true, time: 0, updatedAt: now(), revision: room.playback.revision + 1 };
        broadcast(room, { type: 'media', media, playback: room.playback, serverTime: now(), from: client.id });
      } else if (message.type === 'playback') {
        if (typeof message.paused !== 'boolean' || !Number.isFinite(message.time) || message.time < 0 || message.time > 7 * 86400) return;
        room.playback = { paused: message.paused, time: message.time, updatedAt: now(), revision: room.playback.revision + 1 };
        broadcast(room, { type: 'playback', playback: room.playback, serverTime: now(), from: client.id });
      } else if (message.type === 'call-state' && typeof message.video === 'boolean' && typeof message.audio === 'boolean') {
        client.video = message.video; client.audio = message.audio;
        broadcast(room, { type: 'call-state', from: client.id, video: client.video, audio: client.audio }, ws);
      } else if (message.type === 'signal' && (message.description || message.candidate)) {
        broadcast(room, { type: 'signal', from: client.id, description: message.description, candidate: message.candidate }, ws);
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(joinTimer);
      const ip = req.socket.remoteAddress;
      const count = (connections.get(ip) || 1) - 1;
      if (count) connections.set(ip, count); else connections.delete(ip);
      if (!room || !client) return;
      room.clients.delete(client.id);
      broadcast(room, { type: 'presence', participants: participants(room) });
    });
  });
  const cleanup = setInterval(() => {
    for (const [id, room] of rooms) if (now() - room.createdAt >= ROOM_TTL) {
      broadcast(room, { type: 'error', code: 'room-expired', message: 'Your six-hour room has ended. Create a new room to keep watching.' });
      for (const { ws } of room.clients.values()) ws.close(1000, 'Room expired.');
      rooms.delete(id);
    }
    for (const [ip, limit] of creationLimits) if (limit.reset < now()) creationLimits.delete(ip);
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
    }
  }, 30000);
  cleanup.unref();
  server.on('close', () => { clearInterval(cleanup); wss.close(); });
  return { server, rooms, wss };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = createApp();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Closer is listening on port ${server.address().port}`));
}
