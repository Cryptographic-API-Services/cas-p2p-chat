import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { AESGCMSIVWrapper, HmacWrapper } from "cas-typescript-sdk";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { type SqliteRemoteDatabase, drizzle } from "drizzle-orm/sqlite-proxy";
import { migrate } from "drizzle-orm/sqlite-proxy/migrator";
import { type Bytes, fromBase64, fromUtf8, lengthPrefixed, toBase64, utf8 } from "../bytes.ts";
import * as schema from "./schema.ts";

/** Length of the key that protects a device's local database. */
export const STORAGE_KEY_LENGTH = 32;

export type LocalDb = SqliteRemoteDatabase<typeof schema>;

const ENCRYPTION_KEY_CONTEXT = utf8("cas-p2p-chat/v1/local-encryption-key");
const LOOKUP_KEY_CONTEXT = utf8("cas-p2p-chat/v1/local-lookup-key");
const MIGRATIONS_TABLE = "__drizzle_migrations";

const aes = new AESGCMSIVWrapper();
const hmac = new HmacWrapper();

export function createStorageKey(): Bytes {
    return aes.aes256Key();
}

export function serializeStorageKey(key: Bytes): string {
    return JSON.stringify({ version: 1, key: toBase64(key) });
}

export function parseStorageKey(json: string): Bytes {
    const data = JSON.parse(json) as { version?: unknown; key?: unknown };
    if (data.version !== 1) {
        throw new Error(`unsupported storage key version ${String(data.version)}`);
    }
    return fromBase64(data.key, "key", STORAGE_KEY_LENGTH);
}

/** A 32-byte subkey for one purpose: HMAC-SHA512(key, context), truncated. */
function derive(key: Bytes, context: Bytes): Bytes {
    return hmac.hmacSha512SignBytes(key, context).slice(0, 32);
}

/**
 * The migrations drizzle-kit wrote for schema.ts: packages/core/drizzle, whether this runs as
 * src/repositories/*.ts or compiled from dist/src/repositories (also inside the app's asar).
 */
function migrationsFolder(): string {
    for (let dir = import.meta.dirname; ; dir = path.dirname(dir)) {
        const folder = path.join(dir, "drizzle");
        if (fs.existsSync(path.join(folder, "meta", "_journal.json"))) {
            return folder;
        }
        if (path.dirname(dir) === dir) {
            throw new Error("the local database's migrations (packages/core/drizzle) are missing");
        }
    }
}

/**
 * The device's local SQLite database: Node's built-in node:sqlite, queried through Drizzle (its
 * sqlite-proxy driver, since Drizzle 0.45 has no node:sqlite one). Repositories build on it.
 * Every row's content is sealed with AES-256-GCM-SIV under a key the app keeps sealed with the
 * OS keychain, and rows are found by keyed hashes (HMAC-SHA512) instead of fingerprints, so the
 * file doesn't show who you talk to or what was said.
 */
export class LocalDatabase {
    readonly db: LocalDb;
    private readonly sqlite: DatabaseSync;
    private readonly statements = new Map<string, StatementSync>();
    private readonly encryptionKey: Bytes;
    private readonly lookupKey: Bytes;

    /**
     * Opens the database at `file` (":memory:" for a throwaway one), creating it if needed, and
     * applies pending migrations.
     */
    static async open(file: string, key: Bytes): Promise<LocalDatabase> {
        const local = new LocalDatabase(file, key);
        try {
            await local.migrate();
            return local;
        } catch (err) {
            local.close();
            throw err;
        }
    }

    private constructor(file: string, key: Bytes) {
        if (key.length !== STORAGE_KEY_LENGTH) {
            throw new Error(`the storage key must be ${STORAGE_KEY_LENGTH} bytes`);
        }
        this.encryptionKey = derive(key, ENCRYPTION_KEY_CONTEXT);
        this.lookupKey = derive(key, LOOKUP_KEY_CONTEXT);
        if (file !== ":memory:") {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            // Owner-only before SQLite opens it; SQLite gives its -wal and -shm files the same permissions.
            fs.closeSync(fs.openSync(file, "a", 0o600));
        }
        this.sqlite = new DatabaseSync(file);
        // secure_delete overwrites deleted rows instead of leaving them in free pages.
        this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 5000;");
        // node:sqlite is synchronous, so each query runs whole before anything else can.
        this.db = drizzle(async (sql, params, method) => {
            const statement = this.prepare(sql);
            const values = params as SQLInputValue[];
            if (method === "run") {
                statement.run(...values);
                return { rows: [] };
            }
            // Drizzle maps result columns by position.
            return { rows: method === "get" ? statement.get(...values) : statement.all(...values) } as { rows: unknown[] };
        }, { schema });
    }

    /** A stable, opaque 32-byte ID for `value` (a fingerprint, say), different for each context. */
    lookupId(context: Bytes, value: string): Buffer {
        return Buffer.from(hmac.hmacSha512SignBytes(this.lookupKey, lengthPrefixed(context, utf8(value))).slice(0, 32));
    }

    /** Encrypts `plaintext`, bound to the context and to `binding` (the row's identifying columns). */
    seal(context: Bytes, plaintext: string, binding: Array<Bytes | Uint8Array>): Buffer {
        return Buffer.from(aes.aes256Seal(this.encryptionKey, utf8(plaintext), aad(context, binding)));
    }

    /** Decrypts what seal produced. Throws if it was altered, or moved to a row with a different binding. */
    unseal(context: Bytes, sealed: Uint8Array, binding: Array<Bytes | Uint8Array>): string {
        return fromUtf8(aes.aes256Open(this.encryptionKey, Array.from(sealed), aad(context, binding)));
    }

    /** Moves the write-ahead log into the database file and empties it, e.g. after deleting rows. */
    checkpoint(): void {
        this.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }

    close(): void {
        if (this.sqlite.isOpen) {
            this.sqlite.close();
        }
    }

    private prepare(sql: string): StatementSync {
        let statement = this.statements.get(sql);
        if (!statement) {
            statement = this.sqlite.prepare(sql);
            statement.setReturnArrays(true);
            this.statements.set(sql, statement);
        }
        return statement;
    }

    /** Applies drizzle-kit's pending migrations in one transaction. */
    private async migrate(): Promise<void> {
        const config = { migrationsFolder: migrationsFolder(), migrationsTable: MIGRATIONS_TABLE };
        await migrate(this.db, async (queries) => {
            this.sqlite.exec("BEGIN IMMEDIATE");
            try {
                for (const query of queries) {
                    this.sqlite.exec(query);
                }
                this.sqlite.exec("COMMIT");
            } catch (err) {
                this.sqlite.exec("ROLLBACK");
                throw err;
            }
        }, config);
        // Drizzle skips migrations it doesn't know, so an older app would run on a newer schema.
        const newest = Math.max(0, ...readMigrationFiles(config).map((m) => m.folderMillis));
        const applied = this.prepare(`SELECT max(created_at) FROM ${MIGRATIONS_TABLE}`).get() as unknown as [number | string | null];
        if (Number(applied[0] ?? 0) > newest) {
            throw new Error("the local database was written by a newer version of the app");
        }
    }
}

function aad(context: Bytes, binding: Array<Bytes | Uint8Array>): Bytes {
    return lengthPrefixed(context, ...binding.map((part) => Array.from(part)));
}
