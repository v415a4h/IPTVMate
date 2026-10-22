# IPTV Mate Web (starter)

A standalone browser-based IPTV playlist player prototype. This is separate from the Android/Kotlin application.

## Features
- Load an M3U playlist from a local file or a URL
- Parse channel names, logos, categories, and TVG IDs
- Search and filter channels
- Favourites and recently played channels (session only)
- HLS playback using hls.js where supported; native playback fallback
- Responsive layout and basic keyboard/TV-friendly controls

## Deploy to Cloudflare Pages
1. Add the `web` folder from this project to your GitHub repository.
2. In Cloudflare Dashboard, open **Workers & Pages** and create a Pages project connected to the GitHub repository.
3. Set **Root directory** to `web`.
4. For this plain HTML project, leave **Build command** empty and set **Build output directory** to `.`.
5. Deploy.

If the Pages setup asks for a build command, this project does not need one.

## Run locally
Open `index.html` in a modern browser or use a local static server. Some browsers restrict features when opened as a `file://` URL, so a local server is preferable.

## Known limitations
- A remote playlist URL must permit cross-origin browser requests (CORS). Otherwise, use a local playlist file or configure a trusted backend proxy.
- A localhost playlist URL refers to the device running the browser, not the computer/server where the playlist may be hosted.
- HLS playback depends on browser support and stream server CORS headers. Streams that need custom headers, cookies, tokens, DRM, or special authentication may not work.
- This prototype does not include an EPG, playlist persistence, Xtream Codes login, or a proxy backend.
- Do not expose private tokens or credentials in public playlist URLs or client-side code.
- Only use playlists and streams you are authorized to access.

## Suggested next steps
1. Add the existing IPTV Mate branding/logo.
2. Add an EPG XMLTV parser and guide UI.
3. Integrate the existing Cloudflare Worker safely, with an explicit upstream allowlist and correct HLS segment/playlist rewriting.
4. Add persistent user settings and a TV-specific focus-navigation pass.
