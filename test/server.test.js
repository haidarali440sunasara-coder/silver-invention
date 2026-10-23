import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../server.js';
import { normalizeMedia } from '../public/media.js';

async function fixture(t, options = {}) {
  const app = createApp(options);
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { for (const ws of app.wss.clients) ws.terminate(); await new Promise(resolve => app.server.close(resolve)); });
  const create = async () => {
    const response = await fetch(`${origin}/api/rooms`, { method: 'POST', headers: { Origin: origin } });
    assert.equal(response.status, 201); return (await response.json()).roomId;
  };
  const connect = async (roomId, name = 'Love') => {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { origin });
    const inbox = [], waiting = [];
    ws.on('message', raw => {
      const message = JSON.parse(raw);
      const index = waiting.findIndex(wait => wait.type === message.type);
      if (index >= 0) { const wait = waiting.splice(index, 1)[0]; clearTimeout(wait.timer); wait.resolve(message); }
      else inbox.push(message);
    });
    await once(ws, 'open');
    const take = type => {
      const index = inbox.findIndex(message => message.type === type);
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const wait = { type, resolve };
        wait.timer = setTimeout(() => { const index = waiting.indexOf(wait); if (index >= 0) waiting.splice(index, 1); reject(new Error(`Timed out waiting for ${type}`)); }, 2500);
        waiting.push(wait);
      });
    };
    const send = payload => ws.send(JSON.stringify(payload));
    if (roomId !== null) send({ type: 'join', roomId, name });
    return { ws, take, send, inbox };
  };
  return { ...app, origin, create, connect };
}

test('serves the app, health, manifest, and seekable demo video', async t => {
  const { origin } = await fixture(t);
  const home = await fetch(origin); assert.equal(home.status, 200); assert.match(await home.text(), /Make tonight/);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(home.headers.get('content-security-policy'), /script-src 'self' https:\/\/www.youtube.com https:\/\/s.ytimg.com/);
  assert.match(home.headers.get('content-security-policy'), /frame-src https:/);
  assert.equal(home.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.deepEqual(await (await fetch(`${origin}/api/health`)).json(), { ok: true });
  const manifest = await (await fetch(`${origin}/manifest.webmanifest`)).json(); assert.equal(manifest.short_name, 'Closer');
  const video = await fetch(`${origin}/media/together.mp4`, { headers: { Range: 'bytes=0-31' } });
  assert.equal(video.status, 206); assert.equal((await video.arrayBuffer()).byteLength, 32); assert.match(video.headers.get('content-range'), /^bytes 0-31\//);
  assert.equal((await fetch(`${origin}/media/together.mp4`, { headers: { Range: 'bytes=999999999-' } })).status, 416);
  assert.equal((await fetch(`${origin}/media/together.mp4`, { headers: { Range: 'bytes=-' } })).status, 416);
});

test('rejects room creation and WebSockets from a different origin', async t => {
  const { origin } = await fixture(t);
  assert.equal((await fetch(`${origin}/api/rooms`, { method: 'POST', headers: { Origin: 'https://elsewhere.example' } })).status, 403);
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { origin: 'https://elsewhere.example' });
  const [error] = await once(ws, 'error'); assert.match(error.message, /403/);
});

test('accepts HTTPS origins behind a same-host TLS proxy', async t => {
  const { origin } = await fixture(t);
  const response = await fetch(`${origin}/api/rooms`, { method: 'POST', headers: { Origin: origin.replace('http:', 'https:') } });
  assert.equal(response.status, 201);
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { origin: origin.replace('http:', 'https:') });
  await once(ws, 'open'); ws.close();
  assert.equal((await fetch(`${origin}/api/rooms`, { method: 'POST', headers: { Origin: origin.replace('http:', 'ftp:') } })).status, 403);
});

test('private rooms admit two people, reject a third, and relay presence', async t => {
  const { create, connect } = await fixture(t); const code = await create();
  assert.match(code, /^[A-HJ-NP-Z2-9]{10}$/);
  const first = await connect(code, 'Asha'); const firstJoin = await first.take('joined');
  assert.equal(firstJoin.room.participants.length, 1);
  const second = await connect(code, 'Alex'); const secondJoin = await second.take('joined');
  assert.equal(secondJoin.room.participants.length, 2); assert.equal((await first.take('presence')).participants[1].name, 'Alex');
  const third = await connect(code); assert.equal((await third.take('error')).code, 'room-full');
  second.ws.close(); assert.equal((await first.take('presence')).participants.length, 1);
  const missing = await connect('AAAAAAAAAA'); assert.equal((await missing.take('error')).code, 'room-missing');
});

test('synchronizes media, seeking, late joins, and server timestamps', async t => {
  const { create, connect } = await fixture(t); const code = await create();
  const first = await connect(code); await first.take('joined');
  first.send({ type: 'playback', paused: false, time: 8.5 });
  const play = await first.take('playback'); assert.equal(play.playback.time, 8.5); assert.equal(play.playback.paused, false); assert.equal(play.playback.revision, 1);
  const second = await connect(code); const join = await second.take('joined'); assert.equal(join.room.playback.time, 8.5); assert.equal(join.room.playback.updatedAt, play.playback.updatedAt);
  second.send({ type: 'playback', paused: true, time: 15 });
  assert.equal((await first.take('playback')).playback.time, 15); await second.take('playback');
  first.send({ type: 'media', kind: 'url', url: 'https://example.com/video.mp4', title: 'Our memory' });
  const media = await second.take('media'); assert.equal(media.media.title, 'Our memory'); assert.equal(media.playback.time, 0); assert.equal(media.playback.paused, true);
  first.send({ type: 'media', kind: 'url', url: 'javascript:alert(1)' }); assert.equal((await first.take('error')).code, 'invalid-media');
  first.send({ type: 'media', kind: 'url', url: 'https://user:password@example.com/video.mp4' }); assert.equal((await first.take('error')).code, 'invalid-media');
  first.send({ type: 'media', kind: 'demo' }); assert.equal((await second.take('media')).media.kind, 'demo');
});

test('isolates rooms and relays chat, reactions, and call signaling', async t => {
  const { create, connect } = await fixture(t); const code = await create();
  const first = await connect(code, 'Asha'); const firstJoin = await first.take('joined');
  const second = await connect(code, 'Alex'); await second.take('joined');
  const outsider = await connect(await create(), 'Other'); await outsider.take('joined');
  first.send({ type: 'chat', text: '<img src=x onerror=alert(1)>♡' });
  const chat = await second.take('chat'); assert.equal(chat.text, '<img src=x onerror=alert(1)>♡'); assert.equal(chat.name, 'Asha');
  first.send({ type: 'reaction', reaction: 'heart' }); assert.equal((await second.take('reaction')).reaction, 'heart');
  first.send({ type: 'call-state', video: true, audio: false });
  const callState = await second.take('call-state'); assert.equal(callState.video, true); assert.equal(callState.audio, false);
  first.send({ type: 'signal', description: { type: 'offer', sdp: 'test-sdp' } });
  const signal = await second.take('signal'); assert.equal(signal.from, firstJoin.selfId); assert.equal(signal.description.sdp, 'test-sdp');
  first.send({ type: 'ping', sentAt: 42 }); assert.equal((await first.take('pong')).sentAt, 42);
  assert.equal(outsider.inbox.length, 0);
});

test('expired invitations cannot be reused', async t => {
  let time = Date.now(); const { create, connect } = await fixture(t, { now: () => time });
  const code = await create(); time += 6 * 60 * 60 * 1000;
  const client = await connect(code); assert.equal((await client.take('error')).code, 'room-missing');
});

test('recognizes shared YouTube URLs without trusting arbitrary video IDs or hosts', () => {
  const id = 'M7lc1UVf-VE';
  for (const url of [
    `https://www.youtube.com/watch?v=${id}&list=ignored`, `https://youtu.be/${id}?si=tracking`,
    `https://m.youtube.com/watch?v=${id}`, `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`, `https://www.youtube-nocookie.com/embed/${id}`
  ]) {
    assert.deepEqual(normalizeMedia({ url, title: ' Our pick ' }), { kind: 'youtube', url: `https://www.youtube.com/watch?v=${id}`, videoId: id, title: 'Our pick' });
  }
  for (const url of ['https://youtube.com/', 'https://youtu.be/invalid', 'https://youtube.com/watch?v=<script>', 'javascript:alert(1)', 'http://youtu.be/M7lc1UVf-VE', 'https://user:password@youtu.be/M7lc1UVf-VE', 'https://youtube.com.evil.example/watch?v=M7lc1UVf-VE']) {
    assert.throws(() => normalizeMedia({ kind: 'youtube', url }));
  }
});

test('shares YouTube and website selections with late joiners and rejects invalid sources', async t => {
  const { create, connect } = await fixture(t); const code = await create();
  const first = await connect(code); await first.take('joined');
  first.send({ type: 'media', kind: 'youtube', url: 'https://youtu.be/M7lc1UVf-VE', videoId: 'untrusted', title: 'Together' });
  assert.equal((await first.take('media')).media.videoId, 'M7lc1UVf-VE');
  first.send({ type: 'playback', time: 42, paused: true }); await first.take('playback');
  const second = await connect(code); const joined = await second.take('joined');
  assert.equal(joined.room.media.kind, 'youtube'); assert.equal(joined.room.playback.time, 42);
  first.send({ type: 'media', kind: 'website', url: 'https://example.com/page?q=two' });
  const website = await second.take('media');
  assert.equal(website.media.kind, 'website'); assert.equal(website.media.url, 'https://example.com/page?q=two');
  assert.equal(website.playback.paused, true);
  for (const [kind, url] of [['website', 'data:text/html,unsafe'], ['website', 'https://me:secret@example.com'], ['youtube', 'https://example.com/embed/id'], ['other', 'https://example.com']]) {
    first.send({ type: 'media', kind, url }); assert.equal((await first.take('error')).code, 'invalid-media');
  }
  first.send({ type: 'playback', time: 100, paused: false });
  first.send({ type: 'ping', sentAt: 123 }); await first.take('pong');
  assert.equal(second.inbox.filter(message => message.type === 'playback').length, 0);
  first.send({ type: 'media', kind: 'demo' }); assert.equal((await second.take('media')).media.kind, 'demo');
});
