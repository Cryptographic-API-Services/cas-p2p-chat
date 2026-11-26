import { BrowserWindow, app, clipboard, ipcMain, safeStorage, session, type IpcMainInvokeEvent } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChatNode, PeerSummary } from "@cas-p2p-chat/core/chat-node";
import { Identity, createIdentity, parseIdentity, serializeIdentity } from "@cas-p2p-chat/core/identity";
import { fingerprintToPeerId, normalizeFingerprint } from "@cas-p2p-chat/core/peer-id";
import { TrustStore } from "@cas-p2p-chat/core/trust-store";
import { ServerState, ServerSync } from "./server-sync";
import { WebRtcBridge, acceptIncoming } from "./webrtc-bridge";

function argValue(name: string): string | undefined {
    const prefix = `--${name}=`;
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const smokeTest = process.argv.includes("--smoke-test");

// --profile=<name> gives a separate identity, contacts and settings, so two instances can run
// side by side on one machine. The smoke test uses a throwaway directory.
const profile = argValue("profile");
if (smokeTest) {
    app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "cas-p2p-chat-smoke-")));
} else if (profile) {
    if (!/^[\w-]{1,32}$/.test(profile)) {
        throw new Error("--profile may only contain letters, digits, '-' and '_'");
    }
    app.setPath("userData", `${app.getPath("userData")}-${profile}`);
}

// Identity

interface LoadedIdentity {
    identity: Identity;
    keyProtection: "os" | "none";
}

/** True when safeStorage really encrypts (on Linux it can fall back to a hard-coded key). */
async function osEncryptionAvailable(): Promise<boolean> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
        return false;
    }
    return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
}

async function writeIdentity(file: string, identity: Identity): Promise<"os" | "none"> {
    const json = serializeIdentity(identity);
    const protect = await osEncryptionAvailable();
    const stored = protect
        ? { protection: "safeStorage", data: (await safeStorage.encryptStringAsync(json)).toString("base64") }
        : { protection: "none", data: json };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
    return protect ? "os" : "none";
}

/** Loads the device identity, creating it on first run. The private key is sealed with the OS keychain when possible. */
async function loadOrCreateIdentity(dir: string): Promise<LoadedIdentity> {
    const file = path.join(dir, "identity.json");
    if (!fs.existsSync(file)) {
        const identity = createIdentity();
        return { identity, keyProtection: await writeIdentity(file, identity) };
    }
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { protection?: string; data?: string };
    if (stored.protection !== "safeStorage") {
        return { identity: parseIdentity(stored.data ?? ""), keyProtection: "none" };
    }
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(stored.data ?? "", "base64"));
    const identity = parseIdentity(result);
    // The OS rotated its key: re-seal the identity under the new one.
    const keyProtection = shouldReEncrypt ? await writeIdentity(file, identity) : "os";
    return { identity, keyProtection };
}

// Settings

interface Settings {
    serverUrl: string | null;
    listed: boolean;
}

function settingsFile(): string {
    return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings(): Settings {
    try {
        const data = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as Partial<Settings>;
        return {
            serverUrl: typeof data.serverUrl === "string" ? data.serverUrl : null,
            listed: data.listed !== false,
        };
    } catch {
        return { serverUrl: null, listed: true };
    }
}

function saveSettings(settings: Settings): void {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

let mainWindow: BrowserWindow | null = null;

async function start(): Promise<void> {
    // No page in this app needs camera, notifications, clipboard-read or anything else.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    const { identity, keyProtection } = await loadOrCreateIdentity(app.getPath("userData"));
    const trust = new TrustStore(path.join(app.getPath("userData"), "known-peers.json"));
    const settings = loadSettings();
    const name = argValue("name") ?? os.userInfo().username;
    const node = new ChatNode({ identity, name });

    // Peers connected this run, kept after they disconnect so their history stays addressable.
    const peers = new Map<string, PeerSummary>();
    const toApiPeer = (peer: PeerSummary): ApiPeer => ({ ...peer, trust: trust.get(peer.fingerprint, peer.name) });
    const toApiServer = (state: ServerState): ApiServer => ({ ...state });
    const send = (event: ApiEvent) => mainWindow?.webContents.send("chat:event", event);

    // Every connection is WebRTC, set up through the server's signaling and dialed by fingerprint.
    const bridge = new WebRtcBridge();
    acceptIncoming(bridge, node);
    const server = new ServerSync(identity, () => node.name, bridge, (state) => send({ type: "server-changed", server: toApiServer(state) }));

    node.on("peer-connected", (peer) => {
        peers.set(peer.id, peer);
        const info = trust.observe(peer.fingerprint, peer.name);
        send({ type: "peer-connected", peer: { ...peer, trust: info } });
    });
    node.on("peer-disconnected", (peerId, reason) => send({ type: "peer-disconnected", peerId, reason }));
    node.on("handshake-failed", (_label, reason) => send({ type: "handshake-failed", reason }));
    node.on("message", (peerId, message) => send({ type: "message", peerId, message }));

    /** Connects to a fingerprint through the server. */
    const connect = async (target: string): Promise<PeerSummary> => {
        const fingerprint = normalizeFingerprint(target);
        if (!fingerprint) {
            throw new Error("enter a fingerprint: 32 hexadecimal digits, as shown under “This device”");
        }
        if (fingerprint === node.fingerprint) {
            throw new Error("that's this device's own fingerprint");
        }
        if (bridge.status !== "online") {
            throw new Error("join a server to connect to someone by fingerprint");
        }
        const link = await bridge.dial(fingerprintToPeerId(fingerprint));
        return node.adopt(link, "outbound", { expectedFingerprint: fingerprint });
    };

    /** Registers an IPC handler that only answers our own window. */
    const handle = (channel: string, fn: (...args: unknown[]) => unknown) => {
        ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
            if (!mainWindow || event.sender !== mainWindow.webContents) {
                throw new Error("unexpected IPC sender");
            }
            return fn(...args);
        });
    };
    const peerFor = (peerId: unknown): PeerSummary => {
        const peer = typeof peerId === "string" ? peers.get(peerId) : undefined;
        if (!peer) {
            throw new Error("unknown peer");
        }
        return peer;
    };

    handle("chat:get-self", (): ApiSelf => ({
        name: node.name,
        fingerprint: node.fingerprint,
        keyProtection,
    }));
    handle("chat:list-peers", () => node.listPeers().map(toApiPeer));
    handle("chat:list-contacts", (): ApiContact[] => trust.list());
    handle("chat:connect", async (target) => toApiPeer(await connect(String(target))));
    handle("chat:send-text", (peerId, text) => node.sendText(peerFor(peerId).id, String(text)));
    handle("chat:disconnect", (peerId) => node.disconnect(peerFor(peerId).id));
    handle("chat:set-verified", (fingerprint, verified) => {
        const canonical = normalizeFingerprint(String(fingerprint));
        const contact = canonical ? trust.list().find((c) => c.fingerprint === canonical) : undefined;
        if (!contact) {
            throw new Error("unknown contact");
        }
        trust.setVerified(contact.fingerprint, verified === true);
        const info = trust.get(contact.fingerprint, contact.name);
        send({ type: "trust-changed", fingerprint: contact.fingerprint, trust: info });
        return info;
    });
    handle("chat:copy-text", (text) => clipboard.writeText(String(text)));

    handle("chat:get-server", () => toApiServer(server.current));
    handle("chat:set-server", async (url, listed) => {
        const value = typeof url === "string" && url.trim() !== "" ? url : null;
        const state = await server.setServer(value, listed !== false);
        Object.assign(settings, { serverUrl: state.url, listed: state.listed });
        saveSettings(settings);
        return toApiServer(state);
    });
    handle("chat:set-listed", async (listed) => {
        const state = await server.setListed(listed === true);
        settings.listed = state.listed;
        saveSettings(settings);
        return toApiServer(state);
    });
    handle("chat:search-directory", async (query): Promise<ApiSearchResult> => {
        const { results, rejected } = await server.search(String(query));
        return { results: results.map((entry) => ({ ...entry, trust: trust.get(entry.fingerprint, entry.name) })), rejected };
    });

    app.on("before-quit", () => {
        server.stop();
        node.close();
    });

    mainWindow = new BrowserWindow({
        width: 1180,
        height: 760,
        minWidth: 860,
        minHeight: 520,
        title: `CAS P2P Chat: ${node.name}`,
        backgroundColor: "#121212",
        show: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webSecurity: true,
        },
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
    // The hidden transport window lives as long as the app, so close everything with this window.
    mainWindow.on("closed", () => {
        mainWindow = null;
        app.quit();
    });

    const initialServer = argValue("server") ?? settings.serverUrl;
    if (initialServer && !smokeTest) {
        server.setServer(initialServer, settings.listed).catch((err) => console.error(`Server: ${(err as Error).message}`));
    }

    if (smokeTest) {
        const { runSmokeTest } = await import("./smoke-test.js");
        runSmokeTest(mainWindow, argValue("screenshot"));
    } else {
        mainWindow.once("ready-to-show", () => mainWindow?.show());
    }
    await mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

app.whenReady()
    .then(start)
    .catch((err) => {
        console.error(err);
        app.exit(1);
    });

app.on("window-all-closed", () => app.quit());
