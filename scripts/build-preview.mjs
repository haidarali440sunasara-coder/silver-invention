// File viewers cannot resolve the app's /styles.css, /app.js, or SVG sprites.
// Bundle a clearly marked, offline preview without changing the hosted app.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = name => readFile(new URL(`public/${name}`, root));
const [htmlBytes, cssBytes, scriptBytes, spriteBytes, poster, movie, favicon, mediaBytes, youtubeBytes] = await Promise.all(
  ['index.html', 'styles.css', 'app.js', 'icons.svg', 'poster.svg', 'media/together.mp4', 'icon-192.png', 'media.js', 'youtube.js'].map(read)
);
const dataURL = (type, bytes) => `data:${type};base64,${bytes.toString('base64')}`;
const icons = Object.fromEntries([...spriteBytes.toString().matchAll(/<symbol id="([^"]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g)]
  .map(([, name, viewBox, body]) => [name, `<svg aria-hidden="true" viewBox="${viewBox}">${body}</svg>`]));
if (!icons.heart || !icons.play) throw new Error('Could not read the icon sprite.');

let html = htmlBytes.toString();
let script = [mediaBytes.toString().replace(/^export /gm, ''), youtubeBytes.toString().replace(/^export /gm, ''), scriptBytes.toString().replace(/^import .*;\n/gm, '')].join('\n');
const iconFactory = 'const icon = name => `<svg aria-hidden="true"><use href="/icons.svg#${name}"></use></svg>`;';
if (!script.includes(iconFactory)) throw new Error('Update the preview bundler for the new icon factory.');
script = script.replace(iconFactory, () => `const previewIcons = ${JSON.stringify(icons)};\nconst icon = name => previewIcons[name] || '';`);

const css = cssBytes.toString().replace(/^@import url\('\/fonts.css'\);\s*/, '') + `
.preview-notice{padding:12px 20px;background:#e9ecdf;color:#42563d;text-align:center;font-size:12px;line-height:1.6}
.preview-notice strong{display:block}
`;
html = html.replace('<html lang="en">', '<html lang="en" data-preview="true">')
  .replace('<title>Closer — a little place for two</title>', '<title>Closer — interactive preview</title>')
  .replace(/  <link rel="(?:icon|apple-touch-icon|manifest)"[^>]*>\n/g, '')
  .replace('  <link rel="stylesheet" href="/styles.css">', () => `<link rel="icon" href="${dataURL('image/png', favicon)}"><style>${css}</style>`)
  .replace('  <script type="module" src="/app.js"></script>\n', '')
  .replace('href="/" aria-label="Closer home"', 'href="#" aria-label="Closer home"')
  .replace(/<svg><use href="\/icons.svg#([^"]+)"><\/use><\/svg>/g, (_, name) => {
    if (!icons[name]) throw new Error(`Missing icon: ${name}`);
    return icons[name];
  })
  .replaceAll('/poster.svg', dataURL('image/svg+xml', poster))
  .replace('src="/media/together.mp4"', () => `src="${dataURL('video/mp4', movie)}"`)
  .replace('<body>', `<body>
  <aside class="preview-notice" aria-label="Preview information"><strong>Try Closer on this phone</strong>Play the short and explore. Rooms and calls need the live website.</aside>
  <noscript><p class="preview-notice">Open this file in a browser with JavaScript enabled to use the video controls.</p></noscript>`)
  .replace('</body>', () => `
  <dialog id="preview-dialog" aria-labelledby="preview-title">
    <button class="dialog-close icon-button" data-close aria-label="Close">${icons.close}</button>
    <span class="dialog-symbol">♡</span><p class="eyebrow">YOU’RE EXPLORING THE PREVIEW</p>
    <h2 id="preview-title">A little look at <em>us.</em></h2>
    <p class="dialog-copy">You can play the short and try the controls here. To watch, chat, and call together, both phones need Closer’s live website address.</p>
    <p class="dialog-copy">The live website hasn’t been set up yet. This preview cannot connect two phones.</p>
    <button class="button button-primary dialog-submit" data-close>Keep exploring ${icons.heart}</button>
  </dialog>
  <script>${script.replace(/<\/script/gi, '<\\/script')}</script>
</body>`);

if (/<(?:link|script|img|use)\b[^>]*(?:href|src)="\//.test(html)) throw new Error('The preview still has external assets.');
const output = new URL('closer-preview.html', root);
await writeFile(output, html);
console.log(`Created ${fileURLToPath(output)} (${Buffer.byteLength(html)} bytes)`);
