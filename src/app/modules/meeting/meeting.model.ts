import { Schema, model } from "mongoose";
import { HttpError } from "../../shared/errors.js";
const meetingSchema = new Schema({
  roomId: { type: String, required: true, unique: true, immutable: true },
  hostUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  title: { type: String, trim: true, maxlength: 120, default: "Bangla accessible meeting" },
  status: { type: String, enum: ["active", "ending", "ended"], default: "active", required: true },
  maxParticipants: { type: Number, default: 7, min: 1, max: 7, required: true },
  endedAt: { type: Date, default: null },
  endedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  operationLease: { type: new Schema({ owner: { type: String, required: true }, expiresAt: { type: Date, required: true } }, { _id: false }), default: null, select: true },
}, { timestamps: true });
meetingSchema.index({ hostUserId: 1, createdAt: -1 });
export const Meeting = model("Meeting", meetingSchema);
export function effectiveStatus(meeting: { status?: string | null; endedAt?: Date | null; endedBy?: unknown }): "active" | "ending" | "ended" {
  if (meeting.status === "ending" || meeting.status === "ended") return meeting.status;
  if ((meeting.status === undefined || meeting.status === "active") && !meeting.endedAt && !meeting.endedBy) return "active";
  throw new HttpError(503, "Meeting state is unavailable. Please contact the host.", "MEETING_STATE_INVALID");
}
export function publicMeeting(meeting: { roomId: string; hostUserId: { toString(): string }; title?: string; status?: string | null; maxParticipants: number; createdAt: Date; endedAt?: Date | null; endedBy?: { toString(): string } | null }) {
  return { roomId: meeting.roomId, hostUserId: meeting.hostUserId.toString(), title: meeting.title ?? "", status: effectiveStatus(meeting), maxParticipants: meeting.maxParticipants, createdAt: meeting.createdAt.toISOString(), endedAt: meeting.endedAt?.toISOString() ?? null, endedBy: meeting.endedBy?.toString() ?? null };
}
