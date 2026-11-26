import { safeStorage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

/** "os": sealed with the OS keychain (Electron safeStorage). "none": there's no keychain, so stored as is. */
export type KeyProtection = "os" | "none";

/**
 * A key kept outside the local database: the identity key, and the key that opens the database
 * (which can't be stored inside it).
 */
export interface KeyRepository<T> {
    /** The stored key, or null if there's none yet. */
    load(): Promise<{ value: T; protection: KeyProtection } | null>;
    save(value: T): Promise<KeyProtection>;
}

export interface KeyCodec<T> {
    serialize(value: T): string;
    /** Throws if the text isn't a valid key. */
    parse(text: string): T;
}

/** True when safeStorage really encrypts (on Linux it can fall back to a hard-coded key). */
async function osEncryptionAvailable(): Promise<boolean> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
        return false;
    }
    return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
}

/** A key in its own JSON file, sealed with the OS keychain when there is one. */
export class SealedFileKeyRepository<T> implements KeyRepository<T> {
    private readonly file: string;
    private readonly codec: KeyCodec<T>;

    constructor(file: string, codec: KeyCodec<T>) {
        this.file = file;
        this.codec = codec;
    }

    async load(): Promise<{ value: T; protection: KeyProtection } | null> {
        if (!fs.existsSync(this.file)) {
            return null;
        }
        const stored = JSON.parse(fs.readFileSync(this.file, "utf8")) as { protection?: string; data?: string };
        if (stored.protection !== "safeStorage") {
            return { value: this.codec.parse(stored.data ?? ""), protection: "none" };
        }
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(stored.data ?? "", "base64"));
        const value = this.codec.parse(result);
        // The OS rotated its key: re-seal under the new one.
        return { value, protection: shouldReEncrypt ? await this.save(value) : "os" };
    }

    async save(value: T): Promise<KeyProtection> {
        const text = this.codec.serialize(value);
        const protect = await osEncryptionAvailable();
        const stored = protect
            ? { protection: "safeStorage", data: (await safeStorage.encryptStringAsync(text)).toString("base64") }
            : { protection: "none", data: text };
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        // Write, then rename over the old file, so a crash can't leave half a key.
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
        fs.renameSync(tmp, this.file);
        return protect ? "os" : "none";
    }
}

/** Loads a key, creating and saving a new one if there's none yet. */
export async function loadOrCreateKey<T>(keys: KeyRepository<T>, create: () => T): Promise<{ value: T; protection: KeyProtection }> {
    const loaded = await keys.load();
    if (loaded) {
        return loaded;
    }
    const value = create();
    return { value, protection: await keys.save(value) };
}
