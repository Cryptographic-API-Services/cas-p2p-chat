import { DirectoryClient, DirectorySearch, ServerConfig } from "../core/directory-client";
import type { Identity } from "../core/identity";
import { createSignalingToken } from "../core/signaling-token";
import { SignalingStatus, WebRtcBridge } from "./webrtc-bridge";

export interface ServerState {
    url: string | null;
    /** Whether this device is (or should be) findable by name. */
    listed: boolean;
    signaling: SignalingStatus;
    directory: "off" | "listed" | "unlisted" | "error";
    error?: string;
}

/** Tokens are valid for 24 h on the server; renew well before that. */
const TOKEN_RENEW_MS = 12 * 60 * 60_000;

/**
 * Keeps this device connected to one chat server: signaling (so peers can reach it by
 * fingerprint) and, if `listed`, a signed name listing in its directory.
 */
export class ServerSync {
    private client: DirectoryClient | null = null;
    private config: ServerConfig | null = null;
    private token: { peerId: string; token: string; created: number } | null = null;
    private state: ServerState = { url: null, listed: true, signaling: "off", directory: "off" };
    private retryTimer: NodeJS.Timeout | undefined;
    private retryDelay = 2_000;
    private refreshTimer: NodeJS.Timeout | undefined;

    constructor(
        private readonly identity: Identity,
        private readonly name: () => string,
        private readonly bridge: WebRtcBridge,
        private readonly onChange: (state: ServerState) => void,
        private readonly refreshMs = 30 * 60_000,
    ) {
        bridge.on("signaling", (status, message) => {
            if (!this.client) {
                return;
            }
            this.update({ signaling: status, error: status === "error" ? message : this.state.error });
            if (status === "online") {
                this.retryDelay = 2_000;
            } else if (status === "error") {
                this.scheduleRestart();
            }
        });
    }

    get current(): ServerState {
        return this.state;
    }

    /** Joins a server (or leaves the current one with null). */
    async setServer(url: string | null, listed: boolean): Promise<ServerState> {
        // Validates the URL before anything changes.
        const next = url ? new DirectoryClient(url, this.identity) : null;
        if (this.client && next && this.client.baseUrl === next.baseUrl) {
            return this.setListed(listed);
        }
        await this.leave();
        if (!next) {
            return this.state;
        }
        this.client = next;
        this.update({ url: next.baseUrl, listed, signaling: "connecting", directory: listed ? "listed" : "unlisted", error: undefined });
        try {
            this.config = await next.config();
            await this.startSignaling();
        } catch (err) {
            this.update({ signaling: "error", error: (err as Error).message });
            this.scheduleRestart();
        }
        await this.refreshListing();
        this.refreshTimer = setInterval(() => void this.refreshListing(), this.refreshMs);
        return this.state;
    }

    /** Lists or unlists this device by name on the current server. */
    async setListed(listed: boolean): Promise<ServerState> {
        if (!this.client) {
            this.update({ listed });
            return this.state;
        }
        if (listed) {
            this.update({ listed });
            await this.refreshListing();
        } else {
            try {
                await this.client.unregister();
                this.update({ listed, directory: "unlisted" });
            } catch (err) {
                this.update({ directory: "error", error: (err as Error).message });
            }
        }
        return this.state;
    }

    async search(query: string): Promise<DirectorySearch> {
        if (!this.client) {
            throw new Error("join a server to search for people");
        }
        return this.client.search(query);
    }

    stop(): void {
        clearTimeout(this.retryTimer);
        clearInterval(this.refreshTimer);
        this.bridge.stop();
    }

    private async refreshListing(): Promise<void> {
        const client = this.client;
        if (!client || !this.state.listed) {
            return;
        }
        try {
            await client.register(this.name());
            if (client === this.client) {
                this.update({ directory: "listed" });
            }
        } catch (err) {
            if (client === this.client) {
                this.update({ directory: "error", error: (err as Error).message });
            }
        }
    }

    private async startSignaling(): Promise<void> {
        if (!this.client || !this.config) {
            return;
        }
        if (!this.token || Date.now() - this.token.created > TOKEN_RENEW_MS) {
            this.token = { ...createSignalingToken(this.identity), created: Date.now() };
        }
        await this.bridge.start({
            serverUrl: this.client.baseUrl,
            signalingPath: this.config.signalingPath,
            signalingKey: this.config.signalingKey,
            iceServers: this.config.iceServers,
            peerId: this.token.peerId,
            token: this.token.token,
        });
    }

    /** After a fatal signaling error, start again with backoff (a fresh token if it's old). */
    private scheduleRestart(): void {
        clearTimeout(this.retryTimer);
        const client = this.client;
        this.retryTimer = setTimeout(async () => {
            if (client !== this.client) {
                return;
            }
            try {
                this.config ??= await client!.config();
                await this.startSignaling();
            } catch (err) {
                this.update({ signaling: "error", error: (err as Error).message });
                this.scheduleRestart();
            }
        }, this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 60_000);
    }

    private async leave(): Promise<void> {
        clearTimeout(this.retryTimer);
        clearInterval(this.refreshTimer);
        const previous = this.client;
        this.client = null;
        this.config = null;
        this.bridge.stop();
        if (previous && this.state.listed) {
            // Ask the old server to unlist us. Best effort: it may be unreachable.
            await previous.unregister().catch(() => undefined);
        }
        this.update({ url: null, signaling: "off", directory: "off", error: undefined });
    }

    private update(patch: Partial<ServerState>): void {
        this.state = { ...this.state, ...patch };
        this.onChange(this.state);
    }
}
