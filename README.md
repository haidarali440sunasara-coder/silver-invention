# Closer

A phone-friendly place for two people to watch a video, chat, and see each other. Built with Node.js, WebSockets, and WebRTC. No account or database required.

## Preview the design

Opening `public/index.html` in a file viewer cannot load its server-relative styles, scripts, or images. Run `npm run preview:build` and open the generated `closer-preview.html` instead. This single file embeds the styling, icons, script, and demo video, so the demo preview works without a server or an internet connection. It is explicitly marked as a preview: rooms, calls, YouTube, and websites need the live website. It does not create invitations or connect two phones. Regenerate it after frontend changes.

## Open it on a phone

You need the public HTTPS address from a hosting service. A workspace file link opens project files; publishing a cloud development environment saves that environment and does not create a public website.

An optional `render.yaml` prepares a single Node web service on Render's free plan:

1. Put these project files in your GitHub repository. An empty remote repository cannot be deployed, even if the files exist in the development workspace.
2. Sign in to Render, choose **New → Blueprint**, and connect that repository. Review the free web service defined in `render.yaml`, then deploy it.
3. Wait for the deployment to finish. Open the HTTPS address supplied by Render on both phones, then create and share a room.

The free service may sleep while idle; its next start can take time. A restart clears room codes, so create a new room after a restart. A public TURN relay may also be needed for camera calls between mobile networks; configure it using the settings below. Public hosting and real-phone calls require their own validation after deployment.

## Run

Use Node.js 24 LTS (22.9 or later also works).

```sh
npm ci
npm start
```

The server listens on port 3000. `npm run dev` restarts it when server files change. Refresh the browser after editing the frontend. Optional settings can be exported as environment variables or placed in a gitignored `.env` file; see `.env.example`.

## A date night on your phones

1. Open the hosted **HTTPS address** on both phones. On your phone, tap **Create our room** and enter your name.
2. Tap **Share invitation** and send the link to your partner. They enter their name to join. A room admits exactly two people and lasts six hours.
3. Tap **Choose video / site**, then paste a YouTube link or a direct HTTPS MP4/WebM link. The included 24-second ambient short also works. Play, pause, and seeking synchronize. Both phones may need one tap on Play to allow playback.
4. Turn on your camera and microphone with the call buttons, chat, and send reactions. Your partner’s camera appears in a little overlay on the movie on phones, so you can watch and see each other at the same time. Headphones help avoid echo.

You can add the site to your home screen: **Share → Add to Home Screen** in iPhone Safari, or the browser’s **Install / Add to Home screen** menu on Android. It runs as a web app; no app-store installation is required. Live rooms need an internet connection.

Phone browsers generally cannot broadcast their screen. Closer uses the shared video player on phones and shows a screen-sharing button only when the browser exposes that capability. Screen sharing sends video, without system audio. Use videos you have permission to share; direct video links must permit browser playback and use a codec supported by both phones.

## YouTube and websites

For YouTube, tap **Find a video on YouTube** in the chooser (opens a separate tab), choose **Share → Copy link** on a video, return to Closer, and paste it. Standard watch links, youtu.be links, Shorts, live-video links, and embed links are recognized. Closer uses YouTube's official iframe player and API; it does not download videos or bypass restrictions. YouTube's controls remain visible, with Closer's shared controls below the player. Private, removed, age/region-restricted, or embedding-disabled videos may not work; use the visible **Open on YouTube** link or choose another video. Ads and buffering can affect synchronization. No YouTube API key is required for video playback, and Closer does not provide an embedded YouTube search engine.

YouTube requires an HTTP Referer from the embedding website. The app and player use `strict-origin-when-cross-origin` to send only the site's origin to YouTube, not room codes (which live in the URL fragment). Keep this header when adding a reverse proxy. Open the live HTTPS site in a browser; local HTML previews and some in-app browsers can trigger YouTube error 153. External services receive normal browser requests when you choose their content.

For other websites, choose **Website**, paste an HTTPS address, and tap **Open website together**. Both participants receive that address in a sandboxed frame. Scrolling, clicks, logins, and videos inside the website are independent; this is not a remote-controlled browser. Browser security prevents reading another site's navigation or synchronizing its controls. Many sites, including streaming services, block embedding through `X-Frame-Options` or CSP; Closer respects those restrictions and always offers **Open in browser**. It does not proxy pages or remove security headers. Sharing another address updates both frames; clicking a link inside a frame only changes that participant's view.

## Host it

Use a host that runs a persistent Node.js service or the included Dockerfile, supports WebSocket upgrades at `/ws`, and provides HTTPS. Forward traffic to `$PORT` (default 3000). Run a **single instance**: rooms and synchronization state are stored in memory. Restarting the server clears all invitations. This is a small, self-hostable first version, without account recovery, recordings, or durable message history.

The app checks WebSocket and room-creation origins. If your reverse proxy rewrites the `Host` header, set `PUBLIC_ORIGIN` to the exact public origin, such as `https://closer.example.com`, with no trailing slash. Otherwise leave it unset. Health check: `GET /api/health` returns `{"ok":true}`.

For camera calls across mobile carriers, corporate networks, or restrictive NATs, configure your own **TURN relay**. A public STUN server is provided for direct connections, but it cannot relay calls. Set all three variables in your host’s secure environment settings:

| Variable | Purpose |
| --- | --- |
| `TURN_URL` | Relay URL, preferably `turns:your-relay.example:5349?transport=tcp` |
| `TURN_USERNAME` | Username issued by your TURN service |
| `TURN_CREDENTIAL` | Password issued by your TURN service |

The browser must be able to reach the relay. These settings are supplied to room participants for WebRTC authentication, as required by the protocol; use scoped or expiring relay credentials in production. The server does not proxy video calls. A room’s video playback, chat, and reactions work independently of the camera call and relay.

To build a container:

```sh
docker build -t closer .
docker run --rm -p 3000:3000 --env-file .env closer
```

Docker is optional; container build validation is separate from the Node/browser tests.

If your build environment requires an HTTPS proxy with a private certificate authority, Docker supports `--build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY` and this Dockerfile accepts `--secret id=build_ca,src=/path/to/trusted-ca.pem`. The CA is used only during installation, is not copied into the image, and TLS verification stays enabled.

## Validate

```sh
npm test
npm run test:browser
```

The server tests cover room capacity, expiry, cross-origin rejection, isolation, signaling, chat, video byte ranges, synchronization, late joins, and validation/canonicalization of YouTube and website links. Browser tests run two mobile-sized Chromium sessions and exercise playback/seek synchronization, chat text escaping, reactions, actual received camera frames, permissions, leaving, and rejection of a third participant. They also check the desktop view and error dialogs. YouTube browser tests use a contract fixture for the iframe API to verify synchronization, native control events, autoplay recovery, late joining, source changes, and failure handling. They do not verify YouTube's video availability or decoding: test an embeddable video on the deployed HTTPS site using both real phones. Website fixtures cover allowed and blocked embeds and the external-link fallback.

Browser tests use `/usr/bin/chromium` by default. Set `CHROMIUM_PATH` to a different Chromium executable when needed. Camera/microphone input in tests is synthetic. The runner starts a separate app server on a free port, so it does not interrupt your development server.

If managed Chromium disallows direct WebRTC UDP, use a TCP relay without changing that browser policy. On this Debian 13 cloud machine, run `sh scripts/setup-cloud-tests.sh` once. It downloads coturn and its missing libraries using official signed APT metadata, extracts them under `/workspace/.cache/closer-turn`, and leaves system packages untouched. The browser test runner detects that installation, starts an authenticated, loopback-only relay with temporary credentials, tests actual call media through it, and cleans it up afterward. Elsewhere, set `TEST_TURN_BIN` to your system coturn executable or supply your own TURN variables. The loopback test relay is not a relay for real phones.

Room codes are random invitation secrets. Share them only with your intended partner. Calls use WebRTC transport encryption; the server relays signaling, playback commands, and chat over the connection supplied by your host. Chat is rendered as text and stays only in participants’ current page memory; it is not written to a database. This is not an audited end-to-end encrypted messaging product.

The bundled illustration and 24-second ambient video were created for this project and are served locally. No external images or fonts are loaded.
