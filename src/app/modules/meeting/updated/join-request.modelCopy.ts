import { Schema, model } from "mongoose";

const schema = new Schema({
  meetingId: { type: String, required: true, index: true },
  participantIdentity: { type: String, required: true },
  displayName: { type: String, required: true, maxlength: 50 },
  userId: { type: String, default: null },
  participantType: { type: String, enum: ["authenticated", "guest"], required: true },
  secretHash: { type: String, default: null, select: false },
  status: { type: String, enum: ["pending", "accepted", "rejected", "cancelled", "expired"], default: "pending", required: true },
  expiresAt: { type: Date, required: true },
  respondedAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ meetingId: 1, userId: 1, status: 1 });
schema.index({ meetingId: 1, userId: 1 }, { unique: true, partialFilterExpression: { participantType: "authenticated", status: "pending" } });
schema.index({ meetingId: 1, secretHash: 1 }, { unique: true, partialFilterExpression: { participantType: "guest", status: "pending" } });
export const JoinRequestCopy = model("MeetingJoinRequest", schema);
