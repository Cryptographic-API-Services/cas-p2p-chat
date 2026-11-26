import { EventEmitter } from "node:events";
import type { FrameLink } from "./frame-link";
import { Identity, fingerprint } from "./identity";
import { Direction, PeerConnection, validateText } from "./peer-connection";
import { validateName } from "./protocol";

export interface PeerSummary {
    id: string;
    name: string;
    fingerprint: string;
    direction: Direction;
}

export interface ChatMessage {
    text: string;
    at: number;
}

export interface ChatNodeOptions {
    identity: Identity;
    name: string;
    /** Open and handshaking connections combined. */
    maxConnections?: number;
    handshakeTimeoutMs?: number;
}

export interface AdoptOptions {
    /** Refuse the peer unless its identity has this fingerprint. */
    expectedFingerprint?: string;
}

export interface ChatNodeEvents {
    "peer-connected": [peer: PeerSummary];
    "peer-disconnected": [peerId: string, reason: string | undefined];
    "handshake-failed": [label: string, reason: string | undefined];
    message: [peerId: string, message: ChatMessage];
}

/**
 * A chat endpoint. It runs the authenticated handshake and sealed messaging over links handed to
 * it by a transport (WebRTC data channels in the app, see src/main/webrtc-bridge.ts), whichever
 * side opened them, and routes messages to and from them.
 */
export class ChatNode extends EventEmitter<ChatNodeEvents> {
    readonly name: string;
    readonly fingerprint: string;
    private readonly connections = new Map<string, PeerConnection>();
    private readonly maxConnections: number;
    private readonly handshakeTimeoutMs: number;
    private nextId = 1;

    constructor(private readonly options: ChatNodeOptions) {
        super();
        this.name = validateName(options.name);
        this.fingerprint = fingerprint(options.identity.publicKey);
        this.maxConnections = options.maxConnections ?? 32;
        this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    }

    /**
     * Runs the handshake over a link. Resolves once the peer is authenticated and announced.
     * With `expectedFingerprint`, a peer with any other identity is disconnected before it is
     * announced, and the promise rejects.
     */
    adopt(link: FrameLink, direction: Direction, options: AdoptOptions = {}): Promise<PeerSummary> {
        if (this.connections.size >= this.maxConnections) {
            link.close();
            return Promise.reject(new Error("too many connections"));
        }
        return new Promise((resolve, reject) => {
            const id = `peer-${this.nextId++}`;
            const connection = new PeerConnection(link, this.options.identity, this.name, direction, this.handshakeTimeoutMs);
            this.connections.set(id, connection);
            // Only peers that pass every check are announced; anything else is a failed handshake.
            let announced = false;
            connection.on("open", (peer) => {
                const expected = options.expectedFingerprint;
                if (expected && peer.fingerprint !== expected) {
                    connection.close(`identity mismatch: expected ${expected}, but the peer is ${peer.fingerprint}`, true);
                    return;
                }
                announced = true;
                const summary = this.summary(id, connection);
                this.emit("peer-connected", summary);
                resolve(summary);
            });
            connection.on("message", (text) => this.emit("message", id, { text, at: Date.now() }));
            connection.on("close", (reason) => {
                this.connections.delete(id);
                if (announced) {
                    this.emit("peer-disconnected", id, reason);
                } else {
                    this.emit("handshake-failed", link.label, reason);
                    reject(new Error(reason ?? "connection closed"));
                }
            });
        });
    }

    sendText(peerId: string, text: string): ChatMessage {
        const connection = this.connections.get(peerId);
        if (!connection?.isOpen) {
            throw new Error("that peer is not connected");
        }
        connection.sendText(validateText(text));
        return { text, at: Date.now() };
    }

    disconnect(peerId: string): void {
        this.connections.get(peerId)?.close("disconnected", true);
    }

    listPeers(): PeerSummary[] {
        return [...this.connections]
            .filter(([, connection]) => connection.isOpen && connection.peer !== null)
            .map(([id, connection]) => this.summary(id, connection));
    }

    close(): void {
        for (const connection of this.connections.values()) {
            connection.close("shutting down", true);
        }
    }

    private summary(id: string, connection: PeerConnection): PeerSummary {
        const peer = connection.peer!;
        return { id, name: peer.name, fingerprint: peer.fingerprint, direction: connection.direction };
    }
}
