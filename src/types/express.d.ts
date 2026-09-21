import type { PublicUser } from "../app/modules/user/user.model.js";
import "express-session";
declare module "express-session" {
  interface SessionData { userId?: string; csrfToken?: string; returnTo?: string; }
}
declare global {
  namespace Express {
    interface User extends PublicUser {}
    interface Request { authUser?: PublicUser; }
  }
}
export {};
