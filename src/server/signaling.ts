import type { Express } from "express";
import type { IncomingMessage, Server } from "node:http";
import { ExpressPeerServer } from "peer";
import { WebSocketServer, type ServerOptions } from "ws";
import { peerIdToFingerprint } from "../core/peer-id";
import { checkSignalingToken } from "../core/signaling-token";

export const SIGNALING_PATH = "/signal";
export const SIGNALING_KEY = "cas-p2p-chat";

/** Which peers are connected to signaling right now. In memory only; never written anywhere. */
export class Presence {
    private readonly online = new Set<string>();

    add(fingerprint: string): void {
        this.online.add(fingerprint);
    }

    remove(fingerprint: string): void {
        this.online.delete(fingerprint);
    }

    has(fingerprint: string): boolean {
        return this.online.has(fingerprint);
    }

    get size(): number {
        return this.online.size;
    }
}

/** Accepts a signaling WebSocket only if its token proves it owns the fingerprint ID it claims. */
export function verifySignalingRequest(url: string | undefined, now = Date.now()): string | null {
    const params = new URL(url ?? "", "http://signal").searchParams;
    const id = params.get("id");
    const token = params.get("token");
    if (!id || !token || !peerIdToFingerprint(id)) {
        return "the signaling ID must be a fingerprint ID";
    }
    return checkSignalingToken(id, token, now);
}

export interface SignalingOptions {
    presence: Presence;
    proxied?: boolean | string;
    /** Most devices connected at once. */
    concurrentLimit?: number;
}

/**
 * Mounts a PeerJS signaling server at /signal. It only relays connection setup (WebRTC offers,
 * answers and ICE candidates) between peers that are online right now, and keeps that state in
 * memory. Candidates pass through it in transit, but nothing is stored or logged.
 *
 * PeerJS itself lets anyone claim any ID. Here the WebSocket upgrade is refused unless the ID is
 * a fingerprint ID and the token is a fresh signature by that identity (core/signaling-token.ts).
 */
export function attachSignaling(app: Express, httpServer: Server, options: SignalingOptions): void {
    const peerServer = ExpressPeerServer(httpServer, {
        path: "/",
        key: SIGNALING_KEY,
        allow_discovery: false,
        proxied: options.proxied ?? false,
        concurrent_limit: options.concurrentLimit ?? 5_000,
        alive_timeout: 60_000,
        // `peer` types ws in ESM resolution mode, so its ServerOptions and ours are distinct types.
        createWebSocketServer: ((wsOptions: ServerOptions) =>
            new WebSocketServer({
                ...wsOptions,
                maxPayload: 64 * 1024,
                verifyClient: (info: { req: IncomingMessage }, done: (ok: boolean, code?: number, message?: string) => void) => {
                    const problem = verifySignalingRequest(info.req.url);
                    if (problem) {
                        done(false, 401, problem);
                    } else {
                        done(true);
                    }
                },
            })) as never,
    });
    peerServer.on("connection", (client) => {
        const fingerprint = peerIdToFingerprint(client.getId());
        if (fingerprint) {
            options.presence.add(fingerprint);
        }
    });
    peerServer.on("disconnect", (client) => {
        const fingerprint = peerIdToFingerprint(client.getId());
        if (fingerprint) {
            options.presence.remove(fingerprint);
        }
    });
    // PeerJS reports socket errors here; without a listener they would crash the process.
    peerServer.on("error", () => undefined);
    app.use(SIGNALING_PATH, peerServer as unknown as Express);
}
