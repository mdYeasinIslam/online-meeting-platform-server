import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import request from "supertest";
import mongoose from "mongoose";
import MongoStore from "connect-mongo";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createAppCopy } from "../../src/updated/AppCopy.js";
import { readConfig } from "../../src/app/config/env.js";
import { User } from "../../src/app/modules/user/user.model.js";
import { Meeting } from "../../src/app/modules/meeting/meeting.model.js";
import { JoinRequestCopy } from "../../src/app/modules/meeting/updated/join-request.modelCopy.js";

const origin = "http://localhost:3000";
let database: MongoMemoryServer;
let store: MongoStore;
let app: ReturnType<typeof createAppCopy>;
let host: ReturnType<typeof request.agent>;
let member: ReturnType<typeof request.agent>;
let anonymous: ReturnType<typeof request.agent>;
let hostId: string;
async function post(agent: ReturnType<typeof request.agent>, path: string, body = {}) {
  const csrf = await agent.get("/api/auth/csrf");
  return agent.post(path).set("Origin", origin).set("X-CSRF-Token", csrf.body.csrfToken).send(body);
}
before(async () => {
  database = await MongoMemoryServer.create({ binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY || (existsSync("/usr/bin/mongod") ? "/usr/bin/mongod" : undefined) } });
  const mongoUri = database.getUri("waiting-room");
  await mongoose.connect(mongoUri);
  await Promise.all([User.init(), Meeting.init(), JoinRequestCopy.init()]);
  store = MongoStore.create({ mongoUrl: mongoUri });
  const config = readConfig({ NODE_ENV: "test", MONGODB_URI: mongoUri, SESSION_SECRET: "waiting-room-test-session-secret-long-enough", FRONTEND_URL: origin, LIVEKIT_URL: "wss://livekit.example.test", LIVEKIT_API_KEY: "test-key", LIVEKIT_API_SECRET: "test-livekit-secret-at-least-32-characters" });
  app = createAppCopy(config, store, { async createRoom() { return { maxParticipants: 20 }; }, async listParticipants() { return []; } });
  host = request.agent(app); member = request.agent(app); anonymous = request.agent(app);
  const registered = await post(host, "/api/auth/register", { email: "waiting-host@example.com", displayName: "Meeting host", password: "temporary password 123" });
  assert.equal(registered.status, 201); hostId = registered.body.user.id;
  assert.equal((await post(member, "/api/auth/register", { email: "waiting-member@example.com", displayName: "Signed in member", password: "temporary password 123" })).status, 201);
});
after(async () => { await store?.close(); await mongoose.disconnect(); await database?.stop(); });

test("guest request is private, requires host approval, and receives scoped credentials only after acceptance", async () => {
  const meeting = await Meeting.create({ roomId: randomUUID(), hostUserId: hostId, title: "Public meeting" });
  assert.equal((await anonymous.get(`/api/meetings/${meeting.roomId}`)).status, 200);
  const requestKey = "a".repeat(64);
  const created = await post(anonymous, `/api/meetings/${meeting.roomId}/join-requests`, { displayName: "  Guest One  ", requestKey });
  assert.equal(created.status, 201); assert.equal(created.body.request.displayName, "Guest One");
  const duplicate = await post(anonymous, `/api/meetings/${meeting.roomId}/join-requests`, { displayName: "Guest One", requestKey });
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.request.id, created.body.request.id);
  assert.equal((await post(anonymous, `/api/meetings/${meeting.roomId}/token`)).status, 401);
  const requestId = created.body.request.id;
  assert.equal((await post(member, `/api/meetings/${meeting.roomId}/join-requests/${requestId}/accept`)).status, 403);
  const pending = await host.get(`/api/meetings/${meeting.roomId}/join-requests/pending`).expect(200);
  assert.equal(pending.body.requests.length, 1); assert.equal(pending.body.requests[0].participantType, "guest");
  assert.equal((await member.get(`/api/meetings/${meeting.roomId}/join-requests/pending`)).status, 403);
  const statusBefore = await anonymous.get(`/api/meetings/${meeting.roomId}/join-requests/${requestId}`).set("X-Join-Secret", created.body.secret).expect(200);
  assert.equal(statusBefore.body.request.status, "pending"); assert.equal(statusBefore.body.credentials, undefined);
  assert.equal((await post(host, `/api/meetings/${meeting.roomId}/join-requests/${requestId}/accept`)).status, 200);
  const accepted = await anonymous.get(`/api/meetings/${meeting.roomId}/join-requests/${requestId}`).set("X-Join-Secret", created.body.secret).expect(200);
  assert.equal(accepted.body.request.status, "accepted"); assert.equal(accepted.body.credentials.roomId, meeting.roomId); assert.equal(typeof accepted.body.credentials.token, "string");
  assert.equal((await anonymous.get(`/api/meetings/${meeting.roomId}/join-requests/${requestId}`).expect(403)).body.credentials, undefined);
  const payload = JSON.parse(Buffer.from(accepted.body.credentials.token.split(".")[1], "base64url").toString());
  assert.match(payload.sub, /^guest_/); assert.equal(payload.name, "Guest One");
});

test("authenticated participants cannot use the legacy token endpoint until approval; rejection is terminal", async () => {
  const meeting = await Meeting.create({ roomId: randomUUID(), hostUserId: hostId, title: "Approval required" });
  const created = await post(member, `/api/meetings/${meeting.roomId}/join-requests`, {});
  assert.equal(created.status, 201);
  assert.equal((await post(member, `/api/meetings/${meeting.roomId}/token`)).status, 403);
  const requestId = created.body.request.id;
  assert.equal((await post(host, `/api/meetings/${meeting.roomId}/join-requests/${requestId}/reject`)).status, 200);
  const state = await member.get(`/api/meetings/${meeting.roomId}/join-requests/${requestId}`).expect(200);
  assert.equal(state.body.request.status, "rejected"); assert.equal(state.body.credentials, undefined);
  assert.equal((await post(member, `/api/meetings/${meeting.roomId}/token`)).status, 403);
  assert.equal((await post(host, `/api/meetings/${meeting.roomId}/join-requests/${requestId}/accept`)).status, 409);
});

test("guest names are validated and host credentials remain immediately available", async () => {
  const meeting = await Meeting.create({ roomId: randomUUID(), hostUserId: hostId, title: "Host access" });
  const requestKey = "b".repeat(64);
  assert.equal((await post(anonymous, `/api/meetings/${meeting.roomId}/join-requests`, { displayName: "  ", requestKey })).status, 400);
  assert.equal((await post(anonymous, `/api/meetings/${meeting.roomId}/join-requests`, { displayName: "x".repeat(51), requestKey })).status, 400);
  const hostRequest = await post(host, `/api/meetings/${meeting.roomId}/join-requests`, {});
  assert.equal(hostRequest.body.host, true);
  const token = await post(host, `/api/meetings/${meeting.roomId}/token`);
  assert.equal(token.status, 200); assert.equal(token.body.roomId, meeting.roomId);
});
