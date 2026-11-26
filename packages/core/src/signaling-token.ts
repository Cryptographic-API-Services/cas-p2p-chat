/**
 * Proof that a device owns its signaling ID. The PeerJS server on its own lets anyone claim any
 * ID; ours (src/server/signaling.ts) only accepts a connection whose token is a fresh Ed25519
 * signature by the identity key whose fingerprint the ID is. Nobody can squat someone else's ID.
 *
 * Token format: "<timestamp base36>.<identity key base64url>.<signature base64url>", where the
 * signature covers context ‖ len‖peerId ‖ len‖timestamp.
 */
import { Ed25519Wrapper } from "cas-typescript-sdk";
import { concat, lengthPrefixed, u64, utf8 } from "./bytes";
import { Identity, fingerprint } from "./identity";
import { fingerprintToPeerId } from "./peer-id";

const TOKEN_CONTEXT = utf8("cas-p2p-chat/v1/signaling-token");
/** A token stays valid this long, so a dropped connection can resume with the same token. */
export const SIGNALING_TOKEN_MAX_AGE_MS = 24 * 60 * 60_000;
/** Tolerated clock difference for tokens dated in the future. */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

const ed25519 = new Ed25519Wrapper();

function signedBytes(peerId: string, timestamp: number): number[] {
    return concat(TOKEN_CONTEXT, lengthPrefixed(utf8(peerId), u64(timestamp)));
}

export function createSignalingToken(identity: Identity, timestamp = Date.now()): { peerId: string; token: string } {
    const peerId = fingerprintToPeerId(fingerprint(identity.publicKey));
    const signature = ed25519.signBytes(identity.privateKey, signedBytes(peerId, timestamp));
    const token = [
        timestamp.toString(36),
        Buffer.from(identity.publicKey).toString("base64url"),
        Buffer.from(signature).toString("base64url"),
    ].join(".");
    return { peerId, token };
}

/** Returns why a token is unacceptable for `peerId`, or null if it's valid. */
export function checkSignalingToken(peerId: string, token: string, now = Date.now()): string | null {
    const parts = token.split(".");
    if (parts.length !== 3 || !/^[0-9a-z]{1,12}$/.test(parts[0])) {
        return "malformed token";
    }
    const timestamp = parseInt(parts[0], 36);
    if (!Number.isSafeInteger(timestamp) || now - timestamp > SIGNALING_TOKEN_MAX_AGE_MS || timestamp - now > MAX_FUTURE_SKEW_MS) {
        return "token expired or dated in the future";
    }
    const publicKey = Array.from(Buffer.from(parts[1], "base64url"));
    const signature = Array.from(Buffer.from(parts[2], "base64url"));
    if (publicKey.length !== 32 || signature.length !== 64) {
        return "malformed token";
    }
    if (fingerprintToPeerId(fingerprint(publicKey)) !== peerId) {
        return "token is for a different identity";
    }
    let valid = false;
    try {
        valid = ed25519.verifyBytes(publicKey, signedBytes(peerId, timestamp), signature);
    } catch {
        valid = false;
    }
    return valid ? null : "token signature is invalid";
}
