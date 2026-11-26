// Entry point for the chat server (directory + signaling): `npm run server`.
//
// Environment:
//   PORT         port to listen on (default 8787)
//   HOST         interface to bind (default 0.0.0.0, every interface)
//   DB_PATH      SQLite file for the name directory (default directory.db in the working directory)
//   ICE_SERVERS  JSON array of STUN/TURN servers for clients, e.g.
//                '[{"urls":"stun:stun.example.com:3478"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'
//                (default: Google's public STUN server)
//   TRUST_PROXY  Express "trust proxy" value, when behind a reverse proxy (e.g. "loopback" or 1)
//
// The server never stores or logs IP addresses. Make sure whatever runs in front of it (reverse
// proxy, load balancer, hosting platform) doesn't log them either.
import type { RTCIceServerLike } from "../core/directory-client";
import { createChatServer } from "./app";
import { PeerStore } from "./peer-store";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const dbPath = process.env.DB_PATH ?? "directory.db";
const trustProxyEnv = process.env.TRUST_PROXY;
const trustProxy = trustProxyEnv === undefined ? undefined : /^\d+$/.test(trustProxyEnv) ? Number(trustProxyEnv) : trustProxyEnv;
const iceServers = process.env.ICE_SERVERS
    ? (JSON.parse(process.env.ICE_SERVERS) as RTCIceServerLike[])
    : [{ urls: "stun:stun.l.google.com:19302" }];

const store = new PeerStore(dbPath);
const { server, presence } = createChatServer({ store, iceServers, trustProxy });

store.purge(Date.now());
setInterval(() => store.purge(Date.now()), 60 * 60_000).unref();

server.on("error", (err) => {
    console.error(`Could not listen on ${host}:${port}: ${err.message}`);
    process.exit(1);
});
server.listen(port, host, () => {
    console.log(`CAS P2P Chat server on http://${host}:${port}`);
    console.log(`  directory: ${dbPath} (${store.count()} listed; names and keys only, no IP addresses)`);
    console.log(`  signaling: ws://${host}:${port}/signal/peerjs (in memory, ${presence.size} online)`);
    console.log(`  ICE servers for clients: ${iceServers.map((s) => s.urls).join(", ") || "none"}`);
});

function shutdown(): void {
    server.close();
    store.close();
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
