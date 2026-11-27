/**
 * The cas-p2p-chat wire protocol, transport-agnostic.
 *
 * Every device has a long-term Ed25519 identity key. Every connection gets two fresh key pairs:
 * an X25519 key and an ML-KEM-1024 (FIPS 203) key. The key exchange is hybrid, so the session
 * stays confidential unless both X25519 and ML-KEM are broken: traffic recorded today can't be
 * decrypted later by a quantum computer, which breaks X25519 alone. The handshake is symmetric,
 * so neither side needs a role:
 *
 *   1. both sides send  hello { name, identityKey, sessionKey (X25519), kemKey (ML-KEM), challenge }
 *   2. both sides derive sessionId = BLAKE2b-512(context || both hello transcripts, sorted),
 *      encapsulate a secret to the peer's kemKey, and send
 *                        auth  { kemCiphertext,
 *                                Ed25519 signature over (context || sessionId || own sessionKey || kemCiphertext) }
 *   3. each side verifies the other's auth with the peer's identity key, decapsulates the
 *      peer's kemCiphertext, and derives the session keys:
 *        prk     = HKDF-SHA512-Extract(salt = sessionId,
 *                               context || X25519(own, peer) || both KEM secrets || both KEM ciphertexts)
 *        sendKey = HKDF-Expand(prk, context || sender's sessionKey, 32), one key per direction.
 *
 * sessionId covers both fresh challenges and all four public keys, so an auth can't be replayed
 * into another session, and the signature binds the peer's session key and KEM ciphertext to its
 * identity, so a relay can't swap in its own. Both shared secrets and both ciphertexts go into
 * one HKDF-Extract with the public keys (through sessionId), as hybrid combiners like X-Wing do.
 *
 * Each chat message is then encrypted with AES-256-GCM under the sender's direction key, with the
 * nonce and AAD built from seq, so no nonce is ever reused and none travels on the wire. Only the
 * two peers hold the keys, which come from an authenticated handshake, so the AEAD tag already
 * proves who sent a message (and, unlike a per-message signature, doesn't let the receiver prove
 * it to anyone else). The receiver requires seq to be exactly the next number, which rejects
 * replayed, dropped and reordered messages. Session keys live only in memory for the connection,
 * so a later leak of an identity key doesn't decrypt past conversations.
 *
 * Authentication is still classical (Ed25519). It only has to resist an attacker at the moment of
 * the handshake, so it can move to a hybrid signature later without exposing today's traffic.
 */
import { randomBytes } from "node:crypto";
import {
    AESWrapper,
    Blake2Wrapper,
    Ed25519Wrapper,
    HkdfWrapper,
    MlKem1024Wrapper,
    X25519Wrapper,
    isCasError,
} from "cas-typescript-sdk";
import { type Bytes, compare, concat, equal, fromBase64, lengthPrefixed, toBase64, u32, u64, utf8, wipe } from "./bytes.ts";
import { ProtocolError } from "./errors.ts";
import { type Identity, fingerprint } from "./identity.ts";

export const PROTOCOL_ID = "cas-p2p-chat/2";
export const MAX_NAME_LENGTH = 64;

const KEY_LENGTH = 32;
const KEM_PUBLIC_KEY_LENGTH = 1568;
const KEM_CIPHERTEXT_LENGTH = 1568;
const CHALLENGE_LENGTH = 32;
const SIGNATURE_LENGTH = 64;
const TAG_LENGTH = 16;

const SESSION_ID_CONTEXT = utf8("cas-p2p-chat/v2/session-id");
const AUTH_CONTEXT = utf8("cas-p2p-chat/v2/handshake-auth");
const KEY_SCHEDULE_CONTEXT = utf8("cas-p2p-chat/v2/hybrid-key-schedule");
const MESSAGE_KEY_CONTEXT = utf8("cas-p2p-chat/v2/message-key");
const MESSAGE_AAD_CONTEXT = utf8("cas-p2p-chat/v2/message");

const aes = new AESWrapper();
const ed25519 = new Ed25519Wrapper();
const blake2 = new Blake2Wrapper();
const x25519 = new X25519Wrapper();
const mlKem = new MlKem1024Wrapper();
const hkdf = new HkdfWrapper();

export interface HelloFrame {
    type: "hello";
    protocol: string;
    name: string;
    identityKey: string;
    sessionKey: string;
    kemKey: string;
    challenge: string;
}

export interface AuthFrame {
    type: "auth";
    kemCiphertext: string;
    signature: string;
}

export interface MessageFrame {
    type: "msg";
    seq: number;
    /** AES-256-GCM ciphertext followed by its 16-byte tag. */
    ciphertext: string;
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
    kemKey: Bytes;
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

/** Runs an SDK call on peer-supplied input, turning its errors into a ProtocolError. */
function guard<T>(what: string, run: () => T): T {
    try {
        return run();
    } catch (err) {
        throw new ProtocolError(`${what}${isCasError(err) ? ` (${err.code})` : ""}`);
    }
}

function helloTranscript(hello: HelloFields): Bytes {
    return lengthPrefixed(
        utf8(PROTOCOL_ID),
        utf8(hello.name),
        hello.identityKey,
        hello.sessionKey,
        hello.kemKey,
        hello.challenge,
    );
}

/** All parts after the context are fixed-length (64 + 32 + 1568 bytes). */
function authMessage(sessionId: Bytes, signerSessionKey: Bytes, signerKemCiphertext: Bytes): Bytes {
    return concat(AUTH_CONTEXT, sessionId, signerSessionKey, signerKemCiphertext);
}

/** Both parts are fixed-length (64 + 8 bytes). */
function messageAad(sessionId: Bytes, seq: number): Bytes {
    return concat(MESSAGE_AAD_CONTEXT, sessionId, u64(seq));
}

/** A 96-bit GCM nonce from seq. Each direction has its own key, so a nonce is never reused. */
function messageNonce(seq: number): Bytes {
    return concat(u32(0), u64(seq));
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
    private readonly kemSecretKey: Bytes;
    private peer: HelloFields | null = null;
    private sessionId: Bytes | null = null;
    /** Our hello transcript sorts first; fixes the order of the two KEM secrets in the key schedule. */
    private ownFirst = false;
    /** The secret we encapsulated to the peer, and its ciphertext. */
    private sentKem: { ciphertext: Bytes; sharedSecret: Bytes } | null = null;
    private finished = false;
    private readonly identity: Identity;

    constructor(identity: Identity, name: string) {
        this.identity = identity;
        const sessionKeyPair = x25519.generateSecretAndPublicKey();
        const kemKeyPair = mlKem.generateKeyPair();
        this.sessionSecretKey = sessionKeyPair.secretKey;
        this.kemSecretKey = kemKeyPair.secretKey;
        this.own = {
            name: validateName(name),
            identityKey: identity.publicKey,
            sessionKey: sessionKeyPair.publicKey,
            kemKey: kemKeyPair.publicKey,
            challenge: Array.from(randomBytes(CHALLENGE_LENGTH)),
        };
        this.hello = {
            type: "hello",
            protocol: PROTOCOL_ID,
            name: this.own.name,
            identityKey: toBase64(this.own.identityKey),
            sessionKey: toBase64(this.own.sessionKey),
            kemKey: toBase64(this.own.kemKey),
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
            kemKey: fromBase64(fields.kemKey, "kemKey", KEM_PUBLIC_KEY_LENGTH),
            challenge: fromBase64(fields.challenge, "challenge", CHALLENGE_LENGTH),
        };
        // Stops our own hello and auth being reflected back at us.
        if (equal(peer.identityKey, this.own.identityKey)) {
            throw new ProtocolError("peer presented our own identity key");
        }
        if (
            equal(peer.sessionKey, this.own.sessionKey) ||
            equal(peer.kemKey, this.own.kemKey) ||
            equal(peer.challenge, this.own.challenge)
        ) {
            throw new ProtocolError("peer echoed our handshake values");
        }
        const sent = guard("peer's KEM key is invalid", () => mlKem.encapsulate(peer.kemKey));
        this.peer = peer;
        this.sentKem = sent;

        const ours = helloTranscript(this.own);
        const theirs = helloTranscript(peer);
        this.ownFirst = compare(ours, theirs) <= 0;
        const [first, second] = this.ownFirst ? [ours, theirs] : [theirs, ours];
        this.sessionId = blake2.hash512(concat(SESSION_ID_CONTEXT, lengthPrefixed(first, second)));

        const signature = ed25519.signBytes(
            this.identity.privateKey,
            authMessage(this.sessionId, this.own.sessionKey, sent.ciphertext),
        );
        return { type: "auth", kemCiphertext: toBase64(sent.ciphertext), signature: toBase64(signature) };
    }

    /** Verifies the peer's auth frame. On success the handshake is over and a Session begins. */
    receiveAuth(frame: unknown): Session {
        if (!this.peer || !this.sessionId || !this.sentKem) {
            throw new ProtocolError("received auth before hello");
        }
        if (this.finished) {
            throw new ProtocolError("received a second auth");
        }
        const fields = expectFrame(frame, "auth");
        const kemCiphertext = fromBase64(fields.kemCiphertext, "kemCiphertext", KEM_CIPHERTEXT_LENGTH);
        const signature = fromBase64(fields.signature, "signature", SIGNATURE_LENGTH);
        const signed = authMessage(this.sessionId, this.peer.sessionKey, kemCiphertext);
        if (!verifySignature(this.peer.identityKey, signed, signature)) {
            throw new ProtocolError("handshake signature is invalid");
        }

        const peer = this.peer;
        const received = guard("peer's KEM ciphertext is invalid", () => mlKem.decapsulate(this.kemSecretKey, kemCiphertext));
        // Throws for a low-order point, which would give an all-zero secret an attacker knows.
        const dh = guard("peer's session key is invalid", () => x25519.generateSharedSecret(this.sessionSecretKey, peer.sessionKey));
        const sent = this.sentKem;
        const got = { ciphertext: kemCiphertext, sharedSecret: received };
        // Both sides put the KEM secret of the side whose hello sorts first, first.
        const [first, second] = this.ownFirst ? [sent, got] : [got, sent];
        const ikm = concat(
            KEY_SCHEDULE_CONTEXT,
            dh,
            first.sharedSecret,
            second.sharedSecret,
            first.ciphertext,
            second.ciphertext,
        );
        const prk = hkdf.hkdfSha512Extract(this.sessionId, ikm);
        const sendKey = hkdf.hkdfSha512Expand(prk, concat(MESSAGE_KEY_CONTEXT, this.own.sessionKey), KEY_LENGTH);
        const receiveKey = hkdf.hkdfSha512Expand(prk, concat(MESSAGE_KEY_CONTEXT, peer.sessionKey), KEY_LENGTH);
        for (const secret of [ikm, prk, dh, received, sent.sharedSecret]) {
            wipe(secret);
        }
        this.finished = true;
        this.wipeSecrets();
        return new Session(peer, this.sessionId, sendKey, receiveKey);
    }

    /** Wipes the handshake's secrets if it never completed. */
    destroy(): void {
        if (!this.finished) {
            this.wipeSecrets();
        }
    }

    private wipeSecrets(): void {
        wipe(this.sessionSecretKey);
        wipe(this.kemSecretKey);
        if (this.sentKem) {
            wipe(this.sentKem.sharedSecret);
        }
    }
}

/** An authenticated session: seals outgoing messages and opens incoming ones, in order. */
export class Session {
    readonly peer: PeerIdentity;
    readonly sessionId: Bytes;
    private sendSeq = 0;
    private recvSeq = 0;
    private destroyed = false;
    private readonly sendKey: Bytes;
    private readonly receiveKey: Bytes;

    constructor(peer: HelloFields, sessionId: Bytes, sendKey: Bytes, receiveKey: Bytes) {
        this.peer = { name: peer.name, identityKey: peer.identityKey, fingerprint: fingerprint(peer.identityKey) };
        this.sessionId = sessionId;
        this.sendKey = sendKey;
        this.receiveKey = receiveKey;
    }

    seal(plaintext: Bytes): MessageFrame {
        this.assertLive();
        const seq = this.sendSeq++;
        const ciphertext = aes.aes256EncryptWithAad(this.sendKey, messageNonce(seq), plaintext, messageAad(this.sessionId, seq));
        return { type: "msg", seq, ciphertext: toBase64(ciphertext) };
    }

    open(frame: unknown): Bytes {
        this.assertLive();
        const fields = expectFrame(frame, "msg");
        if (fields.seq !== this.recvSeq) {
            throw new ProtocolError(`expected message #${this.recvSeq}, got #${String(fields.seq)} (replayed, dropped or reordered)`);
        }
        const ciphertext = fromBase64(fields.ciphertext, "ciphertext");
        if (ciphertext.length < TAG_LENGTH) {
            throw new ProtocolError("ciphertext is too short");
        }
        const seq = this.recvSeq;
        const plaintext = guard("message failed to decrypt", () =>
            aes.aes256DecryptWithAad(this.receiveKey, messageNonce(seq), ciphertext, messageAad(this.sessionId, seq)),
        );
        this.recvSeq++;
        return plaintext;
    }

    destroy(): void {
        if (!this.destroyed) {
            this.destroyed = true;
            wipe(this.sendKey);
            wipe(this.receiveKey);
        }
    }

    private assertLive(): void {
        if (this.destroyed) {
            throw new Error("session has been closed");
        }
    }
}
