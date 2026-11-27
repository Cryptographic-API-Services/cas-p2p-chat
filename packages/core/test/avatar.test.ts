import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_AVATAR_BYTES, validateAvatar } from "../src/avatar.ts";
import { PNG } from "./helpers/avatars.ts";

const dataUrl = (mime: string, bytes: number[]) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
const JPEG_START = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10];
const WEBP_START = [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38];

describe("validateAvatar", () => {
    it("accepts PNG, JPEG and WebP data URLs whose bytes match", () => {
        assert.equal(validateAvatar(PNG), PNG);
        assert.equal(validateAvatar(dataUrl("image/jpeg", JPEG_START)), dataUrl("image/jpeg", JPEG_START));
        assert.equal(validateAvatar(dataUrl("image/webp", WEBP_START)), dataUrl("image/webp", WEBP_START));
    });

    it("accepts the size limit and refuses one byte more", () => {
        const at = [...JPEG_START, ...new Array(MAX_AVATAR_BYTES - JPEG_START.length).fill(0)];
        assert.ok(validateAvatar(dataUrl("image/jpeg", at)));
        assert.throws(() => validateAvatar(dataUrl("image/jpeg", [...at, 0])), /KiB/);
        assert.throws(() => validateAvatar(`data:image/png;base64,${"A".repeat(200_000)}`), /larger than/, "a huge string isn't decoded");
    });

    it("refuses anything that isn't a base64 image of an allowed type", () => {
        const cases: Array<[unknown, RegExp]> = [
            [null, /must be a string/],
            [42, /must be a string/],
            ["javascript:alert(1)", /PNG, JPEG or WebP/],
            ["https://example.com/me.png", /PNG, JPEG or WebP/],
            ["data:image/svg+xml;base64,PHN2Zy8+", /PNG, JPEG or WebP/],
            ["data:text/html;base64,PGgxPmhpPC9oMT4=", /PNG, JPEG or WebP/],
            ["data:image/png,rawbytes", /PNG, JPEG or WebP/],
            ["data:image/png;charset=utf-8;base64,iVBORw0KGgo=", /PNG, JPEG or WebP/],
            [` ${PNG}`, /PNG, JPEG or WebP/],
            ["data:image/png;base64,iVBORw0KGgo", /valid base64/],
            ["data:image/png;base64,", /PNG, JPEG or WebP/],
            [dataUrl("image/png", JPEG_START), /aren't a PNG image/],
            [dataUrl("image/webp", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]), /aren't a WEBP image/],
        ];
        for (const [value, error] of cases) {
            assert.throws(() => validateAvatar(value), error, String(value).slice(0, 40));
        }
    });
});
