const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);

// Shared by the browser and room server so every participant receives the same
// validated source. No remote page is fetched or proxied through the server.
export function normalizeMedia({ url: value, title, kind = 'video' }) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Paste a complete HTTPS link.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048) throw new Error('Use an HTTPS link without a username or password.');
  if (!['video', 'url', 'youtube', 'website'].includes(kind)) throw new Error('Choose a YouTube video, video file, or website.');
  const name = typeof title === 'string' ? title.trim().slice(0, 80) : '';
  if (youtubeHosts.has(url.hostname)) {
    const parts = url.pathname.split('/').filter(Boolean);
    const id = url.hostname.endsWith('youtu.be') ? parts[0] : url.pathname === '/watch' ? url.searchParams.get('v') : ['embed', 'shorts', 'live'].includes(parts[0]) ? parts[1] : null;
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('Copy the link to a specific YouTube video using Share → Copy link.');
    return { kind: 'youtube', url: `https://www.youtube.com/watch?v=${id}`, videoId: id, title: name || 'Our YouTube pick' };
  }
  if (kind === 'youtube') throw new Error('Use a link from YouTube or youtu.be.');
  if (kind === 'website') return { kind, url: url.href, title: name || url.hostname };
  if (/(^|\.)(netflix\.com|vimeo\.com|disneyplus\.com)$/.test(url.hostname)) throw new Error('Choose Website for a web page, or paste a direct MP4/WebM video link. Some streaming sites block embedding.');
  return { kind: 'url', url: url.href, title: name || 'Our movie' };
}
