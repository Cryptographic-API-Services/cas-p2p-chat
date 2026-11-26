import type { SignedRegistration } from "@cas-p2p-chat/core/directory-record";
import { bigint, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";

/**
 * Listed peers. This is everything the directory keeps: a self-signed record of a name and an
 * identity key, and when the peer first listed and last refreshed. No IP addresses, ports or
 * connection history. A deleted peer keeps its row for a few minutes as a tombstone (`record`
 * and `name_key` NULL), so an old registration can't be replayed to bring it back.
 *
 * Times are Unix milliseconds. Change this file, then run `npm run db:generate` to add a
 * migration under drizzle/.
 */
export const peers = pgTable(
    "peers",
    {
        fingerprint: text("fingerprint").primaryKey(),
        /** searchKey(name); NULL once deleted. */
        nameKey: text("name_key"),
        /** The signed registration; NULL once deleted. */
        record: jsonb("record").$type<SignedRegistration>(),
        /** Newest accepted signed timestamp (the replay guard). */
        timestamp: bigint("timestamp", { mode: "number" }).notNull(),
        firstSeen: bigint("first_seen", { mode: "number" }).notNull(),
        lastSeen: bigint("last_seen", { mode: "number" }).notNull(),
        deletedAt: bigint("deleted_at", { mode: "number" }),
    },
    (table) => [index("peers_last_seen").on(table.lastSeen)],
);
