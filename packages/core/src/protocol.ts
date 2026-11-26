/**
 * The cas-p2p-chat wire protocol, transport-agnostic.
 *
 * Every device has a long-term Ed25519 identity key. Every connection gets a fresh X25519
 * session key pair (the HPKE key pair: cas-lib's HPKE suite is DHKEM(X25519, HKDF-SHA256),
 * HKDF-SHA512, AES-256-GCM). The handshake is symmetric, so neither side needs a role:
 *
 *   1. both sides send  hello { name, identityKey, sessionKey, challenge }
 *   2. both sides derive sessionId = BLAKE2b-512(context || both hello transcripts, sorted)
 *      and send          auth  { Ed25519 signature over (context || sessionId || own sessionKey) }
 *   3. each side verifies the other's auth with the peer's identity key.
 *
 * sessionId covers both fresh challenges, so an auth can't be replayed into another session,
 * and the signature binds the peer's session key to its identity.
 *
 * Each chat message is then HPKE-sealed to the peer's session public key, with AAD
 * (sessionId || sender sessionKey || seq), and the result is signed with the sender's identity
 * key. HPKE base mode alone doesn't say who sent a message; the signature does. The receiver
 * requires seq to be exactly the next number, which rejects replayed, dropped and reordered
 * messages. Session keys live only in memory for the connection, so a later leak of an identity
 * key doesn't decrypt past conversations.
 */
import { randomBytes } from "node:crypto";
import { Blake2Wrapper, Ed25519Wrapper, HpkeWrapper, isCasError } from "cas-typescript-sdk";
import { type Bytes, compare, concat, equal, fromBase64, lengthPrefixed, toBase64, u64, utf8, wipe } from "./bytes.ts";
import { ProtocolError } from "./errors.ts";
import { type Identity, fingerprint } from "./identity.ts";

export const PROTOCOL_ID = "cas-p2p-chat/1";
export const MAX_NAME_LENGTH = 64;

const KEY_LENGTH = 32;
const CHALLENGE_LENGTH = 32;
const SIGNATURE_LENGTH = 64;
const TAG_LENGTH = 16;

const HPKE_INFO = utf8("cas-p2p-chat/v1/hpke-message");
const SESSION_ID_CONTEXT = utf8("cas-p2p-chat/v1/session-id");
const AUTH_CONTEXT = utf8("cas-p2p-chat/v1/handshake-auth");
const MESSAGE_SIGNATURE_CONTEXT = utf8("cas-p2p-chat/v1/message-signature");

const hpke = new HpkeWrapper();
const ed25519 = new Ed25519Wrapper();
const blake2 = new Blake2Wrapper();

export interface HelloFrame {
    type: "hello";
    protocol: string;
    name: string;
    identityKey: string;
    sessionKey: string;
    challenge: string;
}

export interface AuthFrame {
    type: "auth";
    signature: string;
}

export interface MessageFrame {
    type: "msg";
    seq: number;
    encapsulatedKey: string;
    ciphertext: string;
    tag: string;
    signature: string;
}

/** The authenticated peer at the other end of a session. */
export interface PeerIdentity {
    readonly name: string;
    readonly identityKey: Bytes;
    readonly fingerprint: string;
}

interface HelloFields {
    name: string;
    identityKey: Bytes;
    sessionKey: Bytes;
    challenge: Bytes;
}

/** Returns the frame's fields if it is an object of the given type. */
function expectFrame(frame: unknown, type: string): Record<string, unknown> {
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
        throw new ProtocolError(`expected a ${type} frame`);
    }
    const fields = frame as Record<string, unknown>;
    if (fields.type !== type) {
        throw new ProtocolError(`expected a ${type} frame, got ${String(fields.type)}`);
    }
    return fields;
}

/** Display names are self-chosen and unauthenticated, but at least can't hide characters. */
export function validateName(name: unknown): string {
    if (typeof name !== "string") {
        throw new ProtocolError("name must be a string");
    }
    const trimmed = name.trim();
    if (trimmed.length === 0 || [...trimmed].length > MAX_NAME_LENGTH) {
        throw new ProtocolError(`name must be 1 to ${MAX_NAME_LENGTH} characters`);
    }
    if (/[\p{Cc}\p{Cf}]/u.test(trimmed)) {
        throw new ProtocolError("name contains control or invisible formatting characters");
    }
    return trimmed;
}

function helloTranscript(hello: HelloFields): Bytes {
    return lengthPrefixed(utf8(PROTOCOL_ID), utf8(hello.name), hello.identityKey, hello.sessionKey, hello.challenge);
}

function authMessage(sessionId: Bytes, signerSessionKey: Bytes): Bytes {
    return concat(AUTH_CONTEXT, sessionId, signerSessionKey);
}

/** All parts are fixed-length (64 + 32 + 8 bytes). */
function messageAad(sessionId: Bytes, senderSessionKey: Bytes, seq: number): Bytes {
    return concat(sessionId, senderSessionKey, u64(seq));
}

/** Only the ciphertext varies in length, and it comes last. */
function messageSignatureInput(aad: Bytes, encapsulatedKey: Bytes, tag: Bytes, ciphertext: Bytes): Bytes {
    return concat(MESSAGE_SIGNATURE_CONTEXT, aad, encapsulatedKey, tag, ciphertext);
}

function verifySignature(publicKey: Bytes, message: Bytes, signature: Bytes): boolean {
    try {
        return ed25519.verifyBytes(publicKey, message, signature);
    } catch {
        return false;
    }
}

/** One side of the handshake. Send `hello`, then feed in the peer's hello and auth. */
export class Handshake {
    readonly hello: HelloFrame;
    private readonly own: HelloFields;
    private readonly sessionSecretKey: Bytes;
    private peer: HelloFields | null = null;
    private sessionId: Bytes | null = null;
    private finished = false;
    private readonly identity: Identity;

    constructor(identity: Identity, name: string) {
        this.identity = identity;
        // The key pair's random infoStr is ignored: messages use the fixed HPKE_INFO.
        const keyPair = hpke.generateKeyPair();
        this.sessionSecretKey = keyPair.secretKey;
        this.own = {
            name: validateName(name),
            identityKey: identity.publicKey,
            sessionKey: keyPair.publicKey,
            challenge: Array.from(randomBytes(CHALLENGE_LENGTH)),
        };
        this.hello = {
            type: "hello",
            protocol: PROTOCOL_ID,
            name: this.own.name,
            identityKey: toBase64(this.own.identityKey),
            sessionKey: toBase64(this.own.sessionKey),
            challenge: toBase64(this.own.challenge),
        };
    }

    /** Processes the peer's hello and returns the auth frame to send back. */
    receiveHello(frame: unknown): AuthFrame {
        if (this.peer) {
            throw new ProtocolError("received a second hello");
        }
        const fields = expectFrame(frame, "hello");
        if (fields.protocol !== PROTOCOL_ID) {
            throw new ProtocolError(`peer speaks ${String(fields.protocol)}, not ${PROTOCOL_ID}`);
        }
        const peer: HelloFields = {
            name: validateName(fields.name),
            identityKey: fromBase64(fields.identityKey, "identityKey", KEY_LENGTH),
            sessionKey: fromBase64(fields.sessionKey, "sessionKey", KEY_LENGTH),
            challenge: fromBase64(fields.challenge, "challenge", CHALLENGE_LENGTH),
        };
        // Stops our own hello and auth being reflected back at us.
        if (equal(peer.identityKey, this.own.identityKey)) {
            throw new ProtocolError("peer presented our own identity key");
        }
        if (equal(peer.sessionKey, this.own.sessionKey) || equal(peer.challenge, this.own.challenge)) {
            throw new ProtocolError("peer echoed our handshake values");
        }
        this.peer = peer;

        const ours = helloTranscript(this.own);
        const theirs = helloTranscript(peer);
        const [first, second] = compare(ours, theirs) <= 0 ? [ours, theirs] : [theirs, ours];
        this.sessionId = blake2.hash512(concat(SESSION_ID_CONTEXT, lengthPrefixed(first, second)));

        const signature = ed25519.signBytes(this.identity.privateKey, authMessage(this.sessionId, this.own.sessionKey));
        return { type: "auth", signature: toBase64(signature) };
    }

    /** Verifies the peer's auth frame. On success the handshake is over and a Session begins. */
    receiveAuth(frame: unknown): Session {
        if (!this.peer || !this.sessionId) {
            throw new ProtocolError("received auth before hello");
        }
        if (this.finished) {
            throw new ProtocolError("received a second auth");
        }
        const fields = expectFrame(frame, "auth");
        const signature = fromBase64(fields.signature, "signature", SIGNATURE_LENGTH);
        if (!verifySignature(this.peer.identityKey, authMessage(this.sessionId, this.peer.sessionKey), signature)) {
            throw new ProtocolError("handshake signature is invalid");
        }
        this.finished = true;
        return new Session(this.identity, this.own.sessionKey, this.sessionSecretKey, this.peer, this.sessionId);
    }

    /** Wipes the session secret if the handshake never completed. */
    destroy(): void {
        if (!this.finished) {
            wipe(this.sessionSecretKey);
        }
    }
}

/** An authenticated session: seals outgoing messages and opens incoming ones, in order. */
export class Session {
    readonly peer: PeerIdentity;
    private readonly peerSessionKey: Bytes;
    private sendSeq = 0;
    private recvSeq = 0;
    private destroyed = false;
    private readonly identity: Identity;
    private readonly ownSessionKey: Bytes;
    private readonly sessionSecretKey: Bytes;
    readonly sessionId: Bytes;

    constructor(identity: Identity, ownSessionKey: Bytes, sessionSecretKey: Bytes, peer: HelloFields, sessionId: Bytes) {
        this.identity = identity;
        this.ownSessionKey = ownSessionKey;
        this.sessionSecretKey = sessionSecretKey;
        this.sessionId = sessionId;
        this.peerSessionKey = peer.sessionKey;
        this.peer = { name: peer.name, identityKey: peer.identityKey, fingerprint: fingerprint(peer.identityKey) };
    }

    seal(plaintext: Bytes): MessageFrame {
        this.assertLive();
        const seq = this.sendSeq++;
        const aad = messageAad(this.sessionId, this.ownSessionKey, seq);
        const { encapsulatedKey, ciphertext, tag } = hpke.encrypt(plaintext, this.peerSessionKey, HPKE_INFO, aad);
        const signature = ed25519.signBytes(
            this.identity.privateKey,
            messageSignatureInput(aad, encapsulatedKey, tag, ciphertext),
        );
        return {
            type: "msg",
            seq,
            encapsulatedKey: toBase64(encapsulatedKey),
            ciphertext: toBase64(ciphertext),
            tag: toBase64(tag),
            signature: toBase64(signature),
        };
    }

    open(frame: unknown): Bytes {
        this.assertLive();
        const fields = expectFrame(frame, "msg");
        if (fields.seq !== this.recvSeq) {
            throw new ProtocolError(`expected message #${this.recvSeq}, got #${String(fields.seq)} (replayed, dropped or reordered)`);
        }
        const encapsulatedKey = fromBase64(fields.encapsulatedKey, "encapsulatedKey", KEY_LENGTH);
        const tag = fromBase64(fields.tag, "tag", TAG_LENGTH);
        const ciphertext = fromBase64(fields.ciphertext, "ciphertext");
        const signature = fromBase64(fields.signature, "signature", SIGNATURE_LENGTH);

        const aad = messageAad(this.sessionId, this.peerSessionKey, this.recvSeq);
        const signed = messageSignatureInput(aad, encapsulatedKey, tag, ciphertext);
        if (!verifySignature(this.peer.identityKey, signed, signature)) {
            throw new ProtocolError("message signature is invalid");
        }
        let plaintext: Bytes;
        try {
            plaintext = hpke.decrypt(ciphertext, this.sessionSecretKey, encapsulatedKey, tag, HPKE_INFO, aad);
        } catch (err) {
            throw new ProtocolError(`message failed to decrypt${isCasError(err) ? ` (${err.code})` : ""}`);
        }
        this.recvSeq++;
        return plaintext;
    }

    destroy(): void {
        if (!this.destroyed) {
            this.destroyed = true;
            wipe(this.sessionSecretKey);
        }
    }

    private assertLive(): void {
        if (this.destroyed) {
            throw new Error("session has been closed");
        }
    }
}
