import { Blake2Wrapper, Ed25519Wrapper } from "cas-typescript-sdk";
import { type Bytes, concat, fromBase64, toBase64, utf8 } from "./bytes.ts";

/** A device's long-term Ed25519 signing key pair. Its public key is the device's identity. */
export interface Identity {
    readonly publicKey: Bytes;
    readonly privateKey: Bytes;
}

const KEY_LENGTH = 32;
const FINGERPRINT_CONTEXT = utf8("cas-p2p-chat/v1/fingerprint");
const PROBE_MESSAGE = utf8("cas-p2p-chat/v1/identity-self-check");

const ed25519 = new Ed25519Wrapper();
const blake2 = new Blake2Wrapper();

export function createIdentity(): Identity {
    const keyPair = ed25519.getKeyPair();
    return { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey };
}

/**
 * A short, human-comparable digest of an identity key: the first 128 bits of
 * BLAKE2b-512(context || publicKey), as 8 groups of 4 hex digits. Two people read these to
 * each other (in person, or over a call) to confirm no one is in the middle.
 */
export function fingerprint(publicKey: Bytes): string {
    const digest = blake2.hash512(concat(FINGERPRINT_CONTEXT, publicKey)).slice(0, 16);
    const hex = Buffer.from(digest).toString("hex").toUpperCase();
    return hex.match(/.{4}/g)!.join(" ");
}

export function serializeIdentity(identity: Identity): string {
    return JSON.stringify({
        version: 1,
        publicKey: toBase64(identity.publicKey),
        privateKey: toBase64(identity.privateKey),
    });
}

/** Parses a stored identity and checks that its private key really signs for its public key. */
export function parseIdentity(json: string): Identity {
    const data = JSON.parse(json) as { version?: unknown; publicKey?: unknown; privateKey?: unknown };
    if (data.version !== 1) {
        throw new Error(`unsupported identity file version ${String(data.version)}`);
    }
    const identity: Identity = {
        publicKey: fromBase64(data.publicKey, "publicKey", KEY_LENGTH),
        privateKey: fromBase64(data.privateKey, "privateKey", KEY_LENGTH),
    };
    const signature = ed25519.signBytes(identity.privateKey, PROBE_MESSAGE);
    if (!ed25519.verifyBytes(identity.publicKey, PROBE_MESSAGE, signature)) {
        throw new Error("stored identity is corrupt: its private key does not match its public key");
    }
    return identity;
}
