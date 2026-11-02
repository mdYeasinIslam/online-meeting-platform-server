import { RoomServiceClient, ServerError } from "livekit-server-sdk";
import type { AppConfig } from "../../config/env.js";
import { HttpError } from "../../shared/errors.js";
export interface RoomTerminator { deleteRoom(room: string): Promise<void>; }
export function roomTermination(config: AppConfig, external?: RoomTerminator) {
  return async (roomId: string) => {
    if (!config.livekit) throw new HttpError(503, "Room shutdown is unavailable. New joins are blocked. Ask the host to configure LiveKit, then retry.", "MEETING_END_RETRY");
    const { url, apiKey, apiSecret } = config.livekit;
    const rooms = external ?? new RoomServiceClient(url.replace(/^ws/, "http"), apiKey, apiSecret, { requestTimeout: 8, failover: false });
    try { await rooms.deleteRoom(roomId); }
    catch (error) {
      if (error instanceof ServerError && error.code === "not_found" && error.status === 404) return;
      console.warn("Meeting room shutdown failed; retry required."); // No secrets, SDK bodies or stacks.
      throw new HttpError(503, "Could not complete room shutdown. New joins are blocked, but participants may still be connected. Retry ending the meeting.", "MEETING_END_RETRY");
    }
  };
}
