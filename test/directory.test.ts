import assert from "node:assert/strict";
import * as fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { toBase64 } from "../src/core/bytes";
import { DirectoryClient, normalizeServerUrl } from "../src/core/directory-client";
import {
    MAX_CLOCK_SKEW_MS,
    createDeletion,
    createRegistration,
    verifyDeletion,
    verifyRegistration,
} from "../src/core/directory-record";
import { createIdentity, fingerprint } from "../src/core/identity";
import { fingerprintToPeerId, normalizeFingerprint, peerIdToFingerprint } from "../src/core/peer-id";
import { SIGNALING_TOKEN_MAX_AGE_MS, checkSignalingToken, createSignalingToken } from "../src/core/signaling-token";
import { createChatServer } from "../src/server/app";
import { PeerStore } from "../src/server/peer-store";
import { verifySignalingRequest } from "../src/server/signaling";

async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function call(url: string, body?: unknown, method = "POST"): Promise<{ status: number; body: any }> {
    const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
}

const IP_PATTERN = /\b\d{1,3}(\.\d{1,3}){3}\b|::/;

describe("peer IDs and fingerprints", () => {
    it("map fingerprints to PeerJS IDs and back", () => {
        const fp = fingerprint(createIdentity().publicKey);
        const id = fingerprintToPeerId(fp);
        assert.match(id, /^cas-[0-9a-f]{32}$/);
        assert.equal(peerIdToFingerprint(id), fp);
        assert.equal(peerIdToFingerprint("someone-else"), null);
        assert.equal(normalizeFingerprint(fp.replace(/ /g, "-").toLowerCase()), fp);
        assert.equal(normalizeFingerprint("192.168.1.20:47800"), null);
    });
});

describe("signaling tokens", () => {
    const identity = createIdentity();

    it("prove ownership of the fingerprint ID", () => {
        const { peerId, token } = createSignalingToken(identity);
        assert.equal(peerId, fingerprintToPeerId(fingerprint(identity.publicKey)));
        assert.equal(checkSignalingToken(peerId, token), null);
        assert.equal(verifySignalingRequest(`/signal/peerjs?key=k&id=${peerId}&token=${encodeURIComponent(token)}`), null);
    });

    it("can't be used to claim someone else's ID", () => {
        const victim = fingerprintToPeerId(fingerprint(createIdentity().publicKey));
        const { token } = createSignalingToken(identity);
        assert.equal(checkSignalingToken(victim, token), "token is for a different identity");
    });

    it("expire, and reject tampering and junk", () => {
        const { peerId, token } = createSignalingToken(identity, Date.now() - SIGNALING_TOKEN_MAX_AGE_MS - 1000);
        assert.match(checkSignalingToken(peerId, token)!, /expired/);
        const fresh = createSignalingToken(identity).token.split(".");
        const otherTime = [(parseInt(fresh[0], 36) + 1).toString(36), fresh[1], fresh[2]].join(".");
        assert.equal(checkSignalingToken(peerId, otherTime), "token signature is invalid");
        assert.equal(checkSignalingToken(peerId, "garbage"), "malformed token");
        assert.match(verifySignalingRequest("/signal/peerjs?key=k&id=anything&token=x")!, /fingerprint ID/);
        assert.match(verifySignalingRequest("/signal/peerjs?key=k")!, /fingerprint ID/);
    });
});

describe("directory records", () => {
    const identity = createIdentity();

    it("hold a name and a key, and verify when untouched", () => {
        const record = createRegistration(identity, "Alice");
        assert.deepEqual(Object.keys(record).sort(), ["identityKey", "name", "signature", "timestamp"]);
        const verified = verifyRegistration(record, Date.now());
        assert.equal(verified.fingerprint, fingerprint(identity.publicKey));
    });

    const tamperings: Array<[string, (r: any) => void]> = [
        ["name", (r) => (r.name = "Mallory")],
        ["timestamp", (r) => (r.timestamp += 1)],
        ["identity key", (r) => (r.identityKey = toBase64(createIdentity().publicKey))],
    ];
    for (const [what, tamper] of tamperings) {
        it(`reject a changed ${what}`, () => {
            const record: any = createRegistration(identity, "Alice");
            tamper(record);
            assert.throws(() => verifyRegistration(record), /signature is invalid/);
        });
    }

    it("refuse extra fields, so an address can't ride along", () => {
        const record = { ...createRegistration(identity, "Alice"), lanAddresses: ["192.168.1.5"] };
        assert.throws(() => verifyRegistration(record), /unexpected field\(s\): lanAddresses/);
    });

    it("reject stale timestamps when freshness is required", () => {
        const old = createRegistration(identity, "Alice", Date.now() - MAX_CLOCK_SKEW_MS - 1000);
        assert.throws(() => verifyRegistration(old, Date.now()), /too far from the current time/);
        assert.ok(verifyRegistration(old));
    });

    it("sign deletions with the identity key", () => {
        const deletion = createDeletion(identity);
        assert.equal(verifyDeletion(deletion, Date.now()).fingerprint, fingerprint(identity.publicKey));
        const forged = { ...createDeletion(createIdentity()), identityKey: deletion.identityKey };
        assert.throws(() => verifyDeletion(forged, Date.now()), /signature is invalid/);
    });

    it("normalize server URLs", () => {
        assert.equal(normalizeServerUrl(" https://chat.example.com/ "), "https://chat.example.com");
        assert.throws(() => normalizeServerUrl("ftp://x"), /http/);
        assert.throws(() => normalizeServerUrl("http://user:pw@x"), /credentials/);
    });
});

describe("chat server API", () => {
    let now = Date.now();
    let store: PeerStore;
    let server: Server;
    let url: string;

    beforeEach(async () => {
        server?.close();
        now = Date.now();
        store = new PeerStore(":memory:");
        const chat = createChatServer({
            store,
            signaling: false,
            iceServers: [{ urls: "stun:stun.example.com:3478" }],
            now: () => now,
        });
        server = chat.server;
        url = await listen(server);
    });
    after(() => server?.close());

    it("hands out its ICE servers and signaling settings", async () => {
        const config = (await (await fetch(`${url}/v1/config`)).json()) as any;
        assert.deepEqual(config, {
            iceServers: [{ urls: "stun:stun.example.com:3478" }],
            signalingPath: "/signal",
            signalingKey: "cas-p2p-chat",
        });
    });

    it("lists peers by name and finds them by part of it, storing no IP address", async () => {
        const alice = createIdentity();
        const created = await call(`${url}/v1/peers`, createRegistration(alice, "Alice Smith", now));
        assert.equal(created.status, 201);
        assert.equal(created.body.fingerprint, fingerprint(alice.publicKey));
        assert.equal(created.body.online, false);
        assert.ok(!("observedAddress" in created.body));
        await call(`${url}/v1/peers`, createRegistration(createIdentity(), "Bob", now));

        const found = (await (await fetch(`${url}/v1/peers?q=SMITH`)).json()) as { peers: any[] };
        assert.deepEqual(found.peers.map((p) => p.record.name), ["Alice Smith"]);
        assert.ok(verifyRegistration(found.peers[0].record));

        // There is no "list everyone" endpoint: a search needs 2+ characters.
        assert.equal((await fetch(`${url}/v1/peers`)).status, 400);
        assert.equal((await fetch(`${url}/v1/peers?q=a`)).status, 400);
        // LIKE wildcards are matched literally.
        assert.equal(((await (await fetch(`${url}/v1/peers?q=%25%25`)).json()) as any).peers.length, 0);

        const compact = fingerprint(alice.publicKey).replace(/ /g, "").toLowerCase();
        assert.equal((await fetch(`${url}/v1/peers/${compact}`)).status, 200);
        assert.equal((await fetch(`${url}/v1/peers/${"0".repeat(32)}`)).status, 404);

        assert.doesNotMatch(JSON.stringify(store.list()), IP_PATTERN);
    });

    it("refuses replays, stale timestamps, bad signatures, extra fields and junk", async () => {
        const alice = createIdentity();
        const record = createRegistration(alice, "Alice", now);
        assert.equal((await call(`${url}/v1/peers`, record)).status, 201);
        assert.equal((await call(`${url}/v1/peers`, record)).status, 409, "exact replay");
        assert.equal((await call(`${url}/v1/peers`, createRegistration(alice, "Alice", now - 1))).status, 409, "older record");

        const stale = await call(`${url}/v1/peers`, createRegistration(alice, "Alice", now - MAX_CLOCK_SKEW_MS - 1));
        assert.equal(stale.status, 400);
        assert.match(stale.body.error, /too far from the current time/);

        const forged = { ...createRegistration(alice, "Alice", now + 5), name: "Mallory" };
        assert.equal((await call(`${url}/v1/peers`, forged)).status, 400);
        const withIp = { ...createRegistration(alice, "Alice", now + 6), observedAddress: "203.0.113.9" };
        assert.equal((await call(`${url}/v1/peers`, withIp)).status, 400);
        assert.equal((await call(`${url}/v1/peers`, "{not json")).status, 400);
        assert.equal((await call(`${url}/v1/peers`, { padding: "x".repeat(10_000) })).status, 413);
        assert.equal((await fetch(`${url}/nope`)).status, 404);
    });

    it("unlists a peer on a signed deletion, and blocks replaying its old registration", async () => {
        const alice = createIdentity();
        const record = createRegistration(alice, "Alice", now);
        await call(`${url}/v1/peers`, record);
        now += 10;
        assert.equal((await call(`${url}/v1/peers`, createDeletion(alice, now), "DELETE")).status, 204);
        assert.equal(store.count(), 0);
        assert.equal((await call(`${url}/v1/peers`, record)).status, 409, "replayed registration");
        assert.equal((await call(`${url}/v1/peers`, createDeletion(alice, now + 1), "DELETE")).status, 404);
        assert.equal((await call(`${url}/v1/peers`, createRegistration(alice, "Alice", now + 2))).status, 201);
    });
});

describe("peer store", () => {
    it("persists, evicts the least recently seen, and purges stale listings", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-p2p-chat-store-"));
        const file = path.join(dir, "directory.db");
        try {
            const t = Date.now();
            const store = new PeerStore(file, { maxPeers: 2, retentionMs: 1_000 });
            [0, 1, 2].forEach((i) => store.register(verifyRegistration(createRegistration(createIdentity(), `P${i}`, t)), t + i));
            assert.deepEqual(store.list().map((p) => p.record.name), ["P2", "P1"], "P0 was evicted");
            store.close();

            const reopened = new PeerStore(file, { retentionMs: 1_000 });
            assert.equal(reopened.count(), 2);
            reopened.purge(t + 10_000);
            assert.equal(reopened.count(), 0);
            reopened.close();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("drops an old (schema 1) database that stored IP addresses", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-p2p-chat-store-"));
        const file = path.join(dir, "directory.db");
        try {
            const old = new DatabaseSync(file);
            old.exec(`CREATE TABLE peers (fingerprint TEXT PRIMARY KEY, record TEXT, observed_address TEXT,
                      timestamp INTEGER, first_seen INTEGER, last_seen INTEGER, deleted_at INTEGER);
                      INSERT INTO peers VALUES ('F', '{"lanAddresses":["192.168.1.5"]}', '203.0.113.9', 1, 1, 1, NULL);`);
            old.close();

            const store = new PeerStore(file);
            assert.equal(store.count(), 0);
            store.close();
            const check = new DatabaseSync(file);
            const columns = (check.prepare("PRAGMA table_info(peers)").all() as Array<{ name: string }>).map((c) => c.name);
            const rows = JSON.stringify(check.prepare("SELECT * FROM peers").all());
            check.close();
            assert.ok(!columns.includes("observed_address"));
            assert.doesNotMatch(rows, IP_PATTERN);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("DirectoryClient", () => {
    let server: Server;
    let url: string;
    before(async () => {
        server = createChatServer({ store: new PeerStore(":memory:"), signaling: false }).server;
        url = await listen(server);
    });
    after(() => server.close());

    it("lists by name, searches, and unlists", async () => {
        const alice = new DirectoryClient(url, createIdentity());
        const bobIdentity = createIdentity();
        const bob = new DirectoryClient(url, bobIdentity);
        await alice.register("Alice");
        await bob.register("Bob Builder");

        const { results, rejected } = await alice.search("bob");
        assert.equal(rejected, 0);
        assert.deepEqual(results.map((r) => [r.name, r.fingerprint]), [["Bob Builder", fingerprint(bobIdentity.publicKey)]]);
        assert.deepEqual((await alice.search("alice")).results, [], "own listing is left out");

        await bob.unregister();
        assert.equal((await alice.search("bob")).results.length, 0);
        await bob.unregister(); // already gone: not an error
    });

    it("drops records a malicious server has altered", async () => {
        const honest = createRegistration(createIdentity(), "Bob");
        const evil = express();
        evil.get("/v1/peers", (_req, res) => {
            res.json({
                peers: [
                    { record: honest, online: true, lastSeen: Date.now() },
                    { record: { ...honest, name: "Bob (official)" }, online: true, lastSeen: 0 },
                    { record: { ...honest, lanAddresses: ["10.6.6.6"] }, online: true, lastSeen: 0 },
                    { record: "garbage" },
                ],
            });
        });
        const evilServer = evil.listen(0, "127.0.0.1");
        await new Promise((resolve) => evilServer.once("listening", resolve));
        try {
            const evilUrl = `http://127.0.0.1:${(evilServer.address() as AddressInfo).port}`;
            const { results, rejected } = await new DirectoryClient(evilUrl, createIdentity()).search("bob");
            assert.equal(rejected, 3);
            assert.deepEqual(results.map((r) => r.name), ["Bob"]);
        } finally {
            evilServer.close();
        }
    });

    it("reports an unreachable server clearly", async () => {
        const client = new DirectoryClient("http://127.0.0.1:1", createIdentity(), 2_000);
        await assert.rejects(client.search("bob"), /could not reach the server/);
    });
});
