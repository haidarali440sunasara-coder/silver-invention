let apiPromise;
function loadYouTubeAPI() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const previous = window.onYouTubeIframeAPIReady;
    const timeout = setTimeout(() => fail(), 15000);
    function fail() {
      clearTimeout(timeout); script.remove(); apiPromise = null;
      window.onYouTubeIframeAPIReady = previous;
      reject(new Error('YouTube couldn’t load. Check your connection, then try again.'));
    }
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timeout); previous?.(); resolve(window.YT);
    };
    script.src = 'https://www.youtube.com/iframe_api';
    script.referrerPolicy = 'strict-origin-when-cross-origin';
    script.onerror = fail;
    document.head.append(script);
  });
  return apiPromise;
}

export class YouTubePlayer {
  constructor(container, media, callbacks) {
    this.callbacks = callbacks; this.ready = false; this.destroyed = false;
    this.suppressUntil = 0; this.blocked = false; this.sample = null;
    this.frame = document.createElement('iframe');
    this.frame.title = 'YouTube video player';
    this.frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
    this.frame.allowFullscreen = true;
    // YouTube requires a Referer (error 153 when absent).
    this.frame.referrerPolicy = 'strict-origin-when-cross-origin';
    const source = new URL(`https://www.youtube-nocookie.com/embed/${media.videoId}`);
    source.search = new URLSearchParams({ enablejsapi: '1', playsinline: '1', rel: '0', origin: location.origin }).toString();
    this.frame.src = source.href;
    container.replaceChildren(this.frame);
    this.start();
  }
  async start() {
    try {
      const YT = await loadYouTubeAPI();
      if (this.destroyed) return;
      this.readyTimeout = setTimeout(() => this.fail('YouTube is taking too long to respond. Try again or open the video on YouTube.'), 20000);
      this.player = new YT.Player(this.frame, { events: {
        onReady: () => {
          if (this.destroyed) return;
          clearTimeout(this.readyTimeout); this.ready = true;
          this.timer = setInterval(() => this.poll(), 250);
          this.callbacks.ready();
        },
        onStateChange: event => {
          if (!this.ready || this.destroyed) return;
          if (event.data === 1) this.blocked = false;
          if ([0, 1, 2].includes(event.data) && !this.blocked && performance.now() >= this.suppressUntil) this.callbacks.change(this.paused, this.currentTime);
          this.sample = null; this.callbacks.render();
        },
        onAutoplayBlocked: () => { if (!this.destroyed) { this.blocked = true; this.callbacks.blocked(); } },
        onError: event => {
          const messages = {
            2: 'That YouTube video link is invalid. Choose another video.',
            5: 'This YouTube video couldn’t play in this browser. Try another video.',
            100: 'This YouTube video is private, removed, or unavailable.',
            101: 'The owner doesn’t allow this video in other apps. Choose another video or open it on YouTube.',
            150: 'The owner doesn’t allow this video in other apps. Choose another video or open it on YouTube.',
            153: 'YouTube needs the live website address. Open Closer’s HTTPS link in your browser.'
          };
          this.fail(messages[event.data] || 'YouTube couldn’t play this video. Try another video or open it on YouTube.');
        }
      } });
    } catch (error) { this.fail(error.message); }
  }
  fail(message) { if (!this.destroyed) { clearTimeout(this.readyTimeout); this.callbacks.error(message); } }
  get currentTime() { return this.ready ? this.player.getCurrentTime() || 0 : 0; }
  get duration() { return this.ready ? this.player.getDuration() || 0 : 0; }
  get paused() { return !this.ready || ![1, 3].includes(this.player.getPlayerState()); }
  get muted() { return this.ready && this.player.isMuted(); }
  mute(value) { if (this.ready) value ? this.player.mute() : this.player.unMute(); }
  seek(time) { if (this.ready) { this.pendingConfirmation = true; this.suppressUntil = performance.now() + 1200; this.sample = null; this.player.seekTo(time, true); } }
  play() { if (this.ready) { this.pendingConfirmation = true; this.blocked = false; this.suppressUntil = performance.now() + 1200; this.player.playVideo(); } }
  pause() { if (this.ready) { this.pendingConfirmation = true; this.suppressUntil = performance.now() + 1200; this.player.pauseVideo(); } }
  poll() {
    if (this.destroyed || !this.ready) return;
    const sample = { time: this.currentTime, at: performance.now(), status: this.player.getPlayerState() };
    const previous = this.sample;
    // Reconcile after commands settle, including a native user click made
    // during the short echo-suppression window.
    if (this.pendingConfirmation && !this.blocked && sample.at >= this.suppressUntil && [0, 1, 2].includes(sample.status)) {
      this.pendingConfirmation = false; this.callbacks.change(this.paused, sample.time);
    }
    // Native YouTube controls do not expose a seek event. Detect a jump from
    // the previous local position, rather than confusing clock drift with a seek.
    if (!this.blocked && previous && sample.at >= this.suppressUntil && previous.status === sample.status && [1, 2].includes(sample.status)) {
      const expected = previous.time + (sample.status === 1 ? (sample.at - previous.at) / 1000 : 0);
      if (Math.abs(sample.time - expected) > 1.5) this.callbacks.change(this.paused, sample.time);
    }
    this.sample = sample; this.callbacks.render();
  }
  destroy() {
    this.destroyed = true; this.ready = false;
    clearInterval(this.timer); clearTimeout(this.readyTimeout);
    this.player?.destroy(); this.frame.remove();
  }
}
