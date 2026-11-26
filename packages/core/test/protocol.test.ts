import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromBase64, toBase64, utf8, fromUtf8 } from "../src/core/bytes";
import { ProtocolError } from "../src/core/errors";
import { createIdentity, fingerprint, parseIdentity, serializeIdentity } from "../src/core/identity";
import { Handshake, MessageFrame, Session } from "../src/core/protocol";

function establish(): { alice: Session; bob: Session; aliceId: ReturnType<typeof createIdentity>; bobId: ReturnType<typeof createIdentity> } {
    const aliceId = createIdentity();
    const bobId = createIdentity();
    const a = new Handshake(aliceId, "Alice");
    const b = new Handshake(bobId, "Bob");
    const aAuth = a.receiveHello(b.hello);
    const bAuth = b.receiveHello(a.hello);
    return { alice: a.receiveAuth(bAuth), bob: b.receiveAuth(aAuth), aliceId, bobId };
}

/** Flips one bit of a base64 field. */
function flip(frame: MessageFrame, field: "ciphertext" | "tag" | "encapsulatedKey" | "signature"): MessageFrame {
    const bytes = fromBase64(frame[field], field);
    bytes[0] ^= 0x01;
    return { ...frame, [field]: toBase64(bytes) };
}

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
            [{ ...good, name: "" }, /name must be/],
            [{ ...good, name: "Bob‮evil" }, /invisible formatting/],
            [{ ...good, type: "auth" }, /expected a hello frame/],
        ];
        for (const [frame, error] of cases) {
            assert.throws(() => new Handshake(createIdentity(), "Alice").receiveHello(frame), error);
        }
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

    for (const field of ["ciphertext", "tag", "encapsulatedKey", "signature"] as const) {
        it(`rejects a message with a modified ${field}`, () => {
            const { alice, bob } = establish();
            assert.throws(() => bob.open(flip(alice.seal(utf8("hello")), field)), ProtocolError);
        });
    }

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
        // Claiming to be message #0 doesn't help: seq is bound into the AAD and signature.
        assert.throws(() => bob.open({ ...second, seq: 0 }), /signature is invalid/);
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
        // Mallory's frame is well-formed but signed with Mallory's identity, for another session.
        assert.throws(() => bob.open(mallory.seal(utf8("I am Alice"))), /signature is invalid/);
        assert.equal(fromUtf8(bob.open(alice.seal(utf8("real")))), "real");
    });

    it("refuses to work after it is destroyed", () => {
        const { alice } = establish();
        alice.destroy();
        assert.throws(() => alice.seal(utf8("x")), /closed/);
    });
});
