import { eq } from "drizzle-orm";
import { utf8 } from "../bytes.ts";
import type { LocalDatabase } from "./local-database.ts";
import { settings } from "./schema.ts";

/** The user's choices that outlive a run. */
export interface Settings {
    /** The server to join at startup, or null for none. */
    serverUrl: string | null;
    /** Listed in the server's find-by-name directory. */
    listed: boolean;
}

export interface SettingsRepository {
    /** The saved settings, or null if none have been saved. */
    load(): Promise<Settings | null>;
    save(value: Settings): Promise<void>;
}

const SETTINGS_CONTEXT = utf8("cas-p2p-chat/v1/local-settings");
const ROW_ID = 1;

/** Settings in the local database: one sealed row. */
export class SqliteSettingsRepository implements SettingsRepository {
    private readonly local: LocalDatabase;

    constructor(local: LocalDatabase) {
        this.local = local;
    }

    async load(): Promise<Settings | null> {
        const [row] = await this.local.db.select({ sealed: settings.sealed }).from(settings).where(eq(settings.id, ROW_ID));
        if (!row) {
            return null;
        }
        try {
            return toSettings(JSON.parse(this.local.unseal(SETTINGS_CONTEXT, row.sealed, [])));
        } catch {
            return null;
        }
    }

    async save(value: Settings): Promise<void> {
        const sealed = this.local.seal(SETTINGS_CONTEXT, JSON.stringify(toSettings(value)), []);
        await this.local.db.insert(settings).values({ id: ROW_ID, sealed }).onConflictDoUpdate({ target: settings.id, set: { sealed } });
    }
}

/** Keeps only well-formed fields, so nothing else can ride along in the row. */
export function toSettings(value: unknown): Settings {
    const { serverUrl, listed } = (value ?? {}) as Record<string, unknown>;
    return { serverUrl: typeof serverUrl === "string" ? serverUrl : null, listed: listed !== false };
}
