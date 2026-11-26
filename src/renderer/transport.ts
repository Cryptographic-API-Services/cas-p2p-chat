// The hidden WebRTC transport window. It runs PeerJS (WebRTC exists only in Chromium, not in the
// main process) and moves opaque strings between data channels and the main process. Those
// strings are protocol frames that the main process has already signed and encrypted, so nothing
// here ever sees a key or a plaintext message.
import Peer, { type DataConnection, type PeerError } from "peerjs";

let peer: Peer | null = null;
let reconnectDelay = 2_000;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let inboundSeq = 1;
const connections = new Map<string, DataConnection>();

const emit = (event: TransportEvent) => window.transport.emit(event);

function closed(connId: string, reason?: string): void {
    if (connections.delete(connId)) {
        emit({ type: "closed", connId, reason });
    }
}

function track(connId: string, conn: DataConnection, inbound: boolean): void {
    connections.set(connId, conn);
    conn.on("open", () => emit(inbound ? { type: "incoming", connId, peerId: conn.peer } : { type: "open", connId }));
    conn.on("data", (data) => emit({ type: "data", connId, data: typeof data === "string" ? data : null }));
    conn.on("close", () => closed(connId, "the data channel closed"));
    conn.on("error", (err) => {
        closed(connId, err.message);
        conn.close();
    });
}

function stop(): void {
    clearTimeout(reconnectTimer);
    const old = peer;
    peer = null;
    old?.destroy();
    for (const connId of [...connections.keys()]) {
        closed(connId, "signaling stopped");
    }
}

function start(command: Extract<TransportCommand, { type: "start" }>): void {
    stop();
    reconnectDelay = 2_000;
    const current = new Peer(command.peerId, {
        host: command.host,
        port: command.port,
        secure: command.secure,
        path: command.path,
        key: command.key,
        token: command.token,
        config: { iceServers: command.iceServers },
        debug: 0,
    });
    peer = current;

    current.on("open", () => {
        reconnectDelay = 2_000;
        emit({ type: "signaling", status: "online" });
    });
    current.on("connection", (conn) => track(`in-${inboundSeq++}`, conn, true));
    current.on("disconnected", () => {
        if (peer !== current || current.destroyed) {
            return;
        }
        // Signaling dropped. Data channels already open keep working; reconnect with the same ID and token.
        emit({ type: "signaling", status: "connecting", message: "lost the connection to the server; retrying" });
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            if (peer === current && current.disconnected && !current.destroyed) {
                current.reconnect();
            }
        }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    });
    current.on("error", (err: PeerError<string>) => {
        if (peer !== current) {
            return;
        }
        if (err.type === "peer-unavailable") {
            // A dial to someone who isn't online: fail the matching pending connection.
            const target = /cas-[0-9a-f]{32}/.exec(err.message)?.[0];
            for (const [connId, conn] of connections) {
                if (conn.peer === target && !conn.open) {
                    closed(connId, "that peer isn't online right now");
                }
            }
            return;
        }
        if (current.destroyed) {
            // Fatal (ID taken, server refused the token, ...): the main process restarts with a fresh token.
            emit({ type: "signaling", status: "error", message: err.message });
        }
    });
}

window.transport.onCommand((command) => {
    switch (command.type) {
        case "start":
            start(command);
            break;
        case "stop":
            stop();
            break;
        case "dial": {
            if (!peer || !peer.open) {
                emit({ type: "closed", connId: command.connId, reason: "not connected to the server" });
                return;
            }
            track(command.connId, peer.connect(command.peerId, { reliable: true, serialization: "raw" }), false);
            break;
        }
        case "send":
            connections.get(command.connId)?.send(command.data);
            break;
        case "close": {
            const conn = connections.get(command.connId);
            if (conn) {
                connections.delete(command.connId);
                conn.close({ flush: true });
            }
            break;
        }
    }
});
