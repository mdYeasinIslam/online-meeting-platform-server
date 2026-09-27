import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import request from "supertest";
import mongoose from "mongoose";
import MongoStore from "connect-mongo";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ServerError } from "livekit-server-sdk";
import { createApp } from "../src/App.js";
import { readConfig } from "../src/app/config/env.js";
import { User } from "../src/app/modules/user/user.model.js";
import { Meeting } from "../src/app/modules/meeting/meeting.model.js";
import { createMeetingRecord } from "../src/app/modules/meeting/meeting.lifecycle.js";
import { endMeetingService } from "../src/app/modules/meeting/end-meeting.js";
import { roomTermination } from "../src/app/modules/livekit/room-termination.js";
const origin = "http://localhost:3000";
let database: MongoMemoryServer, store: MongoStore;
let config: ReturnType<typeof readConfig>;
let app: ReturnType<typeof createApp>;
let host: ReturnType<typeof request.agent>, guest: ReturnType<typeof request.agent>;
let hostId: string;
let deletion: (room: string) => Promise<void> = async () => {};
let provision: () => Promise<void> = async () => {};
const deleted: string[] = [];
async function post(agent: ReturnType<typeof request.agent>, path: string, body = {}) {
  const csrf = await agent.get("/api/auth/csrf");
  return agent.post(path).set("Origin", origin).set("X-CSRF-Token", csrf.body.csrfToken).send(body);
}
async function meeting() { return Meeting.create({ roomId: randomUUID(), hostUserId: hostId, title: "Termination" }); }
before(async () => {
  database = await MongoMemoryServer.create({ binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY || (existsSync("/usr/bin/mongod") ? "/usr/bin/mongod" : undefined) } });
  const mongoUri = database.getUri("termination"); await mongoose.connect(mongoUri);
  await Promise.all([User.init(), Meeting.init()]); store = MongoStore.create({ mongoUrl: mongoUri });
  config = readConfig({ NODE_ENV: "test", MONGODB_URI: mongoUri, SESSION_SECRET: "test-session-secret-at-least-32-characters", FRONTEND_URL: origin, LIVEKIT_URL: "wss://livekit.example.test", LIVEKIT_API_KEY: "test-key", LIVEKIT_API_SECRET: "test-livekit-secret-at-least-32-characters" });
  app = createApp(config, store, { async createRoom() { await provision(); return { maxParticipants: 7 }; }, async listParticipants() { return []; } }, { async deleteRoom(id) { deleted.push(id); await deletion(id); } });
  host = request.agent(app); guest = request.agent(app);
  const registered = await post(host, "/api/auth/register", { email: "host@example.com", displayName: "Host", password: "temporary password 123" });
  assert.equal(registered.status, 201); hostId = registered.body.user.id;
  assert.equal((await post(guest, "/api/auth/register", { email: "guest@example.com", displayName: "Guest", password: "temporary password 123" })).status, 201);
});
after(async () => { await store?.close(); await mongoose.disconnect(); await database?.stop(); });
test("end endpoint authenticates, validates, checks stored ownership and rejects body impersonation", async () => {
  const value = await meeting(), path = `/api/meetings/${value.roomId}/end`;
  assert.equal((await post(request.agent(app), path)).status, 401);
  assert.equal((await post(guest, path)).status, 403);
  assert.equal((await post(host, "/api/meetings/invalid/end")).status, 400);
  assert.equal((await post(host, `/api/meetings/${randomUUID()}/end`)).status, 404);
  assert.equal((await post(host, path, { hostUserId: hostId })).status, 400);
  await request(app).post(path).send({}).expect(403);
  assert.equal((await Meeting.findById(value.id))?.status, "active"); assert.equal(deleted.length, 0);
});
test("host sets ending before DeleteRoom, blocks lookup/token, persists host/time, and duplicates are idempotent", async () => {
  const value = await meeting(), path = `/api/meetings/${value.roomId}`;
  deletion = async id => {
    assert.equal(id, value.roomId); assert.equal((await Meeting.findById(value.id))?.status, "ending");
    const lookup = await host.get(path).expect(410); assert.equal(lookup.body.code, "MEETING_ENDING"); assert.equal(lookup.body.canEnd, true);
    assert.equal((await guest.get(path).expect(410)).body.canEnd, false);
    assert.equal((await post(guest, `${path}/token`)).status, 410);
  };
  const before = Date.now(), ended = await post(host, `${path}/end`);
  assert.equal(ended.status, 200); assert.equal(ended.body.meeting.status, "ended");
  assert.equal(ended.body.meeting.endedBy, hostId); assert.ok(Date.parse(ended.body.meeting.endedAt) >= before);
  assert.equal(JSON.stringify(ended.body).includes(config.livekit!.apiSecret), false);
  assert.equal("operationLease" in ended.body.meeting, false);
  const count = deleted.length, again = await post(host, `${path}/end`);
  assert.deepEqual(again.body, ended.body); assert.equal(deleted.length, count);
  assert.equal((await post(guest, `${path}/end`)).status, 403);
  assert.equal((await host.get(path).expect(410)).body.code, "MEETING_ENDED");
  assert.equal((await post(host, `${path}/token`)).status, 410);
  deletion = async () => {};
});
test("provider failure retains ending, exposes safe retry, and authorized retry succeeds", async () => {
  const value = await meeting(), path = `/api/meetings/${value.roomId}`;
  deletion = async () => { throw new Error("PRIVATE provider details"); };
  const failed = await post(host, `${path}/end`); assert.equal(failed.status, 503);
  assert.equal(failed.body.code, "MEETING_END_RETRY"); assert.equal(JSON.stringify(failed.body).includes("PRIVATE"), false);
  assert.equal((await Meeting.findById(value.id))?.status, "ending");
  await guest.get(path).expect(410); assert.equal((await post(host, `${path}/token`)).status, 410);
  deletion = async () => {};
  assert.equal((await post(host, `${path}/end`)).body.meeting.status, "ended");
});
test("only confirmed provider not-found counts as absent; configuration/auth/network errors fail", async () => {
  await roomTermination(config, { async deleteRoom() { throw new ServerError("TwirpError", "missing", 404, "not_found"); } })(randomUUID());
  for (const error of [new ServerError("TwirpError", "denied", 401, "unauthenticated"), new ServerError("TwirpError", "ambiguous", 404, "unknown"), new Error("timeout")]) {
    await assert.rejects(roomTermination(config, { async deleteRoom() { throw error; } })(randomUUID()), /Could not complete/);
  }
  await assert.rejects(roomTermination({ ...config, livekit: undefined })(randomUUID()), /unavailable/);
});
test("two concurrent authorized shutdowns serialize deletion and retain a single terminal timestamp", async () => {
  const value = await meeting(); let calls = 0;
  const end = endMeetingService(async () => { calls++; await new Promise(resolve => setTimeout(resolve, 100)); });
  const [first, second] = await Promise.all([end(value.roomId, hostId), end(value.roomId, hostId)]);
  assert.deepEqual(first, second); assert.equal(calls, 1);
  assert.equal((await Meeting.findById(value.id).lean())?.operationLease, undefined);
});
test("in-flight provisioning cannot return credentials after shutdown begins or run after deletion", async () => {
  const value = await meeting(), path = `/api/meetings/${value.roomId}`;
  let unblock!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  provision = async () => { entered(); await gate; };
  const joining = post(guest, `${path}/token`); await started;
  const ending = post(host, `${path}/end`);
  for (let tries = 0; (await Meeting.findById(value.id))?.status !== "ending"; tries++) {
    assert.ok(tries < 100); await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(deleted.includes(value.roomId), false); unblock();
  assert.equal((await joining).status, 410); assert.equal((await ending).status, 200);
  provision = async () => {}; assert.equal((await post(host, `${path}/token`)).status, 410);
});
test("legacy missing status works; malformed/ended records fail closed; IDs never overwrite tombstones", async () => {
  const value = await meeting(); await Meeting.collection.updateOne({ _id: value._id }, { $unset: { status: "" } });
  assert.equal((await host.get(`/api/meetings/${value.roomId}`).expect(200)).body.meeting.status, "active");
  assert.equal((await post(host, `/api/meetings/${value.roomId}/token`)).status, 200);
  await endMeetingService(async () => {})(value.roomId, hostId);
  let calls = 0; const fresh = randomUUID();
  const created = await createMeetingRecord(hostId, "New", () => ++calls === 1 ? value.roomId : fresh);
  assert.equal(created.roomId, fresh); assert.equal(calls, 2); assert.equal((await Meeting.findById(value.id))?.status, "ended");
  assert.equal((await post(host, "/api/meetings", { roomId: value.roomId })).status, 400);
  await Meeting.collection.updateOne({ _id: created._id }, { $set: { status: "unknown" } });
  await host.get(`/api/meetings/${fresh}`).expect(503);
  assert.equal((await post(host, `/api/meetings/${fresh}/token`)).status, 503);
});
test("expired operation lease is recoverable; live lease leaves joins blocked and asks host to retry", async () => {
  const value = await meeting();
  await Meeting.updateOne({ _id: value._id }, { $set: { operationLease: { owner: "stalled", expiresAt: new Date(Date.now() + 10000) } } });
  const end = endMeetingService(async () => {});
  await assert.rejects(end(value.roomId, hostId), /shutdown is pending/);
  assert.equal((await Meeting.findById(value.id))?.status, "ending");
  await Meeting.updateOne({ _id: value._id }, { $set: { "operationLease.expiresAt": new Date(0) } });
  assert.equal((await end(value.roomId, hostId)).meeting.status, "ended");
});
