import { Schema, model } from "mongoose";
const meetingSchema = new Schema({
  roomId: { type: String, required: true, unique: true },
  hostUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  title: { type: String, trim: true, maxlength: 120, default: "Bangla accessible meeting" },
  status: { type: String, enum: ["active", "ended"], default: "active", required: true },
  maxParticipants: { type: Number, default: 7, min: 1, max: 7, required: true },
  endedAt: { type: Date, default: null },
}, { timestamps: true });
meetingSchema.index({ hostUserId: 1, createdAt: -1 });
export const Meeting = model("Meeting", meetingSchema);
export function publicMeeting(meeting: { roomId: string; hostUserId: { toString(): string }; title?: string; status: string; maxParticipants: number; createdAt: Date; endedAt?: Date | null }) {
  return { roomId: meeting.roomId, hostUserId: meeting.hostUserId.toString(), title: meeting.title ?? "", status: meeting.status, maxParticipants: meeting.maxParticipants, createdAt: meeting.createdAt.toISOString(), endedAt: meeting.endedAt?.toISOString() ?? null };
}
