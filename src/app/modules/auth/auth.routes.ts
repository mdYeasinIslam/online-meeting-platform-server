import { randomBytes } from "node:crypto";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { configureGoogle } from "./google.js";
import type { AppConfig } from "../../config/env.js";
import { HttpError } from "../../shared/errors.js";
import { safeReturnPath } from "../../shared/return-path.js";
import { User, publicUser } from "../user/user.model.js";
import { hashPassword, verifyPassword } from "./password.js";
import { establishSession, requireAuth, saveSession } from "./session.js";
const credentials = z.object({ email: z.string().trim().email().max(254).transform(value => value.toLowerCase()), password: z.string().min(8).max(128) }).strict();
const registration = credentials.extend({ displayName: z.string().trim().min(1).max(80) });
export function authRoutes(config: AppConfig, passport: ReturnType<typeof configureGoogle>) {
  const router = Router();
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many authentication attempts. Try again later." } });
  const csrfLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many requests. Please wait." } });
  router.get("/csrf", csrfLimiter, async (request, response) => {
    request.session.csrfToken ??= randomBytes(32).toString("hex");
    await saveSession(request);
    response.json({ csrfToken: request.session.csrfToken });
  });
  router.get("/providers", (_request, response) => { response.json({ google: Boolean(config.google) }); });
  router.post("/register", limiter, async (request, response) => {
    const input = registration.parse(request.body);
    if (await User.exists({ email: input.email })) throw new HttpError(409, "An account with that email already exists.");
    const user = await User.create({ displayName: input.displayName, email: input.email, passwordHash: await hashPassword(input.password) });
    await establishSession(request, user.id);
    response.status(201).json({ user: publicUser(user) });
  });
  router.post("/login", limiter, async (request, response) => {
    const input = credentials.parse(request.body);
    const user = await User.findOne({ email: input.email }).select("+passwordHash");
    const matches = await verifyPassword(input.password, user?.passwordHash ?? undefined);
    if (!user || !matches) throw new HttpError(401, "Invalid email or password.");
    await establishSession(request, user.id);
    response.json({ user: publicUser(user) });
  });
  router.post("/logout", async (request, response) => {
    await new Promise<void>((resolve, reject) => request.session.destroy(error => error ? reject(error) : resolve()));
    response.clearCookie("lets-talk.sid", { httpOnly: true, secure: config.production, sameSite: config.cookieSameSite, path: "/" });
    response.status(204).end();
  });
  router.get("/me", requireAuth, (request, response) => { response.json({ user: request.authUser }); });
  router.get("/google", limiter, async (request, response, next) => {
    if (!config.google) throw new HttpError(503, "Google login is not configured. Use email and password.");
    request.session.returnTo = safeReturnPath(request.query.next);
    await saveSession(request);
    passport.authenticate("google", { scope: ["profile", "email"], session: false })(request, response, next);
  });
  router.get("/google/callback", (request, response, next) => {
    if (!config.google) { next(new HttpError(503, "Google login is not configured.")); return; }
    const returnTo = safeReturnPath(request.session.returnTo);
    passport.authenticate("google", { session: false }, (error: unknown, user: Express.User | false | null) => {
      void (async () => {
        delete request.session.returnTo;
        if (error || !user) {
          const target = new URL("/auth", config.frontendOrigin);
          target.searchParams.set("next", returnTo);
          target.searchParams.set("error", error instanceof HttpError && error.status === 409 ? "account-exists" : "google-failed");
          await saveSession(request);
          response.redirect(target.toString()); return;
        }
        await establishSession(request, user.id);
        response.redirect(new URL(returnTo, config.frontendOrigin).toString());
      })().catch(next);
    })(request, response, next);
  });
  return router;
}
