import express from "express";
import cors from "cors";
import helmet from "helmet";
import session, { type Store } from "express-session";
import type { AppConfig } from "./app/config/env.js";
import { csrfProtection } from "./app/middleware/csrf.js";
import { authRoutes } from "./app/modules/auth/auth.routes.js";
import { configureGoogle } from "./app/modules/auth/google.js";
import { meetingRoutes } from "./app/modules/meeting/meeting.routes.js";
import type { RoomProvisioner } from "./app/modules/livekit/livekit.service.js";
import { errorHandler, HttpError } from "./app/shared/errors.js";
export function createApp(config: AppConfig, store: Store, provisioner?: RoomProvisioner) {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxyHops) app.set("trust proxy", config.trustProxyHops);
  app.use(helmet());
  app.use(cors({ origin(origin, callback) {
    if (!origin || origin === config.frontendOrigin) callback(null, true);
    else callback(new HttpError(403, "Request origin is not allowed."));
  }, credentials: true, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "X-CSRF-Token"] }));
  app.use(express.json({ limit: "16kb" }));
  app.get("/health", (_request, response) => { response.json({ status: "ok" }); });
  app.use("/api", (_request, response, next) => { response.set("Cache-Control", "no-store"); next(); });
  app.use(session({ name: "lets-talk.sid", secret: config.sessionSecret, store, resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, secure: config.production, sameSite: config.cookieSameSite, maxAge: 7 * 24 * 60 * 60 * 1000, path: "/" },
  }));
  const passport = configureGoogle(config);
  app.use(passport.initialize());
  app.use("/api", csrfProtection(config.frontendOrigin));
  app.use("/api/auth", authRoutes(config, passport));
  app.use("/api/meetings", meetingRoutes(config, provisioner));
  app.use((_request, _response, next) => next(new HttpError(404, "Endpoint not found.")));
  app.use(errorHandler);
  return app;
}
