import { Router } from "express";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import type { AppConfig } from "../../config/env.js";
import { requireAuth } from "../auth/session.js";
import { liveKitService, type RoomProvisioner } from "../livekit/livekit.service.js";
import { roomTermination, type RoomTerminator } from "../livekit/room-termination.js";
import { endMeetingService } from "./end-meeting.js";
import { acquireOperation, assertTokenAllowed, createMeetingRecord, releaseOperation, requireActive, validateRoomId } from "./meeting.lifecycle.js";
import { Meeting, publicMeeting } from "./meeting.model.js";
export const meetingInput = z.object({ title: z.string().trim().max(120).optional() }).strict();
export function meetingRoutes(config: AppConfig, provisioner?: RoomProvisioner, terminator?: RoomTerminator) {
  const router = Router();
  const join = liveKitService(config, provisioner);
  const end = endMeetingService(roomTermination(config, terminator));
  router.use(requireAuth);
  router.post("/", rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many meetings created. Please wait." } }), async (request, response) => {
    const input = meetingInput.parse(request.body);
    const meeting = await createMeetingRecord(request.authUser!.id, input.title || "Bangla accessible meeting");
    response.status(201).json({ meeting: publicMeeting(meeting), inviteUrl: `${config.frontendOrigin}/meeting/${meeting.roomId}` });
  });
  router.get("/", async (request, response) => {
    const query = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1) }).parse(request.query);
    const pageSize = 20;
    const meetings = await Meeting.find({ hostUserId: request.authUser!.id }).sort({ createdAt: -1, _id: -1 }).skip((query.page - 1) * pageSize).limit(pageSize + 1).lean();
    response.json({ meetings: meetings.slice(0, pageSize).map(publicMeeting), page: query.page, hasMore: meetings.length > pageSize });
  });
  router.get("/:roomId", async (request, response) => {
    validateRoomId(request.params.roomId);
    response.json({ meeting: publicMeeting(await requireActive(request.params.roomId, request.authUser!.id)) });
  });
  router.post("/:roomId/end", rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many shutdown requests. Please wait." } }), async (request, response) => {
    validateRoomId(request.params.roomId);
    z.object({}).strict().parse(request.body ?? {});
    response.json(await end(request.params.roomId, request.authUser!.id));
  });
  router.post("/:roomId/token", rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many token requests. Please wait." } }), async (request, response) => {
    validateRoomId(request.params.roomId);
    z.object({}).strict().parse(request.body ?? {});
    const roomId = request.params.roomId, user = request.authUser!;
    await requireActive(roomId, user.id);
    const owner = await acquireOperation(roomId, "active");
    if (!owner) throw new Error("Active operation lease was not acquired.");
    let credentials;
    try {
      const meeting = await assertTokenAllowed(roomId, owner, user.id);
      credentials = await join(meeting, user);
      // Recheck persisted status after every asynchronous provisioning/signing step.
      await assertTokenAllowed(roomId, owner, user.id);
    } finally { await releaseOperation(roomId, owner); }
    await requireActive(roomId, user.id);
    response.json(credentials);
  });
  return router;
}
