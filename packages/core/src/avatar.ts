/**
 * Profile pictures. A peer's avatar is untrusted input that ends up as an <img src> in the UI, so
 * the only accepted form is a base64 data URL of a PNG, JPEG or WebP image within a size limit,
 * whose bytes really start like that format. Anything else (a javascript: or http: URL, SVG,
 * HTML, a mislabeled or oversized file) is rejected.
 *
 * The app itself sends a small square WebP that the UI re-encodes from the user's file, which
 * also strips metadata such as EXIF location.
 */
import { type Bytes, fromBase64, toBase64 } from "./bytes.ts";

/** Decoded image bytes. The app's own avatars are a few kilobytes; this leaves headroom. */
export const MAX_AVATAR_BYTES = 64 * 1024;

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/;

/** Checks that the bytes start the way the claimed format must. */
function hasSignature(mime: string, bytes: Bytes): boolean {
    const startsWith = (prefix: Bytes, offset = 0) => prefix.every((byte, i) => bytes[offset + i] === byte);
    switch (mime) {
        case "image/png":
            return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        case "image/jpeg":
            return startsWith([0xff, 0xd8, 0xff]);
        case "image/webp":
            // "RIFF", a 4-byte size, then "WEBP".
            return startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8);
        default:
            return false;
    }
}

/** Returns the avatar as a canonical data URL, or throws saying what's wrong with it. */
export function validateAvatar(value: unknown): string {
    if (typeof value !== "string") {
        throw new Error("the avatar must be a string");
    }
    // Checked before decoding, so a huge string isn't decoded at all (base64 is 4/3 the size).
    if (value.length > 64 + Math.ceil(MAX_AVATAR_BYTES / 3) * 4) {
        throw new Error(`the avatar is larger than ${MAX_AVATAR_BYTES / 1024} KiB`);
    }
    const match = DATA_URL.exec(value);
    if (!match) {
        throw new Error("the avatar must be a PNG, JPEG or WebP image");
    }
    const [, mime, base64] = match;
    let bytes: Bytes;
    try {
        bytes = fromBase64(base64, "avatar");
    } catch {
        throw new Error("the avatar isn't valid base64");
    }
    if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) {
        throw new Error(`the avatar must be 1 byte to ${MAX_AVATAR_BYTES / 1024} KiB`);
    }
    if (!hasSignature(mime, bytes)) {
        throw new Error(`the avatar's contents aren't a ${mime.slice("image/".length).toUpperCase()} image`);
    }
    return `data:${mime};base64,${toBase64(bytes)}`;
}
