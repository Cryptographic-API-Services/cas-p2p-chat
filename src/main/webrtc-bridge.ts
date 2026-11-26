import { BrowserWindow, ipcMain } from "electron";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import type { ChatNode } from "../core/chat-node";
import { ProtocolError } from "../core/errors";
import { FrameLink, FrameLinkHandlers, MAX_FRAME_BYTES } from "../core/frame-link";
import { peerIdToFingerprint } from "../core/peer-id";

export type SignalingStatus = "off" | "connecting" | "online" | "error";

export interface SignalingConfig {
    serverUrl: string;
    signalingPath: string;
    signalingKey: string;
    iceServers: TransportIceServer[];
    peerId: string;
    token: string;
}

interface BridgeEvents {
    signaling: [status: SignalingStatus, message: string | undefined];
    incoming: [link: WebRtcFrameLink, fingerprint: string];
}

/** Routes events from each transport window to its bridge. */
const bridgesBySender = new Map<number, WebRtcBridge>();
let ipcRegistered = false;

/** A WebRTC data channel, seen from the main process. */
export class WebRtcFrameLink implements FrameLink {
    private handlers: FrameLinkHandlers | null = null;
    private readonly pending: unknown[] = [];
    private closedReason: string | undefined | null = null;

    constructor(private readonly bridge: WebRtcBridge, readonly connId: string, readonly label: string) {}

    start(handlers: FrameLinkHandlers): void {
        this.handlers = handlers;
        for (const data of this.pending.splice(0)) {
            this.deliver(data);
        }
        if (this.closedReason !== null) {
            handlers.closed(this.closedReason);
        }
    }

    send(frame: object): void {
        const data = JSON.stringify(frame);
        if (Buffer.byteLength(data) > MAX_FRAME_BYTES) {
            throw new Error(`frame exceeds the ${MAX_FRAME_BYTES}-byte limit`);
        }
        this.bridge.command({ type: "send", connId: this.connId, data });
    }

    close(): void {
        this.bridge.closeLink(this.connId);
    }

    /** Called by the bridge with whatever the data channel delivered. */
    deliver(data: unknown): void {
        if (!this.handlers) {
            this.pending.push(data);
            return;
        }
        if (typeof data !== "string" || Buffer.byteLength(data) > MAX_FRAME_BYTES) {
            this.handlers.error(new ProtocolError("received a frame that isn't text, or is too large"));
            return;
        }
        let frame: unknown;
        try {
            frame = JSON.parse(data);
        } catch {
            this.handlers.error(new ProtocolError("frame is not valid JSON"));
            return;
        }
        this.handlers.frame(frame);
    }

    remoteClosed(reason: string | undefined): void {
        if (this.handlers) {
            this.handlers.closed(reason);
        } else {
            this.closedReason = reason;
        }
    }
}

/**
 * Runs PeerJS in a hidden, sandboxed window (WebRTC exists only in Chromium) and exposes its data
 * channels as FrameLinks. The window only ever handles frames that are already signed and
 * encrypted here.
 */
export class WebRtcBridge extends EventEmitter<BridgeEvents> {
    status: SignalingStatus = "off";
    private window: BrowserWindow | null = null;
    private loaded: Promise<void> | null = null;
    private readonly links = new Map<string, WebRtcFrameLink>();
    private readonly dials = new Map<string, { resolve: (link: WebRtcFrameLink) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
    private nextId = 1;

    async start(config: SignalingConfig): Promise<void> {
        const url = new URL(config.serverUrl);
        const secure = url.protocol === "https:";
        await this.ensureWindow();
        this.setStatus("connecting", undefined);
        this.command({
            type: "start",
            host: url.hostname,
            port: url.port ? Number(url.port) : secure ? 443 : 80,
            secure,
            path: config.signalingPath,
            key: config.signalingKey,
            peerId: config.peerId,
            token: config.token,
            iceServers: config.iceServers,
        });
    }

    stop(): void {
        this.command({ type: "stop" });
        this.setStatus("off", undefined);
    }

    /** Opens a data channel to `peerId` through signaling. Resolves once it's open. */
    dial(peerId: string, timeoutMs = 20_000): Promise<WebRtcFrameLink> {
        if (this.status !== "online") {
            return Promise.reject(new Error("not connected to a server"));
        }
        const connId = `out-${this.nextId++}`;
        const link = new WebRtcFrameLink(this, connId, `peer ${peerIdToFingerprint(peerId) ?? peerId}`);
        this.links.set(connId, link);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.dials.delete(connId);
                this.closeLink(connId);
                reject(new Error("no answer: the peer may be offline or unreachable (a TURN relay may be needed)"));
            }, timeoutMs);
            this.dials.set(connId, { resolve, reject, timer });
            this.command({ type: "dial", connId, peerId });
        });
    }

    command(command: TransportCommand): void {
        if (this.window && !this.window.isDestroyed()) {
            this.window.webContents.send("transport:command", command);
        }
    }

    closeLink(connId: string): void {
        if (this.links.delete(connId)) {
            this.command({ type: "close", connId });
        }
    }

    destroy(): void {
        this.window?.destroy();
        this.window = null;
        this.loaded = null;
    }

    handle(event: TransportEvent): void {
        switch (event.type) {
            case "signaling":
                this.setStatus(event.status, event.message);
                break;
            case "incoming": {
                const fingerprint = typeof event.peerId === "string" ? peerIdToFingerprint(event.peerId) : null;
                if (!fingerprint) {
                    this.command({ type: "close", connId: event.connId });
                    return;
                }
                const link = new WebRtcFrameLink(this, event.connId, `peer ${fingerprint}`);
                this.links.set(event.connId, link);
                this.emit("incoming", link, fingerprint);
                break;
            }
            case "open": {
                const dial = this.dials.get(event.connId);
                const link = this.links.get(event.connId);
                if (dial && link) {
                    clearTimeout(dial.timer);
                    this.dials.delete(event.connId);
                    dial.resolve(link);
                }
                break;
            }
            case "data":
                this.links.get(event.connId)?.deliver(event.data);
                break;
            case "closed": {
                const dial = this.dials.get(event.connId);
                if (dial) {
                    clearTimeout(dial.timer);
                    this.dials.delete(event.connId);
                    dial.reject(new Error(event.reason ?? "could not connect"));
                }
                const link = this.links.get(event.connId);
                this.links.delete(event.connId);
                link?.remoteClosed(event.reason);
                break;
            }
        }
    }

    private setStatus(status: SignalingStatus, message: string | undefined): void {
        this.status = status;
        this.emit("signaling", status, message);
    }

    private async ensureWindow(): Promise<void> {
        if (!ipcRegistered) {
            ipcRegistered = true;
            ipcMain.on("transport:event", (event, payload: TransportEvent) => {
                bridgesBySender.get(event.sender.id)?.handle(payload);
            });
        }
        if (!this.loaded) {
            const window = new BrowserWindow({
                show: false,
                webPreferences: {
                    preload: path.join(__dirname, "transport-preload.js"),
                    contextIsolation: true,
                    sandbox: true,
                    nodeIntegration: false,
                    // Keep PeerJS heartbeats running although the window is never shown.
                    backgroundThrottling: false,
                },
            });
            window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
            window.webContents.on("will-navigate", (event) => event.preventDefault());
            const senderId = window.webContents.id;
            bridgesBySender.set(senderId, this);
            window.on("closed", () => bridgesBySender.delete(senderId));
            this.window = window;
            this.loaded = window.loadFile(path.join(__dirname, "..", "renderer", "transport.html"));
        }
        await this.loaded;
    }
}

/** Hands inbound WebRTC connections to a ChatNode, which only accepts the identity the ID names. */
export function acceptIncoming(bridge: WebRtcBridge, node: ChatNode): void {
    bridge.on("incoming", (link, fingerprint) => {
        node.adopt(link, "inbound", { expectedFingerprint: fingerprint }).catch(() => undefined);
    });
}
