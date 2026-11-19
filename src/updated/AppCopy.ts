import express from "express";
import cors from "cors";
import helmet from "helmet";
import session, { type Store } from "express-session";
import type { AppConfig } from "../app/config/env.js";
import { csrfProtection } from "../app/middleware/csrf.js";
import { authRoutes } from "../app/modules/auth/auth.routes.js";
import { configureGoogle } from "../app/modules/auth/google.js";
import { meetingRoutesCopy } from "../app/modules/meeting/updated/meeting.routesCopy.js";
import type { RoomProvisioner } from "../app/modules/livekit/livekit.service.js";
import type { RoomTerminator } from "../app/modules/livekit/room-termination.js";
import { errorHandler, HttpError } from "../app/shared/errors.js";

export function createAppCopy(
  config: AppConfig,
  store: Store,
  provisioner?: RoomProvisioner,
  terminator?: RoomTerminator,
) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(
    cors({
      origin: [
        config.frontendOrigin,
        "http://localhost:3000",
        "http://192.168.10.186:3000",
      ],
      credentials: true,
    }),
  );
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(
    session({
      name: "lets-talk.sid",
      secret: config.sessionSecret,
      store,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: config.production,
        sameSite: config.cookieSameSite,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    }),
  );
  const passport = configureGoogle(config);
  app.use(passport.initialize());
  app.use("/api", csrfProtection(config.frontendOrigin));
  app.use("/api/auth", authRoutes(config, passport));
  app.use("/api/meetings", meetingRoutesCopy(config, provisioner, terminator));
  app.use((_req, _res, next) =>
    next(new HttpError(404, "Endpoint not found.")),
  );
  app.use(errorHandler);
  return app;
}
