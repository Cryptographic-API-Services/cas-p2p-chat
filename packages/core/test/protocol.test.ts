import assert from "node:assert/strict";
import { hkdfSync, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { HkdfWrapper } from "cas-typescript-sdk";
import { fromBase64, toBase64, utf8, fromUtf8 } from "../src/bytes.ts";
import { ProtocolError } from "../src/errors.ts";
import { createIdentity, fingerprint, parseIdentity, serializeIdentity } from "../src/identity.ts";
import { type AuthFrame, Handshake, type MessageFrame, Session } from "../src/protocol.ts";

function establish(): { alice: Session; bob: Session; aliceId: ReturnType<typeof createIdentity>; bobId: ReturnType<typeof createIdentity> } {
    const aliceId = createIdentity();
    const bobId = createIdentity();
    const a = new Handshake(aliceId, "Alice");
    const b = new Handshake(bobId, "Bob");
    const aAuth = a.receiveHello(b.hello);
    const bAuth = b.receiveHello(a.hello);
    return { alice: a.receiveAuth(bAuth), bob: b.receiveAuth(aAuth), aliceId, bobId };
}

/** Flips one bit of a base64 field, at the given byte (negative counts from the end). */
function flip<T extends MessageFrame | AuthFrame>(frame: T, field: keyof T & string, at = 0): T {
    const bytes = fromBase64(frame[field], field);
    bytes[at < 0 ? bytes.length + at : at] ^= 0x01;
    return { ...frame, [field]: toBase64(bytes) };
}

describe("HKDF-SHA512 (the key schedule's KDF)", () => {
    it("cas-typescript-sdk's extract + expand matches node:crypto's RFC 5869 HKDF", () => {
        const hkdf = new HkdfWrapper();
        // The key schedule's shapes (64-byte salt, 32-byte keys) plus no salt and multi-block output.
        for (const [saltLength, length] of [[64, 32], [0, 64], [13, 100], [64, 200]]) {
            const salt = Array.from(randomBytes(saltLength));
            const ikm = Array.from(randomBytes(97));
            const info = Array.from(randomBytes(40));
            const expected = Array.from(new Uint8Array(hkdfSync("sha512", Buffer.from(ikm), Buffer.from(salt), Buffer.from(info), length)));
            assert.deepEqual(hkdf.hkdfSha512Expand(hkdf.hkdfSha512Extract(salt, ikm), info, length), expected);
        }
    });
});

describe("identity", () => {
    it("round-trips through serialization", () => {
        const identity = createIdentity();
        const parsed = parseIdentity(serializeIdentity(identity));
        assert.deepEqual(parsed, identity);
    });

    it("rejects a stored identity whose keys don't match", () => {
        const stored = JSON.parse(serializeIdentity(createIdentity()));
        stored.publicKey = toBase64(createIdentity().publicKey);
        assert.throws(() => parseIdentity(JSON.stringify(stored)), /does not match/);
    });

    it("formats fingerprints as 8 groups of 4 hex digits, stable per key", () => {
        const identity = createIdentity();
        assert.match(fingerprint(identity.publicKey), /^[0-9A-F]{4}( [0-9A-F]{4}){7}$/);
        assert.equal(fingerprint(identity.publicKey), fingerprint([...identity.publicKey]));
        assert.notEqual(fingerprint(identity.publicKey), fingerprint(createIdentity().publicKey));
    });
});

describe("handshake", () => {
    it("authenticates both sides and agrees on a session id", () => {
        const { alice, bob, aliceId, bobId } = establish();
        assert.deepEqual(alice.sessionId, bob.sessionId);
        assert.equal(alice.peer.name, "Bob");
        assert.equal(bob.peer.name, "Alice");
        assert.equal(alice.peer.fingerprint, fingerprint(bobId.publicKey));
        assert.equal(bob.peer.fingerprint, fingerprint(aliceId.publicKey));
    });

    it("gives every session a different id", () => {
        assert.notDeepEqual(establish().alice.sessionId, establish().alice.sessionId);
    });

    it("rejects a man in the middle who swaps in their own session key", () => {
        const alice = new Handshake(createIdentity(), "Alice");
        const bob = new Handshake(createIdentity(), "Bob");
        const mallory = new Handshake(createIdentity(), "Mallory");
        // Mallory relays Bob's hello with her session key, so she could read what Alice sends.
        alice.receiveHello({ ...bob.hello, sessionKey: mallory.hello.sessionKey });
        const bobAuth = bob.receiveHello(alice.hello);
        assert.throws(() => alice.receiveAuth(bobAuth), /handshake signature is invalid/);
        // And she can't sign in Bob's place with her own identity key.
        const malloryAuth = mallory.receiveHello(alice.hello);
        assert.throws(() => alice.receiveAuth(malloryAuth), /handshake signature is invalid/);
    });

    it("rejects a man in the middle who swaps in their own ML-KEM key", () => {
        const alice = new Handshake(createIdentity(), "Alice");
        const bob = new Handshake(createIdentity(), "Bob");
        const mallory = new Handshake(createIdentity(), "Mallory");
        // Bob would encapsulate to Mallory's KEM key, so she'd learn the post-quantum secret.
        const bobAuth = bob.receiveHello({ ...alice.hello, kemKey: mallory.hello.kemKey });
        alice.receiveHello(bob.hello);
        assert.throws(() => alice.receiveAuth(bobAuth), /handshake signature is invalid/);
    });

    it("rejects an auth whose KEM ciphertext was replaced or modified", () => {
        const alice = new Handshake(createIdentity(), "Alice");
        const bob = new Handshake(createIdentity(), "Bob");
        const mallory = new Handshake(createIdentity(), "Mallory");
        alice.receiveHello(bob.hello);
        const bobAuth = bob.receiveHello(alice.hello);
        // Mallory encapsulates her own secret to Alice and splices it into Bob's auth.
        const malloryAuth = mallory.receiveHello(alice.hello);
        assert.throws(() => alice.receiveAuth({ ...bobAuth, kemCiphertext: malloryAuth.kemCiphertext }), /signature is invalid/);
        assert.throws(() => alice.receiveAuth(flip(bobAuth, "kemCiphertext", -1)), /signature is invalid/);
        assert.throws(() => alice.receiveAuth({ ...bobAuth, kemCiphertext: toBase64([1, 2, 3]) }), /kemCiphertext must be 1568 bytes/);
        // The genuine auth still works afterwards.
        assert.equal(alice.receiveAuth(bobAuth).peer.name, "Bob");
    });

    it("puts the KEM key and ciphertext on the wire, but no secrets", () => {
        const alice = new Handshake(createIdentity(), "Alice");
        const bob = new Handshake(createIdentity(), "Bob");
        assert.equal(fromBase64(alice.hello.kemKey, "kemKey").length, 1568);
        const auth = alice.receiveHello(bob.hello);
        assert.deepEqual(Object.keys(auth).sort(), ["kemCiphertext", "signature", "type"]);
        assert.deepEqual(Object.keys(alice.hello).sort(), ["challenge", "identityKey", "kemKey", "name", "protocol", "sessionKey", "type"]);
    });

    it("rejects a hello carrying our own identity (reflection)", () => {
        const identity = createIdentity();
        const a = new Handshake(identity, "Alice");
        const b = new Handshake(identity, "Alice");
        assert.throws(() => a.receiveHello(b.hello), /our own identity key/);
    });

    it("rejects an auth replayed from another session", () => {
        const aliceId = createIdentity();
        const bobId = createIdentity();
        const old = { a: new Handshake(aliceId, "Alice"), b: new Handshake(bobId, "Bob") };
        old.a.receiveHello(old.b.hello);
        const oldBobAuth = old.b.receiveHello(old.a.hello);

        const fresh = { a: new Handshake(aliceId, "Alice"), b: new Handshake(bobId, "Bob") };
        fresh.a.receiveHello(fresh.b.hello);
        assert.throws(() => fresh.a.receiveAuth(oldBobAuth), /handshake signature is invalid/);
    });

    it("rejects malformed hellos", () => {
        const a = new Handshake(createIdentity(), "Alice");
        const good = new Handshake(createIdentity(), "Bob").hello;
        const cases: Array<[object, RegExp]> = [
            [{ ...good, protocol: "other/9" }, /speaks other\/9/],
            [{ ...good, identityKey: toBase64([1, 2, 3]) }, /identityKey must be 32 bytes/],
            [{ ...good, sessionKey: "not base64!" }, /sessionKey must be a base64 string/],
            [{ ...good, kemKey: toBase64(new Array(1567).fill(7)) }, /kemKey must be 1568 bytes/],
            [{ ...good, kemKey: undefined }, /kemKey must be a base64 string/],
            [{ ...good, protocol: "cas-p2p-chat/1" }, /speaks cas-p2p-chat\/1, not cas-p2p-chat\/2/],
            [{ ...good, name: "" }, /name must be/],
            [{ ...good, name: "Bob‮evil" }, /invisible formatting/],
            [{ ...good, type: "auth" }, /expected a hello frame/],
        ];
        for (const [frame, error] of cases) {
            assert.throws(() => new Handshake(createIdentity(), "Alice").receiveHello(frame), error);
        }
        assert.throws(() => a.receiveHello({ ...good, kemKey: a.hello.kemKey }), /echoed our handshake values/);
        assert.throws(() => a.receiveAuth({ type: "auth", signature: "" }), /auth before hello/);
    });
});

describe("session messages", () => {
    it("seals and opens in both directions", () => {
        const { alice, bob } = establish();
        assert.equal(fromUtf8(bob.open(alice.seal(utf8("hi Bob")))), "hi Bob");
        assert.equal(fromUtf8(alice.open(bob.seal(utf8("hi Alice 👋")))), "hi Alice 👋");
        assert.equal(fromUtf8(bob.open(alice.seal(utf8("second")))), "second");
    });

    it("does not put the plaintext on the wire", () => {
        const { alice } = establish();
        const frame = JSON.stringify(alice.seal(utf8("attack at dawn")));
        assert.ok(!frame.includes("attack"));
        assert.ok(!Buffer.from(frame).includes(Buffer.from("attack at dawn")));
    });

    it("sends only seq and AES-256-GCM ciphertext plus tag, with no nonce or signature", () => {
        const { alice } = establish();
        const frame = alice.seal(utf8("hello"));
        assert.deepEqual(Object.keys(frame).sort(), ["ciphertext", "seq", "type"]);
        assert.equal(fromBase64(frame.ciphertext, "ciphertext").length, 5 + 16);
    });

    for (const [where, at] of [["ciphertext", 0], ["tag", -1]] as const) {
        it(`rejects a message with a modified ${where}`, () => {
            const { alice, bob } = establish();
            assert.throws(() => bob.open(flip(alice.seal(utf8("hello")), "ciphertext", at)), /failed to decrypt/);
        });
    }

    it("rejects a truncated message", () => {
        const { alice, bob } = establish();
        assert.throws(() => bob.open({ ...alice.seal(utf8("hello")), ciphertext: toBase64(new Array(15).fill(0)) }), /too short/);
    });

    it("uses a different key in each direction, so a message can't be reflected to its sender", () => {
        const { alice, bob } = establish();
        assert.throws(() => alice.open(alice.seal(utf8("echo"))), /failed to decrypt/);
        // Same seq, same session, other direction: still distinct ciphertexts.
        assert.notEqual(alice.seal(utf8("same")).ciphertext, bob.seal(utf8("same")).ciphertext);
    });

    it("rejects replayed, skipped and reordered messages", () => {
        const { alice, bob } = establish();
        const first = alice.seal(utf8("one"));
        const second = alice.seal(utf8("two"));
        assert.throws(() => bob.open(second), /expected message #0, got #1/);
        bob.open(first);
        assert.throws(() => bob.open(first), /expected message #1, got #0/);
        assert.equal(fromUtf8(bob.open(second)), "two");
    });

    it("rejects a message whose seq was rewritten", () => {
        const { alice, bob } = establish();
        alice.seal(utf8("dropped"));
        const second = alice.seal(utf8("two"));
        // Claiming to be message #0 doesn't help: seq is bound into the nonce and AAD.
        assert.throws(() => bob.open({ ...second, seq: 0 }), /failed to decrypt/);
    });

    it("rejects a message from another session between the same identities", () => {
        const aliceId = createIdentity();
        const bobId = createIdentity();
        const pair = () => {
            const a = new Handshake(aliceId, "Alice");
            const b = new Handshake(bobId, "Bob");
            const aAuth = a.receiveHello(b.hello);
            const bAuth = b.receiveHello(a.hello);
            return { alice: a.receiveAuth(bAuth), bob: b.receiveAuth(aAuth) };
        };
        const one = pair();
        const two = pair();
        assert.throws(() => two.bob.open(one.alice.seal(utf8("from session one"))), ProtocolError);
    });

    it("rejects a message sealed by someone other than the authenticated peer", () => {
        const { alice, bob } = establish();
        const { alice: mallory } = establish();
        // Mallory's frame is well-formed, but sealed under her own session's key.
        assert.throws(() => bob.open(mallory.seal(utf8("I am Alice"))), /failed to decrypt/);
        assert.equal(fromUtf8(bob.open(alice.seal(utf8("real")))), "real");
    });

    it("refuses to work after it is destroyed", () => {
        const { alice } = establish();
        alice.destroy();
        assert.throws(() => alice.seal(utf8("x")), /closed/);
    });
});
