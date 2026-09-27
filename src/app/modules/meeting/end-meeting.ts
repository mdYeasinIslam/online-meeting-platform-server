import { HttpError } from "../../shared/errors.js";
import { Meeting, effectiveStatus, publicMeeting } from "./meeting.model.js";
import { acquireOperation, activeFilter, loadMeeting, releaseOperation } from "./meeting.lifecycle.js";
export function endMeetingService(deleteRoom: (roomId: string) => Promise<void>) {
  return async (roomId: string, authenticatedUserId: string) => {
    let meeting = await loadMeeting(roomId);
    if (meeting.hostUserId.toString() !== authenticatedUserId) throw new HttpError(403, "Only the meeting host can end this meeting.", "HOST_REQUIRED");
    if (effectiveStatus(meeting) === "ended") return { meeting: publicMeeting(meeting) };
    await Meeting.updateOne({ roomId, hostUserId: authenticatedUserId, ...activeFilter }, { $set: { status: "ending" } });
    const owner = await acquireOperation(roomId, "ending");
    if (!owner) return { meeting: publicMeeting(await loadMeeting(roomId)) };
    try {
      // Tokens/provisioning cannot own this same persisted lease while DeleteRoom runs.
      meeting = await loadMeeting(roomId);
      if (meeting.hostUserId.toString() !== authenticatedUserId || meeting.status !== "ending" || meeting.operationLease?.owner !== owner || meeting.operationLease.expiresAt <= new Date()) throw new HttpError(503, "Meeting shutdown needs a retry.", "MEETING_END_RETRY");
      await deleteRoom(roomId);
      const ended = await Meeting.findOneAndUpdate({ roomId, hostUserId: authenticatedUserId, status: "ending", "operationLease.owner": owner, "operationLease.expiresAt": { $gt: new Date() } }, { $set: { status: "ended", endedAt: new Date(), endedBy: authenticatedUserId } }, { returnDocument: "after" }).lean();
      if (!ended) throw new HttpError(503, "Room shutdown needs confirmation. New joins remain blocked. Please retry.", "MEETING_END_RETRY");
      return { meeting: publicMeeting(ended) };
    } finally { await releaseOperation(roomId, owner); }
  };
}
