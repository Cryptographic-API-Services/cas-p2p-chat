/**
 * HKDF-SHA512 (RFC 5869), built on cas-typescript-sdk's HMAC-SHA512, which has no HKDF of its
 * own. The tests check it against node:crypto's hkdfSync.
 */
import { HmacWrapper } from "cas-typescript-sdk";
import { type Bytes, concat } from "./bytes.ts";

const HASH_LENGTH = 64;
const hmac = new HmacWrapper();

/** HKDF-Extract: a pseudorandom key from input keying material, with a (non-secret) salt. */
export function hkdfExtract(salt: Bytes, ikm: Bytes): Bytes {
    return hmac.hmacSha512SignBytes(salt.length > 0 ? salt : new Array<number>(HASH_LENGTH).fill(0), ikm);
}

/** HKDF-Expand: `length` bytes of output keying material for the purpose named by `info`. */
export function hkdfExpand(prk: Bytes, info: Bytes, length: number): Bytes {
    if (!Number.isInteger(length) || length < 1 || length > 255 * HASH_LENGTH) {
        throw new RangeError(`HKDF-SHA512 can't produce ${length} bytes`);
    }
    const out: Bytes = [];
    let block: Bytes = [];
    for (let counter = 1; out.length < length; counter++) {
        block = hmac.hmacSha512SignBytes(prk, concat(block, info, [counter]));
        out.push(...block);
    }
    return out.slice(0, length);
}
