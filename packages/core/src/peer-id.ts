/**
 * Fingerprints and the PeerJS IDs derived from them. A device's signaling ID is its
 * fingerprint, so peers are dialed by identity rather than by IP address.
 */

const FINGERPRINT_HEX = /^[0-9A-F]{32}$/;
const PEER_ID = /^cas-([0-9a-f]{32})$/;

/**
 * Accepts a fingerprint with or without spaces or dashes, in either case, and returns it in
 * canonical form ("ABCD 1234 ..."), or null if it isn't one.
 */
export function normalizeFingerprint(input: string): string | null {
    const hex = input.replace(/[\s-]/g, "").toUpperCase();
    return FINGERPRINT_HEX.test(hex) ? hex.match(/.{4}/g)!.join(" ") : null;
}

/** The PeerJS ID for a fingerprint, e.g. "cas-9d0aee5514b36c331cf008b8bf4c945c". */
export function fingerprintToPeerId(fingerprint: string): string {
    const canonical = normalizeFingerprint(fingerprint);
    if (!canonical) {
        throw new Error(`${fingerprint} is not a fingerprint`);
    }
    return `cas-${canonical.replace(/ /g, "").toLowerCase()}`;
}

/** The fingerprint a PeerJS ID stands for, or null if the ID isn't one of ours. */
export function peerIdToFingerprint(peerId: string): string | null {
    const match = PEER_ID.exec(peerId);
    return match ? normalizeFingerprint(match[1]) : null;
}
