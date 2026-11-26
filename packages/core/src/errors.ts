/**
 * Thrown when a peer sends something that breaks the protocol: a malformed frame, a bad
 * signature, a replayed message, a ciphertext that fails to decrypt. The connection that
 * raised it is closed, and its message is shown to the user as the reason.
 */
export class ProtocolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ProtocolError";
    }
}
