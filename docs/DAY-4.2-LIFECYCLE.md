# Day-4.2: authoritative meeting termination

## Ownership and state

Previously, Leave only disconnected the local LiveKit client; MongoDB already stored a unique UUID roomId, hostUserId, active/ended status, endedAt, and a seven-participant limit. No end endpoint existed. No meeting endpoint used an upsert.

The database remains authoritative. Only the authenticated session user matching the persisted hostUserId may end a meeting. Request bodies are strictly empty; identity, names, metadata and client host flags are not accepted. Existing session authentication, origin/CSRF protections and route protection remain in use. Ordinary host/guest Leave, refresh, navigation and network loss do not call the end endpoint.

```text
active → ending → ended
           ↑        |
           └ retry  └ terminal; no reopen or ID reuse
```

A host request first atomically changes active to ending, even while a token operation is in progress. Ending and ended both reject lookup and token issuance. LiveKit deletion then confirms absence; only after success are ended, server-generated endedAt and session-derived endedBy persisted. Errors never revert to active. Ended records remain permanent tombstones. Creation retries a UUID collision up to three times; it never replaces an existing record.

New schema fields are endedBy and an internal operationLease {owner, expiresAt}; ending extends the status enum. roomId and hostUserId are immutable in Mongoose. Existing unique roomId and hostUserId/createdAt indexes are unchanged. There is no TTL index, destructive migration, transaction, queue, or meeting expiry timer.

Legacy compatibility uses lean reads to avoid hiding missing fields behind Mongoose defaults. A valid legacy record with absent status and no termination metadata is effectively active; new records explicitly store active. Unknown/null status, inconsistent active termination metadata, missing host, invalid capacity or missing creation date fail closed. Explicit ending/ended never becomes active. No bulk migration is required.

## API

`POST /api/meetings/:roomId/end` with session cookies, existing CSRF header and `{}` body:

| Condition | Response |
| --- | --- |
| Host, active; deletion confirmed | 200 `{ meeting }`, status ended |
| Host, already ended | 200 same terminal timestamp/host; no deletion repeated |
| Host, ending | Retry deletion safely; 200 on confirmation |
| No authenticated session, valid CSRF | 401 |
| Missing/invalid CSRF or untrusted origin | Existing 403 middleware response |
| Authenticated non-host | 403 `HOST_REQUIRED` |
| Invalid UUID / nonempty body | 400 |
| Unknown UUID | 404 |
| Deletion/configuration/confirmation failure | 503 `MEETING_END_RETRY`; remain non-joinable |
| Busy operation lease | 503 `MEETING_BUSY`; retry |

Lookup and token endpoints return 410 with `MEETING_ENDING` or `MEETING_ENDED`. An authenticated host's ending lookup also returns canEnd:true to support recovery after reload. No credentials, database lease, or provider error body is serialized. The existing paginated host list includes terminal records for status visibility.

## LiveKit and concurrency

Installed livekit-server-sdk 2.19.0 `RoomServiceClient.deleteRoom(roomId)` uses server-only configuration. This disconnects all room participants. Only the installed SDK's ServerError with status 404 and code not_found is accepted as confirmed absence; authentication, timeout, other 404 and network errors are failures. Logs contain a fixed operational message, never raw provider errors. Provider calls use an eight-second request timeout with SDK failover disabled, giving the host an explicit retry rather than unbounded internal retries.

A MongoDB operation lease serializes application room provisioning/token work with deletion across Express processes. Lease acquisition waits at most two seconds. The lease expires after 120 seconds to recover from a crashed process; a host can retry afterward. Changing to ending is independent of the lease so new joins stop immediately. Owners release only their own lease. Expired/stolen leases cannot finalize shutdown or pass the token check. Simultaneous hosts serialize deletion; duplicates retain the original endedAt and endedBy.

Token routes check persisted active state before acquisition, under the lease, after asynchronous provisioning/signing, and again before returning credentials. There is no upsert or restore endpoint. New access tokens have a 60-second initial lifetime (previously ten minutes), while room-scoped grants and capacity remain unchanged. A token request that overlaps the active-to-ending transition is rejected by the final checks; an in-flight provisioning operation must release its lease before deletion proceeds.

## Limits that must remain explicit

Database checks cannot be atomic with delivery of HTTP bytes or provider admission. A state change can occur just after the last check; a previously issued bearer token may already be in transit. Deletion disconnects the room, but universal revocation of every cached JWT is not guaranteed by DeleteRoom. Self-hosted LiveKit can accept a still-valid cached token and automatically create a room. Provider-refreshed credentials may live longer than the application's initial 60-second JWT. `roomCreate:false` is not a universal prohibition on join-triggered room creation. The application never supplies a fresh token, reconnect action or usable ended link after termination, but a custom client holding provider credentials is outside that guarantee.

A process stalled longer than the lease, or a remote request continuing after a network timeout, cannot be perfectly fenced by a MongoDB lease because LiveKit has no shared transaction/fencing token with MongoDB. Ending remains non-joinable and host retry reconfirms deletion. A failed deletion can leave current participants connected until successful retry. There is no automatic job to finish an abandoned ending meeting. These are documented distributed-system/provider limits, not claims of universal revocation.

Provider references: [DeleteRoom](https://docs.livekit.io/reference/other/roomservice-api/), [token expiration and revocation](https://docs.livekit.io/frontends/reference/tokens-grants/), [connection and disconnection](https://docs.livekit.io/intro/basics/connect/).

## Client integration and verification

The client uses an accessible native modal dialog with Cancel focus, keyboard containment, Escape/cancel before submission, a destructive button, a pending submission lock, abort-on-unmount and retryable errors. Closing a browser does not undo a request already received by Express. Success is not optimistic. A pending dialog stays mounted if LiveKit disconnection arrives before its HTTP response.

ROOM_DELETED produces a terminal UI, releases tracks, removes room listeners and unmounts the existing caption and recognition components. Their existing cleanup unsubscribes caption transport and disposes recognition sessions/timers. Other disconnection reasons retain their previous recovery behavior. Lookup/token 410 also locks out further join attempts. Direct ended links never mount pre-join or request media/token. Dashboard raw IDs, paths and full links remain local and show a safe ended message. Hosts can retry ending from an ending route or the dashboard.

`tests/termination.test.ts` uses real temporary MongoDB and real session/CSRF middleware, mocking only provider boundaries. It covers ownership, transitions, endpoint errors, missing rooms, retry, idempotency, concurrent ends, token/delete overlap, legacy records, collision retention and lease recovery. `tests/e2e-server.ts` has opt-in DAY42_TESTING fault injection only at DeleteRoom, only for a specifically titled temporary test meeting; this is not reachable through the production server entry point. All other deletion calls use the configured real provider.

Run server: `npm run dev` (existing server .env required). Verification: `npm ls --depth=0`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`. Client commands, observed results and the exact two-browser procedure are in the companion client document `docs/DAY-4.2-DELIVERY.md`.
