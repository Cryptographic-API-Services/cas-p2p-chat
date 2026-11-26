// --smoke-test: an end-to-end check of the real app, driving the actual Vue UI.
//
//   A real chat server (directory + PeerJS signaling) runs in-process, and two bots join it, each
//   with its own hidden WebRTC transport window, like separate devices:
//   1. "Echo Bot" is unlisted: it can't be found by name, but connecting by fingerprint works.
//   2. "Remote Bot" is listed: find it by name and connect.
//   3. Disconnect, then reconnect to the contact by fingerprint.
//   4. Check the server's database holds no IP address.
//
// Exits 0 on success. --screenshot=<file.png> also saves the window.
import { BrowserWindow, app } from "electron";
import * as fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ChatNode } from "../core/chat-node";
import { createIdentity } from "../core/identity";
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
        await until(name + "'s conversation", () => text("peer-name") === name && text("peer-where") !== "offline");
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

export function runSmokeTest(window: BrowserWindow, screenshot: string | undefined): void {
    const echo = device("Echo Bot");
    const remote = device("Remote Bot");

    window.webContents.once("did-finish-load", async () => {
        let ok = false;
        let chatServer: Server | undefined;
        try {
            const { createChatServer } = await import("../server/app.js");
            const { PeerStore } = await import("../server/peer-store.js");
            const store = new PeerStore(":memory:");
            // No STUN/TURN: both "devices" are on this machine, so host candidates are enough.
            const chat = createChatServer({ store, iceServers: [] });
            chatServer = chat.server;
            await new Promise<void>((resolve) => chat.server.listen(0, "127.0.0.1", resolve));
            const serverUrl = `http://127.0.0.1:${(chat.server.address() as AddressInfo).port}`;

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

                // 3. Disconnect, then reconnect to the contact by fingerprint.
                q("disconnect").click();
                await until("the disconnect", () => text("peer-where") === "offline");
                await until("the reconnect button", () => !q("reconnect").disabled);
                q("reconnect").click();
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

            // Everything the server stored, as text: it must not contain an IP address.
            const stored = JSON.stringify(store.list());
            const storesNoIp = !/\b\d{1,3}(\.\d{1,3}){3}\b|::/.test(stored);
            ok = /^[0-9A-F]{4}( [0-9A-F]{4}){7}$/.test(result.fingerprint)
                && result.echoFindable === false
                && result.echoWhere === "connected (WebRTC)"
                && result.badge === "unverified"
                && result.contacts.length === 2
                && result.incoming.includes("echo: back again")
                && store.count() === 2 // Remote Bot and this app; Echo Bot stayed unlisted
                && storesNoIp;
            console.log(`smoke test ${ok ? "passed" : "FAILED"}: ${JSON.stringify({ ...result, listed: store.count(), storesNoIp })}`);

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
        chatServer?.close();
        try {
            fs.rmSync(app.getPath("userData"), { recursive: true, force: true });
        } catch {
            // Chromium can still hold files open on Windows; it's only a temp directory.
        }
        app.exit(ok ? 0 : 1);
    });
}
