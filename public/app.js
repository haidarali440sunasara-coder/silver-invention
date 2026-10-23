const $ = id => document.getElementById(id);
const movie = $('movie');
const isPreview = document.documentElement.dataset.preview === 'true';
const DEMO = { url: movie.getAttribute('src'), title: 'Our little universe', kind: 'demo' };
const state = { ws: null, roomId: null, name: '', selfId: null, connected: false, participants: [], media: DEMO, playback: { paused: true, time: 0, updatedAt: Date.now(), revision: 0 }, clockOffset: 0, retries: 0, reconnectTimer: null, pc: null, remoteId: null, makingOffer: false, ignoreOffer: false, settingAnswer: false, pendingCandidates: [], localStream: new MediaStream(), screenStream: null, iceServers: [], remoteStream: new MediaStream(), formMode: 'create', pingTimer: null };
let toastTimer, applySequence = 0;
const icon = name => `<svg aria-hidden="true"><use href="/icons.svg#${name}"></use></svg>`;
const send = payload => { if (state.connected && state.ws?.readyState === WebSocket.OPEN) { state.ws.send(JSON.stringify(payload)); return true; } return false; };
const rememberName = value => { try { localStorage.setItem('closer-name', value); } catch {} };
try { state.name = localStorage.getItem('closer-name') || ''; } catch {}

function toast(message) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
}
function openDialog(id) { $(id).showModal(); }
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  const rect = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
}));
$('how-button').addEventListener('click', () => openDialog('how-dialog'));

function formatCode(code) { return `${code.slice(0, 5)} ${code.slice(5)}`; }
function parseCode(value) {
  let text = value.trim();
  try { const url = new URL(text); text = new URLSearchParams(url.hash.slice(1)).get('room') || ''; } catch {}
  const code = text.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-HJ-NP-Z2-9]{10}$/.test(code)) throw new Error('Enter the ten-character room code or paste the invitation link.');
  return code;
}
function showRoomForm(mode, code = '') {
  if (isPreview) { openDialog('preview-dialog'); return; }
  if (state.roomId) { toast('Leave your current room before joining another one.'); return; }
  state.formMode = mode;
  $('room-dialog-title').innerHTML = mode === 'create' ? 'Make room for <em>us.</em>' : 'Your person is <em>waiting.</em>';
  $('room-dialog-copy').textContent = mode === 'create' ? 'A private invitation. Your favorite person. That’s all you need.' : 'Bring your invitation and make yourself at home.';
  $('join-code-field').hidden = mode !== 'join';
  $('room-code-input').required = mode === 'join';
  $('room-code-input').value = code;
  $('name-input').value = state.name;
  $('room-form-error').textContent = '';
  $('room-submit').innerHTML = `${mode === 'create' ? 'Create our room' : 'Join our room'} ${icon('arrow')}`;
  openDialog('room-dialog');
}
$('create-button').addEventListener('click', () => showRoomForm('create'));
$('join-button').addEventListener('click', () => showRoomForm('join'));
$('room-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (isPreview) { openDialog('preview-dialog'); return; }
  $('room-form-error').textContent = '';
  const name = $('name-input').value.trim();
  if (!name) { $('room-form-error').textContent = 'Add your name so your person knows it’s you.'; return; }
  $('room-submit').disabled = true;
  try {
    let code;
    if (state.formMode === 'create') {
      const response = await fetch('/api/rooms', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Couldn’t make a room. Try again.');
      code = result.roomId;
    } else code = parseCode($('room-code-input').value);
    const chosenMedia = state.media;
    await connectRoom(code, name);
    if (state.formMode === 'create' && chosenMedia.kind !== 'demo') send({ type: 'media', ...chosenMedia });
    rememberName(name);
    $('room-dialog').close();
    if (state.formMode === 'create') showInvite();
    else toast('You’re here. Make yourselves at home.');
  } catch (error) { $('room-form-error').textContent = error.message; }
  finally { $('room-submit').disabled = false; }
});

function updatePresence() {
  const partner = state.participants.find(person => person.id !== state.selfId);
  $('lobby-actions').hidden = !!state.roomId;
  $('active-room-actions').hidden = !state.roomId;
  $('room-heading').textContent = state.roomId ? `Our room · ${formatCode(state.roomId)}` : 'Your date night starts here';
  $('room-description').textContent = state.roomId ? (state.connected ? (partner ? 'You’re both here. The rest of the world can wait.' : 'Your seat is ready. Invite your favorite person.') : 'Connection interrupted. Reconnecting to your room…') : 'Make a private room and send your person an invite.';
  $('invite-button').innerHTML = `${icon('link')}${state.connected ? 'Invite your person' : 'Reconnect'}`;
  $('self-label').textContent = state.roomId ? `${state.name} (you)` : 'You';
  $('partner-label').textContent = partner?.name || 'Your person';
  $('mini-partner-label').textContent = partner?.name || 'Your person';
  $('partner-wait').hidden = !!partner;
  $('people-count').textContent = `${state.connected ? state.participants.length : 0} / 2`;
  $('presence-description').textContent = partner ? 'A little distance. A lot of us.' : 'Save a seat for your favorite person.';
  $('sync-status').className = `status-pill${state.roomId ? state.connected ? (partner ? ' connected' : '') : ' disconnected' : ''}`;
  $('sync-status').replaceChildren(Object.assign(document.createElement('span'), {}), document.createTextNode(state.roomId ? state.connected ? partner ? 'Connected · the two of you' : 'Waiting for your person' : 'Reconnecting…' : 'Just for you two'));
  $('chat-input').disabled = !state.connected;
  $('chat-send').disabled = !state.connected;
  if (partner && state.connected) ensurePeer(partner.id);
  else { closePeer(); $('call-caption').textContent = 'Say hello, face to face'; }
}

async function connectRoom(roomId, name, reconnect = false) {
  if (isPreview) throw new Error('Open the live website to connect with your person.');
  clearTimeout(state.reconnectTimer);
  if (state.ws) { const previous = state.ws; state.ws = null; previous.close(); }
  closePeer();
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  state.ws = ws;
  return new Promise((resolve, reject) => {
    let joined = false, settled = false, fatal = false;
    const timeout = setTimeout(() => { if (!joined) { settled = true; reject(new Error('The room is taking too long to connect. Please try again.')); ws.close(); } }, 12000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'join', roomId, name })));
    ws.addEventListener('message', async event => {
      if (state.ws !== ws) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'joined') {
        clearTimeout(timeout); joined = true; settled = true;
        state.connected = true; state.roomId = roomId; state.name = name; state.selfId = message.selfId; state.participants = message.room.participants;
        state.iceServers = message.iceServers; state.clockOffset = message.room.serverTime - Date.now(); state.retries = 0;
        history.replaceState(null, '', `#room=${roomId}`);
        if (!reconnect) clearChat();
        updateMedia(message.room.media, message.room.playback);
        updatePresence();
        refreshLocalPreview();
        clearInterval(state.pingTimer);
        send({ type: 'ping', sentAt: Date.now() });
        state.pingTimer = setInterval(() => send({ type: 'ping', sentAt: Date.now() }), 15000);
        resolve();
      } else if (message.type === 'error') {
        if (!joined) { fatal = true; clearTimeout(timeout); settled = true; reject(new Error(message.message)); ws.close(); }
        else if (message.code === 'room-expired') { toast(message.message); leaveRoom(); }
        else toast(message.message);
      } else if (message.type === 'presence') {
        const previous = state.participants.find(person => person.id !== state.selfId);
        state.participants = message.participants;
        const partner = state.participants.find(person => person.id !== state.selfId);
        updatePresence();
        if (partner && !previous) { addNotice(`${partner.name} is here. Let date night begin.`); toast(`${partner.name} joined your room ♡`); }
        else if (!partner && previous) addNotice(`${previous.name} left the room.`);
      } else if (message.type === 'media') {
        updateMedia(message.media, message.playback);
        if (message.from !== state.selfId) toast('Your person picked a new video.');
      } else if (message.type === 'playback') {
        if (message.playback.revision >= state.playback.revision) { state.playback = message.playback; applyPlayback(); }
      } else if (message.type === 'pong') {
        state.clockOffset = message.serverTime - (Date.now() + message.sentAt) / 2;
      } else if (message.type === 'chat') appendChat(message);
      else if (message.type === 'reaction') floatReaction(message.reaction);
      else if (message.type === 'call-state') {
        const partner = state.participants.find(person => person.id === message.from);
        if (partner) { partner.video = message.video; partner.audio = message.audio; renderRemoteMedia(); }
      }
      else if (message.type === 'signal') await handleSignal(message);
    });
    ws.addEventListener('error', () => { /* The close event reports the actionable connection state. */ });
    ws.addEventListener('close', () => {
      clearTimeout(timeout);
      if (!settled) { settled = true; reject(new Error('Couldn’t connect to the room. Check your connection and try again.')); }
      if (state.ws !== ws) return;
      state.connected = false;
      clearInterval(state.pingTimer);
      closePeer();
      if (state.roomId) {
        movie.pause(); updatePresence();
        if (!fatal && state.retries < 5) {
          state.retries++;
          state.reconnectTimer = setTimeout(() => connectRoom(state.roomId, state.name, true).catch(error => {
            if (fatal || state.retries >= 5 || /expired|already has/.test(error.message)) {
              toast(`${error.message} Tap Reconnect to try again.`);
              $('room-description').textContent = 'Disconnected. Tap Reconnect to return to your room.';
              clearTimeout(state.reconnectTimer);
            }
          }), Math.min(1500 * 2 ** (state.retries - 1), 10000));
        } else $('room-description').textContent = 'Disconnected. Tap Reconnect to return to your room.';
      }
    });
  });
}
function leaveRoom() {
  clearTimeout(state.reconnectTimer); clearInterval(state.pingTimer);
  state.roomId = null; state.connected = false; state.participants = []; state.selfId = null;
  if (state.ws) { state.ws.close(); state.ws = null; }
  stopMedia(); closePeer(); movie.pause();
  state.playback = { paused: true, time: movie.currentTime, updatedAt: Date.now(), revision: 0 };
  $('resume-button').hidden = true;
  history.replaceState(null, '', location.pathname + location.search);
  clearChat(); updatePresence();
}
$('leave-button').addEventListener('click', () => { leaveRoom(); toast('You left the room. Come back anytime.'); });
$('invite-button').addEventListener('click', () => {
  if (state.connected) showInvite();
  else connectRoom(state.roomId, state.name, true).catch(error => toast(error.message));
});
function invitation() { return `${location.origin}${location.pathname}#room=${state.roomId}`; }
function showInvite() {
  $('invite-code').textContent = formatCode(state.roomId);
  $('invite-link').value = invitation();
  openDialog('invite-dialog');
}
async function copyInvite() {
  try { await navigator.clipboard.writeText(invitation()); toast('Invitation copied. Send it to your person ♡'); }
  catch { $('invite-link').focus(); $('invite-link').select(); toast('Press and hold the selected link to copy it.'); }
}
$('copy-link').addEventListener('click', copyInvite);
$('share-link').addEventListener('click', async () => {
  if (navigator.share) {
    try { await navigator.share({ title: 'A little date night?', text: 'Come spend a little time with me on Closer ♡', url: invitation() }); }
    catch (error) { if (error.name !== 'AbortError') await copyInvite(); }
  } else await copyInvite();
});

function updateMedia(media, playback) {
  state.media = media; state.playback = playback;
  const target = new URL(media.url, document.baseURI).href;
  if (movie.src !== target) { movie.src = media.url; movie.load(); }
  $('media-title').textContent = media.title;
  $('media-detail').textContent = media.kind === 'demo' ? 'An original ambient short · 24 seconds' : 'Your shared video · play, pause, and seek together';
  $('stage-story').hidden = media.kind !== 'demo';
  if (playback.time === 0 && playback.paused) $('video-stage').classList.remove('has-started');
  applyPlayback();
}
function expectedTime() {
  const playback = state.playback;
  return Math.max(0, playback.time + (playback.paused ? 0 : Math.max(0, Date.now() + state.clockOffset - playback.updatedAt) / 1000));
}
async function applyPlayback() {
  const sequence = ++applySequence;
  if (!movie.readyState) return;
  const target = Math.min(expectedTime(), Number.isFinite(movie.duration) ? movie.duration : Infinity);
  if (Math.abs(movie.currentTime - target) > .4) movie.currentTime = target;
  if (state.playback.paused) { movie.pause(); $('resume-button').hidden = true; }
  else {
    try { await movie.play(); if (sequence === applySequence) $('resume-button').hidden = true; }
    catch (error) { if (sequence === applySequence && error.name !== 'AbortError') $('resume-button').hidden = false; }
  }
  renderPlayer();
}
function publishPlayback(paused, time) {
  if (state.roomId && !state.connected) { toast('Reconnecting. Your movie will continue when you’re back.'); return false; }
  if (state.connected) return send({ type: 'playback', paused, time });
  state.playback = { paused, time, updatedAt: Date.now(), revision: state.playback.revision + 1 }; state.clockOffset = 0;
  return true;
}
async function togglePlay() {
  if (state.roomId && !state.connected) { toast('Tap Reconnect to return to your room.'); return; }
  if (movie.error) { toast('This video couldn’t load. Try another direct video link.'); return; }
  if (movie.paused) {
    if (movie.ended) movie.currentTime = 0;
    else if (state.connected && !state.playback.paused) movie.currentTime = Math.min(expectedTime(), movie.duration || Infinity);
    try { await movie.play(); publishPlayback(false, movie.currentTime); $('resume-button').hidden = true; }
    catch { toast('This video can’t play on this phone. Try an MP4 video.'); }
  } else { movie.pause(); publishPlayback(true, movie.currentTime); }
}
function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const value = Math.floor(seconds);
  return value >= 3600 ? `${Math.floor(value / 3600)}:${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}` : `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}
function renderPlayer() {
  $('play-button').innerHTML = icon(movie.paused ? 'play' : 'pause');
  $('play-button').setAttribute('aria-label', movie.paused ? 'Play movie' : 'Pause movie');
  $('time-label').textContent = `${formatTime(movie.currentTime)} / ${formatTime(movie.duration)}`;
  if (Number.isFinite(movie.duration)) { $('seek').max = movie.duration; $('seek').value = movie.currentTime; }
  if (!movie.paused || movie.currentTime > .5) $('video-stage').classList.add('has-started');
}
$('play-button').addEventListener('click', togglePlay);
$('stage-play').addEventListener('click', togglePlay);
$('resume-button').addEventListener('click', async () => {
  try { if (state.connected) movie.currentTime = Math.min(expectedTime(), movie.duration || Infinity); await movie.play(); $('resume-button').hidden = true; }
  catch { toast('Try choosing a different video. This one may not support your phone.'); }
});
$('seek').addEventListener('change', event => {
  if (state.roomId && !state.connected) { toast('Reconnect before changing the movie.'); return; }
  movie.currentTime = Number(event.target.value);
  publishPlayback(movie.paused, movie.currentTime);
});
movie.addEventListener('timeupdate', renderPlayer);
movie.addEventListener('play', renderPlayer);
movie.addEventListener('pause', renderPlayer);
movie.addEventListener('loadedmetadata', () => { renderPlayer(); if (state.connected) applyPlayback(); });
movie.addEventListener('ended', () => { if (!state.playback.paused) publishPlayback(true, movie.currentTime); });
// iPhone's native fullscreen UI has its own controls. Relay those user actions
// too; compare with the desired state so incoming sync never echoes back.
movie.addEventListener('webkitbeginfullscreen', () => { state.nativeFullscreen = true; });
movie.addEventListener('webkitendfullscreen', () => { state.nativeFullscreen = false; });
movie.addEventListener('play', () => { if (state.nativeFullscreen && state.playback.paused) publishPlayback(false, movie.currentTime); });
movie.addEventListener('pause', () => { if (state.nativeFullscreen && !state.playback.paused && !movie.ended) publishPlayback(true, movie.currentTime); });
movie.addEventListener('seeked', () => { if (state.nativeFullscreen && Math.abs(movie.currentTime - expectedTime()) > .8) publishPlayback(movie.paused, movie.currentTime); });
movie.addEventListener('error', () => {
  if (state.media.kind !== 'demo') toast('The video couldn’t load. Use a direct MP4 or WebM link that allows playback.');
});
$('volume-button').addEventListener('click', () => {
  movie.muted = !movie.muted;
  $('volume-button').innerHTML = icon(movie.muted ? 'volume-off' : 'volume');
  $('volume-button').setAttribute('aria-label', movie.muted ? 'Unmute movie' : 'Mute movie');
});
$('fullscreen-button').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if ($('video-stage').requestFullscreen) await $('video-stage').requestFullscreen();
    else if (movie.webkitEnterFullscreen) movie.webkitEnterFullscreen();
    else toast('Rotate your phone for a wider view.');
  } catch { toast('Rotate your phone for a wider view.'); }
});
setInterval(() => {
  if (state.connected && !state.playback.paused && !movie.paused && movie.readyState >= 2 && Math.abs(movie.currentTime - expectedTime()) > 1.2) applyPlayback();
}, 4000);
$('choose-video').addEventListener('click', () => { $('video-form-error').textContent = ''; openDialog('video-dialog'); });
function selectVideo(media) {
  if (state.roomId && !state.connected) { $('video-form-error').textContent = 'Reconnect to your room before changing the video.'; return; }
  if (state.connected) send({ type: 'media', ...media });
  else updateMedia(media.kind === 'demo' ? DEMO : media, { paused: true, time: 0, updatedAt: Date.now(), revision: 0 });
  $('video-dialog').close();
  if (!state.roomId) toast(isPreview ? 'Video ready. Tap play to try it on this phone.' : 'Video ready. Create a room to watch it together.');
}
$('choose-demo').addEventListener('click', () => selectVideo(DEMO));
$('video-form').addEventListener('submit', event => {
  event.preventDefault(); $('video-form-error').textContent = '';
  try {
    const url = new URL($('video-url').value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048) throw new Error();
    if (/(^|\.)(youtube\.com|youtu\.be|netflix\.com|vimeo\.com|disneyplus\.com)$/.test(url.hostname)) { $('video-form-error').textContent = 'Use a direct video file link, rather than a streaming service page.'; return; }
    selectVideo({ url: url.href, title: $('video-name').value.trim() || 'Our movie', kind: 'url' });
  } catch { $('video-form-error').textContent = 'Add a valid HTTPS link to a video file.'; }
});

function clearChat() { $('chat-log').replaceChildren($('chat-empty') || makeChatEmpty()); $('chat-input').value = ''; }
function makeChatEmpty() {
  const element = document.createElement('div'); element.className = 'chat-empty'; element.id = 'chat-empty';
  element.innerHTML = '<span>♡</span><p>The best part is who<br>you’re watching with.</p><small>Your messages will appear here.</small>';
  return element;
}
function appendChat(message) {
  $('chat-empty')?.remove();
  const bubble = document.createElement('div'); bubble.className = `chat-message${message.from === state.selfId ? ' self' : ''}`;
  const author = document.createElement('strong'); author.textContent = message.from === state.selfId ? 'You' : message.name;
  const text = document.createElement('span'); text.textContent = message.text;
  bubble.append(author, text); $('chat-log').append(bubble);
  while ($('chat-log').children.length > 150) $('chat-log').firstElementChild.remove();
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
}
function addNotice(text) {
  const notice = document.createElement('p'); notice.className = 'chat-notice'; notice.textContent = text;
  $('chat-log').append(notice); $('chat-log').scrollTop = $('chat-log').scrollHeight;
}
$('chat-form').addEventListener('submit', event => {
  event.preventDefault(); const text = $('chat-input').value.trim();
  if (text && send({ type: 'chat', text })) $('chat-input').value = '';
});
const emoji = { heart: '❤️', kiss: '😘', sparkle: '✨', clap: '👏' };
function floatReaction(reaction) {
  if (!emoji[reaction]) return;
  const particle = document.createElement('span'); particle.className = 'floating-heart'; particle.textContent = emoji[reaction]; particle.style.left = `${24 + Math.random() * 62}%`;
  $('floating-reactions').append(particle);
  setTimeout(() => particle.remove(), 2900);
}
document.querySelectorAll('[data-reaction]').forEach(button => button.addEventListener('click', () => {
  if (!send({ type: 'reaction', reaction: button.dataset.reaction })) floatReaction(button.dataset.reaction);
}));

function closePeer() {
  if (state.pc) { state.pc.onnegotiationneeded = null; state.pc.onconnectionstatechange = null; state.pc.close(); }
  state.pc = null; state.audioSender = null; state.videoSender = null; state.remoteId = null; state.pendingCandidates = []; state.makingOffer = false; state.ignoreOffer = false; state.settingAnswer = false;
  state.remoteStream = new MediaStream(); $('remote-video').srcObject = null; $('remote-video').hidden = true; $('remote-avatar').hidden = false;
  $('mini-remote').srcObject = null; $('mini-call').hidden = true;
  $('remote-video').closest('.call-tile').classList.remove('has-video'); $('remote-sound').hidden = true;
}
function ensurePeer(remoteId) {
  if (!window.RTCPeerConnection) { $('call-caption').textContent = 'Calls need a newer browser'; return null; }
  if (state.pc && state.remoteId === remoteId) return state.pc;
  closePeer();
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  state.pc = pc; state.remoteId = remoteId;
  // One side creates the offer. The other adopts its transceivers when answering,
  // so there is exactly one negotiated audio lane and one video lane.
  if (state.selfId < remoteId) {
    state.audioSender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
    state.videoSender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
    attachLocalTracks().catch(() => {});
  }
  pc.onicecandidate = ({ candidate }) => { if (candidate) send({ type: 'signal', candidate }); };
  pc.onnegotiationneeded = async () => {
    if (state.selfId > remoteId) return;
    try {
      state.makingOffer = true;
      await pc.setLocalDescription();
      if (pc === state.pc) send({ type: 'signal', description: pc.localDescription });
    } catch { /* A disconnect during negotiation is handled by presence updates. */ }
    finally { state.makingOffer = false; }
  };
  pc.ontrack = event => {
    state.remoteStream.addTrack(event.track);
    $('remote-video').srcObject = state.remoteStream;
    $('mini-remote').srcObject = state.remoteStream;
    event.track.onunmute = renderRemoteMedia; event.track.onmute = renderRemoteMedia; event.track.onended = renderRemoteMedia;
    renderRemoteMedia();
  };
  pc.onconnectionstatechange = () => {
    if (pc !== state.pc) return;
    if (pc.connectionState === 'connected') $('call-caption').textContent = 'A little closer now';
    else if (pc.connectionState === 'failed') { $('call-caption').textContent = 'Call couldn’t connect'; toast('The camera call couldn’t connect on this network. Your shared movie and chat still work.'); }
    else if (pc.connectionState === 'disconnected') $('call-caption').textContent = 'Call reconnecting…';
  };
  return pc;
}
function renderRemoteMedia() {
  const partner = state.participants.find(person => person.id !== state.selfId);
  const visible = !!partner?.video && state.remoteStream.getVideoTracks().some(track => !track.muted && track.readyState === 'live');
  $('remote-video').hidden = !visible; $('remote-avatar').hidden = visible; $('mini-call').hidden = !visible;
  $('remote-video').closest('.call-tile').classList.toggle('has-video', visible);
  if (visible) $('mini-remote').play().catch(() => {});
  if (!partner?.audio) $('remote-sound').hidden = true;
  if (partner?.audio || visible) $('remote-video').play().then(() => { $('remote-sound').hidden = true; }).catch(() => { $('remote-sound').hidden = !partner?.audio; });
}
async function attachLocalTracks() {
  const audio = state.localStream.getAudioTracks()[0] || null;
  const video = state.screenStream?.getVideoTracks()[0] || state.localStream.getVideoTracks()[0] || null;
  await Promise.all([state.audioSender?.replaceTrack(audio), state.videoSender?.replaceTrack(video)]);
}
async function handleSignal(message) {
  if (!state.participants.some(person => person.id === message.from && person.id !== state.selfId)) return;
  const pc = ensurePeer(message.from);
  if (!pc) return;
  const polite = state.selfId > message.from;
  try {
    if (message.description) {
      const description = message.description;
      const readyForOffer = !state.makingOffer && (pc.signalingState === 'stable' || state.settingAnswer);
      const collision = description.type === 'offer' && !readyForOffer;
      state.ignoreOffer = !polite && collision;
      if (state.ignoreOffer) return;
      state.settingAnswer = description.type === 'answer';
      await pc.setRemoteDescription(description); state.settingAnswer = false;
      for (const candidate of state.pendingCandidates.splice(0)) await pc.addIceCandidate(candidate);
      if (description.type === 'offer') {
        for (const transceiver of pc.getTransceivers()) {
          transceiver.direction = 'sendrecv';
          if (transceiver.receiver.track.kind === 'audio') state.audioSender = transceiver.sender;
          else if (transceiver.receiver.track.kind === 'video') state.videoSender = transceiver.sender;
        }
        await attachLocalTracks();
        await pc.setLocalDescription(); send({ type: 'signal', description: pc.localDescription });
      }
    } else if (message.candidate) {
      if (state.ignoreOffer) return;
      if (!pc.remoteDescription) { if (state.pendingCandidates.length < 100) state.pendingCandidates.push(message.candidate); }
      else await pc.addIceCandidate(message.candidate);
    }
  } catch { state.settingAnswer = false; /* Keep the movie and chat available if the call cannot negotiate. */ }
}
function refreshLocalPreview() {
  const videoTrack = state.screenStream?.getVideoTracks()[0] || state.localStream.getVideoTracks()[0];
  const audioTrack = state.localStream.getAudioTracks()[0];
  $('local-video').srcObject = videoTrack ? new MediaStream([videoTrack]) : null;
  $('local-video').hidden = !videoTrack; $('local-avatar').hidden = !!videoTrack;
  $('local-video').closest('.call-tile').classList.toggle('has-video', !!videoTrack);
  const cameraOn = !!state.localStream.getVideoTracks().length;
  $('camera-button').setAttribute('aria-pressed', String(cameraOn));
  $('camera-button').setAttribute('aria-label', cameraOn ? 'Turn camera off' : 'Turn camera on');
  $('camera-button').innerHTML = icon(cameraOn ? 'camera' : 'camera-off');
  $('mic-button').setAttribute('aria-pressed', String(!!audioTrack));
  $('mic-button').setAttribute('aria-label', audioTrack ? 'Turn microphone off' : 'Turn microphone on');
  $('mic-button').innerHTML = icon(audioTrack ? 'mic' : 'mic-off');
  $('screen-button').setAttribute('aria-pressed', String(!!state.screenStream));
  $('screen-button').setAttribute('aria-label', state.screenStream ? 'Stop sharing screen' : 'Share screen');
  $('local-video').style.transform = state.screenStream ? 'none' : '';
  send({ type: 'call-state', video: !!videoTrack, audio: !!audioTrack });
}
async function toggleDevice(kind) {
  if (isPreview) { openDialog('preview-dialog'); return; }
  const button = kind === 'video' ? $('camera-button') : $('mic-button');
  button.disabled = true;
  try {
    const existing = state.localStream.getTracks().filter(track => track.kind === kind);
    if (existing.length) {
      for (const track of existing) { track.stop(); state.localStream.removeTrack(track); }
      const sender = kind === 'audio' ? state.audioSender : state.videoSender;
      if (state.pc && !(kind === 'video' && state.screenStream)) await sender?.replaceTrack(null);
    } else {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('secure-context');
      const stream = await navigator.mediaDevices.getUserMedia(kind === 'video' ? { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false } : { video: false, audio: { echoCancellation: true, noiseSuppression: true } });
      for (const track of stream.getTracks()) {
        state.localStream.addTrack(track);
        track.onended = () => { state.localStream.removeTrack(track); refreshLocalPreview(); };
        const sender = kind === 'audio' ? state.audioSender : state.videoSender;
        if (state.pc && !(kind === 'video' && state.screenStream)) await sender?.replaceTrack(track);
      }
    }
    refreshLocalPreview();
  } catch (error) {
    if (error.message === 'secure-context') toast('Camera and microphone need an HTTPS link. Ask your host for the secure app address.');
    else if (error.name === 'NotAllowedError') toast(`Allow ${kind === 'video' ? 'camera' : 'microphone'} access in your browser settings, then try again.`);
    else if (error.name === 'NotFoundError') toast(`No ${kind === 'video' ? 'camera' : 'microphone'} was found on this device.`);
    else toast('That device couldn’t start. Close other apps using it and try again.');
  } finally { button.disabled = false; }
}
$('mic-button').addEventListener('click', () => toggleDevice('audio'));
$('camera-button').addEventListener('click', () => toggleDevice('video'));
$('remote-sound').addEventListener('click', async () => {
  try { await $('remote-video').play(); $('remote-sound').hidden = true; } catch { toast('Check your phone’s sound settings and try again.'); }
});
$('mini-call').addEventListener('click', () => document.querySelector('.together-panel').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }));
async function stopScreen() {
  if (state.screenStream) { const stream = state.screenStream; state.screenStream = null; stream.getTracks().forEach(track => track.stop()); }
  if (state.pc) await state.videoSender?.replaceTrack(state.localStream.getVideoTracks()[0] || null);
  refreshLocalPreview();
}
if (!isPreview && navigator.mediaDevices?.getDisplayMedia) $('screen-button').hidden = false;
$('screen-button').addEventListener('click', async () => {
  if (isPreview) { openDialog('preview-dialog'); return; }
  if (state.screenStream) { await stopScreen(); return; }
  try {
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = state.screenStream.getVideoTracks()[0];
    track.onended = stopScreen;
    if (state.pc) await state.videoSender?.replaceTrack(track);
    refreshLocalPreview();
  } catch (error) { await stopScreen(); if (error.name !== 'NotAllowedError') toast('Screen sharing isn’t available here. Use the shared video player instead.'); }
});
function stopMedia() {
  state.localStream.getTracks().forEach(track => track.stop()); state.localStream = new MediaStream();
  state.screenStream?.getTracks().forEach(track => track.stop()); state.screenStream = null; refreshLocalPreview();
}
window.addEventListener('pagehide', () => { state.ws?.close(); stopMedia(); });
window.addEventListener('pageshow', event => { if (event.persisted && state.roomId && !state.connected) connectRoom(state.roomId, state.name, true).catch(error => toast(error.message)); });
window.addEventListener('online', () => { if (state.roomId && !state.connected) connectRoom(state.roomId, state.name, true).catch(error => toast(error.message)); });
function readInvitation() {
  const code = new URLSearchParams(location.hash.slice(1)).get('room');
  if (code && !state.roomId) showRoomForm('join', code);
}
window.addEventListener('hashchange', readInvitation);
readInvitation();
