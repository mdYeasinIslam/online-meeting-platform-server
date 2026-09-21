/** Isolated browser-test fixture. Never reads the real server .env. */
import { existsSync } from "node:fs";
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
const server = createApp(config, store).listen(5000, () => console.info("Isolated test API ready."));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  server.close(); await store.close(); await mongoose.disconnect(); await database.stop(); process.exit(0);
}
process.on("SIGINT", () => { void close(); }); process.on("SIGTERM", () => { void close(); });
