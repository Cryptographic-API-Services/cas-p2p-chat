import { DatabaseSync } from "node:sqlite";
import { MAX_CLOCK_SKEW_MS, SignedRegistration, VerifiedRegistration } from "../core/directory-record";

/**
 * A listed peer, as stored. This is everything the directory keeps: a self-signed record of a
 * name and identity key, and when the peer first listed and last refreshed. No IP addresses,
 * ports or connection history.
 */
export interface StoredPeer {
    fingerprint: string;
    record: SignedRegistration;
    firstSeen: number;
    lastSeen: number;
}

export interface PeerStoreOptions {
    /** Most peers kept; registering past it evicts the least recently seen. */
    maxPeers?: number;
    /** Peers that haven't refreshed their listing for this long are forgotten. */
    retentionMs?: number;
}

interface PeerRow {
    fingerprint: string;
    record: string | null;
    timestamp: number;
    first_seen: number;
    last_seen: number;
}

const DAY_MS = 24 * 60 * 60_000;
const SCHEMA_VERSION = 2;

/** Lowercased, Unicode-normalized form used for name search. */
export function searchKey(text: string): string {
    return text.normalize("NFKC").toLowerCase();
}

/**
 * SQLite-backed store (Node's built-in node:sqlite) of listed peers. Deleted peers leave a
 * tombstone with their last signed timestamp for a few minutes, so an old registration can't
 * be replayed to bring them back.
 */
export class PeerStore {
    private readonly db: DatabaseSync;
    private readonly maxPeers: number;
    private readonly retentionMs: number;

    constructor(file = ":memory:", options: PeerStoreOptions = {}) {
        this.maxPeers = options.maxPeers ?? 10_000;
        this.retentionMs = options.retentionMs ?? 30 * DAY_MS;
        this.db = new DatabaseSync(file);
        const { user_version: version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
        if (version < SCHEMA_VERSION) {
            // Schema 1 stored peers' IP addresses. Drop it rather than migrate, so none survive.
            this.db.exec("DROP TABLE IF EXISTS peers");
        }
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS peers (
                fingerprint TEXT PRIMARY KEY,
                name_key    TEXT,             -- searchKey(name); NULL once deleted
                record      TEXT,             -- signed registration JSON; NULL once deleted
                timestamp   INTEGER NOT NULL, -- newest accepted signed timestamp (replay guard)
                first_seen  INTEGER NOT NULL,
                last_seen   INTEGER NOT NULL,
                deleted_at  INTEGER
            );
            CREATE INDEX IF NOT EXISTS peers_last_seen ON peers (last_seen);
            PRAGMA user_version = ${SCHEMA_VERSION};
        `);
    }

    /**
     * Stores a verified registration. Returns "stale" if its timestamp isn't newer than the
     * last one accepted for this peer, which is how replays are refused.
     */
    register(verified: VerifiedRegistration, now: number): "created" | "updated" | "stale" {
        const existing = this.row(verified.fingerprint);
        if (existing && verified.record.timestamp <= existing.timestamp) {
            return "stale";
        }
        const isNew = !existing || existing.record === null;
        if (isNew && this.count() >= this.maxPeers) {
            this.db.prepare(
                "DELETE FROM peers WHERE fingerprint = (SELECT fingerprint FROM peers WHERE record IS NOT NULL ORDER BY last_seen ASC LIMIT 1)",
            ).run();
        }
        this.db.prepare(`
            INSERT INTO peers (fingerprint, name_key, record, timestamp, first_seen, last_seen, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT (fingerprint) DO UPDATE SET
                name_key = excluded.name_key,
                record = excluded.record,
                timestamp = excluded.timestamp,
                first_seen = CASE WHEN peers.record IS NULL THEN excluded.first_seen ELSE peers.first_seen END,
                last_seen = excluded.last_seen,
                deleted_at = NULL
        `).run(
            verified.fingerprint,
            searchKey(verified.record.name),
            JSON.stringify(verified.record),
            verified.record.timestamp,
            now,
            now,
        );
        return isNew ? "created" : "updated";
    }

    /** Removes a peer's listing, keeping a tombstone. */
    delete(fingerprint: string, timestamp: number, now: number): "deleted" | "not-found" | "stale" {
        const existing = this.row(fingerprint);
        if (!existing || existing.record === null) {
            return "not-found";
        }
        if (timestamp <= existing.timestamp) {
            return "stale";
        }
        this.db.prepare(
            "UPDATE peers SET name_key = NULL, record = NULL, timestamp = ?, deleted_at = ? WHERE fingerprint = ?",
        ).run(timestamp, now, fingerprint);
        return "deleted";
    }

    get(fingerprint: string): StoredPeer | null {
        const row = this.row(fingerprint);
        return row && row.record !== null ? toPeer(row) : null;
    }

    /** Listed peers whose name contains `query` (case-insensitive), most recently seen first. */
    search(query: string, limit: number): StoredPeer[] {
        const pattern = `%${searchKey(query).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const rows = this.db.prepare(
            "SELECT * FROM peers WHERE record IS NOT NULL AND name_key LIKE ? ESCAPE '\\' ORDER BY last_seen DESC LIMIT ?",
        ).all(pattern, limit) as unknown as PeerRow[];
        return rows.map(toPeer);
    }

    /** Every listed peer, most recently seen first. For maintenance and tests; not served over HTTP. */
    list(limit = 500): StoredPeer[] {
        const rows = this.db.prepare(
            "SELECT * FROM peers WHERE record IS NOT NULL ORDER BY last_seen DESC LIMIT ?",
        ).all(limit) as unknown as PeerRow[];
        return rows.map(toPeer);
    }

    count(): number {
        const row = this.db.prepare("SELECT COUNT(*) AS n FROM peers WHERE record IS NOT NULL").get() as { n: number };
        return row.n;
    }

    /** Drops expired tombstones and peers that haven't refreshed within the retention period. */
    purge(now: number): void {
        // Once a tombstone outlives the clock-skew window, no replayable registration remains.
        this.db.prepare("DELETE FROM peers WHERE deleted_at IS NOT NULL AND deleted_at < ?").run(now - 2 * MAX_CLOCK_SKEW_MS);
        this.db.prepare("DELETE FROM peers WHERE record IS NOT NULL AND last_seen < ?").run(now - this.retentionMs);
    }

    close(): void {
        this.db.close();
    }

    private row(fingerprint: string): PeerRow | undefined {
        return this.db.prepare("SELECT * FROM peers WHERE fingerprint = ?").get(fingerprint) as PeerRow | undefined;
    }
}

function toPeer(row: PeerRow): StoredPeer {
    return {
        fingerprint: row.fingerprint,
        record: JSON.parse(row.record!) as SignedRegistration,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
    };
}
