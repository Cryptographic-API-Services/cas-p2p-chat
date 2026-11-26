/** Chat text is capped well below this, so a larger frame means a broken or hostile peer. */
export const MAX_FRAME_BYTES = 256 * 1024;

export interface FrameLinkHandlers {
    frame(frame: unknown): void;
    /** The link received something it can't decode (a ProtocolError); the connection should close. */
    error(err: Error): void;
    /** The link has closed. May be called more than once; only the first matters. */
    closed(reason?: string): void;
}

/**
 * Carries protocol frames (JSON objects) between two peers. The app's only transport is a WebRTC
 * data channel (src/main/webrtc-bridge.ts); tests use an in-memory pair. PeerConnection runs
 * the same authenticated handshake and sealed messages over any link, so the transport never
 * needs to be trusted: a link only moves frames that are already signed and encrypted.
 */
export interface FrameLink {
    /** Names the other end in error messages (never an IP address). */
    readonly label: string;
    start(handlers: FrameLinkHandlers): void;
    send(frame: object): void;
    close(): void;
}
