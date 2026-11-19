import { EventEmitter } from "node:events";

// The REST status endpoints remain authoritative; SSE clients always reload on reconnect.
export const joinRequestEventsCopy = new EventEmitter();
joinRequestEventsCopy.setMaxListeners(0);
export function publishJoinRequestCopy(roomId: string, payload: unknown) {
  joinRequestEventsCopy.emit(`meeting:${roomId}`, payload);
}
