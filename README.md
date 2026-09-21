# Lets-Talk — server

This existing Express application owns authentication, MongoDB profiles/sessions/meetings, authorization, Google OAuth callbacks and LiveKit room/token operations. Next.js is the separate UI client. Supabase, PeerJS and Socket.io are not used.

## Start locally

Use Node.js 22.16 or later. In this folder:

```bash
npm ci
npm run dev
```

Before starting, add the required settings to your existing `.env`. Do not replace your existing file with the example. Real env files were not modified during implementation.

| Variable | Required / default |
| --- | --- |
| `MONGODB_URI` | Required; connection URI including the application database |
| `SESSION_SECRET` | Required; random secret of at least 32 characters |
| `PORT` | Defaults to `5000` |
| `NODE_ENV` | `development` locally; `production` on HTTPS deployments |
| `FRONTEND_URL` | Exact client origin; defaults to `http://localhost:3000`; required in production |
| `API_PUBLIC_URL` | Public API origin; defaults to `http://localhost:5000`; required in production |
| `COOKIE_SAME_SITE` | Defaults to `lax`; use `none` only for cross-site HTTPS deployments |
| `TRUST_PROXY_HOPS` | Defaults to `0`; set only for your known proxy topology |
| `GOOGLE_CLIENT_ID` | Optional; required with the secret to enable Google login |
| `GOOGLE_CLIENT_SECRET` | Optional Google secret; server-only |
| `LIVEKIT_URL` | Optional until requesting join tokens; normally `wss://<project>.livekit.cloud` |
| `LIVEKIT_API_KEY` | Server-only LiveKit key |
| `LIVEKIT_API_SECRET` | Server-only LiveKit secret |

Generate a session secret locally:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The existing MongoDB URI passed a read-only connection/ping during implementation. No existing records were changed. `SESSION_SECRET`, Google and LiveKit settings were absent from the inspected real `.env`; supply them yourself. Startup deliberately fails clearly when required configuration or MongoDB/index initialization fails.

### MongoDB

Create an application database/user, permit your development/deployment IP in Atlas, and put the correct URI in `MONGODB_URI`. Percent-encode reserved characters in the password. Startup creates/validates the User/Meeting indexes. Profiles, password hashes, meetings and sessions stay on this server's database.

Passwords use salted asynchronous scrypt (`N=32768`, `r=8`, `p=1`). Password hashes and OAuth IDs are excluded from default model selection and never returned in API DTOs. Credentials registration starts an authenticated session. Sessions are MongoDB-backed, expire after seven days, regenerate on login and are destroyed on logout.

### Cookies, CORS and CSRF

The frontend sends `credentials: include`. Only the exact `FRONTEND_URL` origin is allowed. Before a mutation the client calls `GET /api/auth/csrf`, then sends the returned value as `X-CSRF-Token`. All POST requests require both the matching Origin and a session-bound token, including register/login/logout.

Cookies are HttpOnly and Secure in production. Prefer same-site frontend/API domains so `SameSite=Lax` works reliably. Distinct hosting sites may require `SameSite=None; Secure` and can still be affected by browser third-party-cookie restrictions; a same-site custom domain or reverse proxy avoids that issue. Google OAuth returns from another site, so use Lax rather than Strict for that flow. Set trusted proxy hops accurately when TLS terminates before Express.

Auth endpoint rate limits are local to this single Express process, appropriate for the Day-1 single-instance deployment. A multi-instance deployment would need a shared rate-limit store.

### Google OAuth

Create a Google OAuth Web Application client and set its authorized redirect URI to exactly:

```text
http://localhost:5000/api/auth/google/callback
```

In production use `${API_PUBLIC_URL}/api/auth/google/callback`. Configure your consent screen/test users and put the client ID/secret only in server `.env`. The server validates OAuth state, requires a verified Google email and preserves a validated meeting destination. Existing password accounts are not silently linked to a Google identity with the same email; use password login for those accounts. Manual account linking is outside Day 1.

With either Google setting absent, Google login is disabled and email/password login still works. The providers endpoint tells the UI whether to display the Google button.

### LiveKit

Create a LiveKit Cloud project or configure a server, then add its URL/key/secret. The token endpoint requires an active persisted meeting and authenticated session, derives identity/name from that user, and provisions/reuses the LiveKit room with capacity 7. If the service reports a different capacity it refuses to issue a token. Capacity is enforced by LiveKit, not merely stored in MongoDB or inferred from a headcount.

Tokens expire after 10 minutes and allow joining only the requested room, publishing media/data and subscribing; they do not grant room administration, creation or recording. Missing credentials or provisioning failures return 503. The API secret is never returned. Actual LiveKit connectivity/capacity has not been tested against a configured service yet.

## Endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/health` | Process liveness |
| GET | `/api/auth/csrf` | Session-bound CSRF token |
| GET | `/api/auth/providers` | Google availability |
| POST | `/api/auth/register` | Display name/email/password registration |
| POST | `/api/auth/login` | Email/password login |
| POST | `/api/auth/logout` | Destroy session and clear cookie |
| GET | `/api/auth/me` | Current authenticated user |
| GET | `/api/auth/google?next=…` | Start Google authentication |
| GET | `/api/auth/google/callback` | OAuth callback |
| POST | `/api/meetings` | Create meeting; host from session, optional title |
| GET | `/api/meetings?page=1` | Hosted meetings, 20 per page |
| GET | `/api/meetings/:roomId` | Authenticated meeting lookup |
| POST | `/api/meetings/:roomId/token` | Room-scoped LiveKit credentials; empty JSON body |

All meeting endpoints require authentication. A registered participant possessing an active room's invitation can join; there is no approval/waiting-room system in this milestone. Validation failures use 400, missing authentication 401, origin/CSRF rejection 403, unknown meetings 404, duplicates 409, ended meetings 410, rate limits 429, and service/database failures 503. Error responses do not expose database/secret details.

Meeting has roomId (unique UUID), hostUserId, title, createdAt/updatedAt, endedAt, status and maxParticipants=7. Meeting ending is represented and checked but no end-meeting action is implemented yet.

## Build and test

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm start
```

Tests use a disposable MongoDB and real Express sessions/model operations. LiveKit room provisioning is mocked while its JWT is generated and cryptographically verified. Google consent redirect/state rejection are tested without contacting Google; successful Google authentication requires real credentials and manual verification.

`npm run test:serve` is only the isolated browser-test fixture used by the client Playwright suite. It ignores real `.env` and must not be deployed.

## Repository hygiene

The existing repository already tracks `.env` and some `node_modules` files. Their tracking was not altered and no secrets were committed. New `.gitignore` rules prevent new ignored paths but do not untrack existing files. Package installation updates tracked dependency artifacts; these are generated, not application source edits. Review existing tracked secrets/vendor files before publishing; no Git history or staging state was rewritten here.

See [server delivery details](docs/DAY-1-DELIVERY.md) and the [client delivery report](../online-meeting-platform/docs/DAY-1-DELIVERY.md).

Reference: [Express sessions](https://expressjs.com/en/resources/middleware/session/), [Passport OAuth state](https://www.passportjs.org/tutorials/google/state/), [LiveKit server SDK](https://docs.livekit.io/reference/server-sdk-js/).
