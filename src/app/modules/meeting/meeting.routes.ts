import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import type { AppConfig } from "../../config/env.js";
import { HttpError } from "../../shared/errors.js";
import { ROOM_ID_PATTERN } from "../../shared/return-path.js";
import { requireAuth } from "../auth/session.js";
import { liveKitService, type RoomProvisioner } from "../livekit/livekit.service.js";
import { Meeting, publicMeeting } from "./meeting.model.js";
export const meetingInput = z.object({ title: z.string().trim().max(120).optional() }).strict();
export function meetingRoutes(config: AppConfig, provisioner?: RoomProvisioner) {
  const router = Router();
  const join = liveKitService(config, provisioner);
  router.use(requireAuth);
  router.post("/", rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many meetings created. Please wait." } }), async (request, response) => {
    const input = meetingInput.parse(request.body);
    const meeting = await Meeting.create({ roomId: randomUUID(), hostUserId: request.authUser!.id, title: input.title || "Bangla accessible meeting" });
    response.status(201).json({ meeting: publicMeeting(meeting), inviteUrl: `${config.frontendOrigin}/meeting/${meeting.roomId}` });
  });
  router.get("/", async (request, response) => {
    const query = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1) }).parse(request.query);
    const pageSize = 20;
    const meetings = await Meeting.find({ hostUserId: request.authUser!.id }).sort({ createdAt: -1, _id: -1 }).skip((query.page - 1) * pageSize).limit(pageSize + 1);
    response.json({ meetings: meetings.slice(0, pageSize).map(publicMeeting), page: query.page, hasMore: meetings.length > pageSize });
  });
  async function findMeeting(roomId: unknown) {
    if (typeof roomId !== "string" || !ROOM_ID_PATTERN.test(roomId)) throw new HttpError(400, "Invalid meeting ID.");
    const meeting = await Meeting.findOne({ roomId });
    if (!meeting) throw new HttpError(404, "Meeting not found.");
    if (meeting.status === "ended") throw new HttpError(410, "This meeting has ended.");
    return meeting;
  }
  router.get("/:roomId", async (request, response) => { response.json({ meeting: publicMeeting(await findMeeting(request.params.roomId)) }); });
  router.post("/:roomId/token", rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many token requests. Please wait." } }), async (request, response) => {
    z.object({}).strict().parse(request.body ?? {});
    const meeting = await findMeeting(request.params.roomId);
    response.json(await join(meeting, request.authUser!));
  });
  return router;
}
