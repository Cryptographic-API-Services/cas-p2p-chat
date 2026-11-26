# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Keep the docs current

**After every change, update `README.md` and this `CLAUDE.md` in the same change, without being asked.**
`README.md` is the user-facing reference (running it, the server, what is stored, the protocol,
limits). `CLAUDE.md` is the contributor reference (commands, architecture, conventions). Update
them when you:

- add, rename or remove an npm script, command-line option (`--name`, `--profile`, `--server`,
  `--smoke-test`, `--screenshot`) or server environment variable (`PORT`, `HOST`, `DB_PATH`,
  `ICE_SERVERS`, `TRUST_PROXY`);
- change the wire protocol, the directory record format or API, signaling, what the server
  stores or sees, or any security property described in either file;
- add or move a source folder, a dependency, or a build step;
- fix or remove something listed under "Limits, and what to build next" in the README.

If a statement in either file is no longer true, fix it. Don't leave it for later.

## What this is

CAS P2P Chat is an end-to-end encrypted, peer-to-peer desktop chat. It's an Electron app with a
Vue 3 + Vuetify 4 + Tailwind CSS v4 UI. The crypto comes from
[cas-typescript-sdk](https://www.npmjs.com/package/cas-typescript-sdk), a native N-API addon
wrapping the Rust `cas-lib`. Peers connect **only** over WebRTC data channels, dialed by
fingerprint. The Express server (`src/server/`) provides PeerJS signaling plus an opt-in
"find someone by name" directory. There is no direct TCP/LAN mode, and nothing stores, shows or
exchanges IP addresses at the app level.

## Commands

```bash
npm install          # postinstall runs scripts/ensure-electron.mjs (npm may skip Electron's own download)
npm run build        # clean → tsc (main, core, server, tests) → vue-tsc + vite build (UI + transport page)
npm run server       # chat server on :8787 (signaling + directory, SQLite in ./directory.db)
npm start            # build, then run the app
npm run start:alice  # profile "alice", joins http://127.0.0.1:8787; start:bob likewise (run the server first)
npm test             # build:main, then node --test on dist/test/**/*.test.js (no Electron needed)
npm run smoke        # build, then launch the real app hidden and drive the Vue UI end to end
npm run smoke -- --screenshot=out.png   # also save a PNG of the window
```

- Run one test file: `npm run build:main && node --test dist/test/protocol.test.js`. Filter by
  name with `--test-name-pattern="replay"`.
- `npm test` doesn't build the renderer. Run `npm run build:renderer` (vue-tsc type-check +
  Vite) after UI changes, or `npm run smoke`, which does both and checks the UI really works.
- Before finishing a change, run `npm test` **and** `npm run smoke`. The smoke test is the only
  test of WebRTC and signaling: they need Chromium, and PeerJS's server keeps Node alive with
  un-`unref`'d timers, so the node tests create the server with `signaling: false`.

## Architecture

```
src/core/      Plain Node, no Electron: protocol, identity, peer-id (fingerprint ↔ PeerJS ID),
               signaling-token, ChatNode (runs any FrameLink), TrustStore (= contacts),
               signed directory records, DirectoryClient. Everything here is unit-tested.
src/server/    app.ts (createChatServer: routes + http server), signaling.ts (PeerJS mount with
               token-checked WebSocket upgrades, in-memory Presence), peer-store.ts (node:sqlite),
               rate-limit.ts, server.ts (entry).
src/main/      main.ts, preload.ts (UI bridge), transport-preload.ts (transport bridge),
               webrtc-bridge.ts (hidden transport window ↔ FrameLinks), server-sync.ts (join,
               signaling token, reconnect backoff, listing), smoke-test.ts.
src/renderer/  Vite multi-page: index.html (Vue UI: store.ts, App.vue, components/, app.css) and
               transport.html (transport.ts: the PeerJS client, no UI).
src/shared/    api.d.ts (UI ↔ main, window.chat) and transport.d.ts (transport ↔ main,
               window.transport). Ambient global types, no imports.
test/          node:test suites; helpers/memory-link.ts is an in-memory FrameLink pair.
```

- **Two TypeScript builds.** `tsconfig.json` (CommonJS, `nodenext`) builds core, main, server
  and tests into `dist/`. `tsconfig.renderer.json` is type-check only (`vue-tsc`). Vite builds
  both pages into `dist/src/renderer`, which the main process opens with `loadFile`. A new
  top-level source folder must be added to the right tsconfig's `include`: `src/server/` was
  once missing, so `server.js` silently wasn't emitted.
- **TypeScript is pinned to 6.0.** TypeScript 7 has no JavaScript API, and `vue-tsc` needs one.
  Don't upgrade until `vue-tsc` supports TypeScript 7.
- Under `nodenext`, dynamic `import()` in main-process code is real ESM and needs a `.js`
  extension (`await import("./smoke-test.js")`). Static imports don't.
- `node:sqlite` needs Node 22.13+ (the server) and works in Electron 45's Node 24 (the smoke test
  runs the server in-process).
- The `peer` package types `ws` in ESM resolution mode, so its `ServerOptions` and ours are
  different types; `signaling.ts` casts at that one boundary.

### Transport and signaling

- WebRTC exists only in Chromium, so `WebRtcBridge` creates a hidden, sandboxed
  `BrowserWindow` (with `backgroundThrottling: false`) that runs PeerJS. It only moves opaque
  strings, which are frames the main process has already signed and encrypted. Keys never go
  there. Each bridge has its own window; `ipcMain` routes `transport:event` by sender ID.
- A device's PeerJS ID is `fingerprintToPeerId(fingerprint)` (`cas-` + 32 hex). The server's
  `verifyClient` refuses the WebSocket upgrade unless the `token` is a fresh Ed25519 signature
  for that ID (`signaling-token.ts`, valid 24 h, renewed after 12 h). Inbound connections are
  adopted with `expectedFingerprint` = the dialer's ID, and outbound with the dialed
  fingerprint, so the handshake must prove the identity the signaling ID claims.
- `ServerSync` reuses the same token across reconnects, so the server treats them as one
  client. A brand-new token while an old session lingers gets `ID-TAKEN` until the old one
  times out (~60 s); the retry backoff handles that.
- **No IP addresses at the app level.** Don't add LAN/TCP connections, address display, or any
  server-side field or log that holds an IP. `verifyRegistration` rejects unknown fields, so
  nothing can ride along in a listing. The in-memory rate limiter is the only per-IP state.

### Crypto and protocol (`src/core/protocol.ts`, `directory-record.ts`, `signaling-token.ts`)

- Identity: a long-term Ed25519 key. Session: a fresh X25519 key pair per connection, which is
  the HPKE key pair (cas-lib's suite is DHKEM(X25519, HKDF-SHA256), HKDF-SHA512, AES-256-GCM).
  Each message is HPKE-sealed with AAD `sessionId ‖ sender session key ‖ seq`, then
  Ed25519-signed. `seq` must be exactly the next number.
- Every signed or hashed input starts with a fixed context string (`cas-p2p-chat/v1/...`,
  `cas-p2p-chat/v2/directory-...`). Variable-length fields are length-prefixed. Keep it that
  way, and use a **new** context string for any new signature purpose.
- **Any wire-format change** (frames, payload, transcript, signed bytes) must bump `PROTOCOL_ID`,
  or old and new peers will fail in confusing ways. For directory record bytes, bump the context
  version (as v1 → v2 did when IPs were removed), and bump `SCHEMA_VERSION` in `peer-store.ts`
  if the table changes.
- Bytes cross the SDK boundary as `number[]` (`Bytes` in `bytes.ts`). Wrap SDK errors: check them
  with `isCasError` and rethrow as `ProtocolError`, which closes the connection with that reason.
- Anything a peer, the transport window or the server sends is untrusted. Validate shape,
  lengths and types before use (see `expectFrame`, `fromBase64(value, field, length)`,
  `validateName`, `WebRtcFrameLink.deliver`).

### Main process and IPC

- Keys stay in the main process. The UI only gets names, fingerprints and text.
- **Adding an IPC call** takes four places: the type in `src/shared/api.d.ts` (`ChatApi`, plus
  `ApiEvent` for pushes), the `ipcRenderer.invoke` in `src/main/preload.ts`, a `handle(...)` in
  `src/main/main.ts` (it checks the sender is our window; validate every argument there), and an
  action in `src/renderer/store.ts`.
- Both windows are `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and
  block navigation, pop-ups and permission requests. The UI's CSP has no `connect-src`; the
  transport page allows `ws: wss:` only. Keep all of these.
- The identity key is sealed with `safeStorage` (the async API; the sync one is deprecated in
  Electron 45). Files in userData: `identity.json`, `known-peers.json` (contacts),
  `settings.json` (`serverUrl`, `listed`).
- Closing the main window quits the app (the hidden transport window would otherwise keep it
  running).

### Renderer (Vue + Vuetify + Tailwind)

- Components bind to `store.ts`. Put logic there, not in components. Conversations are keyed
  by fingerprint and seeded from contacts; `conversation.peer` is the live connection, or null.
- **Never use `v-html`.** Peer text must go through `{{ }}` interpolation.
- Styling: use Vuetify for components and Tailwind classes for layout and custom styling. Don't
  use Vuetify's helper classes (`d-flex`, `ga-2`, `text-caption`, …) or scoped CSS for things
  Tailwind covers.
- `src/renderer/app.css` declares the cascade-layer order: Tailwind base → every
  `vuetify-*` layer → Tailwind `components`/`utilities` → `vuetify-final`. It must stay the first
  CSS imported (`main.ts`). Tailwind colors come from Vuetify theme variables and use distinct
  names (`brand`, `on-brand`, `bubble`, `muted`, `line`). Don't name one `primary`, `surface`,
  etc., because those collide with classes Vuetify generates.
- The CSP in `index.html` allows inline styles (Vuetify injects its theme `<style>`), but
  scripts are `'self'` only. Don't add anything that needs `eval` or inline scripts.
- Icons are `@mdi/js` SVG paths (`:icon="mdiSend"`), bundled with the app, never fetched.
- Optional boolean props default to `false` when absent, not `undefined`. That's why `TrustChip`
  takes `offline`, not `online`.
- `vue-tsc` mistypes the imported reactive `state` as a ref inside `<template v-else>` blocks
  (`Property 'value' does not exist`). Read it through a `computed` there, as `ServerCard.vue`
  does with `found`.
- The smoke test (`src/main/smoke-test.ts`) finds elements by `data-testid`. When you rename or
  restructure UI, keep those attributes or update the smoke test in the same change.

### Server

- The server is untrusted by design. It verifies listings on the way in (fresh timestamps,
  monotonically increasing per peer, signed deletions with tombstones), but clients verify again
  and recompute fingerprints. Never make the app trust a server-provided fingerprint or name.
- Data minimization is a feature. Don't store or log anything new about peers (or who looks up
  or connects to whom) without updating the README's "What is stored" section. Search needs 2+
  characters; there is deliberately no "list everyone" endpoint.

## Git

Don't commit `dist/`, `node_modules/` or `directory.db*` (all git-ignored).
