# Server Day-1 delivery

The Express application now exclusively owns authentication, MongoDB, meeting management and LiveKit token generation. See [README](../README.md) for configuration, security behavior, endpoints and run commands; see the [combined delivery report](../../online-meeting-platform/docs/DAY-1-DELIVERY.md) for the complete audit and verification.

Server typecheck, lint and production build pass. Seven API/domain tests pass against temporary MongoDB with real sessions and model persistence. Google state rejection is tested; successful Google login is not. LiveKit JWTs are generated/verified and provisioning options tested through an injected test provisioner; actual LiveKit service operation is unverified until credentials are supplied.

Real MongoDB configuration passed a read-only ping. The existing `.env` remains byte-for-byte unchanged; add SESSION_SECRET before using the regular startup command. No records were written to the existing database during verification. Browser end-to-end tests use a separate disposable database.

The repository already tracked `.env` and `node_modules`. New ignore rules do not remove their existing Git tracking. No staging/history changes were made. Generated dependency modifications are reported separately from application source.

## Files created

- `.env.example`
- `.gitignore`
- `README.md`
- `docs/DAY-1-DELIVERY.md`
- `eslint.config.mjs`
- `src/app/config/env.ts`
- `src/app/middleware/csrf.ts`
- `src/app/modules/auth/auth.routes.ts`
- `src/app/modules/auth/google.ts`
- `src/app/modules/auth/password.ts`
- `src/app/modules/auth/session.ts`
- `src/app/modules/livekit/livekit.service.ts`
- `src/app/modules/meeting/meeting.model.ts`
- `src/app/modules/meeting/meeting.routes.ts`
- `src/app/modules/user/user.model.ts`
- `src/app/shared/errors.ts`
- `src/app/shared/return-path.ts`
- `src/types/express.d.ts`
- `tests/e2e-server.ts`
- `tests/foundation.test.ts`

## Existing files changed/removed

- `package-lock.json` — modified
- `package.json` — modified
- `src/App.ts` — modified
- `src/app/config/database.ts` — modified
- `src/server.ts` — modified
- `tsconfig.json` — modified
