// The contract between the UI and the main process, exposed as `window.chat` by the preload
// script. Ambient (global) declarations, shared by the main process and the Vue UI.
// Keys never cross this boundary: the UI only sees names, fingerprints and text.

type ApiTrustLevel = "new" | "known" | "verified";

interface ApiTrust {
    level: ApiTrustLevel;
    nameConflict: boolean;
}

/** A live connection (always WebRTC, set up through the server). */
interface ApiPeer {
    id: string;
    name: string;
    fingerprint: string;
    direction: "inbound" | "outbound";
    trust: ApiTrust;
}

/** Someone this device has connected to before (kept only on this device). */
interface ApiContact {
    fingerprint: string;
    name: string;
    firstSeen: string;
    lastSeen: string;
    /** When the last saved message with them was sent or received, if any. */
    lastMessageAt: number | null;
    trust: ApiTrust;
}

interface ApiSelf {
    name: string;
    fingerprint: string;
    /** "os": the identity key and the local database's key are encrypted with the OS keychain (Electron safeStorage). */
    keyProtection: "os" | "none";
    /** Set if the local database couldn't be opened: this run keeps nothing. */
    storageError: string | null;
}

interface ApiMessage {
    text: string;
    at: number;
    /** Its ID in the saved history, or null if it couldn't be saved. */
    id: number | null;
}

interface ApiSavedMessage {
    id: number;
    direction: "in" | "out";
    text: string;
    at: number;
}

interface ApiHistory {
    /** Oldest first: the latest saved messages with a contact. */
    messages: ApiSavedMessage[];
    /** Saved messages that failed to decrypt, left out. */
    unreadable: number;
}

/** The chat server: signaling (reach peers by fingerprint) plus the find-by-name directory. */
interface ApiServer {
    url: string | null;
    listed: boolean;
    signaling: "off" | "connecting" | "online" | "error";
    directory: "off" | "listed" | "unlisted" | "error";
    error?: string;
    /** The public server, offered when no server is joined. */
    defaultUrl: string;
}

/** A directory search result. Its name is verified against the peer's own signature. */
interface ApiDirectoryEntry {
    fingerprint: string;
    name: string;
    online: boolean;
    lastSeen: number;
    trust: ApiTrust;
}

interface ApiSearchResult {
    results: ApiDirectoryEntry[];
    /** Records that failed signature checks and were dropped. */
    rejected: number;
}

type ApiEvent =
    | { type: "peer-connected"; peer: ApiPeer }
    | { type: "peer-disconnected"; peerId: string; reason?: string }
    | { type: "handshake-failed"; reason?: string }
    | { type: "message"; peerId: string; message: ApiMessage }
    | { type: "trust-changed"; fingerprint: string; trust: ApiTrust }
    | { type: "server-changed"; server: ApiServer };

interface ChatApi {
    getSelf(): Promise<ApiSelf>;
    listPeers(): Promise<ApiPeer[]>;
    listContacts(): Promise<ApiContact[]>;
    /** Dials a fingerprint through the server. */
    connect(fingerprint: string): Promise<ApiPeer>;
    sendText(peerId: string, text: string): Promise<ApiMessage>;
    disconnect(peerId: string): Promise<void>;
    /** The saved messages with a contact. */
    loadHistory(fingerprint: string): Promise<ApiHistory>;
    /** Deletes the saved messages with a contact. */
    clearHistory(fingerprint: string): Promise<void>;
    setVerified(fingerprint: string, verified: boolean): Promise<ApiTrust>;
    copyText(text: string): Promise<void>;
    getServer(): Promise<ApiServer>;
    /** Joins the server at `url` (null leaves the current one), listed by name or not. */
    setServer(url: string | null, listed: boolean): Promise<ApiServer>;
    setListed(listed: boolean): Promise<ApiServer>;
    searchDirectory(query: string): Promise<ApiSearchResult>;
    /** Subscribes to events; returns an unsubscribe function. */
    onEvent(listener: (event: ApiEvent) => void): () => void;
}

interface Window {
    chat: ChatApi;
}
