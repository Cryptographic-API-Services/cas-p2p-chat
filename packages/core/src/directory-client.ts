import { createDeletion, createRegistration, verifyRegistration } from "./directory-record.ts";
import type { Identity } from "./identity.ts";
import { fingerprint } from "./identity.ts";

/** A directory search result whose record verified. Only `online` and `lastSeen` are the server's word. */
export interface DirectoryEntry {
    fingerprint: string;
    name: string;
    online: boolean;
    lastSeen: number;
}

export interface DirectorySearch {
    results: DirectoryEntry[];
    /** Records dropped because they failed verification: a sign of a broken or malicious server. */
    rejected: number;
}

/** What the server tells clients about connecting to it. */
export interface ServerConfig {
    iceServers: RTCIceServerLike[];
    signalingPath: string;
    signalingKey: string;
}

/** The subset of RTCIceServer the server hands out (no DOM types in the main process). */
export interface RTCIceServerLike {
    urls: string | string[];
    username?: string;
    credential?: string;
}

/** Accepts only http(s) URLs without credentials, a query or a fragment; drops any trailing slash. */
export function normalizeServerUrl(url: string): string {
    let parsed: URL;
    try {
        parsed = new URL(url.trim());
    } catch {
        throw new Error("enter a URL such as https://chat.example.com");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("the server URL must start with http:// or https://");
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error("the server URL must not contain credentials, a query or a fragment");
    }
    return parsed.href.replace(/\/+$/, "");
}

function validIceServers(value: unknown): RTCIceServerLike[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((server): server is RTCIceServerLike => {
        const urls = (server as RTCIceServerLike | null)?.urls;
        const list = Array.isArray(urls) ? urls : [urls];
        return list.length > 0 && list.every((u) => typeof u === "string" && /^(stun|stuns|turn|turns):/.test(u));
    });
}

/**
 * Talks to the server's directory API (apps/server). Treats the server as untrusted: every
 * record it returns is verified against the peer's own signature, and fingerprints are
 * recomputed here.
 */
export class DirectoryClient {
    readonly baseUrl: string;
    private readonly ownFingerprint: string;
    private readonly identity: Identity;
    private readonly timeoutMs: number;

    constructor(baseUrl: string, identity: Identity, timeoutMs = 8_000) {
        this.identity = identity;
        this.timeoutMs = timeoutMs;
        this.baseUrl = normalizeServerUrl(baseUrl);
        this.ownFingerprint = fingerprint(identity.publicKey);
    }

    async config(): Promise<ServerConfig> {
        const body = (await this.request("GET", "/v1/config")) as Partial<ServerConfig> | null;
        return {
            iceServers: validIceServers(body?.iceServers),
            signalingPath: typeof body?.signalingPath === "string" ? body.signalingPath : "/signal",
            signalingKey: typeof body?.signalingKey === "string" ? body.signalingKey : "cas-p2p-chat",
        };
    }

    /** Lists this device under its name, or refreshes the listing. */
    async register(name: string): Promise<void> {
        await this.request("POST", "/v1/peers", createRegistration(this.identity, name));
    }

    /** Removes this device's listing. */
    async unregister(): Promise<void> {
        await this.request("DELETE", "/v1/peers", createDeletion(this.identity), [404]);
    }

    /** Finds other listed peers whose name contains `query`. */
    async search(query: string): Promise<DirectorySearch> {
        const body = (await this.request("GET", `/v1/peers?q=${encodeURIComponent(query)}`)) as { peers?: unknown };
        const results: DirectoryEntry[] = [];
        let rejected = 0;
        for (const item of Array.isArray(body?.peers) ? body.peers : []) {
            const entry = item as { record?: unknown; online?: unknown; lastSeen?: unknown };
            let verified;
            try {
                verified = verifyRegistration(entry.record);
            } catch {
                rejected++;
                continue;
            }
            if (verified.fingerprint === this.ownFingerprint) {
                continue;
            }
            results.push({
                fingerprint: verified.fingerprint,
                name: verified.record.name,
                online: entry.online === true,
                lastSeen: typeof entry.lastSeen === "number" ? entry.lastSeen : verified.record.timestamp,
            });
        }
        return { results, rejected };
    }

    private async request(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<unknown> {
        let response: Response;
        try {
            response = await fetch(this.baseUrl + path, {
                method,
                headers: body === undefined ? undefined : { "Content-Type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(this.timeoutMs),
                redirect: "error",
            });
        } catch (err) {
            const cause = (err as { cause?: { code?: string } }).cause?.code;
            throw new Error(`could not reach the server at ${this.baseUrl}${cause ? ` (${cause})` : ""}`);
        }
        if (!response.ok && !okStatuses.includes(response.status)) {
            const detail = await response.json().then((json: unknown) => (json as { error?: unknown } | null)?.error, () => undefined);
            throw new Error(`server refused the request (${response.status}${typeof detail === "string" ? `: ${detail}` : ""})`);
        }
        return response.status === 204 || !response.ok ? null : response.json();
    }
}
