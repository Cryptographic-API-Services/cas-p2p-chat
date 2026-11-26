// --smoke-test: an end-to-end check of the real app, driving the actual Vue UI.
//
//   The real chat server (directory + PeerJS signaling, in-memory PGlite) runs as a child Node
//   process (Node 22.18+ on PATH; npm's own Node when run through npm), and two bots join it,
//   each with its own hidden WebRTC transport window, like separate devices:
//   1. "Echo Bot" is unlisted: it can't be found by name, but connecting by fingerprint works.
//   2. "Remote Bot" is listed: find it by name and connect.
//   3. Disconnect, then click the contact, which dials them again.
//   4. Check the server's listings hold no IP address.
//   5. Check the local database holds no message text, name or fingerprint in the clear; reload
//      the window and check the saved history comes back; delete one contact's history.
//
// Exits 0 on success. --screenshot=<file.png> also saves the window.
import { BrowserWindow, app } from "electron";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { ChatNode } from "@cas-p2p-chat/core/chat-node";
import { createIdentity } from "@cas-p2p-chat/core/identity";
import { ServerSync } from "./server-sync";
import { WebRtcBridge, acceptIncoming } from "./webrtc-bridge";

function echoBot(name: string, identity = createIdentity()): ChatNode {
    const bot = new ChatNode({ identity, name });
    bot.on("message", (peerId, message) => bot.sendText(peerId, `echo: ${message.text}`));
    return bot;
}

async function until(what: string, check: () => boolean, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

/** Runs in the page. Helpers to fill Vuetify fields and wait for the UI. */
const PAGE_HELPERS = `
    const q = (testId) => document.querySelector('[data-testid="' + testId + '"]');
    const text = (testId) => q(testId)?.textContent.trim() ?? "";
    const until = async (what, check) => {
        for (let i = 0; i < 600; i++) {
            const value = check();
            if (value) return value;
            await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error("timed out waiting for " + what);
    };
    // Vuetify fields wrap the real <input>/<textarea>; v-model listens for input events.
    const fill = (testId, value) => {
        const input = q(testId).querySelector("input, textarea");
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const texts = (testId) => [...document.querySelectorAll('[data-testid="' + testId + '"] [data-testid="message-text"]')].map((e) => e.textContent.trim());
    const chatWith = async (name, message) => {
        await until(name + "'s conversation", () => text("peer-name") === name && text("peer-where") === "connected (WebRTC)");
        fill("composer", message);
        await until("the send button", () => !q("send").disabled);
        q("send").click();
        await until("the echo from " + name, () => texts("message-in").includes("echo: " + message));
    };
`;

/** A bot "device": its own identity, chat node and hidden WebRTC transport window. */
function device(name: string) {
    const identity = createIdentity();
    const node = echoBot(name, identity);
    const bridge = new WebRtcBridge();
    acceptIncoming(bridge, node);
    const server = new ServerSync(identity, () => node.name, bridge, () => undefined);
    return { node, bridge, server };
}

/** Starts apps/server under Node, on a free port with an in-memory database. Resolves to its URL. */
function startServer(): Promise<{ url: string; child: ChildProcess }> {
    const dir = path.join(__dirname, "..", "..", "..", "server");
    const child = spawn(process.env.npm_node_execpath ?? "node", ["--conditions=cas-source", path.join("src", "server.ts")], {
        cwd: dir,
        env: { ...process.env, PORT: "0", HOST: "127.0.0.1", DATABASE_URL: "pglite:memory", ICE_SERVERS: "[]" },
        stdio: ["ignore", "pipe", "inherit"],
    });
    return new Promise((resolve, reject) => {
        let output = "";
        child.stdout!.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            const match = /server on (http:\/\/[\d.]+:\d+)/.exec(output);
            if (match) {
                resolve({ url: match[1], child });
            }
        });
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`the chat server exited (${code}): ${output}`)));
    });
}

export function runSmokeTest(window: BrowserWindow, screenshot: string | undefined): void {
    const echo = device("Echo Bot");
    const remote = device("Remote Bot");

    window.webContents.once("did-finish-load", async () => {
        let ok = false;
        let chatServer: ChildProcess | undefined;
        try {
            // No STUN/TURN (ICE_SERVERS=[]): both "devices" are on this machine, so host candidates are enough.
            const started = await startServer();
            chatServer = started.child;
            const serverUrl = started.url;

            await echo.server.setServer(serverUrl, false);
            await remote.server.setServer(serverUrl, true);
            await until("the bots to reach signaling", () => echo.bridge.status === "online" && remote.bridge.status === "online");

            const result = await window.webContents.executeJavaScript(`(async () => {
                ${PAGE_HELPERS}
                await until("own fingerprint", () => text("self-fingerprint"));

                fill("server-url", ${JSON.stringify(serverUrl)});
                q("server-form").requestSubmit();
                await until("signaling", () => text("server-status") === "online");

                // 1. Echo Bot is unlisted: not findable by name, but reachable by fingerprint.
                fill("search", "echo");
                await until("the empty search", () => document.body.textContent.includes("Nobody listed under that name."));
                const echoFindable = document.querySelectorAll('[data-testid="search-result"]').length > 0;
                fill("connect-target", ${JSON.stringify(echo.node.fingerprint.replace(/ /g, "").toLowerCase())});
                q("connect-form").requestSubmit();
                await chatWith("Echo Bot", "hello by fingerprint");
                const echoWhere = text("peer-where");

                // 2. Find Remote Bot by name and connect.
                fill("search", "remote");
                const result = await until("Remote Bot in the search results", () => document.querySelector('[data-testid="search-result"][data-name="Remote Bot"]'));
                await until("Remote Bot to show as online", () => !result.querySelector('[data-testid="search-connect"]').disabled);
                result.querySelector('[data-testid="search-connect"]').click();
                await chatWith("Remote Bot", "hello by name");

                // 3. Disconnect, then click the contact, which dials them again.
                q("disconnect").click();
                await until("the disconnect", () => text("peer-where") === "not connected");
                document.querySelector('[data-testid="conversation"][data-name="Remote Bot"]').click();
                await chatWith("Remote Bot", "back again");

                return {
                    fingerprint: text("self-fingerprint"),
                    echoFindable,
                    echoWhere,
                    badge: text("peer-badge"),
                    contacts: [...document.querySelectorAll('[data-testid="conversation"]')].map((e) => e.dataset.name),
                    incoming: texts("message-in"),
                };
            })()`);

            // The listings the server hands out, as text: they must not contain an IP address.
            const listed = ((await (await fetch(`${serverUrl}/health`)).json()) as { listed: number }).listed;
            const stored = await (await fetch(`${serverUrl}/v1/peers?q=bot`)).text();
            const storesNoIp = stored.includes("Remote Bot") && !/\b\d{1,3}(\.\d{1,3}){3}\b|::/.test(stored);
            ok = /^[0-9A-F]{4}( [0-9A-F]{4}){7}$/.test(result.fingerprint)
                && result.echoFindable === false
                && result.echoWhere === "connected (WebRTC)"
                && result.badge === "unverified"
                && result.contacts.length === 2
                && result.incoming.includes("echo: back again")
                && listed === 2 // Remote Bot and this app; Echo Bot stayed unlisted
                && storesNoIp;

            // 5. Everything saved is in the encrypted database: no plaintext there, and no old JSON files.
            const userData = app.getPath("userData");
            const files = fs.readdirSync(userData);
            const database = Buffer.concat(files.filter((f) => f.startsWith("chat.sqlite")).map((f) => fs.readFileSync(path.join(userData, f))));
            const secrets = ["hello by name", "echo: back again", "Remote Bot", "Echo Bot", remote.node.fingerprint, remote.node.fingerprint.replace(/ /g, "")];
            const savedEncrypted = database.length > 0
                && secrets.every((secret) => !database.includes(secret))
                && !files.some((f) => f === "known-peers.json" || f === "settings.json");

            window.webContents.reload();
            await once(window.webContents, "did-finish-load");
            const history = await window.webContents.executeJavaScript(`(async () => {
                ${PAGE_HELPERS}
                const open = async (name) => {
                    const item = await until(name + " in the contacts", () => document.querySelector('[data-testid="conversation"][data-name="' + name + '"]'));
                    item.click();
                    await until(name + "'s conversation", () => text("peer-name") === name);
                };
                await open("Remote Bot");
                await until("the saved messages", () => texts("message-in").length >= 2);
                const restored = [...texts("message-out"), ...texts("message-in")];

                q("clear-history").click();
                (await until("the confirmation", () => q("clear-history-confirm"))).click();
                await until("the history to clear", () => texts("message-in").length + texts("message-out").length === 0);

                await open("Echo Bot");
                await until("Echo Bot's saved messages", () => texts("message-in").length > 0);
                return { restored, echoKept: texts("message-in") };
            })()`);
            const historyOk = ["hello by name", "back again", "echo: hello by name", "echo: back again"].every((m) => history.restored.includes(m))
                && history.echoKept.includes("echo: hello by fingerprint");
            ok = ok && savedEncrypted && historyOk;
            console.log(`smoke test ${ok ? "passed" : "FAILED"}: ${JSON.stringify({ ...result, listed, storesNoIp, savedEncrypted, ...history })}`);

            // A hidden window can't be captured, so show it unfocused first.
            if (ok && screenshot) {
                window.showInactive();
                await new Promise((resolve) => setTimeout(resolve, 600));
                fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
            }
        } catch (err) {
            console.error("smoke test FAILED:", err);
        }
        for (const bot of [echo, remote]) {
            bot.server.stop();
            bot.bridge.destroy();
            bot.node.close();
        }
        chatServer?.kill();
        try {
            fs.rmSync(app.getPath("userData"), { recursive: true, force: true });
        } catch {
            // Chromium can still hold files open on Windows; it's only a temp directory.
        }
        app.exit(ok ? 0 : 1);
    });
}
