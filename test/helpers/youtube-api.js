// Contract fixture for the official iframe API. This tests our synchronization
// and error handling, not YouTube's network availability or video decoding.
export async function mockYouTube(context) {
  await context.route('https://www.youtube-nocookie.com/embed/**', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body style="background:#182822;color:white;font-family:sans-serif"><p>YouTube player test fixture</p></body></html>'
  }));
  await context.route('https://www.youtube.com/iframe_api', route => route.fulfill({
    contentType: 'application/javascript', body: `
      window.youTubeTest = { players: [], blockNextPlay: false };
      window.YT = { Player: class {
        constructor(frame, options) {
          this.frame=frame; this.events=options.events; this.status=5; this.time=0; this.muted=false; this.at=performance.now();
          window.youTubeTest.players.push(this);
          setTimeout(()=>{if(!this.dead)this.events.onReady({target:this})},20);
        }
        getCurrentTime(){return this.time+(this.status===1?(performance.now()-this.at)/1000:0)}
        getDuration(){return 180}
        getPlayerState(){return this.status}
        isMuted(){return this.muted}
        mute(){this.muted=true}
        unMute(){this.muted=false}
        setState(status){this.time=this.getCurrentTime();this.at=performance.now();this.status=status;queueMicrotask(()=>{if(!this.dead)this.events.onStateChange({data:status})})}
        playVideo(){if(window.youTubeTest.blockNextPlay){window.youTubeTest.blockNextPlay=false;this.events.onAutoplayBlocked();return}this.setState(1)}
        pauseVideo(){this.setState(2)}
        seekTo(time){this.time=time;this.at=performance.now()}
        nativePlay(){this.setState(1)}
        nativePause(){this.setState(2)}
        nativeSeek(time){this.seekTo(time)}
        error(code){this.events.onError({data:code})}
        destroy(){this.dead=true;this.frame.remove()}
      }};
      window.onYouTubeIframeAPIReady();
    `
  }));
}
