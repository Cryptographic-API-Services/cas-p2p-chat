# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Keep the docs current

**After every change, update `README.md` and this `CLAUDE.md` in the same change, without being asked.**
`README.md` is short and for users: joining the public server
(`https://chatp2p.cryptographicapiservices.com`) comes first, then installing, running from
source, what is stored, a brief "how it works", running your own server (its environment
variables) and limits. Keep it that way: put details (API, protocol steps, deployment, UI
internals, tests, ideas) here instead. `CLAUDE.md` is the contributor reference (commands,
architecture, conventions, deployment). Update them when you:

- add, rename or remove an npm script, command-line option (`--name`, `--profile`, `--server`,
  `--smoke-test`, `--screenshot`) or server environment variable (`PORT`, `HOST`,
  `DATABASE_URL`, `ICE_SERVERS`, `TRUST_PROXY`, `USE_MANAGED_IDENTITY`,
  `MANAGED_IDENTITY_CLIENT_ID`);
- change the wire protocol, the directory record format or API, signaling, what the server
  stores or sees, or any security property described in either file;
- add or move a source folder or workspace, a dependency, a build step, or deployment or
  release configuration (`apps/server/Dockerfile`, `deploy/azure/`, `.github/workflows/`,
  `apps/desktop/electron-builder.yml`, `release-please-config.json`);
- fix or remove something listed under "Limits" in the README or "What to build next" here.

If a statement in either file is no longer true, fix it. Don't leave it for later.

## What this is

CAS P2P Chat is an end-to-end encrypted, peer-to-peer desktop chat. It's an Electron app with a
Vue 3 + Vuetify 4 + Tailwind CSS v4 UI. The crypto comes from
[cas-typescript-sdk](https://www.npmjs.com/package/cas-typescript-sdk), a native N-API addon
wrapping the Rust `cas-lib`. Peers connect **only** over WebRTC data channels, dialed by
fingerprint. The Express server (`apps/server/`) provides PeerJS signaling plus an opt-in
"find someone by name" directory in PostgreSQL (Drizzle ORM). The app keeps contacts, settings
and message history in an encrypted local SQLite database (`node:sqlite`). It joins the public
server, `https://chatp2p.cryptographicapiservices.com`, by default. There is no direct TCP/LAN
mode, and nothing stores, shows or exchanges IP addresses at the app level.

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
npm run db:generate -w @cas-p2p-chat/core     # after editing packages/core/src/repositories/schema.ts (the app's local database)
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
- The server tests run against in-memory PGlite, which is real PostgreSQL, so they exercise the
  production SQL. The smoke test starts the real server as a child process (in-memory PGlite)
  and two bot devices, each with its own hidden WebRTC window, and checks that an unlisted bot
  can't be found by name but can be reached by fingerprint, a listed bot can be found and
  chatted with, a contact can be redialed by fingerprint after a disconnect, the listings the
  server hands out hold no IP address, and the local database holds no message text, name or
  fingerprint in the clear. Then it reloads the window, checks the saved history comes back,
  and deletes one contact's history. It never joins the public server (`--smoke-test` skips
  the startup join).
- Server image: `docker build --platform linux/amd64 -f apps/server/Dockerfile -t cas-p2p-chat-server .`
  (from the root; it needs `packages/core`). Azure: `deploy/azure/setup.sh` (one-time CLI
  setup, re-runnable) and `.github/workflows/deploy-server.yml` (deploys on pushes to `main`
  that touch the server or core). Both are described under "Azure deployment" below.

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
  scoped package name. It also drops `drizzle-orm`'s CommonJS copies, types and source maps
  (core loads its ESM), which keeps `app.asar` at about 3 MB instead of 12.
- **electron-builder packages what the lockfile says the app depends on**, through
  `@cas-p2p-chat/core`. A package core imports must be in core's `package.json`
  `dependencies` (then `npm install`): one that only resolves because the server hoisted it
  works in development and the smoke test, but is missing from installers. After adding one,
  check `npx @electron/asar list apps/desktop/release/win-unpacked/resources/app.asar`.
  Core's `drizzle/` folder (the local database's migrations) ships too.
- **Electron is pinned to an exact version** in `apps/desktop/package.json`: it's hoisted to the
  root `node_modules`, and electron-builder can't resolve a range from there.
- Builds are unsigned (`mac.identity: null`, no Windows certificate). The README tells users
  how to get past SmartScreen and Gatekeeper; signing is under "What to build next".

## Architecture

```
packages/core/src/    Plain Node, no Electron: protocol, identity, peer-id (fingerprint ↔ PeerJS
                      ID), signaling-token, ChatNode (runs any FrameLink), TrustStore (= contacts,
                      over a ContactRepository), signed directory records, DirectoryClient.
                      Everything here is unit-tested.
packages/core/src/repositories/  The desktop app's local data: schema.ts (Drizzle tables),
                      local-database.ts (node:sqlite through Drizzle, its key, sealing, and
                      migrations at startup), contact-, message- and settings-repository.ts,
                      legacy-files.ts (imports 0.2's JSON files).
packages/core/drizzle/  The local database's SQL migrations, generated by drizzle-kit (commit them,
                      never edit applied ones). The server's are in apps/server/drizzle/.
packages/core/test/   node:test suites; helpers/memory-link.ts is an in-memory FrameLink pair.
apps/server/src/      app.ts (createChatServer: routes + http server), signaling.ts (PeerJS mount
                      with token-checked WebSocket upgrades, in-memory Presence), schema.ts (the
                      Drizzle table), db.ts (openDatabase: node-postgres or PGlite, runs
                      migrations), repositories/peer-repository.ts, rate-limit.ts, server.ts (entry).
apps/server/drizzle/  SQL migrations generated by drizzle-kit (commit them, never edit applied ones).
apps/server/test/     directory, server API, peer repository and DirectoryClient tests.
apps/desktop/src/main/      main.ts, preload.ts (UI bridge), transport-preload.ts (transport
                      bridge), webrtc-bridge.ts (hidden transport window ↔ FrameLinks),
                      server-sync.ts (join, signaling token, reconnect backoff, listing),
                      repositories/key-repository.ts (keychain-sealed key files), smoke-test.ts.
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
  Both drivers are typed as one `Database` (`PgDatabase`), so write queries once.
  `DrizzlePeerRepository` is async; `register` and `delete` run in transactions with
  `SELECT … FOR UPDATE`, and the upsert only overwrites an older timestamp, so concurrent
  requests can't reorder a replay guard.
- **Data access goes through repositories**, in both apps: an interface for what callers need,
  and one class per storage technology. Code outside a repository never touches a database or
  data file, so add a method to the repository rather than a query elsewhere.
  - Server: `app.ts` takes a `PeerRepository`; `DrizzlePeerRepository` implements it. Rules
    that need atomicity (the replay guard, eviction) stay inside the repository's transactions.
  - Desktop: `ContactRepository`, `MessageRepository` and `SettingsRepository` (in
    `packages/core/src/repositories/`, so `node --test` covers them) are implemented on
    `LocalDatabase`; `KeyRepository` (`apps/desktop/src/main/repositories/`) keeps the identity
    and database keys in files sealed with `safeStorage`.
  - Both apps query through Drizzle 0.45 (one version for the monorepo). Every repository
    method is async.
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

- Identity: a long-term Ed25519 key. Fingerprint: the first 128 bits of BLAKE2b-512 of the
  identity key. Session: a fresh X25519 key pair per connection, which is the HPKE key pair
  (cas-lib's suite is DHKEM(X25519, HKDF-SHA256), HKDF-SHA512, AES-256-GCM).
- The handshake is symmetric, so it doesn't matter who dialed. Both sides send `hello`
  (display name, identity key, session key, random 32-byte challenge), derive
  `sessionId = BLAKE2b-512(context ‖ both hello transcripts, sorted)`, and send `auth`: an
  Ed25519 signature over `context ‖ sessionId ‖ own session key`, verified with the key from
  the peer's hello. `sessionId` covers both challenges, so an `auth` can't be replayed into
  another session, and the signature binds the session key to the identity, so a relay can't
  swap in its own. This is why neither the transport window, the server, a TURN relay nor DTLS
  (whose keys the signaling server could swap) has to be trusted.
- Each message is HPKE-sealed to the peer's session key with AAD
  `sessionId ‖ sender session key ‖ seq`, then Ed25519-signed (HPKE base mode doesn't
  authenticate the sender). `seq` must be exactly the next number, which rejects replayed,
  dropped and reordered messages; any violation closes the connection.
- Frames are JSON text on a reliable, ordered data channel, binary fields in base64, capped at
  `MAX_FRAME_BYTES` (256 KiB). Messages are capped at `MAX_TEXT_LENGTH` (16,000 characters).
- Trust is TOFU: `TrustStore` remembers fingerprints on first connection (that list is the
  Contacts list). The UI warns until the user clicks **Mark as verified**, and warns in red if a
  different key connects under a name seen before.
- Every signed or hashed input starts with a fixed context string (`cas-p2p-chat/v1/...`,
  `cas-p2p-chat/v2/directory-...`). Variable-length fields are length-prefixed. Keep it that
  way, and use a **new** context string for any new signature purpose.
- **Any wire-format change** (frames, payload, transcript, signed bytes) must bump `PROTOCOL_ID`,
  or old and new peers will fail in confusing ways. For directory record bytes, bump the context
  version (as v1 → v2 did when IPs were removed). For a table change, edit
  `apps/server/src/schema.ts` and run `npm run db:generate -w @cas-p2p-chat/server` (the
  server), or `packages/core/src/repositories/schema.ts` and
  `npm run db:generate -w @cas-p2p-chat/core` (the app's local database). Each applies its
  pending migrations at startup.
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
- **Files in userData**: `identity.json` and `storage-key.json` (the identity key and the
  local database's key, each sealed with `safeStorage`, the async API: DPAPI on Windows,
  Keychain on macOS, libsecret/kwallet on Linux), and `chat.sqlite` (settings, contacts and
  messages). If Linux falls back to `basic_text`, `keyProtection` is `"none"` and the UI warns.
  Keys are written to a `.tmp` file and renamed, so a crash can't leave half a key. Don't add
  other data files: add a table and a repository.
- **The local database** (`LocalDatabase`) is `node:sqlite` queried through Drizzle's
  `sqlite-proxy` driver: Drizzle 0.45 has no `node:sqlite` driver, and its `better-sqlite3` one
  needs that native module. The proxy callback runs each statement synchronously
  (`setReturnArrays`, since Drizzle maps columns by position). `LocalDatabase.open` applies
  drizzle-kit's pending migrations from `packages/core/drizzle` (found by walking up from the
  module, so it works from `src/`, `dist/` and inside `app.asar`) in one transaction, and
  refuses a database migrated by a newer app version (Drizzle alone would skip unknown ones).
- **Sealing**: every row's content is sealed with AES-256-GCM-SIV (cas-typescript-sdk) under a
  subkey of `storage-key.json`'s key, with AAD of a context string plus the row's identifying
  columns. Rows are found by HMAC-SHA512 lookup IDs, a different context per table, so the
  file shows no fingerprints, and contacts can't be linked to conversations. A message's seal
  is bound to its conversation and a random `uid` (so it can't be swapped, moved or
  duplicated), and holds its direction, text and time; histories are ordered by that sealed
  time, so reordering rows on disk changes nothing. Saving one is a single `INSERT …
  RETURNING`: with an async driver, a multi-statement transaction could interleave with other
  writes. `secure_delete` is on, and clearing a conversation checkpoints the WAL. Rows that
  fail to decrypt are skipped and counted (`unreadable`). If the file can't be opened, the app
  runs on an in-memory database, reports `storageError`, and skips the legacy import (it
  deletes what it reads).
- **0.2 data**: `importLegacyFiles` moves 0.2's plaintext `known-peers.json` and
  `settings.json` into the database at startup, then deletes them (and `known-peers.json.*`
  leftovers). Remove it once no one runs 0.2.
- **History**: `main.ts` saves every message sent and received (`ApiMessage.id` is its row ID,
  or null if saving failed; chat goes on either way). The UI loads a conversation's latest
  1,000 (`HISTORY_LIMIT`) the first time it's opened, skipping IDs it already shows, and the
  trash-can button deletes them (`clearHistory`).
- **Default server**: with no saved settings, the app joins `DEFAULT_SERVER_URL` (the public
  server) at startup, **unlisted**: listing stays opt-in, because the default display name is
  the OS user name. Saved settings win, so a user who left stays off. `ApiServer.defaultUrl`
  prefills the join form.
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
  takes `disconnected`, not `connected`.
- **Contacts say "connected" / "not connected", never "online" / "offline"**: it's whether
  there's a live chat session (`conversation.peer`), not whether they're running the app. The
  app doesn't learn when a contact comes back; one side clicks **Connect**. Only name-search
  results say "online", because there it is the server's live presence.
- `vue-tsc` mistypes the imported reactive `state` as a ref inside `<template v-else>` blocks
  (`Property 'value' does not exist`). Read it through a `computed` there, as `ServerCard.vue`
  does with `found`.
- The smoke test (`apps/desktop/src/main/smoke-test.ts`) finds elements by `data-testid`. When you rename or
  restructure UI, keep those attributes or update the smoke test in the same change.

### Server

- The server is untrusted by design. It verifies listings on the way in (fresh timestamps,
  monotonically increasing per peer, signed deletions with tombstones), but clients verify again
  and recompute fingerprints. Never make the app trust a server-provided fingerprint or name.
- API (documented at the top of `app.ts`): `GET /health`, `GET /v1/config` (ICE servers and
  signaling settings), `GET /v1/peers?q=` (search: 2+ characters, at most 20 results),
  `GET /v1/peers/:fingerprint`, `POST /v1/peers` (a `SignedRegistration`), `DELETE /v1/peers`
  (a `SignedDeletion`), and the PeerJS WebSocket at `/signal/peerjs`. Bodies are capped at
  4 KiB; `rate-limit.ts` is a per-IP token bucket in memory (burst 60, 2/s).
- Signaling relays offers, answers and ICE candidates (which hold addresses) between peers that
  are online now, in memory only. Search results' `online` comes from that live state.
- Data minimization is a feature. Don't store or log anything new about peers (or who looks up
  or connects to whom) without updating the README's "What is stored" section. There is
  deliberately no "list everyone" endpoint. The `peers` table holds the signed listing, name
  key and timestamps; listings not refreshed for 30 days are purged; a deletion leaves only a
  tombstone (fingerprint and last signed timestamp) until the clock-skew window passes, so an
  old listing can't be replayed. The server tests check stored rows hold no IP address.
- **One instance only.** Signaling `Presence` and PeerJS sessions are in memory, so the Container
  App is pinned to one replica (`minReplicas` = `maxReplicas` = 1). Don't raise it without
  moving presence to shared state.

### Azure deployment

The public server, `https://chatp2p.cryptographicapiservices.com`, runs the
`apps/server/Dockerfile` image on Azure Container Apps, in subscription Rust-Playground. Keep it
separate from other apps' environments: the only shared resource is the PostgreSQL server.

| Resource | Name | Purpose |
| --- | --- | --- |
| Resource group | `cas-p2p-chat` (centralus) | Everything below except the database |
| Container App | `cas-p2p-chat-server` | 0.25 vCPU, 0.5 GiB, exactly one replica |
| Container Apps environment | `cas-p2p-chat-env` | Logs to `cas-p2p-chat-logs` (Log Analytics, 30 days) |
| Container registry | `casp2pchat` (Basic) | The `cas-p2p-chat-server` image |
| Managed identity | `cas-p2p-chat-server` | Pulls the image, signs in to PostgreSQL (role of the same name) |
| Entra app | `cas-p2p-chat-gh` | What GitHub Actions signs in as; Contributor on the resource group only |
| Database | `cas_p2p_chat` on `rust-playground-pg` (resource group `Rust-Playground`) | Owned by the identity's role |

- **Never scaled to zero, never more than one replica**: presence is in memory, and
  scale-to-zero would drop the long-lived signaling WebSockets.
- **Two proxies in front**: Cloudflare (the domain is proxied), then Container Apps' ingress.
  `X-Forwarded-For` arrives as `<client>, <Cloudflare edge>`, so `TRUST_PROXY=2`; with 1, every
  client behind one Cloudflare edge would share a rate-limit bucket. Cloudflare appends to a
  client-supplied header rather than trusting it, so faking one doesn't reset the limit
  (checked on the live app). It's only safe because ingress allows Cloudflare's IPv4 ranges
  alone (`deploy/azure/cloudflare-ingress.sh`; re-run it when Cloudflare changes them, it adds
  before it removes); the default `*.azurecontainerapps.io` address answers 403. Health checks
  must go through the public domain.
- **TLS twice**: Cloudflare serves the public certificate, and Container Apps terminates again
  with the hostname's bound certificate. WebSockets pass through Cloudflare. The database
  connection uses `sslmode=verify-full`. Liveness and readiness probes hit `/health`.
- Don't use `az containerapp update --yaml` on the live app: it replaces the ingress config,
  dropping the custom domain and the Cloudflare rules (`setup.sh` uses `--set-env-vars`).
- **Deploys**: `.github/workflows/deploy-server.yml` runs on pushes to `main` that touch
  `apps/server`, `packages/core` or the lockfile (or by hand). It runs the tests, builds the
  image in the registry (`az acr build`, tagged with the commit SHA and `latest`), points the
  app at it, and waits for `/health` through the public domain. It signs in with the
  repository secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`.
- **GitHub → Azure sign-in** is the Entra app `cas-p2p-chat-gh`, with one federated credential
  (`github-main`), so there's no client secret. The repo has GitHub's `use_immutable_subject`
  on, so the subject is
  `repo:Cryptographic-API-Services@151890385/cas-p2p-chat@1472581191:ref:refs/heads/main`, not
  `repo:<owner>/<repo>:…`. A mismatch fails `azure/login` with `AADSTS700213`. `setup.sh` reads
  the prefix from `gh api repos/<repo>/actions/oidc/customization/sub`; do the same for any new
  credential (an environment, another branch).
- **Setting it up again**: `deploy/azure/setup.sh` is the sequence of Azure CLI commands that
  created all of the above, and is safe to re-run. Run it from the repository root after
  `npm install`, signed in with `az login` as an Entra admin of the PostgreSQL server (with your
  IP allowed by its firewall) and with `gh` signed in as a repository admin. Names are
  overridable through the environment variables at its top. It never touches an existing app's
  hostname binding or ingress rules. The hostname is manual: a proxied Cloudflare DNS record,
  Azure's `asuid` TXT verification record, then `az containerapp hostname add` / `bind` with a
  certificate. After that, run `cloudflare-ingress.sh`.
- **Logs**: the server's own logs (in Log Analytics) never contain IPs. Cloudflare sees them and
  keeps request analytics; keep log retention there (Logpush, for example) off. Don't add
  access logging (Front Door, App Gateway) that would record IPs.
- **Database network**: the PostgreSQL firewall allows "Azure services", because a Container
  Apps environment without a VNet has no fixed outbound address. Entra ID sign-in and TLS still
  apply; a VNet with private access would be stricter.
- **TURN can't run on Container Apps** (no inbound UDP). Use coturn on a small VM or a hosted
  TURN service, and set `ICE_SERVERS` on the app.
- **The image is linux/amd64 only**, because cas-typescript-sdk has no Linux ARM binary.

## What to build next

- **TURN.** The public server hands out STUN only. Add a TURN server to `ICE_SERVERS`, ideally
  with time-limited credentials instead of static ones handed to every client.
- **Relay-only mode** (`iceTransportPolicy: "relay"` plus TURN) would hide peers' public IPs
  from each other, at the cost of relaying all traffic. Chromium already hides LAN addresses
  behind mDNS names.
- **Per-message forward secrecy.** Session keys are discarded when a connection closes, but a
  device compromised mid-session exposes that session. A ratchet would narrow this.
- **More than one server instance** needs shared presence and message routing (for example
  Redis pub/sub). The directory is already in PostgreSQL.
- **History beyond the latest 1,000 messages** (paging older ones in), retention settings or
  disappearing messages, and search.
- **One instance per profile** (`app.requestSingleInstanceLock()`): two would share an identity
  and race on `ID-TAKEN`; SQLite itself copes.
- **File transfer** fits as a new payload kind: chunk files (for example 128 KiB each) and seal
  each chunk as its own message, so sequence numbers protect their order.
- **Name search can be enumerated** by probing 2-character searches; the per-IP rate limit only
  slows that down.
- **Signed releases**: an Apple Developer ID with notarization and a Windows code-signing
  certificate, given to electron-builder as CI secrets. **arm64 builds** need arm64 binaries
  from cas-typescript-sdk (its loader already looks for `darwin-arm64`, `win32-arm64-msvc` and
  `linux-arm64-gnu`). **Auto-update**: electron-updater could read the GitHub releases.
- **The `peer` server package is old** (last released May 2024, pulls in its own Express 4). It
  works mounted in our Express 5 app; watch it for security updates.

## Git

Don't commit `dist/`, `node_modules/`, `*.tsbuildinfo`, `directory-data/` (PGlite's local
data) or `apps/desktop/release/` (installers); all are git-ignored. Don't edit `CHANGELOG.md`
or the version fields by hand: release-please owns them. Do commit `apps/server/drizzle/` and
`packages/core/drizzle/`, including `meta/`.
