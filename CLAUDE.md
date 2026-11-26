# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Keep the docs current

**After every change, update `README.md` and this `CLAUDE.md` in the same change, without being asked.**
`README.md` is the user-facing reference (running it, the server, what is stored, the protocol,
limits). `CLAUDE.md` is the contributor reference (commands, architecture, conventions). Update
them when you:

- add, rename or remove an npm script, command-line option (`--name`, `--profile`, `--server`,
  `--smoke-test`, `--screenshot`) or server environment variable (`PORT`, `HOST`,
  `DATABASE_URL`, `ICE_SERVERS`, `TRUST_PROXY`, `USE_MANAGED_IDENTITY`,
  `MANAGED_IDENTITY_CLIENT_ID`);
- change the wire protocol, the directory record format or API, signaling, what the server
  stores or sees, or any security property described in either file;
- add or move a source folder or workspace, a dependency, a build step, or deployment or
  release configuration (`apps/server/Dockerfile`, `deploy/azure/`, `.github/workflows/`,
  `apps/desktop/electron-builder.yml`, `release-please-config.json`);
- fix or remove something listed under "Limits, and what to build next" in the README.

If a statement in either file is no longer true, fix it. Don't leave it for later.

## What this is

CAS P2P Chat is an end-to-end encrypted, peer-to-peer desktop chat. It's an Electron app with a
Vue 3 + Vuetify 4 + Tailwind CSS v4 UI. The crypto comes from
[cas-typescript-sdk](https://www.npmjs.com/package/cas-typescript-sdk), a native N-API addon
wrapping the Rust `cas-lib`. Peers connect **only** over WebRTC data channels, dialed by
fingerprint. The Express server (`apps/server/`) provides PeerJS signaling plus an opt-in
"find someone by name" directory in PostgreSQL (Drizzle ORM). There is no direct TCP/LAN mode,
and nothing stores, shows or exchanges IP addresses at the app level.

It's an npm workspaces monorepo: `packages/core` (`@cas-p2p-chat/core`, shared protocol code),
`apps/server` (`@cas-p2p-chat/server`, deployed as a container to Azure Container Apps) and
`apps/desktop` (`@cas-p2p-chat/desktop`, the Electron app). The two apps deploy separately.

## Commands

Run these from the repository root (they forward to the workspaces):

```bash
npm install          # the desktop workspace's postinstall runs scripts/ensure-electron.mjs
npm run build        # clean → typecheck (core, server) → desktop: tsc -b (main + core's dist) → vue-tsc + vite
npm run typecheck    # tsc -b packages/core && tsc -p apps/server
npm run server       # chat server on :8787, straight from .ts (directory in PGlite, apps/server/directory-data/)
npm start            # build, then run the app
npm run start:alice  # profile "alice", joins http://127.0.0.1:8787; start:bob likewise (run the server first)
npm test             # typecheck, then node --test on the .ts tests of core and server (no build, no Electron)
npm run smoke        # build, then launch the real app hidden and drive the Vue UI end to end
npm run smoke -- --screenshot=out.png   # also save a PNG of the window (path relative to apps/desktop)
npm run dist -- --win  # build, then package installers into apps/desktop/release (or --mac, --linux)
npm run db:generate -w @cas-p2p-chat/server   # after editing apps/server/src/schema.ts: write a migration
```

- Run one test file: `cd packages/core && node --test test/protocol.test.ts`; for the server,
  `cd apps/server && node --conditions=cas-source --test test/directory.test.ts`. Filter by
  name with `--test-name-pattern="replay"`.
- `npm test` doesn't build the renderer. Run `npm run build:renderer -w @cas-p2p-chat/desktop`
  (vue-tsc type-check + Vite) after UI changes, or `npm run smoke`, which does both and checks
  the UI really works.
- Before finishing a change, run `npm test` **and** `npm run smoke`. The smoke test is the only
  test of WebRTC and signaling: they need Chromium, and PeerJS's server keeps Node alive with
  un-`unref`'d timers, so the node tests create the server with `signaling: false`.
- Server image: `docker build --platform linux/amd64 -f apps/server/Dockerfile -t cas-p2p-chat-server .`
  (from the root; it needs `packages/core`). Azure: `deploy/azure/setup.sh` (one-time CLI
  setup, re-runnable) and `.github/workflows/deploy-server.yml` (deploys on pushes to `main`
  that touch the server or core). Both are described in the README.

## Releases

- **release-please** (`release-please-config.json`, `.release-please-manifest.json`,
  `.github/workflows/release.yml`) versions the desktop app. The released package is the repo
  root (`.`), so commits to `packages/core` count, while `exclude-paths` skips commits that only
  touch the server (`apps/server`, `deploy/`). `extra-files` keeps `apps/desktop/package.json`
  and its `package-lock.json` entry at the same version; electron-builder reads the version
  from there. Tags are `v<version>`.
- PRs are squash-merged, and `pr-title.yml` requires a Conventional Commits title (`feat:`,
  `fix:`, `security:`, …): that title becomes the changelog line and picks the version bump.
- When a release is created, `test` runs, then `package` builds on `windows-latest`,
  `macos-latest` and `ubuntu-latest` and uploads the installers to the release with
  `gh release upload`. Actions are pinned to commit SHAs (as in cas-typescript-sdk).
- **Every build is x64**, including macOS (built on an arm64 runner; runs under Rosetta 2 on
  Apple Silicon). cas-typescript-sdk ships only x64 `.node` binaries. Add arm64 targets in
  `electron-builder.yml` once it ships arm64 ones.
- `electron-builder.yml`: `npmRebuild: false` (the SDK's N-API binaries are prebuilt and
  ABI-stable), `asarUnpack: **/*.node`, and per-platform `files` filters that drop the other
  platforms' SDK binaries. Linux needs `executableName`, because the default comes from the
  scoped package name.
- **Electron is pinned to an exact version** in `apps/desktop/package.json`: it's hoisted to the
  root `node_modules`, and electron-builder can't resolve a range from there.
- Builds are unsigned (`mac.identity: null`, no Windows certificate). Signing is listed under
  the README's Limits.

## Architecture

```
packages/core/src/    Plain Node, no Electron: protocol, identity, peer-id (fingerprint ↔ PeerJS
                      ID), signaling-token, ChatNode (runs any FrameLink), TrustStore (= contacts),
                      signed directory records, DirectoryClient. Everything here is unit-tested.
packages/core/test/   node:test suites; helpers/memory-link.ts is an in-memory FrameLink pair.
apps/server/src/      app.ts (createChatServer: routes + http server), signaling.ts (PeerJS mount
                      with token-checked WebSocket upgrades, in-memory Presence), schema.ts (the
                      Drizzle table), db.ts (openDatabase: node-postgres or PGlite, runs
                      migrations), peer-store.ts, rate-limit.ts, server.ts (entry).
apps/server/drizzle/  SQL migrations generated by drizzle-kit (commit them, never edit applied ones).
apps/server/test/     directory, server API, peer store and DirectoryClient tests.
apps/desktop/src/main/      main.ts, preload.ts (UI bridge), transport-preload.ts (transport
                      bridge), webrtc-bridge.ts (hidden transport window ↔ FrameLinks),
                      server-sync.ts (join, signaling token, reconnect backoff, listing), smoke-test.ts.
apps/desktop/src/renderer/  Vite multi-page: index.html (Vue UI: store.ts, App.vue, components/,
                      app.css) and transport.html (transport.ts: the PeerJS client, no UI).
apps/desktop/src/shared/    api.d.ts (UI ↔ main, window.chat) and transport.d.ts (transport ↔
                      main, window.transport). Ambient global types, no imports.
deploy/azure/         setup.sh (Azure CLI: resource group, identity, registry, Container Apps
                      environment + app, database and role on the existing PostgreSQL server,
                      GitHub federated sign-in and secrets) and cloudflare-ingress.sh (allow
                      only Cloudflare's IP ranges; re-run when they change).
```

- **How each package runs.**
  - `core` and `server` are ESM (`"type": "module"`) and **Node runs their `.ts` directly**
    (type stripping; Node 22.18+, Node 26 in the Docker image). There's no server build. So
    write only erasable TypeScript (no enums, namespaces or constructor parameter properties),
    import relative files with their `.ts` extension, and use `import type` for types. Their
    tsconfigs set `erasableSyntaxOnly` and `verbatimModuleSyntax`, so `tsc` catches mistakes.
  - Core's `exports` resolves `@cas-p2p-chat/core/<module>` to `src/<module>.ts` under the
    custom condition `cas-source` (the server and its tests run with
    `--conditions=cas-source`), and to the compiled `dist/src/<module>.js` otherwise.
  - The desktop main process is CommonJS compiled by `tsc -b`, which also builds core's `dist/`
    through a project reference (`rewriteRelativeImportExtensions` turns `.ts` imports into
    `.js`). Electron loads core's ESM output with `require(esm)`. `tsconfig.renderer.json` is
    type-check only (`vue-tsc`); Vite builds both pages into `apps/desktop/dist/renderer`, which
    the main process opens with `loadFile`.
  - A new source folder must be added to the right tsconfig's `include`.
- **TypeScript is pinned to 6.0.** TypeScript 7 has no JavaScript API, and `vue-tsc` needs one.
  Don't upgrade until `vue-tsc` supports TypeScript 7.
- Under `nodenext`, dynamic `import()` in main-process code is real ESM and needs a `.js`
  extension (`await import("./smoke-test.js")`). Static imports don't.
- **Database.** PostgreSQL through Drizzle. `openDatabase(DATABASE_URL)` picks node-postgres for
  `postgres://` URLs and embedded [PGlite](https://pglite.dev) for `pglite:<dir>` or
  `pglite:memory` (local runs, tests, smoke test), and applies pending migrations at startup.
  Both drivers are typed as one `Database` (`PgDatabase`), so write queries once. `PeerStore`
  is async; `register` and `delete` run in transactions with `SELECT … FOR UPDATE`, and the
  upsert only overwrites an older timestamp, so concurrent requests can't reorder a replay
  guard.
- **Production database sign-in is passwordless.** `rust-playground-pg` accepts Entra ID only.
  With `USE_MANAGED_IDENTITY`, `managed-identity.ts` fetches a token from Container Apps'
  `IDENTITY_ENDPOINT` (cached until 5 minutes before expiry) and `db.ts` passes it as `pg`'s
  password function. `db.ts` parses `DATABASE_URL` itself (`parseIntoClientConfig`) instead of
  passing `connectionString`, because `pg` would let the URL's empty password override the
  function. The identity's PostgreSQL role owns `cas_p2p_chat` (and has `ALL` on `public`,
  which Azure creates owned by `azure_pg_admin`), so the server runs its own migrations.
- The smoke test can't import the server (Electron can't run its `.ts`), so it spawns
  `apps/server/src/server.ts` with the Node that ran npm (`npm_node_execpath`), `PORT=0`, and
  reads the URL from the startup log. Keep that log line's format.
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

### Crypto and protocol (`packages/core/src/protocol.ts`, `directory-record.ts`, `signaling-token.ts`)

- Identity: a long-term Ed25519 key. Session: a fresh X25519 key pair per connection, which is
  the HPKE key pair (cas-lib's suite is DHKEM(X25519, HKDF-SHA256), HKDF-SHA512, AES-256-GCM).
  Each message is HPKE-sealed with AAD `sessionId ‖ sender session key ‖ seq`, then
  Ed25519-signed. `seq` must be exactly the next number.
- Every signed or hashed input starts with a fixed context string (`cas-p2p-chat/v1/...`,
  `cas-p2p-chat/v2/directory-...`). Variable-length fields are length-prefixed. Keep it that
  way, and use a **new** context string for any new signature purpose.
- **Any wire-format change** (frames, payload, transcript, signed bytes) must bump `PROTOCOL_ID`,
  or old and new peers will fail in confusing ways. For directory record bytes, bump the context
  version (as v1 → v2 did when IPs were removed). For a table change, edit
  `apps/server/src/schema.ts` and run `npm run db:generate -w @cas-p2p-chat/server`; the server
  applies the new migration at startup.
- Bytes cross the SDK boundary as `number[]` (`Bytes` in `bytes.ts`). Wrap SDK errors: check them
  with `isCasError` and rethrow as `ProtocolError`, which closes the connection with that reason.
- Anything a peer, the transport window or the server sends is untrusted. Validate shape,
  lengths and types before use (see `expectFrame`, `fromBase64(value, field, length)`,
  `validateName`, `WebRtcFrameLink.deliver`).

### Main process and IPC

- Keys stay in the main process. The UI only gets names, fingerprints and text.
- **Adding an IPC call** takes four places (under `apps/desktop/src/`): the type in
  `shared/api.d.ts` (`ChatApi`, plus `ApiEvent` for pushes), the `ipcRenderer.invoke` in
  `main/preload.ts`, a `handle(...)` in `main/main.ts` (it checks the sender is our window;
  validate every argument there), and an action in `renderer/store.ts`.
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
- `apps/desktop/src/renderer/app.css` declares the cascade-layer order: Tailwind base → every
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
- The smoke test (`apps/desktop/src/main/smoke-test.ts`) finds elements by `data-testid`. When you rename or
  restructure UI, keep those attributes or update the smoke test in the same change.

### Server

- The server is untrusted by design. It verifies listings on the way in (fresh timestamps,
  monotonically increasing per peer, signed deletions with tombstones), but clients verify again
  and recompute fingerprints. Never make the app trust a server-provided fingerprint or name.
- Data minimization is a feature. Don't store or log anything new about peers (or who looks up
  or connects to whom) without updating the README's "What is stored" section. Search needs 2+
  characters; there is deliberately no "list everyone" endpoint.
- **One instance only.** Signaling `Presence` and PeerJS sessions are in memory, so the Container
  App is pinned to one replica (`minReplicas` = `maxReplicas` = 1). Don't raise it without
  moving presence to shared state.
- **Live deployment** (subscription Rust-Playground): resource group `cas-p2p-chat` (centralus)
  holds the Container App `cas-p2p-chat-server`, environment `cas-p2p-chat-env`, registry
  `casp2pchat` and identity `cas-p2p-chat-server`; the database is `cas_p2p_chat` on
  `rust-playground-pg` (resource group `Rust-Playground`). Keep it separate from other apps'
  environments; only the PostgreSQL server is shared.
- **Two proxies in front**: Cloudflare (`chatp2p.cryptographicapiservices.com`, proxied), then
  Container Apps' ingress. So `TRUST_PROXY=2`; with 1, every client behind one Cloudflare edge
  would share a rate-limit bucket. It's only safe because ingress allows Cloudflare's IPv4
  ranges alone (`deploy/azure/cloudflare-ingress.sh`); the default `*.azurecontainerapps.io`
  address answers 403. Health checks (the deploy workflow) must go through the public domain.
  Don't use `az containerapp update --yaml` on the live app: it replaces the ingress config,
  dropping the custom domain and the Cloudflare rules (`setup.sh` uses `--set-env-vars`).
  Don't add access logging (Front Door, App Gateway) that would record IPs.
- **GitHub → Azure sign-in** is the Entra app `cas-p2p-chat-gh`, with one federated credential
  (`github-main`). The repo has GitHub's `use_immutable_subject` on, so the subject is
  `repo:Cryptographic-API-Services@151890385/cas-p2p-chat@1472581191:ref:refs/heads/main`, not
  `repo:<owner>/<repo>:…`. A mismatch fails `azure/login` with `AADSTS700213`. `setup.sh` reads
  the prefix from `gh api repos/<repo>/actions/oidc/customization/sub`; do the same for any new
  credential (an environment, another branch).

## Git

Don't commit `dist/`, `node_modules/`, `*.tsbuildinfo`, `directory-data/` (PGlite's local
data) or `apps/desktop/release/` (installers); all are git-ignored. Don't edit `CHANGELOG.md`
or the version fields by hand: release-please owns them. Do commit `apps/server/drizzle/`, including `meta/`.
