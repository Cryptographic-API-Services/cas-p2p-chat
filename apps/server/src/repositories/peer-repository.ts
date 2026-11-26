import { MAX_CLOCK_SKEW_MS, type SignedRegistration, type VerifiedRegistration } from "@cas-p2p-chat/core/directory-record";
import { and, count, desc, eq, isNotNull, like, lt, sql } from "drizzle-orm";
import type { Database } from "../db.ts";
import { peers } from "../schema.ts";

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

export type RegisterResult = "created" | "updated" | "stale";
export type DeleteResult = "deleted" | "not-found" | "stale";

/** The directory's listings. Route handlers depend on this; DrizzlePeerRepository implements it. */
export interface PeerRepository {
    /**
     * Stores a verified registration. Returns "stale" if its timestamp isn't newer than the
     * last one accepted for this peer, which is how replays are refused. Atomic per peer, so
     * concurrent requests can't reorder the check.
     */
    register(verified: VerifiedRegistration, now: number): Promise<RegisterResult>;
    /** Removes a peer's listing, keeping a tombstone so an older registration can't bring it back. */
    delete(fingerprint: string, timestamp: number, now: number): Promise<DeleteResult>;
    get(fingerprint: string): Promise<StoredPeer | null>;
    /** Listed peers whose name contains `query` (case-insensitive), most recently seen first. */
    search(query: string, limit: number): Promise<StoredPeer[]>;
    /** Every listed peer, most recently seen first. For maintenance and tests; not served over HTTP. */
    list(limit?: number): Promise<StoredPeer[]>;
    count(): Promise<number>;
    /** Drops expired tombstones and peers that haven't refreshed within the retention period. */
    purge(now: number): Promise<void>;
}

export interface DrizzlePeerRepositoryOptions {
    /** Most peers kept; registering past it evicts the least recently seen. */
    maxPeers?: number;
    /** Peers that haven't refreshed their listing for this long are forgotten. */
    retentionMs?: number;
}

type PeerRow = typeof peers.$inferSelect;

const DAY_MS = 24 * 60 * 60_000;

/** Lowercased, Unicode-normalized form used for name search. */
export function searchKey(text: string): string {
    return text.normalize("NFKC").toLowerCase();
}

/**
 * Listings in PostgreSQL (node-postgres or PGlite), through Drizzle. Deleted peers leave a
 * tombstone with their last signed timestamp for a few minutes, so an old registration can't be
 * replayed to bring them back.
 */
export class DrizzlePeerRepository implements PeerRepository {
    private readonly db: Database;
    private readonly maxPeers: number;
    private readonly retentionMs: number;

    constructor(db: Database, options: DrizzlePeerRepositoryOptions = {}) {
        this.db = db;
        this.maxPeers = options.maxPeers ?? 10_000;
        this.retentionMs = options.retentionMs ?? 30 * DAY_MS;
    }

    register(verified: VerifiedRegistration, now: number): Promise<RegisterResult> {
        const { fingerprint, record } = verified;
        return this.db.transaction(async (tx) => {
            // Lock the peer's row, so concurrent registrations for it are ordered.
            const [existing] = await tx.select().from(peers).where(eq(peers.fingerprint, fingerprint)).for("update");
            if (existing && record.timestamp <= existing.timestamp) {
                return "stale";
            }
            const isNew = !existing || existing.record === null;
            if (isNew && (await this.countIn(tx)) >= this.maxPeers) {
                const [oldest] = await tx
                    .select({ fingerprint: peers.fingerprint })
                    .from(peers)
                    .where(isNotNull(peers.record))
                    .orderBy(peers.lastSeen)
                    .limit(1);
                if (oldest) {
                    await tx.delete(peers).where(eq(peers.fingerprint, oldest.fingerprint));
                }
            }
            const written = await tx
                .insert(peers)
                .values({ fingerprint, nameKey: searchKey(record.name), record, timestamp: record.timestamp, firstSeen: now, lastSeen: now })
                .onConflictDoUpdate({
                    target: peers.fingerprint,
                    set: {
                        nameKey: sql`excluded.name_key`,
                        record: sql`excluded.record`,
                        timestamp: sql`excluded.timestamp`,
                        firstSeen: sql`CASE WHEN ${peers.record} IS NULL THEN excluded.first_seen ELSE ${peers.firstSeen} END`,
                        lastSeen: sql`excluded.last_seen`,
                        deletedAt: null,
                    },
                    // A row inserted concurrently (no lock above) with a newer timestamp wins.
                    setWhere: lt(peers.timestamp, sql`excluded.timestamp`),
                })
                .returning({ fingerprint: peers.fingerprint });
            if (written.length === 0) {
                return "stale";
            }
            return isNew ? "created" : "updated";
        });
    }

    delete(fingerprint: string, timestamp: number, now: number): Promise<DeleteResult> {
        return this.db.transaction(async (tx) => {
            const [existing] = await tx.select().from(peers).where(eq(peers.fingerprint, fingerprint)).for("update");
            if (!existing || existing.record === null) {
                return "not-found";
            }
            if (timestamp <= existing.timestamp) {
                return "stale";
            }
            await tx
                .update(peers)
                .set({ nameKey: null, record: null, timestamp, deletedAt: now })
                .where(eq(peers.fingerprint, fingerprint));
            return "deleted";
        });
    }

    async get(fingerprint: string): Promise<StoredPeer | null> {
        const [row] = await this.db.select().from(peers).where(eq(peers.fingerprint, fingerprint));
        return row && row.record !== null ? toPeer(row) : null;
    }

    async search(query: string, limit: number): Promise<StoredPeer[]> {
        // Backslash is PostgreSQL's default LIKE escape character.
        const pattern = `%${searchKey(query).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const rows = await this.db
            .select()
            .from(peers)
            .where(and(isNotNull(peers.record), like(peers.nameKey, pattern)))
            .orderBy(desc(peers.lastSeen))
            .limit(limit);
        return rows.map(toPeer);
    }

    async list(limit = 500): Promise<StoredPeer[]> {
        const rows = await this.db.select().from(peers).where(isNotNull(peers.record)).orderBy(desc(peers.lastSeen)).limit(limit);
        return rows.map(toPeer);
    }

    count(): Promise<number> {
        return this.countIn(this.db);
    }

    async purge(now: number): Promise<void> {
        // Once a tombstone outlives the clock-skew window, no replayable registration remains.
        await this.db.delete(peers).where(and(isNotNull(peers.deletedAt), lt(peers.deletedAt, now - 2 * MAX_CLOCK_SKEW_MS)));
        await this.db.delete(peers).where(and(isNotNull(peers.record), lt(peers.lastSeen, now - this.retentionMs)));
    }

    private async countIn(db: Pick<Database, "select">): Promise<number> {
        const [row] = await db.select({ n: count() }).from(peers).where(isNotNull(peers.record));
        return row?.n ?? 0;
    }
}

function toPeer(row: PeerRow): StoredPeer {
    return { fingerprint: row.fingerprint, record: row.record!, firstSeen: row.firstSeen, lastSeen: row.lastSeen };
}
