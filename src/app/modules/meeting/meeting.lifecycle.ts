import { Types } from "mongoose";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Meeting, effectiveStatus } from "./meeting.model.js";
import { HttpError } from "../../shared/errors.js";
import { ROOM_ID_PATTERN } from "../../shared/return-path.js";

// Cross-process coordination; no TTL index (meeting tombstones must never expire).
export const OPERATION_LEASE_MS = 120_000;
const WAIT_MS = 2000;
export const activeFilter = { endedAt: null, endedBy: null, $or: [{ status: "active" as const }, { status: { $exists: false } }] };
export function validateRoomId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !ROOM_ID_PATTERN.test(value)) throw new HttpError(400, "Invalid meeting ID.");
}
export async function loadMeeting(roomId: string) {
  const meeting = await Meeting.findOne({ roomId }).lean();
  if (!meeting) throw new HttpError(404, "Meeting not found.");
  if (!(meeting.hostUserId instanceof Types.ObjectId) || !Number.isInteger(meeting.maxParticipants) || meeting.maxParticipants < 1 || meeting.maxParticipants > 7 || !(meeting.createdAt instanceof Date)) {
    throw new HttpError(503, "Meeting state is unavailable. Please contact the host.", "MEETING_STATE_INVALID");
  }
  effectiveStatus(meeting); // Reject malformed lifecycle records, rather than guessing active.
  return meeting;
}
export function nonJoinable(status: "ending" | "ended", canEnd = false) {
  return new HttpError(410, status === "ending" ? "This meeting is ending and cannot be joined." : "This meeting has ended.", status === "ending" ? "MEETING_ENDING" : "MEETING_ENDED", { canEnd });
}
export async function requireActive(roomId: string, userId?: string) {
  const meeting = await loadMeeting(roomId), status = effectiveStatus(meeting);
  if (status !== "active") throw nonJoinable(status, status === "ending" && meeting.hostUserId.toString() === userId);
  return meeting;
}
export async function acquireOperation(roomId: string, status: "active" | "ending") {
  const owner = randomUUID(), deadline = Date.now() + WAIT_MS;
  do {
    const meeting = await Meeting.findOneAndUpdate({ roomId, $and: [
      status === "active" ? activeFilter : { status: "ending" },
      { $or: [{ operationLease: null }, { "operationLease.expiresAt": { $lte: new Date() } }] },
    ] }, { $set: { operationLease: { owner, expiresAt: new Date(Date.now() + OPERATION_LEASE_MS) } } }, { returnDocument: "after" }).lean();
    if (meeting) return owner;
    const current = await loadMeeting(roomId), currentStatus = effectiveStatus(current);
    if (status === "active" && currentStatus !== "active") throw nonJoinable(currentStatus);
    if (status === "ending" && currentStatus === "ended") return null;
    if (Date.now() < deadline) await delay(50);
  } while (Date.now() < deadline);
  throw new HttpError(503, status === "ending" ? "Meeting shutdown is pending. New joins are blocked. Please retry ending the meeting." : "Meeting is busy. Please try joining again.", "MEETING_BUSY");
}
export async function releaseOperation(roomId: string, owner: string) {
  await Meeting.updateOne({ roomId, "operationLease.owner": owner }, { $unset: { operationLease: "" } });
}
export async function assertTokenAllowed(roomId: string, owner: string, userId: string) {
  const meeting = await requireActive(roomId, userId);
  if (meeting.operationLease?.owner !== owner || meeting.operationLease.expiresAt <= new Date()) throw new HttpError(503, "Meeting operation expired. Please try again.", "MEETING_BUSY");
  return meeting;
}
export async function createMeetingRecord(hostUserId: string, title: string, nextId: () => string = randomUUID) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await Meeting.create({ roomId: nextId(), hostUserId, title, status: "active" }); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === 11000 && "keyPattern" in error && error.keyPattern && typeof error.keyPattern === "object" && "roomId" in error.keyPattern)) throw error;
    }
  }
  throw new HttpError(503, "Could not create a unique meeting. Please try again.");
}
