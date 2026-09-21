import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  if (error instanceof HttpError) { response.status(error.status).json({ error: error.message }); return; }
  if (error instanceof ZodError) { response.status(400).json({ error: "Invalid request.", fields: error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) }); return; }
  const details = error as { code?: number; type?: string; name?: string };
  if (details?.code === 11000) { response.status(409).json({ error: "An account with that email or identity already exists." }); return; }
  if (details?.type === "entity.parse.failed") { response.status(400).json({ error: "Invalid JSON body." }); return; }
  if (details?.type === "entity.too.large") { response.status(413).json({ error: "Request body is too large." }); return; }
  // Log only the error category: DB/OAuth exceptions can contain credentials or tokens.
  console.error("Request failed:", details?.name ?? "UnknownError");
  response.status(503).json({ error: "The service is temporarily unavailable. Please retry." });
};
