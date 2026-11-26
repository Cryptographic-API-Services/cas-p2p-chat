import type { FrameLink, FrameLinkHandlers } from "../../src/frame-link.ts";

/**
 * One end of an in-memory link. Frames go through JSON and are delivered asynchronously and in
 * order, like a WebRTC data channel, so ChatNode and PeerConnection run exactly as in the app.
 */
export class MemoryLink implements FrameLink {
    other!: MemoryLink;
    private handlers: FrameLinkHandlers | null = null;
    private readonly inbox: string[] = [];
    private closed = false;

    readonly label: string;

    constructor(label: string) {
        this.label = label;
    }

    start(handlers: FrameLinkHandlers): void {
        this.handlers = handlers;
        for (const data of this.inbox.splice(0)) {
            this.receive(data);
        }
    }

    send(frame: object): void {
        if (!this.closed) {
            const data = JSON.stringify(frame);
            setImmediate(() => this.other.receive(data));
        }
    }

    close(): void {
        if (!this.closed) {
            this.closed = true;
            // Queued after any frames already sent (such as a "bye"), like a real channel.
            setImmediate(() => this.other.remoteClosed());
        }
    }

    private receive(data: string): void {
        if (this.closed) {
            return;
        }
        if (!this.handlers) {
            this.inbox.push(data);
            return;
        }
        this.handlers.frame(JSON.parse(data));
    }

    private remoteClosed(): void {
        if (!this.closed) {
            this.closed = true;
            this.handlers?.closed("connection closed");
        }
    }
}

/** Two connected link ends, like the two sides of a data channel. */
export function linkPair(): [MemoryLink, MemoryLink] {
    const a = new MemoryLink("peer A");
    const b = new MemoryLink("peer B");
    a.other = b;
    b.other = a;
    return [a, b];
}
