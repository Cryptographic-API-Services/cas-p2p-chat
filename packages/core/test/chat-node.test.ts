import assert from "node:assert/strict";
import { once } from "node:events";
import { after, describe, it } from "node:test";
import { fromUtf8, utf8 } from "../src/bytes.ts";
import { type ChatMessage, ChatNode, type PeerSummary } from "../src/chat-node.ts";
import { createIdentity, fingerprint } from "../src/identity.ts";
import { Handshake, PROTOCOL_ID, type Session } from "../src/protocol.ts";
import { SqliteContactRepository } from "../src/repositories/contact-repository.ts";
import { LocalDatabase, createStorageKey } from "../src/repositories/local-database.ts";
import { TrustStore } from "../src/trust-store.ts";
import { JPEG, PNG } from "./helpers/avatars.ts";
import { linkPair } from "./helpers/memory-link.ts";

const nodes: ChatNode[] = [];
after(() => nodes.forEach((node) => node.close()));

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) {
            throw new Error("timed out");
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

function makeNode(name: string, handshakeTimeoutMs?: number, avatar?: string | null): ChatNode {
    const node = new ChatNode({ identity: createIdentity(), name, handshakeTimeoutMs, avatar });
    nodes.push(node);
    return node;
}

/** Connects `dialer` to `answerer` over an in-memory link, as the WebRTC bridge does. */
async function connect(dialer: ChatNode, answerer: ChatNode): Promise<{ outbound: PeerSummary; inbound: PeerSummary }> {
    const [a, b] = linkPair();
    const [outbound, inbound] = await Promise.all([
        dialer.adopt(a, "outbound", { expectedFingerprint: answerer.fingerprint }),
        answerer.adopt(b, "inbound"),
    ]);
    return { outbound, inbound };
}

describe("ChatNode", () => {
    it("connects two nodes and exchanges messages both ways", async () => {
        const alice = makeNode("Alice");
        const bob = makeNode("Bob");
        const { outbound, inbound } = await connect(alice, bob);

        assert.deepEqual(
            { name: outbound.name, fingerprint: outbound.fingerprint, direction: outbound.direction },
            { name: "Bob", fingerprint: bob.fingerprint, direction: "outbound" },
        );
        assert.deepEqual(
            { name: inbound.name, fingerprint: inbound.fingerprint, direction: inbound.direction },
            { name: "Alice", fingerprint: alice.fingerprint, direction: "inbound" },
        );

        const bobGot = once(bob, "message");
        alice.sendText(outbound.id, "Hi Bob, it's Alice.");
        const [fromId, message] = (await bobGot) as [string, ChatMessage];
        assert.equal(fromId, inbound.id);
        assert.equal(message.text, "Hi Bob, it's Alice.");

        const aliceGot = once(alice, "message");
        bob.sendText(inbound.id, "Hey Alice!\nSecond line, ünïcödé 🔐");
        const [, reply] = (await aliceGot) as [string, ChatMessage];
        assert.equal(reply.text, "Hey Alice!\nSecond line, ünïcödé 🔐");

        // Many messages arrive in order over one session.
        const received: string[] = [];
        const done = new Promise<void>((resolve) => {
            bob.on("message", (_id, m) => {
                received.push(m.text);
                if (received.length === 50) {
                    resolve();
                }
            });
        });
        for (let i = 0; i < 50; i++) {
            alice.sendText(outbound.id, `message ${i}`);
        }
        await done;
        assert.deepEqual(received, Array.from({ length: 50 }, (_, i) => `message ${i}`));

        const bobSawLeave = once(bob, "peer-disconnected");
        alice.disconnect(outbound.id);
        const [leftId, reason] = await bobSawLeave;
        assert.equal(leftId, inbound.id);
        assert.match(String(reason), /disconnected/);
        assert.throws(() => alice.sendText(outbound.id, "too late"), /not connected/);
    });

    it("rejects empty and oversized messages", async () => {
        const alice = makeNode("Alice");
        const { outbound } = await connect(alice, makeNode("Bob"));
        assert.throws(() => alice.sendText(outbound.id, "   "), /empty/);
        assert.throws(() => alice.sendText(outbound.id, "x".repeat(16_001)), /longer than/);
    });

    it("refuses a peer whose identity isn't the one dialed", async () => {
        const alice = makeNode("Alice");
        const impostor = makeNode("Bob");
        let announced = false;
        alice.on("peer-connected", () => (announced = true));
        const [a, b] = linkPair();
        const answer = impostor.adopt(b, "inbound").catch(() => undefined);
        await assert.rejects(
            alice.adopt(a, "outbound", { expectedFingerprint: fingerprint(createIdentity().publicKey) }),
            /identity mismatch/,
        );
        await answer;
        assert.equal(announced, false, "the impostor never became a conversation");
        assert.deepEqual(alice.listPeers(), []);
    });

    it("drops a peer that sends garbage, and says why", async () => {
        const bob = makeNode("Bob");
        const [raw, b] = linkPair();
        const failed = once(bob, "handshake-failed");
        bob.adopt(b, "inbound").catch(() => undefined);
        raw.start({ frame: () => undefined, error: () => undefined, closed: () => undefined });
        raw.send({ type: "hello", protocol: PROTOCOL_ID, name: "Eve", identityKey: "AAAA" });
        const [, reason] = await failed;
        assert.match(String(reason), /identityKey must be 32 bytes/);
    });

    it("times out a peer that never finishes the handshake", async () => {
        const bob = makeNode("Bob", 200);
        const [silent, b] = linkPair();
        silent.start({ frame: () => undefined, error: () => undefined, closed: () => undefined });
        const failed = once(bob, "handshake-failed");
        bob.adopt(b, "inbound").catch(() => undefined);
        const [, reason] = await failed;
        assert.equal(reason, "handshake timed out");
    });

    it("limits concurrent connections", async () => {
        const bob = new ChatNode({ identity: createIdentity(), name: "Bob", maxConnections: 1 });
        nodes.push(bob);
        bob.adopt(linkPair()[1], "inbound").catch(() => undefined);
        await assert.rejects(bob.adopt(linkPair()[1], "inbound"), /too many connections/);
    });
});

/**
 * Runs the handshake by hand against `node`, so the test can send payloads the app never would.
 * Resolves once both sides are authenticated.
 */
async function rawPeer(node: ChatNode): Promise<{ send(payload: unknown): void; summary: PeerSummary; profiles: unknown[] }> {
    const [raw, link] = linkPair();
    const handshake = new Handshake(createIdentity(), "Raw");
    const profiles: unknown[] = [];
    let session: Session | null = null;
    const opened = new Promise<Session>((resolve) => {
        raw.start({
            frame: (frame) => {
                const type = (frame as { type?: unknown }).type;
                if (type === "hello") {
                    raw.send(handshake.receiveHello(frame));
                } else if (type === "auth") {
                    session = handshake.receiveAuth(frame);
                    resolve(session);
                } else if (type === "msg" && session) {
                    profiles.push(JSON.parse(fromUtf8(session.open(frame))));
                }
            },
            error: () => undefined,
            closed: () => undefined,
        });
    });
    raw.send(handshake.hello);
    const [summary, s] = await Promise.all([node.adopt(link, "inbound"), opened]);
    return { send: (payload) => raw.send(s.seal(utf8(JSON.stringify(payload)))), summary, profiles };
}

describe("avatars", () => {
    it("each side sends its avatar when the session opens", async () => {
        const alice = makeNode("Alice", undefined, PNG);
        const bob = makeNode("Bob");
        const bobGot = once(bob, "profile");
        const aliceGot = once(alice, "profile");
        const { inbound, outbound } = await connect(alice, bob);
        assert.deepEqual(await bobGot, [inbound.id, PNG]);
        assert.deepEqual(await aliceGot, [outbound.id, null], "no avatar is said explicitly, so an old one is cleared");
    });

    it("sends a changed avatar to everyone connected, and null to remove it", async () => {
        const alice = makeNode("Alice");
        const bob = makeNode("Bob");
        const carol = makeNode("Carol");
        // First the profiles sent when the sessions open (none).
        const initial = [once(bob, "profile"), once(carol, "profile")];
        const { inbound: atBob } = await connect(alice, bob);
        const { inbound: atCarol } = await connect(alice, carol);
        assert.deepEqual((await Promise.all(initial)).map(([, avatar]) => avatar), [null, null]);

        const bobGot = once(bob, "profile");
        const carolGot = once(carol, "profile");
        alice.setAvatar(JPEG);
        assert.deepEqual(await bobGot, [atBob.id, JPEG]);
        assert.deepEqual(await carolGot, [atCarol.id, JPEG]);

        const cleared = once(bob, "profile");
        alice.setAvatar(null);
        assert.deepEqual(await cleared, [atBob.id, null]);

        // A peer connecting later gets the current one.
        alice.setAvatar(PNG);
        const dave = makeNode("Dave");
        const daveGot = once(dave, "profile");
        await connect(alice, dave);
        assert.equal((await daveGot)[1], PNG);
    });

    it("ignores an avatar it can't accept, and keeps the session", async () => {
        const bob = makeNode("Bob");
        const profiles: Array<string | null> = [];
        bob.on("profile", (_id, avatar) => profiles.push(avatar));
        const messages: string[] = [];
        bob.on("message", (_id, message) => messages.push(message.text));
        const peer = await rawPeer(bob);
        const hostile = [
            "javascript:alert(1)",
            "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+",
            "data:text/html;base64,PGgxPmhpPC9oMT4=",
            `data:image/png;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64")}`,
            `data:image/png;base64,${"A".repeat(200_000)}`,
            42,
            { src: PNG },
        ];
        for (const avatar of hostile) {
            peer.send({ kind: "profile", avatar });
        }
        peer.send({ kind: "profile", avatar: PNG });
        peer.send({ kind: "text", text: "still here" });
        await until(() => messages.length === 1);
        assert.deepEqual(profiles, [PNG], "only the valid avatar got through");
        assert.deepEqual(messages, ["still here"]);
        assert.equal(bob.listPeers().length, 1);
        // Bob sent his own profile (none) once the session opened.
        assert.deepEqual(peer.profiles, [{ kind: "profile", avatar: null }]);
    });
});

describe("TrustStore", () => {
    it("tracks new, known and verified peers, lists contacts, and flags reused names", async () => {
        const local = await LocalDatabase.open(":memory:", createStorageKey());
        try {
            const contacts = new SqliteContactRepository(local);
            const store = await TrustStore.load(contacts);
            assert.deepEqual(await store.observe("AAAA", "Bob"), { level: "new", nameConflict: false });
            assert.deepEqual(await store.observe("AAAA", "Bob"), { level: "known", nameConflict: false });
            await store.setVerified("AAAA", true);

            const reloaded = await TrustStore.load(contacts);
            assert.deepEqual(reloaded.get("AAAA", "Bob"), { level: "verified", nameConflict: false });
            // A different key using the same name is flagged.
            assert.deepEqual(await reloaded.observe("BBBB", "Bob"), { level: "new", nameConflict: true });
            assert.deepEqual(reloaded.list().map((c) => [c.fingerprint, c.trust.level]), [["AAAA", "verified"], ["BBBB", "known"]]);
            await assert.rejects(reloaded.setVerified("CCCC", true), /unknown peer/);
        } finally {
            local.close();
        }
    });
});
