import { ProtocolError } from "./errors";

/** cas-typescript-sdk passes bytes across its native boundary as plain number arrays. */
export type Bytes = number[];

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function utf8(text: string): Bytes {
    return Array.from(encoder.encode(text));
}

export function fromUtf8(bytes: Bytes): string {
    try {
        return decoder.decode(Uint8Array.from(bytes));
    } catch {
        throw new ProtocolError("payload is not valid UTF-8");
    }
}

export function toBase64(bytes: Bytes): string {
    return Buffer.from(bytes).toString("base64");
}

/** Decodes a base64 field from a peer, rejecting anything that isn't strict base64 of the expected length. */
export function fromBase64(value: unknown, field: string, length?: number): Bytes {
    if (typeof value !== "string" || !BASE64.test(value)) {
        throw new ProtocolError(`${field} must be a base64 string`);
    }
    const bytes = Array.from(Buffer.from(value, "base64"));
    if (length !== undefined && bytes.length !== length) {
        throw new ProtocolError(`${field} must be ${length} bytes, got ${bytes.length}`);
    }
    return bytes;
}

export function concat(...parts: Bytes[]): Bytes {
    const out: Bytes = [];
    for (const part of parts) {
        for (const byte of part) {
            out.push(byte);
        }
    }
    return out;
}

export function u32(value: number): Bytes {
    return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

export function u64(value: number): Bytes {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${value} is not a non-negative safe integer`);
    }
    return concat(u32(Math.floor(value / 2 ** 32)), u32(value >>> 0));
}

/** Concatenates parts with a 4-byte length before each, so the encoding is unambiguous. */
export function lengthPrefixed(...parts: Bytes[]): Bytes {
    return concat(...parts.flatMap((part) => [u32(part.length), part]));
}

/** Constant-time equality for equal-length inputs. */
export function equal(a: Bytes, b: Bytes): boolean {
    if (a.length !== b.length) {
        return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a[i] ^ b[i];
    }
    return diff === 0;
}

/** Lexicographic order, used to put both peers' transcripts in the same order. */
export function compare(a: Bytes, b: Bytes): number {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i++) {
        if (a[i] !== b[i]) {
            return a[i] - b[i];
        }
    }
    return a.length - b.length;
}

/** Best-effort overwrite of key material held in a JS array. */
export function wipe(bytes: Bytes): void {
    bytes.fill(0);
}
