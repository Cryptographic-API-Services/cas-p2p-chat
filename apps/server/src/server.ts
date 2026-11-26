// Entry point for the chat server (directory + signaling): `npm run server`. Node runs this
// TypeScript directly (type stripping, Node 22.18+); there is no build step.
//
// Environment:
//   PORT          port to listen on (default 8787; 0 picks a free one)
//   HOST          interface to bind (default 0.0.0.0, every interface)
//   DATABASE_URL  the name directory's database (default pglite:directory-data):
//                   postgres://user:password@host:5432/db?sslmode=verify-full   PostgreSQL
//                   pglite:<directory>   embedded PGlite stored in that directory (local runs)
//                   pglite:memory        embedded PGlite in memory (tests)
//   USE_MANAGED_IDENTITY        set (to anything) to sign in to PostgreSQL with the container's
//                               managed identity: an Entra ID token is the password, and
//                               DATABASE_URL names the identity as the user, with no password
//   MANAGED_IDENTITY_CLIENT_ID  client ID of a user-assigned identity (unset: system-assigned)
//   ICE_SERVERS   JSON array of STUN/TURN servers for clients, e.g.
//                 '[{"urls":"stun:stun.example.com:3478"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'
//                 (default: Google's public STUN server)
//   TRUST_PROXY   Express "trust proxy" value, when behind a reverse proxy (e.g. "loopback" or 1)
//
// The server never stores or logs IP addresses. Make sure whatever runs in front of it (reverse
// proxy, load balancer, hosting platform) doesn't log them either.
import type { RTCIceServerLike } from "@cas-p2p-chat/core/directory-client";
import type { AddressInfo } from "node:net";
import { createChatServer } from "./app.ts";
import { openDatabase } from "./db.ts";
import { managedIdentityToken } from "./managed-identity.ts";
import { DrizzlePeerRepository } from "./repositories/peer-repository.ts";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const databaseUrl = process.env.DATABASE_URL ?? "pglite:directory-data";
const trustProxyEnv = process.env.TRUST_PROXY;
const trustProxy = trustProxyEnv === undefined ? undefined : /^\d+$/.test(trustProxyEnv) ? Number(trustProxyEnv) : trustProxyEnv;
const iceServers = process.env.ICE_SERVERS
    ? (JSON.parse(process.env.ICE_SERVERS) as RTCIceServerLike[])
    : [{ urls: "stun:stun.l.google.com:19302" }];

const password = process.env.USE_MANAGED_IDENTITY ? managedIdentityToken(process.env.MANAGED_IDENTITY_CLIENT_ID) : undefined;
const database = await openDatabase(databaseUrl, password);
const peers = new DrizzlePeerRepository(database.db);
const { server, presence } = createChatServer({ peers, iceServers, trustProxy });

const purge = () => peers.purge(Date.now()).catch((err: Error) => console.error(`Purge failed: ${err.message}`));
await purge();
setInterval(purge, 60 * 60_000).unref();

server.on("error", (err) => {
    console.error(`Could not listen on ${host}:${port}: ${err.message}`);
    process.exit(1);
});
server.listen(port, host, async () => {
    const bound = (server.address() as AddressInfo).port;
    console.log(`CAS P2P Chat server on http://${host}:${bound}`);
    console.log(`  directory: ${database.description} (${await peers.count()} listed; names and keys only, no IP addresses)`);
    console.log(`  signaling: ws://${host}:${bound}/signal/peerjs (in memory, ${presence.size} online)`);
    console.log(`  ICE servers for clients: ${iceServers.map((s) => s.urls).join(", ") || "none"}`);
});

function shutdown(): void {
    server.close();
    database.close().finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
