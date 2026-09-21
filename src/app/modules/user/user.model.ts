import { Schema, model } from "mongoose";
const userSchema = new Schema({
  displayName: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, trim: true, lowercase: true, unique: true, maxlength: 254 },
  passwordHash: { type: String, select: false },
  googleId: { type: String, unique: true, sparse: true, select: false },
}, { timestamps: true });
export const User = model("User", userSchema);
export interface PublicUser { id: string; displayName: string; email: string; }
export function publicUser(user: { _id: { toString(): string }; displayName: string; email: string }): PublicUser {
  return { id: user._id.toString(), displayName: user.displayName, email: user.email };
}
