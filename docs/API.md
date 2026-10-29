# API and events

HTTP responses return data directly. Errors use `{ error: { code, message } }` with an appropriate HTTP status. JSON mutation bodies include a UUID `requestId`. Durable service mutations deduplicate that identifier for 24 hours. Authentication/refresh and ephemeral media handshakes are deliberately separate from durable message deduplication.

Use `Authorization: Bearer <access>` on native HTTP calls. Web calls use the session cookie plus `X-CSRF-Token` on unsafe methods and an allowed `Origin`. Native login/register sends `X-Dorham-Native: 1`. Native tokens must never be placed in localStorage or URLs. `/auth/me` returns the current public user and CSRF token.

## Routes under `/api/v1`

| Method | Route | Input / behavior |
| --- | --- | --- |
| GET | `/config` | Public registration and transport configuration |
| POST | `/auth/register` | username, displayName, password; transactional account cap |
| POST | `/auth/login` | username, password; create session |
| POST | `/auth/refresh` | refreshToken; rotate native access/refresh credentials |
| GET | `/auth/me` | Current user and CSRF proof |
| POST | `/auth/logout` | Revoke current session and its sockets |
| POST | `/auth/password` | currentPassword, password; revoke other sessions |
| POST | `/admin/claim` | Single-use bootstrap secret |
| GET | `/bootstrap` | Authorized servers/channels/DMs, public directory, unread cursors |
| GET | `/presence` | Currently connected user identifiers |
| PATCH | `/profile` | displayName, bio, status |
| POST | `/profile/avatar` | One PNG/JPEG/WebP multipart file, ≤256 KiB; `X-Request-Id` header |
| POST | `/servers` | name; create server and default text/voice channels |
| PATCH | `/servers/:id` | name or delete=true; owner-only deletion |
| POST | `/servers/:id/channels` | name, kind=text/voice |
| PATCH | `/channels/:id` | name, delete=true, or role + permissions |
| POST | `/servers/:id/invites` | hours=1..168, uses=1..100 |
| POST | `/invites/join` | code; transactional use decrement |
| GET | `/servers/:id/members` | Authorized membership directory |
| PATCH | `/servers/:serverId/members/:userId` | role or remove=true; hierarchy enforced |
| POST | `/dms` | userId; unique two-party conversation |
| GET | `/conversations/:id/messages` | `before` sequence: 50-message history page |
| GET | `/conversations/:id/messages?after=N` | Up to 200 replay events or reset=true |
| POST | `/messages` | conversationId, content, optional replyTo |
| PATCH | `/messages/:id` | content, delete=true, or emoji + optional removeReaction |
| POST | `/conversations/:id/read` | sequence; monotonic, clamped to committed sequence |
| GET | `/voice/:id` | Authorized current room state |
| POST | `/voice/:id/moderate` | userId, action=mute/unmute/kick/stopShare |
| GET | `/admin/metrics` | Instance-admin-only process, capacity, and storage metrics |

Public `/health` checks process availability; `/ready` also queries schema readiness. Avatars have randomized public image URLs, contain no supplied filename, and are decoded/re-encoded to WebP. Message content is plain text, 1–4000 characters. Supported reactions are 👍 ❤️ 😂 🎉 👀 ✅.

## Socket.IO

Handshake auth is `{ csrf }` with the web cookie, or `{ token }` for native clients. Every acknowledged event returns `{ ok: true, data }` or `{ ok: false, error: { code, message } }`. Authentication validity is checked again for each action; recovery never bypasses middleware.

| Client event | Payload |
| --- | --- |
| `message:send` | Same as POST `/messages`; same deduplication identifier |
| `typing` | conversationId, active |
| `voice:join` | channelId, eligible; returns fenced epoch, room, ICE servers |
| `voice:leave` | requestId |
| `voice:heartbeat` | eligible; refresh own active membership/share |
| `voice:state` | muted, deafened, requestId |
| `voice:signal` | channelId, to, epoch, description/candidate/streams/subscription |
| `share:start`, `share:stop` | requestId; reserve/release own screen lease |
| `voice:sfu` | channelId; short-lived source-scoped LiveKit credentials |

Server events: `conversation:event`, `state:changed`, `presence`, `typing`, `voice:room`, `voice:signal`, `voice:removed`, and `capacity`. Conversation events carry conversationId, sequence, kind, and payload. Clients discard duplicates and request replay on gaps. A successful replay may need multiple pages; reset means load a fresh authorized snapshot.

Permission defaults and types are defined in `packages/contracts`. Channel overrides apply to role defaults; server owners retain all rights. Managing a member requires a strictly higher role. Channel access requires both view and the requested capability. DM history and events are limited to its two members.

## Expansion routes (v0.2, same `/api/v1` version)

All unsafe JSON requests carry `requestId`; cookie requests also require allowed Origin and CSRF proof. Binary content uses its previously authorized reservation ID.

| Method | Route | Behavior |
| --- | --- | --- |
| POST | `/auth/guest` | displayName, invite code, optional language; shared account cap |
| POST | `/auth/upgrade` | convert the existing guest ID using registration fields |
| POST | `/auth/renew` | rotate/extend a web session, CSRF required |
| GET / POST | `/auth/sessions`, `/auth/sessions/revoke` | own device list; revoke sessionId or all |
| GET / POST | `/auth/recovery`, `/auth/recovery-codes`, `/auth/recovery-question` | settings, one-time code issuance, optional supporting question |
| POST | `/auth/recover` | username, code, password; no question-only recovery |
| GET | `/admin/users`, `/admin/audit` | global administrator only |
| POST | `/admin/users/:id` | ban/unban/revoke/resetPassword; hierarchy/audit |
| GET | `/channels/:id` | authorized internal link resolution |
| POST / PATCH | `/servers/:id/tags`, `/voice/:id/policy` | scoped tags and ANY/ALL gates, lock and limit |
| POST | `/voice/:id/moderate`, `/voice/:id/move` | persistent mute/deafen/sharing restriction, kick/stopShare, room move |
| POST | `/attachments` | conversationId, name, size; reserve rolling quota atomically |
| POST | `/attachments/:id/content` | raw octet stream, exact reserved byte count |
| DELETE | `/attachments/:id` | cancel an unpublished reservation; quota not refunded |
| GET | `/attachments/:id/download`, `/uploads/usage` | authorized forced download; rolling usage |

Message mutations may include `attachmentIds`; files must be ready, owned by the sender, in the same conversation, and not previously attached. Message/event views include metadata and availability, never direct public filesystem paths.

`voice:move` asks the target media adapter to leave and join the authorized destination. `voice:changed` refreshes server deafening, restrictions and share state. Session invalidation disconnects sockets. The private `/internal/media/admission` endpoint is available only to the trusted signaling proxy; block `/internal/*` at every public origin. Its credentials must never be sent to a client.
