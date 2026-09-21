import { randomBytes } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { User, publicUser } from "../user/user.model.js";
import { HttpError } from "../../shared/errors.js";
export const requireAuth: RequestHandler = async (request, _response, next) => {
  if (!request.session.userId) throw new HttpError(401, "Sign in to continue.");
  const user = await User.findById(request.session.userId);
  if (!user) throw new HttpError(401, "Your session is no longer valid. Please sign in.");
  request.authUser = publicUser(user); next();
};
export async function establishSession(request: Request, userId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => request.session.regenerate(error => error ? reject(error) : resolve()));
  request.session.userId = userId;
  request.session.csrfToken = randomBytes(32).toString("hex");
  await new Promise<void>((resolve, reject) => request.session.save(error => error ? reject(error) : resolve()));
}
export async function saveSession(request: Request): Promise<void> {
  await new Promise<void>((resolve, reject) => request.session.save(error => error ? reject(error) : resolve()));
}
