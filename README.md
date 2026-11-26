# CAS P2P Chat

An end-to-end encrypted, peer-to-peer desktop chat built with Electron, Vue 3, Vuetify and
Tailwind CSS on [cas-typescript-sdk](https://www.npmjs.com/package/cas-typescript-sdk).
Devices talk directly over WebRTC data channels and find each other by **fingerprint**, not by
IP address. A small Express server relays connection setup (PeerJS signaling) and offers an
optional "find someone by name" directory, kept in PostgreSQL. It never sees messages and never stores an IP
address. Every conversation is authenticated with long-term Ed25519 identity keys and encrypted
with HPKE over fresh X25519 session keys, so the server and the network are untrusted.

## Running it

```bash
npm install        # also downloads the Electron binary if npm skipped its install script
npm run server     # the chat server, on http://0.0.0.0:8787 (no database to install, see below)
npm start          # builds, then opens the app
```

In the app, paste the server's URL into **Server** and click **Join**. Then connect to someone
by pasting their fingerprint into **Connect**, or find them by name under **Server**.

To try it on one machine, run the server, then two instances with separate identities that
join it automatically:

```bash
npm run server
npm run start:alice   # profile "alice", joins http://127.0.0.1:8787
npm run start:bob     # profile "bob", joins http://127.0.0.1:8787
```

Command-line options: `--name=<display name>` (defaults to your OS user name),
`--profile=<name>` (a separate identity, contact list and settings), and `--server=<url>`
(join a server at startup). The server URL and the "find me by name" choice are saved, so the
app rejoins on its next start.

## Installing a release

Each [GitHub release](https://github.com/Cryptographic-API-Services/cas-p2p-chat/releases) has
installers for all three platforms, all x64:

| Platform | Download | Runs on |
| --- | --- | --- |
| Windows | `cas-p2p-chat-<version>-win-x64.exe` (installer) | Windows 10/11 x64. Windows on ARM runs it under emulation. |
| macOS | `cas-p2p-chat-<version>-mac-x64.dmg` (or `.zip`) | Intel Macs natively; Apple Silicon (M1 and later) under Rosetta 2, which macOS offers to install on first launch |
| Linux | `cas-p2p-chat-<version>-linux-x86_64.AppImage`, or `-linux-amd64.deb` | x86-64 Linux (glibc). Make the AppImage executable (`chmod +x`) and run it. |

Everything is x64 because cas-typescript-sdk ships its native binary for Windows x64, macOS
x64 and Linux x64 only. An Electron app can only load a native module built for its own
architecture, so there is no arm64 build until the SDK publishes arm64 binaries (its loader
already looks for `darwin-arm64`, `win32-arm64-msvc` and `linux-arm64-gnu`).

The builds aren't code-signed yet. Windows SmartScreen will warn ("More info" → "Run anyway").
macOS will say the app can't be opened or "is damaged"; after checking the download, remove
the quarantine flag with `xattr -dr com.apple.quarantine "/Applications/CAS P2P Chat.app"`.
Signing needs an Apple Developer ID (plus notarization) and a Windows code-signing
certificate; see Limits.

To build installers yourself: `npm run dist -- --win` (or `--mac`, `--linux`). The output goes
to `apps/desktop/release/`.

## The server

```bash
npm run server     # http://0.0.0.0:8787; name directory in embedded PGlite, apps/server/directory-data/
```

The server lives in `apps/server` and has no build step: Node runs its TypeScript directly (type
stripping), so it needs Node 22.18 or later; the Docker image uses Node 26. The directory is
PostgreSQL through [Drizzle ORM](https://orm.drizzle.team). Locally it defaults to
[PGlite](https://pglite.dev), PostgreSQL compiled to WebAssembly and embedded in the process, so
there's nothing to install. In production, point `DATABASE_URL` at a real PostgreSQL. Pending
migrations (`apps/server/drizzle/`) are applied at startup. Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on (`0` picks a free one) |
| `HOST` | `0.0.0.0` | Interface to bind |
| `DATABASE_URL` | `pglite:directory-data` | `postgres://user:password@host:5432/db?sslmode=verify-full` for PostgreSQL; `pglite:<directory>` for embedded PGlite stored in that directory; `pglite:memory` for an in-memory one |
| `ICE_SERVERS` | Google's public STUN server | JSON array of STUN/TURN servers handed to clients, e.g. `[{"urls":"stun:stun.example.com:3478"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]` |
| `TRUST_PROXY` | unset | Express "trust proxy" value, when behind a reverse proxy (e.g. `loopback` or `1`) |
| `USE_MANAGED_IDENTITY` | unset | Set to sign in to PostgreSQL with the container's Azure managed identity: an Entra ID token is the password, and `DATABASE_URL` names the identity as the user, with no password |
| `MANAGED_IDENTITY_CLIENT_ID` | unset | Client ID of the user-assigned identity to use (unset: the system-assigned one) |

It serves two things:

- **Signaling** (`/signal`, PeerJS). It relays WebRTC offers, answers and ICE candidates
  between two peers that are online right now, keeping that state in memory only. A device's
  signaling ID is its fingerprint. Stock PeerJS lets anyone claim any ID, but this server only
  accepts a connection whose token is a fresh Ed25519 signature by the identity key that
  fingerprint names (`packages/core/src/signaling-token.ts`). Nobody can squat someone else's ID. Search
  results show who's online from this live state.
- **The name directory** (`/v1/peers`). It's opt-in: the **Let people find me by name** switch.
  A listing is a self-signed record of a display name and identity key, nothing else
  (`packages/core/src/directory-record.ts`). The server and the app both verify it, and the app
  recomputes fingerprints itself, so a malicious server can't forge or rename anyone. All it
  can do is hide listings or misreport who's online. You can find people only by searching at
  least 2 characters of a name (at most 20 results); there's no endpoint that lists everyone.
  Listings not refreshed for 30 days are forgotten, and **Leave** or switching the listing off
  sends a signed deletion. A short-lived tombstone stops an old listing being replayed.

API: `GET /health`, `GET /v1/config` (ICE servers and signaling settings), `GET /v1/peers?q=`
(search), `GET /v1/peers/:fingerprint`, `POST /v1/peers` (a signed listing), `DELETE /v1/peers`
(a signed deletion), and the PeerJS WebSocket at `/signal/peerjs`. Bodies are limited to 4 KiB,
and requests are rate-limited per IP in memory.

### What is stored, and where IP addresses go

- **The server's database** (one PostgreSQL table, `peers`, defined in
  `apps/server/src/schema.ts`) holds, for each listed device: its name, identity public key, the
  signed listing, and first and last listing times. A deleted listing keeps only its
  fingerprint and last signed timestamp, for a few minutes. It holds no IP addresses, ports or
  connection history. The server tests check the stored rows contain no IP address, and the
  smoke test checks the same of the listings the server hands out.
- **The server sees IP addresses only in transit.** Any server sees the address of a client
  that's connected to it. ICE candidates, which include addresses, also pass through signaling
  to reach the other peer. This server keeps them in memory only for as long as they're needed,
  and never logs or stores them. Configure whatever runs in front of it (reverse proxy, load
  balancer, hosting platform) not to log request IPs either.
- **Peers see each other's IP address.** Any direct peer-to-peer connection works this way.
  Chromium hides LAN addresses behind mDNS names, but your public address is visible to the
  people you chat with. Routing everything through a TURN relay would hide it (see Limits).
- **Contacts stay on your device.** Everyone you've connected to is kept in `known-peers.json`
  in the app's data folder, never on the server.

For anything beyond a test, run the server behind HTTPS (a reverse proxy, or a platform that
terminates TLS such as Azure Container Apps), so signaling uses `wss://` and directory searches
are private from the network.

## Deploying to Azure

The public server is live at **https://chatp2p.cryptographicapiservices.com**; paste that into
the app's **Server** box. Cloudflare proxies the domain to the Container App, which has the
hostname bound with its own certificate. The app accepts connections **only from Cloudflare's
IP ranges**, so its default `*.azurecontainerapps.io` address answers 403. Cloudflare sees
visitors' IP addresses, so its logging settings fall under "Things to know" below. It runs as a
container (`apps/server/Dockerfile`, built from the
repository root) on **Azure Container Apps**, with its directory in a `cas_p2p_chat` database on
an existing **Azure Database for PostgreSQL** Flexible Server (`rust-playground-pg`, shared with
another app; nothing else is). Everything else lives in its own resource group, `cas-p2p-chat`
(centralus):

| Resource | Name | Purpose |
| --- | --- | --- |
| Container App | `cas-p2p-chat-server` | The server: 0.25 vCPU, 0.5 GiB, exactly one replica |
| Container Apps environment | `cas-p2p-chat-env` | Its own; logs to `cas-p2p-chat-logs` (Log Analytics, 30 days) |
| Container registry | `casp2pchat` (Basic) | The `cas-p2p-chat-server` image |
| Managed identity | `cas-p2p-chat-server` | Pulls the image, and signs in to PostgreSQL |
| Entra app | `cas-p2p-chat-gh` | What GitHub Actions signs in as (federated credential for `main`; Contributor on the resource group only) |

**No passwords anywhere.** The PostgreSQL server only accepts Microsoft Entra ID sign-ins. The
container sets `USE_MANAGED_IDENTITY`, so the server asks Container Apps' identity endpoint for
an Entra token and uses it as the database password (cached, and refreshed before it expires
after about an hour). `DATABASE_URL` names the identity as the user and holds no secret. In
PostgreSQL the identity is a role of the same name that owns `cas_p2p_chat`, so it can run the
migrations itself at startup. GitHub Actions signs in with a federated credential, so there's no
client secret either. Its subject has to match the token GitHub sends exactly. This repository
uses GitHub's immutable subject format, which includes the owner and repository IDs
(`repo:Cryptographic-API-Services@151890385/cas-p2p-chat@1472581191:ref:refs/heads/main`), so a
credential for the plain `repo:<owner>/<repo>:…` form fails with `AADSTS700213`. `setup.sh`
asks GitHub for the right prefix.

The app is also set up for this server:

- **Exactly one replica, never scaled to zero.** Signaling presence lives in the server's memory,
  so two replicas couldn't introduce peers connected to different ones, and long-lived signaling
  WebSockets shouldn't be dropped by scale-to-zero.
- **`TRUST_PROXY=2`**, because two proxies sit in front: Cloudflare, then Container Apps' own.
  `X-Forwarded-For` arrives as `<client>, <Cloudflare edge>`, and the server takes the second
  address from the right, so rate limiting is per client, not per Cloudflare location. That
  is only safe because nothing but Cloudflare can connect: a client reaching the app directly
  could put any address there. Cloudflare appends to a client-supplied header rather than
  trusting it, so faking one doesn't get a fresh rate-limit allowance (checked on the live app).
- **Cloudflare-only ingress.** `deploy/azure/cloudflare-ingress.sh` keeps one "Allow" rule per
  [Cloudflare IPv4 range](https://www.cloudflare.com/ips-v4). Re-run it if Cloudflare changes
  its ranges; it adds missing rules before removing stale ones.
- **HTTPS only.** Cloudflare serves the public certificate, and Container Apps terminates TLS
  again with the bound one, so clients use `https://` and `wss://` (WebSockets pass through
  Cloudflare). The database connection uses `sslmode=verify-full`. Liveness and readiness
  probes hit `/health`.

**Deploys** are automatic: `.github/workflows/deploy-server.yml` runs on pushes to `main` that
touch `apps/server`, `packages/core` or the lockfile (or by hand). It runs the tests, builds the
image in the registry (`az acr build`, no Docker needed), points the app at it and waits for
`/health` through the public domain. The repository secrets `AZURE_CLIENT_ID`,
`AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID` are set.

**Setting it up again** (another subscription, or from scratch): `deploy/azure/setup.sh` is the
exact sequence of Azure CLI commands that created all of the above, and is safe to re-run. Run
it from the repository root after `npm install`, signed in with `az login` as an Entra admin of
the PostgreSQL server (with your IP allowed by its firewall) and with `gh` signed in as a
repository admin. Names are overridable through environment variables at the top of the script.
Re-running it never touches an existing app's hostname binding or ingress rules. The public
hostname is a manual step: a proxied Cloudflare DNS record for the domain, Azure's `asuid`
verification record, and the hostname bound to the app with a certificate (`az containerapp
hostname add` / `bind`). After that, run `deploy/azure/cloudflare-ingress.sh`.

Things to know:

- **Logs.** The server's own logs (sent to Log Analytics) never contain IP addresses. Cloudflare,
  in front, does see them and keeps request analytics; turn off any log retention you don't
  need there (Logpush, for example). The same goes for Azure Front Door or Application Gateway,
  if you ever add them.
- **Database network.** The PostgreSQL firewall allows "Azure services", because a Container
  Apps environment without a VNet has no fixed outbound address. Entra ID sign-in and TLS
  still apply; a VNet with private access is the stricter setup.
- **TURN can't run on Container Apps**, which takes no inbound UDP. Run coturn on a small VM, or
  use a hosted TURN service, and add an `ICE_SERVERS` variable to the app.
- **The image is linux/amd64 only**, because cas-typescript-sdk has no Linux ARM binary.

## Checking it

```bash
npm test           # type-checks, then protocol, ChatNode, signaling token, directory, server and client tests (node:test)
npm run smoke      # launches the real app hidden and drives the Vue UI end to end (see below)
```

The server tests run against an in-memory PGlite, which is real PostgreSQL, so they exercise
the same SQL as production. The smoke test starts the real server as a child Node process
(in-memory PGlite) and two bot "devices", each with its own hidden WebRTC window. It checks four
things:
- An unlisted bot can't be found by name but can be reached by fingerprint.
- A listed bot can be found by name and chatted with.
- After a disconnect, the app can reconnect to a contact by fingerprint.
- The listings the server hands out hold no IP address.

Add `-- --screenshot=out.png` to `npm run smoke` to save a picture of the window.

## How it works

| Piece | Algorithm (from cas-typescript-sdk) | Lifetime |
| --- | --- | --- |
| Device identity | Ed25519 key pair (`Ed25519Wrapper`) | Long-term, created on first run |
| Fingerprint | BLAKE2b-512 of the identity key, first 128 bits (`Blake2Wrapper`) | Shown to the user; also the signaling ID |
| Session key | X25519 key pair (`HpkeWrapper.generateKeyPair`) | One per connection, in memory only |
| Message encryption | HPKE base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA512, AES-256-GCM (`HpkeWrapper`) | Fresh encapsulation per message |
| Message authentication | Ed25519 signature by the sender's identity key | Per message |

**Transport.** WebRTC exists only in Chromium, not in Electron's main process, where the keys
and the native SDK live. So a hidden, sandboxed window (`apps/desktop/src/renderer/transport.ts`) runs PeerJS
and passes opaque strings between data channels and the main process
(`apps/desktop/src/main/webrtc-bridge.ts`). Those strings are protocol frames the main process has already
signed and encrypted. Neither that window, the server, a TURN relay nor WebRTC's own encryption
(DTLS, whose keys the signaling server could swap) has to be trusted. When you dial a
fingerprint, the connection is dropped unless the handshake proves that identity.

**Handshake** (`packages/core/src/protocol.ts`). It's symmetric, so it doesn't matter who dialed:

1. Both sides send `hello`: display name, identity public key, a fresh X25519 session public
   key and a random 32-byte challenge.
2. Both derive `sessionId = BLAKE2b-512(context ‖ both hello transcripts, sorted)` and send
   `auth`: an Ed25519 signature over `context ‖ sessionId ‖ own session key`.
3. Each side verifies the other's signature with the identity key from its hello.

`sessionId` covers both fresh challenges, so an `auth` can't be replayed into another
session. The signature also binds the session key to the identity, so a relay can't swap in
its own session key.

**Messages.** Each message is HPKE-sealed to the peer's session public key. The AAD is
`sessionId ‖ sender's session key ‖ sequence number`, and the sealed message is then signed
with the sender's identity key. HPKE base mode doesn't authenticate the sender, so the
signature does that. The receiver requires each sequence number to be exactly the next one,
which rejects replayed, dropped and reordered messages. Any violation closes the connection.

**Frames** are JSON objects sent as text on a reliable, ordered data channel, with binary
fields in base64. They're capped at 256 KiB, and messages at 16,000 characters.

**Trust** (`packages/core/src/trust-store.ts`). Peers are remembered by fingerprint the first time they
connect (trust on first use), and that list is the **Contacts** list. Until you compare
fingerprints out of band and click **Mark as verified**, the conversation shows a warning. A
red warning appears if a different key connects under a name you've seen before.

**Electron hardening.** Both windows are sandboxed, with context isolation and no Node
integration, and block navigation, pop-ups and permission requests. The UI's CSP allows no
network connections at all. The transport window's CSP allows only WebSockets, for signaling.
Keys stay in the main process: the UI only sees names, fingerprints and message text, through
the small API in `apps/desktop/src/shared/api.d.ts`. IPC handlers answer only their own window. Peer text is
only rendered through Vue's escaping text interpolation, never `v-html`. The identity private
key is encrypted at rest with the OS keychain through Electron `safeStorage` (DPAPI on Windows,
Keychain on macOS, libsecret/kwallet on Linux). The app warns if no keychain is available.

## Limits, and what to build next

- **Strict NATs need a TURN relay.** STUN, the default, lets most home networks connect
  directly. Corporate and mobile networks often need TURN (for example coturn): add it to
  `ICE_SERVERS`. Static TURN credentials are handed to every client; time-limited credentials
  would be better.
- **Peers see each other's public IP.** A "relay only" option (`iceTransportPolicy: "relay"`
  plus a TURN server) would hide it, at the cost of relaying all traffic.
- **Forward secrecy is per connection, not per message.** Session keys are discarded when a
  connection closes, so a later identity-key leak doesn't expose past sessions. But someone who
  compromises a device mid-session could read that session. A ratchet would narrow this.
- **No offline delivery.** Both peers must be online and joined to the same server.
- **One server instance.** Signaling presence is in memory, so the server can't scale out.
  Several replicas would need shared presence and message routing (for example Redis pub/sub).
  The directory itself is already in PostgreSQL and could be shared.
- **Name search can be enumerated.** A determined client can probe 2-character searches; the
  per-IP rate limit only slows that down. Stay unlisted if you don't want to be findable.
- **History lives only in the window** and is gone when you close it. Persisting it would
  need an encrypted store (for example AES-GCM under a key sealed with `safeStorage`).
- **Display names are self-chosen.** Fingerprints are the real identity, which is why the UI
  pushes you to verify them.
- **The `peer` server package is old.** It was last released in May 2024 and pulls in its own
  Express 4. It works mounted in our Express 5 app, but watch it for security updates.
- **File transfer** would fit as a new payload kind. Chunk files (for example 128 KiB each) and
  seal each chunk as its own message, so the sequence numbers protect their order.
- **Releases are unsigned and x64 only.** Code signing needs an Apple Developer ID (with
  notarization, so Gatekeeper opens the app normally) and a Windows certificate; electron-builder
  takes both from CI secrets. Native arm64 builds (Apple Silicon without Rosetta, Windows on
  ARM, Linux ARM) need arm64 binaries from cas-typescript-sdk first. There's no auto-update
  yet; electron-updater could read the GitHub releases.

## The UI

The renderer is Vue 3 (`<script setup>` single-file components) with Vuetify 4 components and
Tailwind CSS v4 for layout and custom styling, built by Vite and type-checked by `vue-tsc`.
That's why the project uses TypeScript 6: TypeScript 7 has no JavaScript API for `vue-tsc` to
use. State and actions live in `apps/desktop/src/renderer/store.ts`, and the components only bind to it.

Vuetify 4 and Tailwind both use CSS cascade layers. `apps/desktop/src/renderer/app.css` declares their order:
Tailwind's reset, then all of Vuetify, then Tailwind's utilities, so a Tailwind class on a
Vuetify component wins without `!important`. Tailwind colors (`bg-brand`, `text-muted`,
`border-line`, ...) are defined from Vuetify's theme variables, so they follow its light/dark
theme, and they're named so they never clash with the `bg-primary`-style classes Vuetify
generates. Vuetify injects its theme as a `<style>` element, so the CSP allows inline styles.
Scripts remain `'self'` only, because Vite precompiles the templates.

## Layout

An npm workspaces monorepo; the server and the desktop app deploy separately.

```
packages/core/   protocol, identity, fingerprint IDs, signaling tokens, ChatNode, trust store,
                 signed directory records and the directory client (plain Node, tested). Shared
                 by both apps, so they always agree on the signed bytes.
apps/server/     the Express server: name directory (PostgreSQL via Drizzle; migrations in
                 drizzle/) and PeerJS signaling. Dockerfile for the container image.
apps/desktop/    the Electron app: main process, preload bridges, WebRTC bridge, server sync and
                 smoke test (src/main), the Vue + Vuetify + Tailwind UI and the hidden PeerJS
                 transport page (src/renderer, built by Vite), their shared types (src/shared),
                 and the installer config (electron-builder.yml)
deploy/azure/    setup.sh (the Azure CLI setup) and cloudflare-ingress.sh (allow only Cloudflare to reach the app)
.github/         release.yml (release-please + installers), pr-title.yml, deploy-server.yml
```

Contributor notes (commands, architecture, conventions) are in [CLAUDE.md](CLAUDE.md). Keep it
and this README up to date with every change.
