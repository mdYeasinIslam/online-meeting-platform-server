import { AccessToken, RoomConfiguration, RoomServiceClient } from "livekit-server-sdk";
import type { AppConfig } from "../../config/env.js";
import type { PublicUser } from "../user/user.model.js";
import { HttpError } from "../../shared/errors.js";
export interface JoinCredentials { token: string; serverUrl: string; roomId: string; }
export interface RoomProvisioner {
  createRoom(options: { name: string; maxParticipants: number; emptyTimeout: number }): Promise<{ maxParticipants: number }>;
  listParticipants(room: string): Promise<{ identity: string }[]>;
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
      // Give an authoritative full-room response before issuing a token. Keep the
      // LiveKit limit as the admission guard for simultaneous join requests.
      const participants = await rooms.listParticipants(meeting.roomId);
      if (participants.length >= meeting.maxParticipants && !participants.some(participant => participant.identity === user.id)) {
        throw new HttpError(409, "This meeting is full (7 participants). Try again after someone leaves.");
      }
      const token = new AccessToken(apiKey, apiSecret, { identity: user.id, name: user.displayName, ttl: "10m" });
      // Carry the same limit through join-time room creation/configuration as provisioning.
      token.roomConfig = new RoomConfiguration({ maxParticipants: meeting.maxParticipants, emptyTimeout: 300 });
      token.addGrant({ roomJoin: true, room: meeting.roomId, canPublish: true, canSubscribe: true, canPublishData: true, roomAdmin: false, roomCreate: false, roomRecord: false });
      return { token: await token.toJwt(), serverUrl: url, roomId: meeting.roomId };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "LiveKit is unavailable. Please retry later.");
    }
  };
}
