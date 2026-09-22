export interface AppConfig {
  port: number;
  production: boolean;
  mongoUri: string;
  sessionSecret: string;
  frontendOrigin: string;
  apiOrigin: string;
  cookieSameSite: "lax" | "strict" | "none";
  trustProxyHops: number;
  google?: { clientId: string; clientSecret: string; callbackURL: string };
  livekit?: { url: string; apiKey: string; apiSecret: string };
}
function origin(value: string, name: string): string {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error(`${name} must be an HTTP(S) origin without a path.`);
  return parsed.origin;
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (!env.MONGODB_URI) throw new Error("Set MONGODB_URI in the server .env.");
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error("Set SESSION_SECRET to a random value of at least 32 characters in the server .env.");
  const port = Number(env.PORT ?? 5000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
  const production = env.NODE_ENV === "production";
  if (production && (!env.FRONTEND_URL || !env.API_PUBLIC_URL)) throw new Error("Set FRONTEND_URL and API_PUBLIC_URL in production.");
  const frontendOrigin = origin(
    env.FRONTEND_URL ?? "https://online-meeting-platform-rho.vercel.app",
    "FRONTEND_URL",
  );
  const apiOrigin = origin(
    env.API_PUBLIC_URL ?? `https://online-meeting-platform-server.onrender.com`,
    "API_PUBLIC_URL",
  );
  if (production && (!frontendOrigin.startsWith("https://") || !apiOrigin.startsWith("https://"))) throw new Error("Production origins must use HTTPS.");
  const cookieSameSite = env.COOKIE_SAME_SITE ?? "lax";
  if (!["lax", "strict", "none"].includes(cookieSameSite) || (cookieSameSite === "none" && !production)) throw new Error("COOKIE_SAME_SITE must be lax/strict, or none over production HTTPS.");
  const trustProxyHops = Number(env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) throw new Error("Invalid TRUST_PROXY_HOPS.");
  let livekit: AppConfig["livekit"];
  if (env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET) {
    const url = new URL(env.LIVEKIT_URL);
    if (!["ws:", "wss:"].includes(url.protocol) || (production && url.protocol !== "wss:")) throw new Error("LIVEKIT_URL must use wss:// (ws:// permitted locally).");
    livekit = { url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET };
  }
  return {
    port, production, mongoUri: env.MONGODB_URI, sessionSecret: env.SESSION_SECRET,
    frontendOrigin, apiOrigin, cookieSameSite: cookieSameSite as AppConfig["cookieSameSite"], trustProxyHops, livekit,
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? {
      clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${apiOrigin}/api/auth/google/callback`,
    } : undefined,
  };
}
