/** A real 1×1 PNG, as a data URL: a valid avatar. */
export const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A minimal JPEG (just its start), as a data URL: also a valid avatar, and different from PNG. */
export const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString("base64")}`;
