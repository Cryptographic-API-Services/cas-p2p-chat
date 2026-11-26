// App state and actions for the Vue UI. The renderer has no Node access: everything goes
// through `window.chat` (src/shared/api.d.ts). Peer-supplied text is only ever rendered
// through Vue's text interpolation, which escapes it, never through v-html.
import { computed, reactive } from "vue";

export interface Line {
    kind: "outgoing" | "incoming" | "system";
    text: string;
    at: number;
}

/**
 * One contact and its chat thread, keyed by fingerprint. Contacts come from this device's own
 * list of everyone it has connected to; `peer` is the live connection, if there is one.
 */
export interface Conversation {
    fingerprint: string;
    name: string;
    trust: ApiTrust;
    peer: ApiPeer | null;
    lines: Line[];
    unread: number;
    /** For ordering: the last message, connection or (for old contacts) last-seen time. */
    lastActive: number;
}

export interface Toast {
    text: string;
    color: "error" | "success" | "info";
}

export const state = reactive({
    me: null as ApiSelf | null,
    conversations: new Map<string, Conversation>(),
    selected: null as string | null,
    server: { url: null, listed: true, signaling: "off", directory: "off" } as ApiServer,
    /** The fingerprint being dialed, if any. */
    connecting: null as string | null,
    search: {
        query: "",
        results: [] as ApiDirectoryEntry[],
        rejected: 0,
        busy: false,
        error: null as string | null,
    },
    toasts: [] as Toast[],
});

const fingerprintByPeerId = new Map<string, string>();

export const sortedConversations = computed(() =>
    [...state.conversations.values()].sort((a, b) => b.lastActive - a.lastActive),
);

export const selectedConversation = computed(() =>
    state.selected ? state.conversations.get(state.selected) ?? null : null,
);

export function errorText(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
}

export function toast(text: string, color: Toast["color"] = "info"): void {
    state.toasts.push({ text, color });
}

export function shortFingerprint(fingerprint: string): string {
    return fingerprint.split(" ").slice(0, 2).join(" ");
}

export function relativeTime(at: number, now = Date.now()): string {
    const minutes = Math.round((now - at) / 60_000);
    if (minutes < 1) {
        return "just now";
    }
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function conversationFor(fingerprint: string, name: string, trust: ApiTrust): Conversation {
    let conversation = state.conversations.get(fingerprint);
    if (!conversation) {
        state.conversations.set(fingerprint, { fingerprint, name, trust, peer: null, lines: [], unread: 0, lastActive: 0 });
        conversation = state.conversations.get(fingerprint)!;
    }
    return conversation;
}

function addContact(contact: ApiContact): void {
    const conversation = conversationFor(contact.fingerprint, contact.name, contact.trust);
    conversation.lastActive = Math.max(conversation.lastActive, Date.parse(contact.lastSeen) || 0);
}

function upsertPeer(peer: ApiPeer): Conversation {
    fingerprintByPeerId.set(peer.id, peer.fingerprint);
    const conversation = conversationFor(peer.fingerprint, peer.name, peer.trust);
    if (conversation.peer?.id !== peer.id) {
        const how = peer.direction === "inbound" ? "they connected to you" : "you connected to them";
        conversation.lines.push({
            kind: "system",
            text: `Secure session started (${how}, over WebRTC). Fresh X25519 session keys, HPKE with ` +
                `AES-256-GCM, and every message signed with Ed25519.`,
            at: Date.now(),
        });
    }
    conversation.name = peer.name;
    conversation.trust = peer.trust;
    conversation.peer = peer;
    conversation.lastActive = Date.now();
    return conversation;
}

function liveConversation(peerId: string): Conversation | undefined {
    const fingerprint = fingerprintByPeerId.get(peerId);
    const conversation = fingerprint ? state.conversations.get(fingerprint) : undefined;
    return conversation?.peer?.id === peerId ? conversation : undefined;
}

function onEvent(event: ApiEvent): void {
    switch (event.type) {
        case "peer-connected": {
            const isNew = !state.conversations.has(event.peer.fingerprint);
            upsertPeer(event.peer);
            if (event.peer.direction === "inbound") {
                toast(`${event.peer.name} connected to you${isNew ? " for the first time" : ""}.`);
            }
            break;
        }
        case "peer-disconnected": {
            const conversation = liveConversation(event.peerId);
            if (conversation) {
                conversation.peer = null;
                conversation.lines.push({
                    kind: "system",
                    text: `Session ended${event.reason ? `: ${event.reason}` : ""}. Its keys have been discarded.`,
                    at: Date.now(),
                });
            }
            break;
        }
        case "handshake-failed":
            // Failed outbound attempts are reported where the user started them.
            if (!state.connecting) {
                toast(`An incoming connection failed: ${event.reason ?? "unknown error"}`, "error");
            }
            break;
        case "message": {
            const conversation = liveConversation(event.peerId);
            if (conversation) {
                conversation.lines.push({ kind: "incoming", text: event.message.text, at: event.message.at });
                conversation.lastActive = event.message.at;
                if (state.selected !== conversation.fingerprint) {
                    conversation.unread++;
                }
            }
            break;
        }
        case "trust-changed": {
            const conversation = state.conversations.get(event.fingerprint);
            if (conversation) {
                conversation.trust = event.trust;
            }
            for (const result of state.search.results) {
                if (result.fingerprint === event.fingerprint) {
                    result.trust = event.trust;
                }
            }
            break;
        }
        case "server-changed":
            state.server = event.server;
            break;
    }
}

export async function init(): Promise<void> {
    window.chat.onEvent(onEvent);
    state.me = await window.chat.getSelf();
    for (const contact of await window.chat.listContacts()) {
        addContact(contact);
    }
    for (const peer of await window.chat.listPeers()) {
        upsertPeer(peer);
    }
    state.server = await window.chat.getServer();
}

export function select(fingerprint: string): void {
    state.selected = fingerprint;
    const conversation = state.conversations.get(fingerprint);
    if (conversation) {
        conversation.unread = 0;
    }
}

/**
 * Connects to a fingerprint through the server and opens the conversation.
 * Returns an error message, or null on success.
 */
export async function connect(target: string): Promise<string | null> {
    const live = [...state.conversations.values()].find((c) => c.peer && c.fingerprint.replace(/ /g, "") === target.replace(/[\s-]/g, "").toUpperCase());
    if (live) {
        select(live.fingerprint);
        return null;
    }
    state.connecting = target;
    try {
        const peer = await window.chat.connect(target.trim());
        upsertPeer(peer);
        select(peer.fingerprint);
        return null;
    } catch (err) {
        return errorText(err);
    } finally {
        state.connecting = null;
    }
}

/** Connects and reports failure as a toast (for buttons without their own error area). */
export async function connectOrToast(target: string): Promise<void> {
    const error = await connect(target);
    if (error) {
        toast(`Could not connect: ${error}`, "error");
    }
}

/** Sends to the selected conversation. Returns true if the message went out. */
export async function send(text: string): Promise<boolean> {
    const conversation = selectedConversation.value;
    if (!conversation?.peer || text.trim() === "") {
        return false;
    }
    try {
        const sent = await window.chat.sendText(conversation.peer.id, text);
        conversation.lines.push({ kind: "outgoing", text: sent.text, at: sent.at });
        conversation.lastActive = sent.at;
        return true;
    } catch (err) {
        toast(`Not sent: ${errorText(err)}`, "error");
        return false;
    }
}

export async function toggleVerified(conversation: Conversation): Promise<void> {
    try {
        await window.chat.setVerified(conversation.fingerprint, conversation.trust.level !== "verified");
    } catch (err) {
        toast(errorText(err), "error");
    }
}

export function disconnect(conversation: Conversation): void {
    if (conversation.peer) {
        void window.chat.disconnect(conversation.peer.id);
    }
}

export async function copyText(text: string, what: string): Promise<void> {
    await window.chat.copyText(text);
    toast(`${what} copied.`, "success");
}

/** Joins a server, or leaves the current one with null. Returns an error message, or null. */
export async function setServer(url: string | null, listed: boolean): Promise<string | null> {
    try {
        state.server = await window.chat.setServer(url, listed);
        if (!url) {
            state.search.results = [];
            state.search.query = "";
        }
        return null;
    } catch (err) {
        return errorText(err);
    }
}

export async function setListed(listed: boolean): Promise<void> {
    try {
        state.server = await window.chat.setListed(listed);
    } catch (err) {
        toast(errorText(err), "error");
    }
}

let searchSeq = 0;

/** Searches the directory by name. Later searches win over slower earlier ones. */
export async function search(query: string): Promise<void> {
    const seq = ++searchSeq;
    state.search.query = query;
    state.search.error = null;
    if (query.trim().length < 2) {
        state.search.results = [];
        state.search.rejected = 0;
        return;
    }
    state.search.busy = true;
    try {
        const { results, rejected } = await window.chat.searchDirectory(query.trim());
        if (seq === searchSeq) {
            state.search.results = results;
            state.search.rejected = rejected;
        }
    } catch (err) {
        if (seq === searchSeq) {
            state.search.error = errorText(err);
        }
    } finally {
        if (seq === searchSeq) {
            state.search.busy = false;
        }
    }
}
