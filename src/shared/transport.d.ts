// Messages between the main process and the hidden WebRTC transport window
// (src/renderer/transport.ts). WebRTC only exists in Chromium, not in Node, so that window runs
// PeerJS and carries opaque strings. They're protocol frames that are already signed and
// encrypted in the main process, so the window never sees keys or plaintext.

interface TransportIceServer {
    urls: string | string[];
    username?: string;
    credential?: string;
}

type TransportCommand =
    | {
          type: "start";
          host: string;
          port: number;
          secure: boolean;
          path: string;
          key: string;
          peerId: string;
          token: string;
          iceServers: TransportIceServer[];
      }
    | { type: "stop" }
    | { type: "dial"; connId: string; peerId: string }
    | { type: "send"; connId: string; data: string }
    | { type: "close"; connId: string };

type TransportEvent =
    /** online: registered with signaling. connecting: lost it, retrying. error: gave up; restart with a fresh token. */
    | { type: "signaling"; status: "online" | "connecting" | "error"; message?: string }
    | { type: "incoming"; connId: string; peerId: string }
    | { type: "open"; connId: string }
    | { type: "data"; connId: string; data: unknown }
    | { type: "closed"; connId: string; reason?: string };

interface TransportApi {
    onCommand(listener: (command: TransportCommand) => void): void;
    emit(event: TransportEvent): void;
}

interface Window {
    transport: TransportApi;
}
