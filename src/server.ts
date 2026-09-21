import "dotenv/config";
import http from "node:http";
import mongoose from "mongoose";
import MongoStore from "connect-mongo";
import { createApp } from "./App.js";
import { readConfig } from "./app/config/env.js";
import connectDB from "./app/config/database.js";
import { User } from "./app/modules/user/user.model.js";
import { Meeting } from "./app/modules/meeting/meeting.model.js";
async function main() {
  const config = readConfig();
  await connectDB(config.mongoUri);
  await Promise.all([User.init(), Meeting.init()]);
  const store = MongoStore.create({ mongoUrl: config.mongoUri, collectionName: "sessions", ttl: 7 * 24 * 60 * 60, mongoOptions: { serverSelectionTimeoutMS: 5000, maxPoolSize: 5 } });
  store.on("error", () => console.error("Session database unavailable."));
  // Do not advertise readiness until the session database is available too.
  await store.collectionP;
  const server = http.createServer(createApp(config, store));
  server.listen(config.port, () => console.info(`API listening on port ${config.port}; Google ${config.google ? "enabled" : "not configured"}; LiveKit ${config.livekit ? "configured" : "not configured"}.`));
  let closing = false;
  const shutdown = () => {
    if (closing) return; closing = true;
    const timeout = setTimeout(() => process.exit(1), 10_000); timeout.unref();
    server.close(() => { void Promise.all([store.close(), mongoose.disconnect()]).then(() => process.exit(0)); });
  };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
  server.on("error", () => { console.error("Could not start HTTP server."); shutdown(); });
}
main().catch(async error => {
  // Configuration messages are safe; never print database exception text/URIs.
  console.error(error instanceof Error && error.name === "Error" ? error.message : "Startup failed: check MongoDB credentials, network access, and server configuration.");
  await mongoose.disconnect(); process.exitCode = 1;
});
