import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../../../config/env.js";
import { HttpError } from "../../../shared/errors.js";
import { requireAuth } from "../../auth/session.js";
import { User, publicUser } from "../../user/user.model.js";
import { liveKitService, type RoomProvisioner } from "../../livekit/livekit.service.js";
import { roomTermination, type RoomTerminator } from "../../livekit/room-termination.js";
import { endMeetingService } from "../end-meeting.js";
import { acquireOperation, assertTokenAllowed, createMeetingRecord, releaseOperation, requireActive, validateRoomId } from "../meeting.lifecycle.js";
import { Meeting, publicMeeting } from "../meeting.model.js";
import { JoinRequestCopy } from "./join-request.modelCopy.js";
import { publishJoinRequestCopy, joinRequestEventsCopy } from "./join-request-eventsCopy.js";

const guestInput = z.object({ displayName: z.string().trim().min(1).max(50), requestKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const credentialsUser = (id: string, displayName: string) => ({ id, displayName, email: "" });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const matchesSecret = (stored: string, provided: string) => {
  const a = Buffer.from(stored), b = Buffer.from(hash(provided));
  return a.length === b.length && timingSafeEqual(a, b);
};
const safeRequest = (request: { _id: unknown; displayName: string; participantType: string; status: string; createdAt: Date }) => ({ id: String(request._id), displayName: request.displayName, participantType: request.participantType, status: request.status, createdAt: request.createdAt });

export function meetingRoutesCopy(config: AppConfig, provisioner?: RoomProvisioner, terminator?: RoomTerminator) {
  const router = Router();
  const join = liveKitService(config, provisioner);
  const end = endMeetingService(roomTermination(config, terminator));
  const requestLimit = rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many join requests. Please wait." } });
  const optionalAuth = async (req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
    if (!req.session.userId) { next(); return; }
    const user = await User.findById(req.session.userId);
    if (!user) throw new HttpError(401, "Your session is no longer valid. Please sign in.");
    req.authUser = publicUser(user);
    next();
  };

  router.post("/", requireAuth, rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false }), async (req, res) => {
    const input = z.object({ title: z.string().trim().max(120).optional() }).strict().parse(req.body);
    const meeting = await createMeetingRecord(req.authUser!.id, input.title || "Bangla accessible meeting");
    res.status(201).json({ meeting: publicMeeting(meeting), inviteUrl: `${config.frontendOrigin}/meeting/${meeting.roomId}` });
  });
  router.get("/", requireAuth, async (req, res) => {
    const page = z.coerce.number().int().min(1).max(10000).default(1).parse(req.query.page);
    const rows = await Meeting.find({ hostUserId: req.authUser!.id }).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 20).limit(21).lean();
    res.json({ meetings: rows.slice(0, 20).map(publicMeeting), page, hasMore: rows.length > 20 });
  });
  // Public metadata contains no participant or private user data.
  router.get("/:roomId", async (req, res) => {
    validateRoomId(req.params.roomId);
    const meeting = await requireActive(req.params.roomId);
    res.json({ meeting: publicMeeting(meeting) });
  });
  router.post("/:roomId/end", requireAuth, rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false }), async (req, res) => {
    validateRoomId(req.params.roomId);
    z.object({}).strict().parse(req.body ?? {});
    const result = await end(req.params.roomId, req.authUser!.id);
    await JoinRequestCopy.updateMany({ meetingId: req.params.roomId, status: "pending" }, { $set: { status: "expired", respondedAt: new Date() } });
    publishJoinRequestCopy(req.params.roomId, { type: "meeting-ended" });
    res.json(result);
  });

  router.post("/:roomId/join-requests", optionalAuth, requestLimit, async (req, res) => {
    validateRoomId(req.params.roomId);
    const meeting = await requireActive(req.params.roomId);
    const authenticated = req.authUser;
    // Host may immediately request a normal LiveKit credential for their own meeting.
    if (authenticated?.id === meeting.hostUserId.toString()) return res.json({ host: true });
    const guest = authenticated ? undefined : guestInput.parse(req.body);
    const displayName = authenticated?.displayName ?? guest!.displayName;
    await JoinRequestCopy.updateMany({ meetingId: req.params.roomId, status: "pending", expiresAt: { $lte: new Date() } }, { $set: { status: "expired", respondedAt: new Date() } });
    if (authenticated) {
      const prior = await JoinRequestCopy.findOne({ meetingId: req.params.roomId, userId: authenticated.id, status: { $in: ["pending", "accepted"] }, expiresAt: { $gt: new Date() } }).select("+secretHash");
      if (prior) return res.status(200).json({ request: safeRequest(prior), secret: null, reused: true });
    }
    const secret = guest?.requestKey ?? randomBytes(32).toString("hex");
    if (!authenticated) {
      const duplicate = await JoinRequestCopy.findOne({ meetingId: req.params.roomId, userId: null, secretHash: hash(secret), status: { $in: ["pending", "accepted"] }, expiresAt: { $gt: new Date() } }).select("+secretHash");
      if (duplicate) return res.status(200).json({ request: safeRequest(duplicate), secret, reused: true });
    }
    const participantIdentity = authenticated?.id ?? `guest_${randomUUID()}`;
    let record;
    try {
      record = await JoinRequestCopy.create({ meetingId: req.params.roomId, participantIdentity, displayName, userId: authenticated?.id ?? null, participantType: authenticated ? "authenticated" : "guest", secretHash: hash(secret), status: "pending", expiresAt: new Date(Date.now() + 30 * 60_000) });
    } catch (failure) {
      if (!failure || typeof failure !== "object" || !("code" in failure) || failure.code !== 11000) throw failure;
      const duplicate = authenticated
        ? await JoinRequestCopy.findOne({ meetingId: req.params.roomId, userId: authenticated.id, participantType: "authenticated", status: "pending", expiresAt: { $gt: new Date() } })
        : await JoinRequestCopy.findOne({ meetingId: req.params.roomId, userId: null, secretHash: hash(secret), participantType: "guest", status: "pending", expiresAt: { $gt: new Date() } });
      if (!duplicate) throw failure;
      return res.status(200).json({ request: safeRequest(duplicate), secret: authenticated ? null : secret, reused: true });
    }
    const result = { request: safeRequest(record), secret: authenticated ? null : secret };
    publishJoinRequestCopy(req.params.roomId, { type: "new", request: result.request });
    res.status(201).json(result);
  });

  router.get("/:roomId/join-requests/pending", requireAuth, async (req, res) => {
    validateRoomId(req.params.roomId);
    const meeting = await requireActive(req.params.roomId);
    if (meeting.hostUserId.toString() !== req.authUser!.id) throw new HttpError(403, "Only the meeting host can manage the waiting room.", "HOST_REQUIRED");
    await JoinRequestCopy.updateMany({ meetingId: req.params.roomId, status: "pending", expiresAt: { $lte: new Date() } }, { $set: { status: "expired", respondedAt: new Date() } });
    const requests = await JoinRequestCopy.find({ meetingId: req.params.roomId, status: "pending", expiresAt: { $gt: new Date() } }).sort({ createdAt: 1 }).lean();
    res.json({ requests: requests.map(safeRequest) });
  });
  router.get("/:roomId/join-requests/events", requireAuth, async (req, res) => {
    validateRoomId(req.params.roomId);
    const meeting = await requireActive(req.params.roomId);
    if (meeting.hostUserId.toString() !== req.authUser!.id) throw new HttpError(403, "Only the meeting host can manage the waiting room.", "HOST_REQUIRED");
    res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    res.write(`event: ready\ndata: {}\n\n`);
    const topic = `meeting:${req.params.roomId}`;
    const send = (payload: unknown) => res.write(`event: update\ndata: ${JSON.stringify(payload)}\n\n`);
    joinRequestEventsCopy.on(topic, send);
    // Local events make actions immediate; this small server-side reconciliation also
    // covers reconnects and deployments with more than one API process.
    let lastSnapshot = "";
    const sync = async () => {
      await JoinRequestCopy.updateMany({ meetingId: req.params.roomId, status: "pending", expiresAt: { $lte: new Date() } }, { $set: { status: "expired", respondedAt: new Date() } });
      const pending = await JoinRequestCopy.find({ meetingId: req.params.roomId, status: "pending", expiresAt: { $gt: new Date() } }).sort({ createdAt: 1 }).select("_id updatedAt").lean();
      const snapshot = JSON.stringify(pending.map((item) => [String(item._id), item.updatedAt?.getTime()]));
      if (snapshot !== lastSnapshot) { lastSnapshot = snapshot; send({ type: "refresh" }); }
    };
    void sync().catch(() => {});
    const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 20_000);
    const reconciliation = setInterval(() => { void sync().catch(() => {}); }, 3_000);
    req.on("close", () => { clearInterval(heartbeat); clearInterval(reconciliation); joinRequestEventsCopy.off(topic, send); });
  });
  router.post("/:roomId/join-requests/:requestId/:decision", requireAuth, async (req, res) => {
    validateRoomId(req.params.roomId);
    const decision = Array.isArray(req.params.decision) ? req.params.decision[0] : req.params.decision;
    if (!["accept", "reject"].includes(decision)) throw new HttpError(404, "Endpoint not found.");
    const meeting = await requireActive(req.params.roomId);
    if (meeting.hostUserId.toString() !== req.authUser!.id) throw new HttpError(403, "Only the meeting host can manage the waiting room.", "HOST_REQUIRED");
    const status = decision === "accept" ? "accepted" : "rejected";
    const record = await JoinRequestCopy.findOneAndUpdate({ _id: req.params.requestId, meetingId: req.params.roomId, status: "pending", expiresAt: { $gt: new Date() } }, { $set: { status, respondedAt: new Date() } }, { new: true });
    if (!record) throw new HttpError(409, "This join request is no longer pending.", "REQUEST_NOT_PENDING");
    const result = safeRequest(record);
    publishJoinRequestCopy(req.params.roomId, { type: "updated", request: result });
    res.json({ request: result });
  });
  router.get("/:roomId/join-requests/:requestId", async (req, res) => {
    validateRoomId(req.params.roomId);
    const meeting = await requireActive(req.params.roomId);
    const record = await JoinRequestCopy.findOne({ _id: req.params.requestId, meetingId: req.params.roomId }).select("+secretHash");
    if (!record) throw new HttpError(404, "Join request not found.");
    const authenticatedOwner = record.userId && req.session.userId === record.userId;
    const guestSecret = typeof req.get("x-join-secret") === "string" && record.secretHash && matchesSecret(record.secretHash, req.get("x-join-secret")!);
    if (!authenticatedOwner && !guestSecret) throw new HttpError(403, "This join request does not belong to you.");
    if (record.expiresAt <= new Date() && record.status === "pending") { record.status = "expired"; record.respondedAt = new Date(); await record.save(); }
    if (!(["accepted"].includes(record.status))) return res.json({ request: safeRequest(record) });
    const owner = await acquireOperation(req.params.roomId, "active");
    if (!owner) throw new HttpError(410, "This meeting has ended.", "MEETING_ENDED");
    let credentials;
    try {
      const currentMeeting = await assertTokenAllowed(req.params.roomId, owner, meeting.hostUserId.toString());
      credentials = await join(currentMeeting, credentialsUser(record.participantIdentity, record.displayName));
      const stillAccepted = await JoinRequestCopy.exists({ _id: record._id, meetingId: req.params.roomId, status: "accepted", expiresAt: { $gt: new Date() } });
      await assertTokenAllowed(req.params.roomId, owner, meeting.hostUserId.toString());
      if (!stillAccepted) throw new HttpError(409, "The join request is no longer accepted.");
    } finally { await releaseOperation(req.params.roomId, owner); }
    res.json({ request: safeRequest(record), credentials });
  });
  router.post("/:roomId/join-requests/:requestId/cancel", async (req, res) => {
    validateRoomId(req.params.roomId);
    await requireActive(req.params.roomId);
    const record = await JoinRequestCopy.findOne({ _id: req.params.requestId, meetingId: req.params.roomId, status: "pending" }).select("+secretHash");
    if (!record) throw new HttpError(409, "This join request is no longer pending.");
    const authOwner = record.userId && req.session.userId === record.userId;
    const raw = req.get("x-join-secret");
    const guestOwner = !record.userId && raw && record.secretHash && matchesSecret(record.secretHash, raw);
    if (!authOwner && !guestOwner) throw new HttpError(403, "This join request does not belong to you.");
    const changed = await JoinRequestCopy.findOneAndUpdate({ _id: record._id, status: "pending" }, { $set: { status: "cancelled", respondedAt: new Date() } }, { new: true });
    if (!changed) throw new HttpError(409, "This join request is no longer pending.");
    publishJoinRequestCopy(req.params.roomId, { type: "updated", request: safeRequest(changed) });
    res.json({ request: safeRequest(changed) });
  });

  // Existing direct token API is retained for hosts only. Participants require an accepted request.
  router.post("/:roomId/token", requireAuth, rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false }), async (req, res) => {
    validateRoomId(req.params.roomId);
    const meeting = await requireActive(req.params.roomId, req.authUser!.id);
    if (meeting.hostUserId.toString() !== req.authUser!.id && !await JoinRequestCopy.exists({ meetingId: req.params.roomId, userId: req.authUser!.id, status: "accepted", expiresAt: { $gt: new Date() } })) throw new HttpError(403, "Host approval is required before joining.", "APPROVAL_REQUIRED");
    const owner = await acquireOperation(req.params.roomId, "active");
    if (!owner) throw new HttpError(410, "This meeting has ended.", "MEETING_ENDED");
    try { await assertTokenAllowed(req.params.roomId, owner, req.authUser!.id); res.json(await join(meeting, req.authUser!)); }
    finally { await releaseOperation(req.params.roomId, owner); }
  });
  return router;
}
