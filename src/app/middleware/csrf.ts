import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { HttpError } from "../shared/errors.js";
export function csrfProtection(frontendOrigin: string): RequestHandler {
  return (request, _response, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) { next(); return; }
    if (request.get("origin") !== frontendOrigin) throw new HttpError(403, "Request origin is not allowed.");
    const supplied = request.get("x-csrf-token");
    const expected = request.session.csrfToken;
    if (!supplied || !expected || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new HttpError(403, "Your security token has expired. Please retry.");
    next();
  };
}
