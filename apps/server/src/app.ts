import express, { type NextFunction, type Request, type Response } from "express";
import * as http from "node:http";
import { verifyDeletion, verifyRegistration } from "@cas-p2p-chat/core/directory-record";
import type { RTCIceServerLike } from "@cas-p2p-chat/core/directory-client";
import { ProtocolError } from "@cas-p2p-chat/core/errors";
import { normalizeFingerprint } from "@cas-p2p-chat/core/peer-id";
import type { PeerStore, StoredPeer } from "./peer-store.ts";
import { rateLimit } from "./rate-limit.ts";
import { Presence, SIGNALING_KEY, SIGNALING_PATH, attachSignaling } from "./signaling.ts";

export const MIN_QUERY_LENGTH = 2;
export const MAX_RESULTS = 20;

export interface ChatServerOptions {
    store: PeerStore;
    /** STUN/TURN servers handed to clients for WebRTC. */
    iceServers?: RTCIceServerLike[];
    /** Mount the PeerJS signaling endpoint. Off in unit tests: its internal timers keep Node alive. */
    signaling?: boolean;
    /** Express "trust proxy" setting; set it when running behind a reverse proxy. */
    trustProxy?: boolean | number | string;
    /** Requests allowed per client IP in a burst, refilled at `refillPerSecond`. Kept in memory only. */
    rateLimit?: { burst: number; refillPerSecond: number };
    /** Injectable clock, for tests. */
    now?: () => number;
}

/** The JSON shape of a peer in API responses. */
export interface PeerView {
    fingerprint: string;
    record: StoredPeer["record"];
    lastSeen: number;
    /** Connected to this server's signaling right now. */
    online: boolean;
}

/**
 * The chat server: a "find someone by name" directory plus PeerJS signaling. It is untrusted by
 * design (clients verify every record and the end-to-end handshake authenticates every peer),
 * and it never stores an IP address.
 *
 *   GET    /health
 *   GET    /v1/config                ICE servers and signaling settings for clients
 *   GET    /v1/peers?q=<name>        listed peers whose name contains q (2+ characters, max 20)
 *   GET    /v1/peers/:fingerprint    one listed peer
 *   POST   /v1/peers                 list me, or refresh my listing (body: SignedRegistration)
 *   DELETE /v1/peers                 unlist me (body: SignedDeletion)
 *   WS     /signal/peerjs            PeerJS signaling (fingerprint IDs with signed tokens only)
 */
export function createChatServer(options: ChatServerOptions): { app: express.Express; server: http.Server; presence: Presence } {
    const { store } = options;
    const now = options.now ?? Date.now;
    const presence = new Presence();
    const iceServers = options.iceServers ?? [];
    const view = (peer: StoredPeer): PeerView => ({
        fingerprint: peer.fingerprint,
        record: peer.record,
        lastSeen: peer.lastSeen,
        online: presence.has(peer.fingerprint),
    });

    const app = express();
    const server = http.createServer(app);
    app.disable("x-powered-by");
    if (options.trustProxy !== undefined) {
        app.set("trust proxy", options.trustProxy);
    }
    app.use((_req, res, next) => {
        res.set({
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        });
        next();
    });
    app.use(rateLimit(options.rateLimit ?? { burst: 60, refillPerSecond: 2 }));
    if (options.signaling !== false) {
        attachSignaling(app, server, { presence, proxied: options.trustProxy !== undefined });
    }
    app.use(express.json({ limit: "4kb" }));

    app.get("/health", async (_req, res) => {
        res.json({ ok: true, listed: await store.count(), online: presence.size });
    });

    app.get("/v1/config", (_req, res) => {
        res.json({ iceServers, signalingPath: SIGNALING_PATH, signalingKey: SIGNALING_KEY });
    });

    app.get("/v1/peers", async (req, res) => {
        const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
        if ([...query].length < MIN_QUERY_LENGTH || query.length > 64) {
            res.status(400).json({ error: `search for a name of ${MIN_QUERY_LENGTH} to 64 characters` });
            return;
        }
        // Online peers first, so the people you can reach right now show up.
        const peers = (await store.search(query, MAX_RESULTS * 3))
            .map(view)
            .sort((a, b) => Number(b.online) - Number(a.online))
            .slice(0, MAX_RESULTS);
        res.json({ peers });
    });

    app.get("/v1/peers/:fingerprint", async (req, res) => {
        const fingerprint = normalizeFingerprint(String(req.params.fingerprint));
        const peer = fingerprint ? await store.get(fingerprint) : null;
        if (!peer) {
            res.status(404).json({ error: "no such peer" });
            return;
        }
        res.json(view(peer));
    });

    app.post("/v1/peers", async (req, res) => {
        const verified = verifyRegistration(req.body, now());
        const result = await store.register(verified, now());
        if (result === "stale") {
            res.status(409).json({ error: "a registration with the same or a newer timestamp was already accepted" });
            return;
        }
        res.status(result === "created" ? 201 : 200).json(view((await store.get(verified.fingerprint))!));
    });

    app.delete("/v1/peers", async (req, res) => {
        const { fingerprint, timestamp } = verifyDeletion(req.body, now());
        const result = await store.delete(fingerprint, timestamp, now());
        if (result === "not-found") {
            res.status(404).json({ error: "no such peer" });
        } else if (result === "stale") {
            res.status(409).json({ error: "this deletion is older than the peer's latest registration" });
        } else {
            res.status(204).end();
        }
    });

    app.use((_req, res) => {
        res.status(404).json({ error: "not found" });
    });

    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
        const type = (err as { type?: string }).type;
        if (err instanceof ProtocolError) {
            res.status(400).json({ error: err.message });
        } else if (type === "entity.parse.failed") {
            res.status(400).json({ error: "body is not valid JSON" });
        } else if (type === "entity.too.large") {
            res.status(413).json({ error: "body is too large" });
        } else {
            // Log the error itself, never the request (it carries the client's IP).
            console.error(err);
            res.status(500).json({ error: "internal error" });
        }
    });

    return { app, server, presence };
}
