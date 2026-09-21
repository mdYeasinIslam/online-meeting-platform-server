import { Passport } from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import type { AppConfig } from "../../config/env.js";
import { User, publicUser } from "../user/user.model.js";
import { HttpError } from "../../shared/errors.js";
export function configureGoogle(config: AppConfig) {
  const passport = new Passport();
  if (config.google) passport.use(new GoogleStrategy({ ...config.google, clientID: config.google.clientId, state: true }, async (_access, _refresh, profile, done) => {
    try {
      const email = profile.emails?.find(item => item.verified)?.value.toLowerCase().trim();
      if (!email) throw new HttpError(401, "Google must provide a verified email address.");
      let user = await User.findOne({ googleId: profile.id });
      if (!user) {
        // Never silently link a Google identity to an existing credentials account.
        if (await User.exists({ email })) throw new HttpError(409, "This email already has an account. Sign in with your password.");
        user = await User.create({ email, googleId: profile.id, displayName: (profile.displayName || email.split("@")[0]).slice(0, 80) });
      }
      done(null, publicUser(user));
    } catch (error) { done(error instanceof Error ? error : new Error("Google authentication failed.")); }
  }));
  return passport;
}
