import type { Contact, ContactRepository } from "./repositories/contact-repository.ts";

/** new: first time this key has connected. known: seen before. verified: the user compared fingerprints. */
export type TrustLevel = "new" | "known" | "verified";

export interface TrustInfo {
    level: TrustLevel;
    /** A different key has connected under this same name before: a new device, or an impersonator. */
    nameConflict: boolean;
}

/**
 * Trust-on-first-use record of peer identity keys, keyed by fingerprint. It doubles as the
 * contact list: everyone this device has ever connected to. Read from memory, and written
 * through to a ContactRepository.
 */
export class TrustStore {
    private readonly entries = new Map<string, Contact>();
    private readonly contacts: ContactRepository;

    /** Loads every contact from the repository. */
    static async load(contacts: ContactRepository): Promise<TrustStore> {
        return new TrustStore(contacts, await contacts.all());
    }

    private constructor(contacts: ContactRepository, entries: Contact[]) {
        this.contacts = contacts;
        for (const contact of entries) {
            this.entries.set(contact.fingerprint, contact);
        }
    }

    /** Classifies a peer that just connected, then records it as seen. */
    async observe(fingerprint: string, name: string): Promise<TrustInfo> {
        const info = this.get(fingerprint, name);
        const now = new Date().toISOString();
        const existing = this.entries.get(fingerprint);
        await this.write({
            fingerprint,
            name,
            firstSeen: existing?.firstSeen ?? now,
            lastSeen: now,
            verified: existing?.verified ?? false,
        });
        return info;
    }

    get(fingerprint: string, name: string): TrustInfo {
        const entry = this.entries.get(fingerprint);
        const level: TrustLevel = !entry ? "new" : entry.verified ? "verified" : "known";
        const nameConflict = [...this.entries].some(([fp, e]) => fp !== fingerprint && e.name === name);
        return { level, nameConflict };
    }

    /** Every peer this device has connected to: its local contact list. Never leaves the device. */
    list(): Array<{ fingerprint: string; name: string; firstSeen: string; lastSeen: string; trust: TrustInfo }> {
        return [...this.entries.values()].map(({ fingerprint, name, firstSeen, lastSeen }) => ({
            fingerprint,
            name,
            firstSeen,
            lastSeen,
            trust: this.get(fingerprint, name),
        }));
    }

    async setVerified(fingerprint: string, verified: boolean): Promise<void> {
        const entry = this.entries.get(fingerprint);
        if (!entry) {
            throw new Error("unknown peer");
        }
        await this.write({ ...entry, verified });
    }

    private async write(contact: Contact): Promise<void> {
        await this.contacts.save(contact);
        this.entries.set(contact.fingerprint, contact);
    }
}
