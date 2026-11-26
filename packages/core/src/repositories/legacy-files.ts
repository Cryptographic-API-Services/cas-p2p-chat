import * as fs from "node:fs";
import * as path from "node:path";
import { type ContactRepository, toContact } from "./contact-repository.ts";
import { type SettingsRepository, toSettings } from "./settings-repository.ts";

export interface LegacyImport {
    contacts: number;
    settings: boolean;
}

/**
 * Versions up to 0.2 kept contacts (known-peers.json) and settings (settings.json) as plaintext
 * JSON in the app's data folder. This moves them into the local database, then deletes them and
 * the old store's leftovers (`known-peers.json.tmp`, `known-peers.json.corrupt-*`). A file that
 * can't be parsed is deleted without importing anything: no version could read it either.
 */
export async function importLegacyFiles(dir: string, to: { contacts: ContactRepository; settings: SettingsRepository }): Promise<LegacyImport> {
    const result: LegacyImport = { contacts: 0, settings: false };
    const contactsFile = path.join(dir, "known-peers.json");
    if (fs.existsSync(contactsFile)) {
        const data = readJson(contactsFile) as { peers?: unknown } | null;
        for (const contact of (Array.isArray(data?.peers) ? data.peers : []).map(toContact)) {
            if (contact) {
                await to.contacts.save(contact);
                result.contacts++;
            }
        }
    }
    const settingsFile = path.join(dir, "settings.json");
    if (fs.existsSync(settingsFile)) {
        const data = readJson(settingsFile);
        if (data !== null && (await to.settings.load()) === null) {
            await to.settings.save(toSettings(data));
            result.settings = true;
        }
    }
    // Delete only after everything was written.
    for (const name of fs.readdirSync(dir)) {
        if (name === "settings.json" || name === "known-peers.json" || name.startsWith("known-peers.json.")) {
            fs.rmSync(path.join(dir, name), { force: true });
        }
    }
    return result;
}

function readJson(file: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return null;
    }
}
