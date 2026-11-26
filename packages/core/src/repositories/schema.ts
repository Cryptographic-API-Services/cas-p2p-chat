// The desktop app's local database (SQLite, through Drizzle). Every table holds only opaque IDs
// and sealed blobs: see local-database.ts. After editing, run
// `npm run db:generate -w @cas-p2p-chat/core` to write a migration; the app applies it at startup.
import { blob, index, integer, sqliteTable } from "drizzle-orm/sqlite-core";

/** One row (id 1): the sealed settings. */
export const settings = sqliteTable("settings", {
    id: integer("id").primaryKey(),
    sealed: blob("sealed", { mode: "buffer" }).notNull(),
});

export const contacts = sqliteTable("contacts", {
    /** A keyed hash of the contact's fingerprint. */
    id: blob("id", { mode: "buffer" }).primaryKey(),
    sealed: blob("sealed", { mode: "buffer" }).notNull(),
});

export const messages = sqliteTable(
    "messages",
    {
        /** Insertion order: which messages are the latest. */
        id: integer("id").primaryKey({ autoIncrement: true }),
        /** A keyed hash of the peer's fingerprint. */
        conversation: blob("conversation", { mode: "buffer" }).notNull(),
        /** Random. The seal is bound to it, so a sealed message can't be copied into another row. */
        uid: blob("uid", { mode: "buffer" }).notNull().unique(),
        sealed: blob("sealed", { mode: "buffer" }).notNull(),
    },
    (t) => [index("messages_by_conversation").on(t.conversation, t.id)],
);
