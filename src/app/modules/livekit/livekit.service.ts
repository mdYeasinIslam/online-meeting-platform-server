import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import type { AppConfig } from "../../config/env.js";
import type { PublicUser } from "../user/user.model.js";
import { HttpError } from "../../shared/errors.js";
export interface JoinCredentials { token: string; serverUrl: string; roomId: string; }
export interface RoomProvisioner {
  createRoom(options: { name: string; maxParticipants: number; emptyTimeout: number }): Promise<{ maxParticipants: number }>;
}
export function liveKitService(config: AppConfig, provisioner?: RoomProvisioner) {
  return async (meeting: { roomId: string; maxParticipants: number }, user: PublicUser): Promise<JoinCredentials> => {
    if (!config.livekit) throw new HttpError(503, "LiveKit is not configured. Ask the host to configure the server.");
    const { url, apiKey, apiSecret } = config.livekit;
    try {
      const rooms = provisioner ?? new RoomServiceClient(url.replace(/^ws/, "http"), apiKey, apiSecret);
      const room = await rooms.createRoom({ name: meeting.roomId, maxParticipants: meeting.maxParticipants, emptyTimeout: 300 });
      // Capacity is enforced by LiveKit, never a race-prone local headcount.
      if (room.maxParticipants !== meeting.maxParticipants) throw new Error("LiveKit room capacity does not match the persisted meeting.");
      const token = new AccessToken(apiKey, apiSecret, { identity: user.id, name: user.displayName, ttl: "10m" });
      token.addGrant({ roomJoin: true, room: meeting.roomId, canPublish: true, canSubscribe: true, canPublishData: true, roomAdmin: false, roomCreate: false, roomRecord: false });
      return { token: await token.toJwt(), serverUrl: url, roomId: meeting.roomId };
    } catch { throw new HttpError(503, "LiveKit is unavailable. Please retry later."); }
  };
}
