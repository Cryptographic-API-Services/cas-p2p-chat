import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createIdentity, fingerprint } from "../src/identity.ts";
import { type Contact, SqliteContactRepository } from "../src/repositories/contact-repository.ts";
import { importLegacyFiles } from "../src/repositories/legacy-files.ts";
import { LocalDatabase, createStorageKey, parseStorageKey, serializeStorageKey } from "../src/repositories/local-database.ts";
import { SqliteMessageRepository } from "../src/repositories/message-repository.ts";
import { SqliteSettingsRepository } from "../src/repositories/settings-repository.ts";
import { TrustStore } from "../src/trust-store.ts";

const alice = fingerprint(createIdentity().publicKey);
const bob = fingerprint(createIdentity().publicKey);

let dir: string;
let file: string;
let key: number[];
const opened: Array<{ close(): void }> = [];

async function open(withKey = key): Promise<LocalDatabase> {
    const local = await LocalDatabase.open(file, withKey);
    opened.push(local);
    return local;
}

/** A second connection to the file, as someone editing it on disk would have. */
function raw(): DatabaseSync {
    const db = new DatabaseSync(file);
    opened.push(db);
    return db;
}

/** Every byte SQLite has written: the database plus its write-ahead log. */
function onDisk(): Buffer {
    return Buffer.concat(fs.readdirSync(dir).filter((f) => f.startsWith("chat.sqlite")).map((f) => fs.readFileSync(path.join(dir, f))));
}

function contact(fingerprint: string, name: string, verified = false): Contact {
    return { fingerprint, name, firstSeen: "2026-11-01T00:00:00.000Z", lastSeen: "2026-11-02T00:00:00.000Z", verified };
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-repositories-"));
    file = path.join(dir, "chat.sqlite");
    key = createStorageKey();
});

afterEach(() => {
    for (const db of opened.splice(0)) {
        try {
            db.close();
        } catch {
            // Already closed by the test.
        }
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("LocalDatabase", () => {
    it("checks the storage key", async () => {
        assert.deepEqual(parseStorageKey(serializeStorageKey(key)), key);
        assert.throws(() => parseStorageKey(serializeStorageKey(key.slice(0, 16))), /32 bytes/);
        await assert.rejects(LocalDatabase.open(":memory:", key.slice(0, 16)), /32 bytes/);
    });

    it("applies drizzle-kit's migrations once", async () => {
        (await open()).close();
        await open();
        const applied = raw().prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number };
        const tables = raw().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('settings', 'contacts', 'messages')").all();
        assert.equal(applied.n, fs.readdirSync(path.join(import.meta.dirname, "..", "drizzle")).filter((f) => f.endsWith(".sql")).length);
        assert.equal(tables.length, 3);
    });

    it("refuses a database migrated by a newer version of the app", async () => {
        (await open()).close();
        raw().exec(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', '${Date.now() + 10 ** 12}')`);
        await assert.rejects(open(), /newer version/);
    });
});

describe("SqliteMessageRepository", () => {
    it("keeps messages per peer, in order, across reopening", async () => {
        const messages = new SqliteMessageRepository(await open());
        const first = await messages.add(alice, "out", "hi Alice", 1_000);
        await messages.add(bob, "in", "hi from Bob", 1_500);
        const second = await messages.add(alice, "in", "hi back", 2_000);
        assert.ok(second.id > first.id);
        opened[0].close();

        const reopened = new SqliteMessageRepository(await open());
        assert.deepEqual(await reopened.history(alice, 100), {
            messages: [
                { id: first.id, direction: "out", text: "hi Alice", at: 1_000 },
                { id: second.id, direction: "in", text: "hi back", at: 2_000 },
            ],
            unreadable: 0,
        });
        assert.deepEqual((await reopened.history(bob, 100)).messages.map((m) => m.text), ["hi from Bob"]);
        assert.deepEqual((await reopened.history(alice, 1)).messages.map((m) => m.text), ["hi back"], "the latest, when limited");
        assert.equal(await reopened.lastMessageAt(alice), 2_000);
        assert.equal(await reopened.lastMessageAt(fingerprint(createIdentity().publicKey)), null);
    });

    it("writes no message text, fingerprint or time in the clear", async () => {
        const local = await open();
        await new SqliteMessageRepository(local).add(alice, "out", "the secret plan", 1_234_567_890_123);
        await new SqliteContactRepository(local).save(contact(alice, "Alice Liddell"));
        for (const bytes of [onDisk(), (local.close(), onDisk())]) {
            for (const needle of ["the secret plan", "Alice Liddell", alice, alice.replace(/ /g, ""), "1234567890123"]) {
                assert.equal(bytes.includes(needle), false, `${needle} is on disk`);
            }
        }
    });

    it("can't be read with another key", async () => {
        const local = await open();
        await new SqliteMessageRepository(local).add(alice, "out", "hello", 1);
        await new SqliteContactRepository(local).save(contact(alice, "Alice"));
        local.close();
        const other = await open(createStorageKey());
        assert.deepEqual(await new SqliteMessageRepository(other).history(alice, 10), { messages: [], unreadable: 0 }, "not even found");
        assert.deepEqual(await new SqliteContactRepository(other).all(), []);
    });

    it("detects messages that were swapped, moved or duplicated on disk", async () => {
        const messages = new SqliteMessageRepository(await open());
        const a = await messages.add(alice, "out", "one", 1);
        const b = await messages.add(alice, "out", "two", 2);
        const c = await messages.add(bob, "out", "three", 3);
        const disk = raw();

        // Swap two messages' contents.
        const sealed = (id: number) => (disk.prepare("SELECT sealed FROM messages WHERE id = ?").get(id) as { sealed: Uint8Array }).sealed;
        const [sa, sb] = [sealed(a.id), sealed(b.id)];
        disk.prepare("UPDATE messages SET sealed = ? WHERE id = ?").run(sb, a.id);
        disk.prepare("UPDATE messages SET sealed = ? WHERE id = ?").run(sa, b.id);
        assert.deepEqual(await messages.history(alice, 10), { messages: [], unreadable: 2 });

        // Move Bob's message into Alice's conversation, and copy it as a new row.
        disk.exec(`UPDATE messages SET conversation = (SELECT conversation FROM messages WHERE id = ${a.id}),
                                       sealed = (SELECT sealed FROM messages WHERE id = ${c.id}) WHERE id = ${a.id}`);
        disk.exec(`INSERT INTO messages (conversation, uid, sealed) SELECT conversation, randomblob(16), sealed FROM messages WHERE id = ${c.id}`);
        assert.equal((await messages.history(alice, 10)).unreadable, 2);
        assert.deepEqual(await messages.history(bob, 10), { messages: [{ id: c.id, direction: "out", text: "three", at: 3 }], unreadable: 1 });
    });

    it("keeps the sealed order when rows are reordered on disk", async () => {
        const messages = new SqliteMessageRepository(await open());
        const a = await messages.add(alice, "out", "one", 1);
        const b = await messages.add(alice, "in", "two", 2);
        raw().exec(`UPDATE messages SET id = CASE id WHEN ${a.id} THEN -1 ELSE ${a.id} END WHERE id IN (${a.id}, ${b.id});
                    UPDATE messages SET id = ${b.id} WHERE id = -1`);
        assert.deepEqual((await messages.history(alice, 10)).messages.map((m) => m.text), ["one", "two"]);
    });

    it("clears one conversation and overwrites it on disk", async () => {
        const messages = new SqliteMessageRepository(await open());
        await messages.add(alice, "out", "keep", 1);
        const gone = await messages.add(bob, "out", "forget me", 2);
        const { sealed } = raw().prepare("SELECT sealed FROM messages WHERE id = ?").get(gone.id) as { sealed: Uint8Array };
        assert.equal(await messages.clear(bob), 1);
        assert.deepEqual((await messages.history(bob, 10)).messages, []);
        assert.deepEqual((await messages.history(alice, 10)).messages.map((m) => m.text), ["keep"]);
        assert.equal(onDisk().includes(Buffer.from(sealed)), false, "the deleted ciphertext is still on disk");
    });
});

describe("contacts", () => {
    it("SqliteContactRepository saves and replaces by fingerprint", async () => {
        const contacts = new SqliteContactRepository(await open());
        await contacts.save(contact(alice, "Alice"));
        await contacts.save(contact(bob, "Bob"));
        await contacts.save(contact(alice, "Alice", true));
        opened[0].close();
        const all = (await new SqliteContactRepository(await open()).all()).sort((x, y) => x.name.localeCompare(y.name));
        assert.deepEqual(all, [contact(alice, "Alice", true), contact(bob, "Bob")]);
    });

    it("TrustStore remembers peers and verification through the repository", async () => {
        const trust = await TrustStore.load(new SqliteContactRepository(await open()));
        assert.deepEqual(await trust.observe(alice, "Alice"), { level: "new", nameConflict: false });
        await trust.setVerified(alice, true);
        opened[0].close();

        const reopened = await TrustStore.load(new SqliteContactRepository(await open()));
        assert.deepEqual(reopened.get(alice, "Alice"), { level: "verified", nameConflict: false });
        assert.deepEqual(await reopened.observe(bob, "Alice"), { level: "new", nameConflict: true }, "another key under Alice's name");
        assert.deepEqual(reopened.list().map((c) => c.name).sort(), ["Alice", "Alice"]);
    });
});

describe("settings", () => {
    it("SqliteSettingsRepository saves one sealed row", async () => {
        const settings = new SqliteSettingsRepository(await open());
        assert.equal(await settings.load(), null);
        await settings.save({ serverUrl: "https://chat.example.com", listed: false });
        opened[0].close();
        assert.deepEqual(await new SqliteSettingsRepository(await open()).load(), { serverUrl: "https://chat.example.com", listed: false });
        assert.equal(onDisk().includes("chat.example.com"), false);
    });
});

describe("importLegacyFiles", () => {
    it("moves 0.2's plaintext contacts and settings into the database, then deletes them", async () => {
        fs.writeFileSync(path.join(dir, "known-peers.json"), JSON.stringify({ version: 1, peers: [contact(alice, "Alice", true), { fingerprint: 7 }] }));
        fs.writeFileSync(path.join(dir, "known-peers.json.corrupt-1700000000000"), "{");
        fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ serverUrl: "https://chat.example.com", listed: false }));
        fs.writeFileSync(path.join(dir, "identity.json"), "{}");
        const local = await open();
        const to = { contacts: new SqliteContactRepository(local), settings: new SqliteSettingsRepository(local) };

        assert.deepEqual(await importLegacyFiles(dir, to), { contacts: 1, settings: true });
        assert.deepEqual(await to.contacts.all(), [contact(alice, "Alice", true)]);
        assert.deepEqual(await to.settings.load(), { serverUrl: "https://chat.example.com", listed: false });
        assert.deepEqual(fs.readdirSync(dir).filter((f) => !f.startsWith("chat.sqlite")), ["identity.json"], "only the key file is left");
        assert.deepEqual(await importLegacyFiles(dir, to), { contacts: 0, settings: false }, "nothing left to import");
    });

    it("doesn't let an old settings.json overwrite newer settings, and drops unreadable files", async () => {
        fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ serverUrl: "https://old.example.com" }));
        fs.writeFileSync(path.join(dir, "known-peers.json"), "not json");
        const local = await open();
        const to = { contacts: new SqliteContactRepository(local), settings: new SqliteSettingsRepository(local) };
        await to.settings.save({ serverUrl: "https://new.example.com", listed: true });
        assert.deepEqual(await importLegacyFiles(dir, to), { contacts: 0, settings: false });
        assert.equal((await to.settings.load())?.serverUrl, "https://new.example.com");
        assert.deepEqual(fs.readdirSync(dir).filter((f) => !f.startsWith("chat.sqlite")), []);
    });
});
