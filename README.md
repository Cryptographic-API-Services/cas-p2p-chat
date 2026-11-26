# CAS P2P Chat

An end-to-end encrypted, peer-to-peer desktop chat built with Electron, Vue 3, Vuetify and
Tailwind CSS on [cas-typescript-sdk](https://www.npmjs.com/package/cas-typescript-sdk).
Devices talk directly over WebRTC data channels and find each other by **fingerprint**, not by
IP address. A small Express server relays connection setup (PeerJS signaling) and offers an
optional "find someone by name" directory. It never sees messages and never stores an IP
address. Every conversation is authenticated with long-term Ed25519 identity keys and encrypted
with HPKE over fresh X25519 session keys, so the server and the network are untrusted.

## Running it

```bash
npm install        # also downloads the Electron binary if npm skipped its install script
npm run server     # the chat server, on http://0.0.0.0:8787
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

## The server

```bash
npm run server     # http://0.0.0.0:8787; name directory in ./directory.db
```

It needs Node 22.13 or later (for the built-in `node:sqlite`). Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `DB_PATH` | `directory.db` | SQLite file for the name directory |
| `ICE_SERVERS` | Google's public STUN server | JSON array of STUN/TURN servers handed to clients, e.g. `[{"urls":"stun:stun.example.com:3478"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]` |
| `TRUST_PROXY` | unset | Express "trust proxy" value, when behind a reverse proxy (e.g. `loopback` or `1`) |

It serves two things:

- **Signaling** (`/signal`, PeerJS). It relays WebRTC offers, answers and ICE candidates
  between two peers that are online right now, keeping that state in memory only. A device's
  signaling ID is its fingerprint. Stock PeerJS lets anyone claim any ID, but this server only
  accepts a connection whose token is a fresh Ed25519 signature by the identity key that
  fingerprint names (`src/core/signaling-token.ts`). Nobody can squat someone else's ID. Search
  results show who's online from this live state.
- **The name directory** (`/v1/peers`). It's opt-in: the **Let people find me by name** switch.
  A listing is a self-signed record of a display name and identity key, nothing else
  (`src/core/directory-record.ts`). The server and the app both verify it, and the app
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

- **The server's database** holds, for each listed device: its name, identity public key, the
  signed listing, and first and last listing times. It holds no IP addresses, ports or
  connection history. Opening an older database that had IP columns drops that table. The
  smoke test checks that the stored data contains no IP address.
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

For anything beyond a test, run the server behind HTTPS (a reverse proxy), so signaling uses
`wss://` and directory searches are private from the network.

## Checking it

```bash
npm test           # protocol, ChatNode, signaling token, directory, server and client tests (node:test)
npm run smoke      # launches the real app hidden and drives the Vue UI end to end (see below)
```

The smoke test runs a real server in-process and two bot "devices", each with its own hidden
WebRTC window. It checks four things:
- An unlisted bot can't be found by name but can be reached by fingerprint.
- A listed bot can be found by name and chatted with.
- After a disconnect, the app can reconnect to a contact by fingerprint.
- The server's database holds no IP address.

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
and the native SDK live. So a hidden, sandboxed window (`src/renderer/transport.ts`) runs PeerJS
and passes opaque strings between data channels and the main process
(`src/main/webrtc-bridge.ts`). Those strings are protocol frames the main process has already
signed and encrypted. Neither that window, the server, a TURN relay nor WebRTC's own encryption
(DTLS, whose keys the signaling server could swap) has to be trusted. When you dial a
fingerprint, the connection is dropped unless the handshake proves that identity.

**Handshake** (`src/core/protocol.ts`). It's symmetric, so it doesn't matter who dialed:

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

**Trust** (`src/core/trust-store.ts`). Peers are remembered by fingerprint the first time they
connect (trust on first use), and that list is the **Contacts** list. Until you compare
fingerprints out of band and click **Mark as verified**, the conversation shows a warning. A
red warning appears if a different key connects under a name you've seen before.

**Electron hardening.** Both windows are sandboxed, with context isolation and no Node
integration, and block navigation, pop-ups and permission requests. The UI's CSP allows no
network connections at all. The transport window's CSP allows only WebSockets, for signaling.
Keys stay in the main process: the UI only sees names, fingerprints and message text, through
the small API in `src/shared/api.d.ts`. IPC handlers answer only their own window. Peer text is
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
- **Packaging.** With electron-builder or Forge, unpack the native module from the asar
  archive (`asarUnpack: ["**/*.node"]`). cas-typescript-sdk ships binaries for Windows x64,
  macOS x64 and Linux x64 (glibc and musl), so Apple Silicon and ARM builds aren't available
  yet.

## The UI

The renderer is Vue 3 (`<script setup>` single-file components) with Vuetify 4 components and
Tailwind CSS v4 for layout and custom styling, built by Vite and type-checked by `vue-tsc`.
That's why the project uses TypeScript 6: TypeScript 7 has no JavaScript API for `vue-tsc` to
use. State and actions live in `src/renderer/store.ts`, and the components only bind to it.

Vuetify 4 and Tailwind both use CSS cascade layers. `src/renderer/app.css` declares their order:
Tailwind's reset, then all of Vuetify, then Tailwind's utilities, so a Tailwind class on a
Vuetify component wins without `!important`. Tailwind colors (`bg-brand`, `text-muted`,
`border-line`, ...) are defined from Vuetify's theme variables, so they follow its light/dark
theme, and they're named so they never clash with the `bg-primary`-style classes Vuetify
generates. Vuetify injects its theme as a `<style>` element, so the CSP allows inline styles.
Scripts remain `'self'` only, because Vite precompiles the templates.

## Layout

```
src/core/       protocol, identity, fingerprint IDs, signaling tokens, ChatNode, trust store,
                signed directory records and the directory client (plain Node, tested)
src/main/       Electron main process, preload bridges, WebRTC bridge, server sync, smoke test
src/server/     the Express server: name directory (SQLite via node:sqlite) and PeerJS signaling
src/renderer/   the Vue + Vuetify + Tailwind UI, and the hidden PeerJS transport page (built by Vite)
src/shared/     the UI ↔ main and transport ↔ main message types
test/           node:test suites (ChatNode tests run over an in-memory link pair)
```

Contributor notes (commands, architecture, conventions) are in [CLAUDE.md](CLAUDE.md). Keep it
and this README up to date with every change.
