export const ROOM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function safeReturnPath(value: unknown): string {
  if (typeof value === "string" && value.startsWith("/meeting/") && ROOM_ID_PATTERN.test(value.slice(9))) return value;
  return "/dashboard";
}
