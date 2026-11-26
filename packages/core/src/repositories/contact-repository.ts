import { utf8 } from "../bytes.ts";
import type { LocalDatabase } from "./local-database.ts";
import { contacts } from "./schema.ts";

/** Someone this device has connected to. */
export interface Contact {
    fingerprint: string;
    name: string;
    firstSeen: string;
    lastSeen: string;
    /** The user compared fingerprints out of band. */
    verified: boolean;
}

/** Everyone this device has connected to. It never leaves the device. */
export interface ContactRepository {
    /** Every contact that can be read. */
    all(): Promise<Contact[]>;
    /** Adds the contact, or replaces the one with the same fingerprint. */
    save(contact: Contact): Promise<void>;
}

const CONTACT_ID_CONTEXT = utf8("cas-p2p-chat/v1/local-contact-id");
const CONTACT_CONTEXT = utf8("cas-p2p-chat/v1/local-contact");

/**
 * Contacts in the local database: an opaque ID (a keyed hash of the fingerprint, unrelated to
 * the message table's conversation IDs) and the sealed contact. Rows that fail to decrypt are
 * left out.
 */
export class SqliteContactRepository implements ContactRepository {
    private readonly local: LocalDatabase;

    constructor(local: LocalDatabase) {
        this.local = local;
    }

    async all(): Promise<Contact[]> {
        const result: Contact[] = [];
        for (const row of await this.local.db.select().from(contacts)) {
            try {
                // The seal is bound to the row ID, a keyed hash of the fingerprint inside, so a
                // contact can't be copied into another contact's row.
                const contact = toContact(JSON.parse(this.local.unseal(CONTACT_CONTEXT, row.sealed, [row.id])));
                if (contact) {
                    result.push(contact);
                }
            } catch {
                // Unreadable: skip it.
            }
        }
        return result;
    }

    async save(contact: Contact): Promise<void> {
        const id = this.local.lookupId(CONTACT_ID_CONTEXT, contact.fingerprint);
        const sealed = this.local.seal(CONTACT_CONTEXT, JSON.stringify(contact), [id]);
        await this.local.db.insert(contacts).values({ id, sealed }).onConflictDoUpdate({ target: contacts.id, set: { sealed } });
    }
}

/** Keeps only well-formed fields, so nothing else can ride along in a row. Null if it isn't a contact. */
export function toContact(value: unknown): Contact | null {
    const { fingerprint, name, firstSeen, lastSeen, verified } = (value ?? {}) as Record<string, unknown>;
    if (typeof fingerprint !== "string" || typeof name !== "string") {
        return null;
    }
    return { fingerprint, name, firstSeen: String(firstSeen), lastSeen: String(lastSeen), verified: verified === true };
}
