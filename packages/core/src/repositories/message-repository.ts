import { randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { utf8 } from "../bytes.ts";
import type { LocalDatabase } from "./local-database.ts";
import { messages } from "./schema.ts";

export type MessageDirection = "in" | "out";

export interface StoredMessage {
    /** Increases with every message saved on this device. */
    id: number;
    direction: MessageDirection;
    text: string;
    at: number;
}

export interface MessageHistory {
    /** Oldest first. */
    messages: StoredMessage[];
    /** Saved messages that failed to decrypt (corrupted, tampered with, or sealed under another key), left out. */
    unreadable: number;
}

/** Messages sent to and received from peers, kept on this device. */
export interface MessageRepository {
    add(fingerprint: string, direction: MessageDirection, text: string, at: number): Promise<StoredMessage>;
    /** The latest `limit` messages with a peer. */
    history(fingerprint: string, limit: number): Promise<MessageHistory>;
    /** When the last message with a peer was sent or received, or null if there's none. */
    lastMessageAt(fingerprint: string): Promise<number | null>;
    /** Deletes every message with a peer. Returns how many there were. */
    clear(fingerprint: string): Promise<number>;
}

const CONVERSATION_CONTEXT = utf8("cas-p2p-chat/v1/local-conversation");
const MESSAGE_CONTEXT = utf8("cas-p2p-chat/v1/local-message");

interface MessageRow {
    id: number;
    uid: Buffer;
    sealed: Buffer;
}

/**
 * Messages in the local database. A row holds only an opaque conversation ID (a keyed hash of
 * the peer's fingerprint), a random uid and the sealed message: direction, text and time. The
 * seal is bound to the conversation and the uid, so a message can't be moved to another
 * conversation, swapped with another or duplicated without failing to decrypt. Histories are
 * ordered by the sealed time, so reordering rows doesn't reorder them either.
 */
export class SqliteMessageRepository implements MessageRepository {
    private readonly local: LocalDatabase;

    constructor(local: LocalDatabase) {
        this.local = local;
    }

    async add(fingerprint: string, direction: MessageDirection, text: string, at: number): Promise<StoredMessage> {
        const conversation = this.conversation(fingerprint);
        const uid = randomBytes(16);
        const sealed = this.local.seal(MESSAGE_CONTEXT, JSON.stringify({ direction, text, at }), [conversation, uid]);
        const [row] = await this.local.db.insert(messages).values({ conversation, uid, sealed }).returning({ id: messages.id });
        return { id: row.id, direction, text, at };
    }

    async history(fingerprint: string, limit: number): Promise<MessageHistory> {
        const conversation = this.conversation(fingerprint);
        const rows = await this.latest(conversation, limit);
        const readable = rows.map((row) => this.open(conversation, row)).filter((message) => message !== null);
        readable.sort((a, b) => a.at - b.at || a.id - b.id);
        return { messages: readable, unreadable: rows.length - readable.length };
    }

    async lastMessageAt(fingerprint: string): Promise<number | null> {
        const conversation = this.conversation(fingerprint);
        const [row] = await this.latest(conversation, 1);
        return row ? this.open(conversation, row)?.at ?? null : null;
    }

    async clear(fingerprint: string): Promise<number> {
        const deleted = await this.local.db
            .delete(messages)
            .where(eq(messages.conversation, this.conversation(fingerprint)))
            .returning({ id: messages.id });
        // secure_delete overwrote the rows in the database; push the old pages out of the write-ahead log too.
        this.local.checkpoint();
        return deleted.length;
    }

    private conversation(fingerprint: string): Buffer {
        return this.local.lookupId(CONVERSATION_CONTEXT, fingerprint);
    }

    private latest(conversation: Buffer, limit: number): Promise<MessageRow[]> {
        return this.local.db
            .select({ id: messages.id, uid: messages.uid, sealed: messages.sealed })
            .from(messages)
            .where(eq(messages.conversation, conversation))
            .orderBy(desc(messages.id))
            .limit(limit);
    }

    private open(conversation: Buffer, row: MessageRow): StoredMessage | null {
        try {
            const data = JSON.parse(this.local.unseal(MESSAGE_CONTEXT, row.sealed, [conversation, row.uid])) as Partial<StoredMessage>;
            const { direction, text, at } = data;
            if ((direction === "in" || direction === "out") && typeof text === "string" && Number.isSafeInteger(at)) {
                return { id: row.id, direction, text, at: at! };
            }
        } catch {
            // Reported as unreadable.
        }
        return null;
    }
}
