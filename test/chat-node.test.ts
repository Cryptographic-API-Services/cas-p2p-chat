import assert from "node:assert/strict";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { ChatMessage, ChatNode, PeerSummary } from "../src/core/chat-node";
import { createIdentity, fingerprint } from "../src/core/identity";
import { TrustStore } from "../src/core/trust-store";
import { linkPair } from "./helpers/memory-link";

const nodes: ChatNode[] = [];
after(() => nodes.forEach((node) => node.close()));

function makeNode(name: string, handshakeTimeoutMs?: number): ChatNode {
    const node = new ChatNode({ identity: createIdentity(), name, handshakeTimeoutMs });
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
        raw.send({ type: "hello", protocol: "cas-p2p-chat/1", name: "Eve", identityKey: "AAAA" });
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

describe("TrustStore", () => {
    it("tracks new, known and verified peers, lists contacts, and flags reused names", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-p2p-chat-test-"));
        try {
            const file = path.join(dir, "known-peers.json");
            const store = new TrustStore(file);
            assert.deepEqual(store.observe("AAAA", "Bob"), { level: "new", nameConflict: false });
            assert.deepEqual(store.observe("AAAA", "Bob"), { level: "known", nameConflict: false });
            store.setVerified("AAAA", true);

            const reloaded = new TrustStore(file);
            assert.deepEqual(reloaded.get("AAAA", "Bob"), { level: "verified", nameConflict: false });
            // A different key using the same name is flagged.
            assert.deepEqual(reloaded.observe("BBBB", "Bob"), { level: "new", nameConflict: true });
            assert.deepEqual(reloaded.list().map((c) => [c.fingerprint, c.trust.level]), [["AAAA", "verified"], ["BBBB", "known"]]);
            assert.throws(() => reloaded.setVerified("CCCC", true), /unknown peer/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
