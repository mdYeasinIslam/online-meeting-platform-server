/** Isolated browser-test database. Real LiveKit is explicitly opt-in; no real users/meetings are written. */
import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";
import { RoomServiceClient } from "livekit-server-sdk";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import MongoStore from "connect-mongo";
import { createApp } from "../src/App.js";
import { readConfig } from "../src/app/config/env.js";
import { User } from "../src/app/modules/user/user.model.js";
import { Meeting } from "../src/app/modules/meeting/meeting.model.js";
const systemBinary = process.env.MONGOMS_SYSTEM_BINARY || (existsSync("/usr/bin/mongod") ? "/usr/bin/mongod" : undefined);
const database = await MongoMemoryServer.create({ binary: { systemBinary } });
const mongoUri = database.getUri("browser_tests");
await mongoose.connect(mongoUri); await Promise.all([User.init(), Meeting.init()]);
const store = MongoStore.create({ mongoUrl: mongoUri });
const config = readConfig({ NODE_ENV: "test", PORT: "5000", MONGODB_URI: mongoUri, SESSION_SECRET: "browser-tests-only-session-secret-123456", FRONTEND_URL: "http://localhost:3000" });
if (process.env.DAY2_LIVEKIT === "1") {
  const environment = parse(readFileSync(new URL("../.env", import.meta.url)));
  config.livekit = readConfig({ ...environment, ...process.env, MONGODB_URI: mongoUri, SESSION_SECRET: config.sessionSecret, NODE_ENV: "test" }).livekit;
  if (!config.livekit) throw new Error("LiveKit configuration is required for the opt-in media tests.");
}
const server = createApp(config, store).listen(5000, () => console.info("Isolated test API ready."));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  server.close();
  if (config.livekit) {
    const rooms = new RoomServiceClient(config.livekit.url.replace(/^ws/, "http"), config.livekit.apiKey, config.livekit.apiSecret);
    for (const meeting of await Meeting.find()) {
      try { await rooms.deleteRoom(meeting.roomId); }
      catch { console.warn("A temporary browser-test room could not be deleted; it will expire when empty."); }
    }
  }
  await store.close(); await mongoose.disconnect(); await database.stop(); process.exit(0);
}
process.on("SIGINT", () => { void close(); }); process.on("SIGTERM", () => { void close(); });
