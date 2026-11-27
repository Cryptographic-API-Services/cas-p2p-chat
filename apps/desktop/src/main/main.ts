import { BrowserWindow, app, clipboard, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateAvatar } from "@cas-p2p-chat/core/avatar";
import type { Bytes } from "@cas-p2p-chat/core/bytes";
import { ChatMessage, ChatNode, PeerSummary } from "@cas-p2p-chat/core/chat-node";
import { createIdentity, parseIdentity, serializeIdentity } from "@cas-p2p-chat/core/identity";
import { fingerprintToPeerId, normalizeFingerprint } from "@cas-p2p-chat/core/peer-id";
import { SqliteAvatarRepository } from "@cas-p2p-chat/core/repositories/avatar-repository";
import { SqliteContactRepository } from "@cas-p2p-chat/core/repositories/contact-repository";
import { importLegacyFiles } from "@cas-p2p-chat/core/repositories/legacy-files";
import { LocalDatabase, createStorageKey, parseStorageKey, serializeStorageKey } from "@cas-p2p-chat/core/repositories/local-database";
import { MessageDirection, SqliteMessageRepository } from "@cas-p2p-chat/core/repositories/message-repository";
import { SqliteSettingsRepository } from "@cas-p2p-chat/core/repositories/settings-repository";
import { TrustStore } from "@cas-p2p-chat/core/trust-store";
import { SealedFileKeyRepository, loadOrCreateKey } from "./repositories/key-repository";
import { ServerState, ServerSync } from "./server-sync";
import { WebRtcBridge, acceptIncoming } from "./webrtc-bridge";

function argValue(name: string): string | undefined {
    const prefix = `--${name}=`;
    return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const smokeTest = process.argv.includes("--smoke-test");

/**
 * The public server. Until the user picks another or leaves it, the app joins it at startup,
 * unlisted: reachable by fingerprint, but findable by name only once the user opts in.
 */
const DEFAULT_SERVER_URL = "https://chatp2p.cryptographicapiservices.com";

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

// Storage: the two keys in their own files, sealed with the OS keychain; everything else (settings,
// contacts, messages) in the encrypted local database, through repositories.

/** Saved messages loaded when a conversation is opened. */
const HISTORY_LIMIT = 1000;

/**
 * Opens the local database and applies pending migrations. If that fails, runs on an in-memory
 * one, so the app still works, and says why.
 */
async function openLocalDatabase(file: string, key: Bytes): Promise<{ local: LocalDatabase; storageError: string | null }> {
    try {
        return { local: await LocalDatabase.open(file, key), storageError: null };
    } catch (err) {
        const message = (err as Error).message;
        console.error(`Could not open ${file}: ${message}`);
        return { local: await LocalDatabase.open(":memory:", key), storageError: message };
    }
}

let mainWindow: BrowserWindow | null = null;

async function start(): Promise<void> {
    // No page in this app needs camera, notifications, clipboard-read or anything else.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    const userData = app.getPath("userData");
    const identityKey = await loadOrCreateKey(
        new SealedFileKeyRepository(path.join(userData, "identity.json"), { serialize: serializeIdentity, parse: parseIdentity }),
        createIdentity,
    );
    const storageKey = await loadOrCreateKey(
        new SealedFileKeyRepository(path.join(userData, "storage-key.json"), { serialize: serializeStorageKey, parse: parseStorageKey }),
        createStorageKey,
    );
    const identity = identityKey.value;
    const keyProtection = identityKey.protection === "os" && storageKey.protection === "os" ? "os" : "none";
    const { local, storageError } = await openLocalDatabase(path.join(userData, "chat.sqlite"), storageKey.value);
    const contacts = new SqliteContactRepository(local);
    const messages = new SqliteMessageRepository(local);
    const settingsStore = new SqliteSettingsRepository(local);
    const avatars = new SqliteAvatarRepository(local);
    // Never into a stand-in in-memory database: the import deletes the files it read.
    if (!storageError) {
        try {
            await importLegacyFiles(userData, { contacts, settings: settingsStore });
        } catch (err) {
            console.error(`Could not import contacts and settings from an older version: ${(err as Error).message}`);
        }
    }
    const trust = await TrustStore.load(contacts);
    const settings = (await settingsStore.load()) ?? { serverUrl: DEFAULT_SERVER_URL, listed: false };
    const name = argValue("name") ?? os.userInfo().username;
    const node = new ChatNode({ identity, name });
    // Our own avatar is kept in the same table as contacts', under our own fingerprint.
    node.setAvatar(await avatars.get(node.fingerprint));

    // Peers connected this run, kept after they disconnect so their history stays addressable.
    const peers = new Map<string, PeerSummary>();
    const toApiPeer = (peer: PeerSummary): ApiPeer => ({ ...peer, trust: trust.get(peer.fingerprint, peer.name) });
    const toApiServer = (state: ServerState): ApiServer => ({ ...state, defaultUrl: DEFAULT_SERVER_URL });
    const send = (event: ApiEvent) => mainWindow?.webContents.send("chat:event", event);

    // Every connection is WebRTC, set up through the server's signaling and dialed by fingerprint.
    const bridge = new WebRtcBridge();
    acceptIncoming(bridge, node);
    const server = new ServerSync(identity, () => node.name, bridge, (state) => send({ type: "server-changed", server: toApiServer(state) }));

    node.on("peer-connected", async (peer) => {
        peers.set(peer.id, peer);
        let info: ApiTrust;
        try {
            info = await trust.observe(peer.fingerprint, peer.name);
        } catch (err) {
            console.error(`Could not save a contact: ${(err as Error).message}`);
            info = trust.get(peer.fingerprint, peer.name);
        }
        send({ type: "peer-connected", peer: { ...peer, trust: info } });
    });
    node.on("peer-disconnected", (peerId, reason) => send({ type: "peer-disconnected", peerId, reason }));
    node.on("handshake-failed", (_label, reason) => send({ type: "handshake-failed", reason }));
    /** Adds a message to the saved history. If that fails, chat goes on; the message just isn't kept. */
    const save = async (fingerprint: string, direction: MessageDirection, message: ChatMessage): Promise<ApiMessage> => {
        try {
            return { ...message, id: (await messages.add(fingerprint, direction, message.text, message.at)).id };
        } catch (err) {
            console.error(`Could not save a message: ${(err as Error).message}`);
            return { ...message, id: null };
        }
    };
    // A peer's avatar, already validated by core. Kept so it shows when they're not connected.
    node.on("profile", async (peerId, avatar) => {
        const peer = peers.get(peerId);
        if (!peer) {
            return;
        }
        try {
            await avatars.save(peer.fingerprint, avatar);
        } catch (err) {
            console.error(`Could not save an avatar: ${(err as Error).message}`);
        }
        send({ type: "avatar-changed", fingerprint: peer.fingerprint, avatar });
    });
    node.on("message", async (peerId, message) => {
        const peer = peers.get(peerId);
        send({ type: "message", peerId, message: peer ? await save(peer.fingerprint, "in", message) : { ...message, id: null } });
    });

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
    /** The canonical fingerprint of a contact, from an untrusted argument. */
    const contactFingerprint = (fingerprint: unknown): string => {
        const canonical = normalizeFingerprint(String(fingerprint));
        if (!canonical || !trust.list().some((c) => c.fingerprint === canonical)) {
            throw new Error("unknown contact");
        }
        return canonical;
    };
    const peerFor = (peerId: unknown): PeerSummary => {
        const peer = typeof peerId === "string" ? peers.get(peerId) : undefined;
        if (!peer) {
            throw new Error("unknown peer");
        }
        return peer;
    };

    handle("chat:get-self", async (): Promise<ApiSelf> => ({
        name: node.name,
        fingerprint: node.fingerprint,
        keyProtection,
        storageError,
        avatar: await avatars.get(node.fingerprint),
    }));
    handle("chat:list-peers", () => node.listPeers().map(toApiPeer));
    handle("chat:list-contacts", (): Promise<ApiContact[]> =>
        Promise.all(trust.list().map(async (contact) => ({
            ...contact,
            lastMessageAt: await messages.lastMessageAt(contact.fingerprint),
            avatar: await avatars.get(contact.fingerprint),
        }))),
    );
    handle("chat:connect", async (target) => toApiPeer(await connect(String(target))));
    handle("chat:send-text", (peerId, text): Promise<ApiMessage> => {
        const peer = peerFor(peerId);
        return save(peer.fingerprint, "out", node.sendText(peer.id, String(text)));
    });
    handle("chat:disconnect", (peerId) => node.disconnect(peerFor(peerId).id));
    handle("chat:load-history", (fingerprint): Promise<ApiHistory> => messages.history(contactFingerprint(fingerprint), HISTORY_LIMIT));
    handle("chat:clear-history", async (fingerprint) => {
        await messages.clear(contactFingerprint(fingerprint));
    });
    handle("chat:set-verified", async (fingerprint, verified) => {
        const canonical = contactFingerprint(fingerprint);
        await trust.setVerified(canonical, verified === true);
        const contact = trust.list().find((c) => c.fingerprint === canonical)!;
        send({ type: "trust-changed", fingerprint: canonical, trust: contact.trust });
        return contact.trust;
    });
    handle("chat:set-avatar", async (avatar): Promise<string | null> => {
        // The UI resizes and re-encodes the user's picture, but checks are only trusted here.
        const value = avatar === null ? null : validateAvatar(avatar);
        await avatars.save(node.fingerprint, value);
        node.setAvatar(value);
        return value;
    });
    handle("chat:copy-text", (text) => clipboard.writeText(String(text)));

    handle("chat:get-server", () => toApiServer(server.current));
    handle("chat:set-server", async (url, listed) => {
        const value = typeof url === "string" && url.trim() !== "" ? url : null;
        const state = await server.setServer(value, listed !== false);
        Object.assign(settings, { serverUrl: state.url, listed: state.listed });
        await settingsStore.save(settings);
        return toApiServer(state);
    });
    handle("chat:set-listed", async (listed) => {
        const state = await server.setListed(listed === true);
        settings.listed = state.listed;
        await settingsStore.save(settings);
        return toApiServer(state);
    });
    handle("chat:search-directory", async (query): Promise<ApiSearchResult> => {
        const { results, rejected } = await server.search(String(query));
        return { results: results.map((entry) => ({ ...entry, trust: trust.get(entry.fingerprint, entry.name) })), rejected };
    });

    app.on("before-quit", () => {
        server.stop();
        node.close();
        local.close();
    });

    // The app icon (apps/desktop/build/icon.png, packaged alongside dist/). Installers embed it
    // in the executable too; this also covers running from source.
    const icon = path.join(__dirname, "..", "..", "build", "icon.png");
    if (process.platform === "darwin") {
        app.dock?.setIcon(icon);
    }
    mainWindow = new BrowserWindow({
        width: 1180,
        height: 760,
        minWidth: 860,
        minHeight: 520,
        title: `CAS P2P Chat: ${node.name}`,
        icon,
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
