import { eq } from "drizzle-orm";
import { validateAvatar } from "../avatar.ts";
import { utf8 } from "../bytes.ts";
import type { LocalDatabase } from "./local-database.ts";
import { avatars } from "./schema.ts";

/** Profile pictures by fingerprint: this device's own and its contacts'. They never leave the device, except our own, sent to peers we chat with. */
export interface AvatarRepository {
    /** The avatar (a data URL), or null if there is none or it can't be read. */
    get(fingerprint: string): Promise<string | null>;
    /** Saves an avatar that passed validateAvatar, or deletes it with null. */
    save(fingerprint: string, avatar: string | null): Promise<void>;
}

const AVATAR_ID_CONTEXT = utf8("cas-p2p-chat/v1/local-avatar-id");
const AVATAR_CONTEXT = utf8("cas-p2p-chat/v1/local-avatar");

/**
 * Avatars in the local database: an opaque ID (a keyed hash of the fingerprint, unrelated to
 * the contact and message tables' IDs) and the sealed data URL, bound to that ID.
 */
export class SqliteAvatarRepository implements AvatarRepository {
    private readonly local: LocalDatabase;

    constructor(local: LocalDatabase) {
        this.local = local;
    }

    async get(fingerprint: string): Promise<string | null> {
        const id = this.local.lookupId(AVATAR_ID_CONTEXT, fingerprint);
        const [row] = await this.local.db.select({ sealed: avatars.sealed }).from(avatars).where(eq(avatars.id, id));
        if (!row) {
            return null;
        }
        try {
            // Checked again on the way out: it becomes an <img src>.
            return validateAvatar(this.local.unseal(AVATAR_CONTEXT, row.sealed, [id]));
        } catch {
            return null;
        }
    }

    async save(fingerprint: string, avatar: string | null): Promise<void> {
        const id = this.local.lookupId(AVATAR_ID_CONTEXT, fingerprint);
        if (avatar === null) {
            await this.local.db.delete(avatars).where(eq(avatars.id, id));
            return;
        }
        const sealed = this.local.seal(AVATAR_CONTEXT, validateAvatar(avatar), [id]);
        await this.local.db.insert(avatars).values({ id, sealed }).onConflictDoUpdate({ target: avatars.id, set: { sealed } });
    }
}
