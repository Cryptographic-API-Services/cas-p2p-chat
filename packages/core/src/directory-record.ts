/**
 * Signed records for the "find someone by name" directory (src/server). A record holds a display
 * name and an identity key, and nothing about where the device is: no IP addresses, no ports.
 * Peers are dialed by fingerprint through signaling instead.
 *
 * The directory is untrusted. Every record is signed by the peer's own Ed25519 identity key, so
 * neither the server nor anyone on the network path can forge one or change its name. The
 * server and the app both verify records with the functions below.
 */
import { Ed25519Wrapper } from "cas-typescript-sdk";
import { Bytes, concat, fromBase64, lengthPrefixed, toBase64, u64, utf8 } from "./bytes";
import { ProtocolError } from "./errors";
import { Identity, fingerprint } from "./identity";
import { validateName } from "./protocol";

// v2: v1 records also carried a port and LAN IP addresses.
const REGISTRATION_CONTEXT = utf8("cas-p2p-chat/v2/directory-registration");
const DELETION_CONTEXT = utf8("cas-p2p-chat/v2/directory-deletion");
const KEY_LENGTH = 32;
const SIGNATURE_LENGTH = 64;

/** How far a signed timestamp may be from the verifier's clock. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

const ed25519 = new Ed25519Wrapper();

/** What a peer publishes about itself, as sent over HTTP. */
export interface SignedRegistration {
    name: string;
    identityKey: string;
    timestamp: number;
    signature: string;
}

export interface SignedDeletion {
    identityKey: string;
    timestamp: number;
    signature: string;
}

/** A registration whose signature has been checked. */
export interface VerifiedRegistration {
    record: SignedRegistration;
    identityKey: Bytes;
    fingerprint: string;
}

function registrationBytes(name: string, identityKey: Bytes, timestamp: number): Bytes {
    return concat(REGISTRATION_CONTEXT, lengthPrefixed(utf8(name), identityKey, u64(timestamp)));
}

function deletionBytes(identityKey: Bytes, timestamp: number): Bytes {
    return concat(DELETION_CONTEXT, identityKey, u64(timestamp));
}

function validateTimestamp(timestamp: unknown): number {
    if (!Number.isSafeInteger(timestamp) || (timestamp as number) < 0) {
        throw new ProtocolError("timestamp must be a non-negative integer (milliseconds)");
    }
    return timestamp as number;
}

function checkFresh(timestamp: number, now: number): void {
    if (Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) {
        throw new ProtocolError("timestamp is too far from the current time; check this device's clock");
    }
}

function verify(publicKey: Bytes, message: Bytes, signature: Bytes): boolean {
    try {
        return ed25519.verifyBytes(publicKey, message, signature);
    } catch {
        return false;
    }
}

export function createRegistration(identity: Identity, name: string, timestamp = Date.now()): SignedRegistration {
    const cleanName = validateName(name);
    const signature = ed25519.signBytes(identity.privateKey, registrationBytes(cleanName, identity.publicKey, timestamp));
    return { name: cleanName, identityKey: toBase64(identity.publicKey), timestamp, signature: toBase64(signature) };
}

/**
 * Checks a registration's shape and signature, and rejects any extra fields (so nothing else,
 * such as an address, can ride along). Pass `now` to also require a fresh timestamp (the server
 * does, for new submissions); the app leaves it out, as stored records can be old.
 */
export function verifyRegistration(input: unknown, now?: number): VerifiedRegistration {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new ProtocolError("registration must be a JSON object");
    }
    const raw = input as Record<string, unknown>;
    const extra = Object.keys(raw).filter((key) => !["name", "identityKey", "timestamp", "signature"].includes(key));
    if (extra.length > 0) {
        throw new ProtocolError(`unexpected field(s): ${extra.join(", ")}`);
    }
    const name = validateName(raw.name);
    if (name !== raw.name) {
        throw new ProtocolError("name must not have leading or trailing spaces");
    }
    const identityKey = fromBase64(raw.identityKey, "identityKey", KEY_LENGTH);
    const timestamp = validateTimestamp(raw.timestamp);
    const signature = fromBase64(raw.signature, "signature", SIGNATURE_LENGTH);
    if (now !== undefined) {
        checkFresh(timestamp, now);
    }
    if (!verify(identityKey, registrationBytes(name, identityKey, timestamp), signature)) {
        throw new ProtocolError("registration signature is invalid");
    }
    return {
        record: { name, identityKey: raw.identityKey as string, timestamp, signature: raw.signature as string },
        identityKey,
        fingerprint: fingerprint(identityKey),
    };
}

export function createDeletion(identity: Identity, timestamp = Date.now()): SignedDeletion {
    const signature = ed25519.signBytes(identity.privateKey, deletionBytes(identity.publicKey, timestamp));
    return { identityKey: toBase64(identity.publicKey), timestamp, signature: toBase64(signature) };
}

/** Checks a deletion request, which must always be fresh. Returns the fingerprint to delete. */
export function verifyDeletion(input: unknown, now: number): { fingerprint: string; timestamp: number } {
    if (typeof input !== "object" || input === null) {
        throw new ProtocolError("deletion must be a JSON object");
    }
    const raw = input as Record<string, unknown>;
    const identityKey = fromBase64(raw.identityKey, "identityKey", KEY_LENGTH);
    const timestamp = validateTimestamp(raw.timestamp);
    const signature = fromBase64(raw.signature, "signature", SIGNATURE_LENGTH);
    checkFresh(timestamp, now);
    if (!verify(identityKey, deletionBytes(identityKey, timestamp), signature)) {
        throw new ProtocolError("deletion signature is invalid");
    }
    return { fingerprint: fingerprint(identityKey), timestamp };
}
