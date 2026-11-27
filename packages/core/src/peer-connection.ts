import { EventEmitter } from "node:events";
import { validateAvatar } from "./avatar.ts";
import { type Bytes, fromUtf8, utf8 } from "./bytes.ts";
import { ProtocolError } from "./errors.ts";
import type { FrameLink } from "./frame-link.ts";
import type { Identity } from "./identity.ts";
import { Handshake, type PeerIdentity, Session } from "./protocol.ts";

export const MAX_TEXT_LENGTH = 16_000;
const MAX_BYE_REASON_LENGTH = 200;

export type Direction = "inbound" | "outbound";

export interface PeerConnectionEvents {
    open: [peer: PeerIdentity];
    message: [text: string];
    /** The peer's profile picture (a validated data URL), or null if they have none. */
    profile: [avatar: string | null];
    close: [reason: string | undefined];
}

/** Checks outgoing text; the same limits apply to what we accept. */
export function validateText(text: unknown): string {
    if (typeof text !== "string" || text.trim().length === 0) {
        throw new Error("message is empty");
    }
    if (text.length > MAX_TEXT_LENGTH) {
        throw new Error(`message is longer than ${MAX_TEXT_LENGTH} characters`);
    }
    return text;
}

function frameType(frame: unknown): unknown {
    return typeof frame === "object" && frame !== null ? (frame as { type?: unknown }).type : undefined;
}

/**
 * What a sealed message carries:
 *   { kind: "text", text }      a chat message
 *   { kind: "profile", avatar } the sender's profile picture (a data URL), or null for none; sent
 *                               when a session opens and whenever it changes
 */
type Payload = { kind: "text"; text: string } | { kind: "profile"; avatar: string | null };

/**
 * Decodes a decrypted payload. Unknown kinds (from a newer version) are ignored, so a new kind
 * that older peers can safely ignore needs no PROTOCOL_ID bump. So is an avatar this version
 * can't accept (another format, or larger): the one we have stays.
 */
function parsePayload(bytes: Bytes): Payload | null {
    let payload: unknown;
    try {
        payload = JSON.parse(fromUtf8(bytes));
    } catch (err) {
        throw err instanceof ProtocolError ? err : new ProtocolError("payload is not valid JSON");
    }
    if (typeof payload !== "object" || payload === null) {
        throw new ProtocolError("payload must be a JSON object");
    }
    const fields = payload as { kind?: unknown; text?: unknown; avatar?: unknown };
    if (fields.kind === "profile") {
        if (fields.avatar === null) {
            return { kind: "profile", avatar: null };
        }
        try {
            return { kind: "profile", avatar: validateAvatar(fields.avatar) };
        } catch {
            return null;
        }
    }
    if (fields.kind !== "text") {
        return null;
    }
    try {
        return { kind: "text", text: validateText(fields.text) };
    } catch (err) {
        throw new ProtocolError(`invalid text message: ${(err as Error).message}`);
    }
}

/**
 * One connection to a peer over any FrameLink: runs the handshake, then carries sealed chat
 * messages. Any protocol violation closes the connection; there is no attempt to recover.
 */
export class PeerConnection extends EventEmitter<PeerConnectionEvents> {
    private handshake: Handshake | null;
    private session: Session | null = null;
    private readonly handshakeTimer: NodeJS.Timeout;
    private closed = false;
    private readonly link: FrameLink;
    readonly direction: Direction;

    constructor(link: FrameLink, identity: Identity, name: string, direction: Direction, handshakeTimeoutMs = 10_000) {
        super();
        this.link = link;
        this.direction = direction;
        this.handshake = new Handshake(identity, name);
        link.start({
            frame: (frame) => this.onFrame(frame),
            error: (err) => this.fail(err),
            closed: (reason) => this.close(reason),
        });
        this.handshakeTimer = setTimeout(() => this.close("handshake timed out", true), handshakeTimeoutMs);
        this.link.send(this.handshake.hello);
    }

    /** Names the other end in error messages. */
    get label(): string {
        return this.link.label;
    }

    /** The authenticated peer, once the handshake has finished. */
    get peer(): PeerIdentity | null {
        return this.session?.peer ?? null;
    }

    get isOpen(): boolean {
        return this.session !== null && !this.closed;
    }

    sendText(text: string): void {
        this.sendPayload({ kind: "text", text: validateText(text) });
    }

    /** Sends our profile picture (already validated), or null for none. */
    sendProfile(avatar: string | null): void {
        this.sendPayload({ kind: "profile", avatar });
    }

    private sendPayload(payload: Payload): void {
        if (!this.session || this.closed) {
            throw new Error("not connected");
        }
        this.link.send(this.session.seal(utf8(JSON.stringify(payload))));
    }

    /** Closes the connection. With notifyPeer, first tells the peer why. */
    close(reason?: string, notifyPeer = false): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        clearTimeout(this.handshakeTimer);
        if (notifyPeer && reason) {
            this.link.send({ type: "bye", reason: reason.slice(0, MAX_BYE_REASON_LENGTH) });
        }
        this.link.close();
        this.handshake?.destroy();
        this.handshake = null;
        this.session?.destroy();
        this.emit("close", reason);
    }

    private fail(err: unknown): void {
        const reason = err instanceof ProtocolError ? err.message : `internal error: ${(err as Error).message}`;
        this.close(reason, true);
    }

    private onFrame(frame: unknown): void {
        if (this.closed) {
            return;
        }
        try {
            this.handleFrame(frame);
        } catch (err) {
            this.fail(err);
        }
    }

    private handleFrame(frame: unknown): void {
        const type = frameType(frame);
        if (type === "bye") {
            const reason = (frame as { reason?: unknown }).reason;
            const text = typeof reason === "string" ? reason.slice(0, MAX_BYE_REASON_LENGTH) : "no reason given";
            this.close(`peer closed the connection: ${text}`);
            return;
        }

        if (this.handshake) {
            if (type === "hello") {
                this.link.send(this.handshake.receiveHello(frame));
            } else if (type === "auth") {
                this.session = this.handshake.receiveAuth(frame);
                this.handshake = null;
                clearTimeout(this.handshakeTimer);
                this.emit("open", this.session.peer);
            } else {
                throw new ProtocolError(`unexpected ${String(type)} frame during the handshake`);
            }
            return;
        }

        const payload = parsePayload(this.session!.open(frame));
        if (payload?.kind === "text") {
            this.emit("message", payload.text);
        } else if (payload?.kind === "profile") {
            this.emit("profile", payload.avatar);
        }
    }
}
