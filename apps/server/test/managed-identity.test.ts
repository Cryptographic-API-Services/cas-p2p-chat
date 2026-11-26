import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { managedIdentityToken } from "../src/managed-identity.ts";

describe("managed identity tokens", () => {
    const requests: IncomingMessage[] = [];
    let reply: { status: number; body: unknown } = { status: 200, body: {} };
    const server = createServer((req, res) => {
        requests.push(req);
        res.writeHead(reply.status, { "Content-Type": "application/json" }).end(JSON.stringify(reply.body));
    });
    let env: NodeJS.ProcessEnv;
    before(async () => {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        env = { IDENTITY_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}/msi/token`, IDENTITY_HEADER: "secret" };
    });
    after(() => server.close());

    it("asks the identity endpoint for a PostgreSQL token, and caches it until shortly before it expires", async () => {
        requests.length = 0;
        reply = { status: 200, body: { access_token: "token-1", expires_on: String(Math.floor(Date.now() / 1000) + 3600) } };
        const token = managedIdentityToken("client-id", env);
        assert.equal(await token(), "token-1");
        assert.equal(await token(), "token-1");
        assert.equal(requests.length, 1);
        const url = new URL(requests[0].url!, "http://x");
        assert.equal(url.pathname, "/msi/token");
        assert.equal(url.searchParams.get("resource"), "https://ossrdbms-aad.database.windows.net");
        assert.equal(url.searchParams.get("client_id"), "client-id");
        assert.equal(requests[0].headers["x-identity-header"], "secret");

        // Within five minutes of expiry: fetch a new one.
        reply = { status: 200, body: { access_token: "token-2", expires_on: String(Math.floor(Date.now() / 1000) + 60) } };
        const soon = managedIdentityToken(undefined, env);
        assert.equal(await soon(), "token-2");
        reply = { status: 200, body: { access_token: "token-3", expires_on: String(Math.floor(Date.now() / 1000) + 3600) } };
        assert.equal(await soon(), "token-3");
        assert.equal(new URL(requests.at(-1)!.url!, "http://x").searchParams.get("client_id"), null);
    });

    it("fails clearly without an identity endpoint or on a bad response", async () => {
        await assert.rejects(managedIdentityToken(undefined, {})(), /no managed identity endpoint/);
        reply = { status: 400, body: { error: "invalid_request" } };
        await assert.rejects(managedIdentityToken(undefined, env)(), /HTTP 400/);
        reply = { status: 200, body: { token_type: "Bearer" } };
        await assert.rejects(managedIdentityToken(undefined, env)(), /no access_token/);
    });
});
