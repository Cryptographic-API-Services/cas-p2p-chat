import * as fs from "node:fs";
import * as path from "node:path";

/** new: first time this key has connected. known: seen before. verified: the user compared fingerprints. */
export type TrustLevel = "new" | "known" | "verified";

export interface TrustInfo {
    level: TrustLevel;
    /** A different key has connected under this same name before: a new device, or an impersonator. */
    nameConflict: boolean;
}

interface Entry {
    name: string;
    firstSeen: string;
    lastSeen: string;
    verified: boolean;
}

/**
 * Trust-on-first-use record of peer identity keys, keyed by fingerprint, stored as JSON on this
 * device. It doubles as the contact list: everyone this device has ever connected to.
 */
export class TrustStore {
    private readonly entries = new Map<string, Entry>();

    constructor(private readonly file: string) {
        if (!fs.existsSync(file)) {
            return;
        }
        try {
            const data = JSON.parse(fs.readFileSync(file, "utf8")) as { peers?: unknown };
            for (const item of Array.isArray(data.peers) ? data.peers : []) {
                const { fingerprint, name, firstSeen, lastSeen, verified } = item as Record<string, unknown>;
                if (typeof fingerprint === "string" && typeof name === "string") {
                    this.entries.set(fingerprint, {
                        name,
                        firstSeen: String(firstSeen),
                        lastSeen: String(lastSeen),
                        verified: verified === true,
                    });
                }
            }
        } catch {
            // Keep the unreadable file for inspection and start a fresh one.
            fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
        }
    }

    /** Classifies a peer that just connected, then records it as seen. */
    observe(fingerprint: string, name: string): TrustInfo {
        const info = this.get(fingerprint, name);
        const now = new Date().toISOString();
        const existing = this.entries.get(fingerprint);
        this.entries.set(fingerprint, {
            name,
            firstSeen: existing?.firstSeen ?? now,
            lastSeen: now,
            verified: existing?.verified ?? false,
        });
        this.save();
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
        return [...this.entries].map(([fingerprint, entry]) => ({
            fingerprint,
            name: entry.name,
            firstSeen: entry.firstSeen,
            lastSeen: entry.lastSeen,
            trust: this.get(fingerprint, entry.name),
        }));
    }

    setVerified(fingerprint: string, verified: boolean): void {
        const entry = this.entries.get(fingerprint);
        if (!entry) {
            throw new Error("unknown peer");
        }
        entry.verified = verified;
        this.save();
    }

    private save(): void {
        const peers = [...this.entries].map(([fingerprint, entry]) => ({ fingerprint, ...entry }));
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, peers }, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, this.file);
    }
}
