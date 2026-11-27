# CAS P2P Chat

An end-to-end encrypted, peer-to-peer desktop chat for Windows, macOS and Linux, built on
[cas-typescript-sdk](https://www.npmjs.com/package/cas-typescript-sdk). Devices talk directly over
WebRTC and find each other by **fingerprint**, a hash of their identity key. A small server helps
them connect and, if you opt in, lets people find you by name. It never sees your messages and
never stores an IP address.

## Getting started

1. Install the app from the
   [latest release](https://github.com/Cryptographic-API-Services/cas-p2p-chat/releases/latest)
   (see [Installing](#installing)).
2. Open it. It joins the public server, **https://chatp2p.cryptographicapiservices.com**, on its
   own: the **Server** card shows it as online. People can already reach you by fingerprint.
3. To let people find you by name, turn on **Let people find me by name** in the **Server** card.
   It's off until you turn it on.
4. Find someone who's online with **Find someone by name** (at least 2 characters), or paste
   their fingerprint into **Connect**. Yours is under **Your fingerprint**; click it to copy.
   Everyone you've talked to stays under **Contacts**: click one to connect again.
5. Compare fingerprints with the other person in person or on a call, then click **Mark as
   verified**. Until you do, the conversation shows a warning.

You need a server to reach anyone: WebRTC uses it to set up each connection. To use another
one, click **Leave**, then paste its URL and click **Join** (the public server's URL is filled
in for you). The app rejoins your choice whenever it starts, and stays off servers if you left.
Switching the listing off or clicking **Leave** deletes your listing from the server.

## Installing

Each [release](https://github.com/Cryptographic-API-Services/cas-p2p-chat/releases) has x64
installers:

| Platform | File | Notes |
| --- | --- | --- |
| Windows 10/11 | `cas-p2p-chat-<version>-win-x64.exe` | Windows on ARM runs it under emulation |
| macOS | `cas-p2p-chat-<version>-mac-x64.dmg` (or `.zip`) | Apple Silicon runs it under Rosetta 2 |
| Linux | `cas-p2p-chat-<version>-linux-x86_64.AppImage` or `-linux-amd64.deb` | `chmod +x` the AppImage, then run it |

The builds aren't code-signed yet. Windows SmartScreen warns: click **More info**, then **Run
anyway**. macOS says the app can't be opened or "is damaged"; after checking the download, run
`xattr -dr com.apple.quarantine "/Applications/CAS P2P Chat.app"`. There are no arm64 builds
until cas-typescript-sdk ships arm64 binaries.

## Running from source

Needs Node 22.18 or later.

```bash
npm install
npm start            # builds, then opens the app
```

To try it on one machine, run a local server and two instances with separate identities:

```bash
npm run server       # http://127.0.0.1:8787; nothing else to install
npm run start:alice  # profile "alice", joins the local server
npm run start:bob    # profile "bob"
```

Turn on **Let people find me by name** in one to find it from the other. The app takes
`--name=<display name>`, `--profile=<name>` (a separate identity, contacts, messages and
settings) and `--server=<url>` (join that server at startup instead).

Data from older versions (contacts and settings in plaintext `known-peers.json` and
`settings.json`) moves into the encrypted database the first time a new version starts, and the
old files are deleted.

## What is stored

- **On the server**, only if you're listed: your display name, identity public key, the signed
  listing, and when it was first and last listed. Listings not refreshed for 30 days are
  deleted. No IP addresses, contacts or connection history.
- **The server sees IP addresses in transit**, as any server does, including in the connection
  details it relays between peers. It never logs or stores them. The public server is behind
  Cloudflare, which also sees visitors' addresses.
- **Peers see each other's public IP**, as with any direct connection.
- **Your photo**, if you add one (click your picture under "This device"), goes to everyone you
  chat with, inside the encrypted session, never to the server. The app crops it to a small
  square and re-encodes it, which drops metadata such as where it was taken. Peers keep the last
  photo you sent them, and removing yours tells them to delete it the next time you chat.
- **Everything else stays on your device**, encrypted: your contacts, your settings, your photo
  and your contacts' photos, and the messages you send and receive, in a SQLite database
  (`chat.sqlite`) whose rows are each encrypted with AES-256-GCM-SIV. The file doesn't show
  names, fingerprints, photos, message text or times. Its key and your identity key are sealed with the OS keychain (Windows DPAPI, macOS
  Keychain, libsecret or kwallet on Linux). The trash-can button in a conversation deletes its
  saved messages from this device.

The server is untrusted. Listings are self-signed, and the app checks them and computes
fingerprints itself. A malicious server could hide people or misreport who's online, but it
can't impersonate anyone or read your messages.

## How it works

| Piece | Algorithm (from cas-typescript-sdk) | Lifetime |
| --- | --- | --- |
| Device identity | Ed25519 key pair | Long-term, created on first run |
| Fingerprint | BLAKE2b-512 of the identity key, first 128 bits | Also the device's signaling ID |
| Key exchange | Hybrid: X25519 + ML-KEM-1024 (post-quantum), combined with HKDF-SHA512 | Fresh keys per connection, in memory only |
| Handshake authentication | Ed25519 signature by each side's identity key | Per connection |
| Message encryption | AES-256-GCM, one key per direction | Per connection |

When two devices connect, each sends fresh X25519 and ML-KEM keys and a random challenge,
encapsulates a secret to the other's ML-KEM key, and signs its keys, that ciphertext and a hash
of both sides' handshakes with its identity key. If you dialed a fingerprint, the connection is
dropped unless the other side proves it owns that identity. Both sides derive the message keys
from the X25519 secret and both ML-KEM secrets together, so recorded traffic stays private
unless both X25519 and ML-KEM are broken: a future quantum computer breaking X25519 isn't
enough. Each message is then encrypted and numbered, so replayed, dropped or reordered messages
are rejected.
The signaling server only relays connection setup; it couldn't read messages even if it
tampered with WebRTC's own encryption. Contacts are trusted on first use, and a red warning
appears if a different key connects under a name you've seen before.

## Running your own server

```bash
npm run server   # on :8787, with the name directory in embedded PGlite (apps/server/directory-data/)
docker build --platform linux/amd64 -f apps/server/Dockerfile -t cas-p2p-chat-server .
```

Run it behind HTTPS for anything beyond a test. It's configured with environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on (`0` picks a free one) |
| `HOST` | `0.0.0.0` | Interface to bind |
| `DATABASE_URL` | `pglite:directory-data` | `postgres://user:password@host:5432/db?sslmode=verify-full`, `pglite:<directory>`, or `pglite:memory` |
| `ICE_SERVERS` | Google's public STUN server | JSON array of STUN/TURN servers for clients, e.g. `[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]` |
| `TRUST_PROXY` | unset | Express "trust proxy" value behind a reverse proxy (e.g. `1`) |
| `USE_MANAGED_IDENTITY` | unset | Sign in to PostgreSQL with the Azure managed identity (no password in `DATABASE_URL`) |
| `MANAGED_IDENTITY_CLIENT_ID` | unset | Which user-assigned identity to use |

How the public server is deployed on Azure is in [CLAUDE.md](CLAUDE.md#azure-deployment).

## Limits

- **Some networks need a TURN relay.** Most home networks connect directly; corporate and mobile
  networks often don't. The public server offers STUN only, so far.
- **Peers see each other's public IP.**
- **Both people must be online.** There's no offline delivery.
- **Saved messages are as safe as your user account.** Anyone who can use your unlocked account
  can open the app and read them; delete a conversation's history if that matters. They're
  also only on this device: there's no sync or backup, and a conversation opens with its latest
  1,000 messages.
- **Forward secrecy is per connection, not per message.** A device compromised mid-session
  exposes that session.
- **Identities are not yet post-quantum.** Encryption is, but identity keys are Ed25519, so a
  future quantum computer could impersonate someone (not read their past messages).
- **Names are self-chosen, and search can be probed.** Fingerprints are the real identity; stay
  unlisted if you don't want to be findable.
- **Releases are unsigned and x64 only**, with no auto-update.

## Contributing

```bash
npm test         # type-check, then the core and server tests
npm run smoke    # build, then drive the real app end to end
npm run dev      # the app with hot reload: UI changes show up without restarting
```

`packages/core` is the shared protocol code, `apps/server` the server and `apps/desktop` the
Electron app. PR titles follow [Conventional Commits](https://www.conventionalcommits.org)
(`feat:`, `fix:`, …), because they become the changelog. [CLAUDE.md](CLAUDE.md) has the
architecture, conventions, protocol details, releases and deployment.
