import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import request from "supertest";
import mongoose from "mongoose";
import MongoStore from "connect-mongo";
import { MongoMemoryServer } from "mongodb-memory-server";
import { TokenVerifier } from "livekit-server-sdk";
import { createApp } from "../src/App.js";
import { readConfig } from "../src/app/config/env.js";
import { User } from "../src/app/modules/user/user.model.js";
import { Meeting } from "../src/app/modules/meeting/meeting.model.js";
import { safeReturnPath } from "../src/app/shared/return-path.js";
import { hashPassword, verifyPassword } from "../src/app/modules/auth/password.js";
import { liveKitService } from "../src/app/modules/livekit/livekit.service.js";
const origin = "http://localhost:3000";
let database: MongoMemoryServer;
let store: MongoStore;
let app: ReturnType<typeof createApp>;
let config: ReturnType<typeof readConfig>;
const provisioned: { name: string; maxParticipants: number }[] = [];
before(async () => {
  const systemBinary = process.env.MONGOMS_SYSTEM_BINARY || (existsSync("/usr/bin/mongod") ? "/usr/bin/mongod" : undefined);
  database = await MongoMemoryServer.create({ binary: { systemBinary } });
  const mongoUri = database.getUri("foundation_tests");
  await mongoose.connect(mongoUri);
  await Promise.all([User.init(), Meeting.init()]);
  store = MongoStore.create({ mongoUrl: mongoUri });
  config = readConfig({ NODE_ENV: "test", MONGODB_URI: mongoUri, SESSION_SECRET: "test-session-secret-at-least-32-characters", FRONTEND_URL: origin, LIVEKIT_URL: "wss://livekit.example.test", LIVEKIT_API_KEY: "test-key", LIVEKIT_API_SECRET: "test-livekit-secret-at-least-32-characters" });
  app = createApp(config, store, { async createRoom(options) { provisioned.push(options); return { maxParticipants: options.maxParticipants }; } });
});
after(async () => { await store?.close(); await mongoose.disconnect(); await database?.stop(); });
async function csrf(agent: ReturnType<typeof request.agent>) {
  const response = await agent.get("/api/auth/csrf").expect(200);
  assert.match(response.body.csrfToken, /^[a-f0-9]{64}$/);
  return response.body.csrfToken as string;
}
async function post(agent: ReturnType<typeof request.agent>, path: string, body: object = {}) {
  const token = await csrf(agent);
  return agent.post(path).set("Origin", origin).set("X-CSRF-Token", token).send(body);
}
test("safe return destinations preserve only valid meeting links", () => {
  const path = `/meeting/${randomUUID()}`;
  assert.equal(safeReturnPath(path), path);
  for (const value of ["https://evil.example", "//evil.example", "/\\evil.example", "/meeting/invalid", [path], null]) assert.equal(safeReturnPath(value), "/dashboard");
});
test("password hashing uses salted hashes and rejects incorrect passwords", async () => {
  const first = await hashPassword("correct password"); const second = await hashPassword("correct password");
  assert.notEqual(first, second); assert.equal(first.includes("correct password"), false);
  assert.equal(await verifyPassword("correct password", first), true);
  assert.equal(await verifyPassword("wrong password", first), false);
  assert.equal(await verifyPassword("correct password"), false);
});
test("configuration enforces secrets and keeps optional integrations independent", () => {
  assert.throws(() => readConfig({ MONGODB_URI: "mongodb://localhost/test" }), /SESSION_SECRET/);
  assert.throws(() => readConfig({ MONGODB_URI: "mongodb://localhost/test", SESSION_SECRET: "x".repeat(32), FRONTEND_URL: "https://example.com/path" }), /origin/);
  assert.equal(readConfig({ MONGODB_URI: "mongodb://localhost/test", SESSION_SECRET: "x".repeat(32) }).google, undefined);
});
test("unauthenticated, cross-origin, and CSRF requests fail closed", async () => {
  await request(app).get("/api/meetings").expect(401);
  await request(app).get(`/api/meetings/${randomUUID()}`).expect(401);
  await request(app).post("/api/meetings").set("Origin", origin).send({}).expect(403);
  await request(app).get("/api/auth/me").set("Origin", "https://evil.example").expect(403);
  const agent = request.agent(app);
  assert.equal((await post(agent, "/api/meetings", {})).status, 401);
  const tokenResponse = await agent.get("/api/auth/csrf").expect(200);
  const cookie = tokenResponse.headers["set-cookie"];
  // A new session was saved by the earlier csrf call; inspect a fresh agent's cookie.
  const fresh = await request(app).get("/api/auth/csrf").expect(200);
  assert.match(String(fresh.headers["set-cookie"] ?? cookie), /HttpOnly/);
  assert.match(String(fresh.headers["set-cookie"] ?? cookie), /SameSite=Lax/);
  await agent.get("/api/auth/providers").expect(200, { google: false });
  await agent.get("/api/auth/google").expect(503);
});
test("register/login/create/invite/logout/login flow, ownership and token scoping", async () => {
  const host = request.agent(app);
  const beforeSession = await host.get("/api/auth/csrf");
  const credentials = { email: "Host@Example.com", password: "safe password 123" };
  const registered = await post(host, "/api/auth/register", { ...credentials, displayName: "Host" });
  assert.equal(registered.status, 201);
  assert.notEqual(registered.headers["set-cookie"]?.[0]?.split(";")[0], beforeSession.headers["set-cookie"]?.[0]?.split(";")[0]);
  const hostId = registered.body.user.id;
  assert.deepEqual(Object.keys(registered.body.user).sort(), ["displayName", "email", "id"]);
  assert.equal(registered.body.user.email, "host@example.com");
  const saved = await User.findById(hostId).select("+passwordHash");
  assert.ok(saved?.passwordHash?.startsWith("scrypt-v1:"));
  assert.equal((await post(host, "/api/auth/register", { ...credentials, displayName: "Duplicate" })).status, 409);
  assert.equal((await post(host, "/api/meetings", { title: "a".repeat(121) })).status, 400);
  assert.equal((await post(host, "/api/meetings", { title: "Spoof", hostUserId: randomUUID() })).status, 400);
  const created = await post(host, "/api/meetings", { title: "Thesis demo" });
  assert.equal(created.status, 201);
  const roomId = created.body.meeting.roomId;
  assert.equal(created.body.inviteUrl, `${origin}/meeting/${roomId}`);
  assert.equal(created.body.meeting.hostUserId, hostId);
  assert.equal(created.body.meeting.maxParticipants, 7);
  const list = await host.get("/api/meetings").expect(200);
  assert.equal(list.body.meetings.length, 1);
  const participant = request.agent(app);
  const guest = await post(participant, "/api/auth/register", { email: "participant@example.com", password: "safe password 123", displayName: "Participant" });
  assert.equal(guest.status, 201);
  assert.equal((await participant.get("/api/meetings").expect(200)).body.meetings.length, 0);
  await participant.get(`/api/meetings/${roomId}`).expect(200);
  await participant.get("/api/meetings/invalid").expect(400);
  await participant.get(`/api/meetings/${randomUUID()}`).expect(404);
  const joined = await post(participant, `/api/meetings/${roomId}/token`);
  assert.equal(joined.status, 200);
  assert.equal(joined.body.token.includes(config.livekit!.apiSecret), false);
  const claims = await new TokenVerifier(config.livekit!.apiKey, config.livekit!.apiSecret).verify(joined.body.token);
  assert.equal(claims.sub, guest.body.user.id); assert.equal(claims.name, "Participant");
  assert.equal(claims.video?.room, roomId); assert.equal(claims.video?.roomJoin, true);
  assert.equal(claims.video?.roomAdmin, false); assert.ok(claims.exp! - claims.nbf! <= 600);
  assert.deepEqual(provisioned.at(-1)?.maxParticipants, 7);
  assert.equal((await post(participant, `/api/meetings/${roomId}/token`, { identity: hostId })).status, 400);
  assert.equal((await post(participant, `/api/meetings/${randomUUID()}/token`)).status, 404);
  await Meeting.updateOne({ roomId }, { status: "ended", endedAt: new Date() });
  await participant.get(`/api/meetings/${roomId}`).expect(410);
  assert.equal((await post(participant, `/api/meetings/${roomId}/token`)).status, 410);
  const invalidatedCsrf = await csrf(host);
  assert.equal((await post(host, "/api/auth/logout")).status, 204);
  await host.get("/api/auth/me").expect(401);
  await host.post("/api/meetings").set("Origin", origin).set("X-CSRF-Token", invalidatedCsrf).send({}).expect(403);
  assert.equal((await post(host, "/api/auth/login", { ...credentials, password: "wrong password" })).status, 401);
  const login = await post(host, "/api/auth/login", credentials);
  assert.equal(login.status, 200); assert.equal(login.body.user.id, hostId);
  await host.get("/api/auth/me").expect(200);
});
test("LiveKit missing configuration and mismatched capacity fail instead of issuing tokens", async () => {
  const meeting = { roomId: randomUUID(), maxParticipants: 7 };
  const user = { id: "test-user", displayName: "Test", email: "test@example.com" };
  await assert.rejects(liveKitService({ ...config, livekit: undefined })(meeting, user), /not configured/);
  await assert.rejects(liveKitService(config, { async createRoom() { return { maxParticipants: 0 }; } })(meeting, user), /unavailable/);
});

test("Google OAuth validates state and retains a safe meeting destination on failure", async () => {
  const configured = createApp({ ...config, google: { clientId: "test-google-id", clientSecret: "test-google-secret", callbackURL: "http://localhost:5000/api/auth/google/callback" } }, store);
  const agent = request.agent(configured);
  const next = `/meeting/${randomUUID()}`;
  const started = await agent.get(`/api/auth/google?next=${encodeURIComponent(next)}`).expect(302);
  const consent = new URL(started.headers.location);
  assert.equal(consent.hostname, "accounts.google.com"); assert.ok(consent.searchParams.get("state"));
  const callback = await agent.get("/api/auth/google/callback?code=fake&state=wrong-state").expect(302);
  const failed = new URL(callback.headers.location);
  assert.equal(failed.origin, origin); assert.equal(failed.searchParams.get("next"), next);
  assert.equal(failed.searchParams.get("error"), "google-failed");
  await agent.get("/api/auth/me").expect(401);
});
