# Dorham v0.3.0 — social and role update

29 October 2026. Version 0.3.0 is deployed at https://dorham.45-135-242-146.nip.io/; the public bundle checksum, WSS upgrade, explicit polling, private-route isolation and readiness checks pass. The migration preserved all previous rows in 31 existing application tables, including 5 accounts, 1 server and 12 messages at the deployment checkpoint. A private coordinated backup was verified and copied off-host. No production fixture accounts were created.

This update preserves accounts, conversations, server membership and existing built-in roles. Schema v3 is additive on SQLite and PostgreSQL.

## Changes

- Settings shows the package version. Notification preferences independently control direct-message and voice-lobby sounds on each device. Cues are synthesized locally, with no asset downloads. Browsers require an interaction before sound can play; Do not disturb suppresses cues.
- Sending a direct message plays a short confirmation. New incoming DMs outside the focused conversation produce a sound, a clickable notification and unread markers on the conversation and Home. Read cursors survive reloads. Edits, reactions, history replay and duplicate events do not chime. No notification preview is stored in localStorage.
- Voice entry/exit cues follow room membership. Clicking your current voice channel keeps its existing connection and epoch. The main voice panel starts as a compact row; Voice controls expands participants, volumes and moderation. Screen viewing still expands the screen area automatically.
- Server settings retains active invitation links with copy, expiration, remaining joins and revoke controls. New UI invitations default to seven days; one day is also available, with 1–100 joins. Existing API clients retain their 24-hour default. Fifty active invitations/server are allowed. Recent v2 links are recovered from matching idempotency replies during migration; older hash-only links remain valid but cannot be redisplayed if their original reply was already pruned.
- Server owners and administrators can create up to 32 named, colored custom roles, edit their permissions, and assign multiple roles to registered members. Badges appear in the member list. Guests cannot receive roles. Custom roles do not grant ownership, global administration, or the ability to create/assign further roles.
- Custom permissions cover view, write, speak, share, channel management, removal of lower-ranked members, message/voice moderation, and invitation management. Between assigned roles an explicit deny wins over allow; built-in-role channel overrides apply last. Inherit leaves the underlying permission unchanged. Owners/global admins retain their protected access. Management/moderation ranks remain protected; custom moderators cannot manage peers or higher roles. Channel management grants creation/renaming/deletion but changing built-in-role overrides still requires the existing hierarchy.
- Role changes are audited, refresh authorized clients, and immediately revalidate active voice/screen permissions. Removing a role denial restores speech only if no moderator mute remains.
- Saved profile details refresh open profile cards, message authors, member lists and voice rosters. Avatar selection resizes a PNG/JPEG/WebP up to 25 MiB into a small 128px WebP before uploading. Failed uploads leave the current avatar in place; the old file is retired after the new database value commits.

- Direct chats can be closed from their header without deleting history. A new permitted message reopens the chat, and opening the person again restores the same conversation. Blocking stops new DMs, typing and uploads in both directions; unblock from the chat/profile or Settings → Blocked people. Blocks do not suppress shared server messages or voice.
- Server settings includes an explicit Leave server confirmation for non-owners. Leaving removes membership, custom roles, tags and active voice/shares while preserving messages for remaining members. Rejoining needs an invitation. Owners must use the separate existing delete-server control; leaving never deletes a server implicitly. Global administrators retain their administrative visibility even after leaving membership.

## Verification

Passed: lint, TypeScript, 44 unit/integration tests, 9 expansion browser scenarios and 5 existing browser regressions, including decoded synthetic WebRTC audio/video. The final regression browser run peaked at 2,223.3 MiB combined Chrome/Edge memory, below the 4 GiB budget.

See `artifacts/logs/social-verify.log`, `social-browser.log`, `social-regression-browser.log` and `artifacts/evidence/social-*.png` in the implementation workspace. API/database integration covers role scoping, escalation denial, invite retries/revocation, active voice revalidation, profiles, additive migration and PostgreSQL. Browser scenarios cover the actual settings, role assignment, persisted invitations, cross-client profile/avatar refresh, DM cues and unread markers, compact voice, repeated channel clicks and join/leave cues.

The Windows x64 NSIS installer was installed in an isolated directory (exit 0) and passed native registration, visible 0.3.0 settings, protected credentials, renderer sandboxing and background-call close behavior against an isolated backend. Its guarded run peaked at 1,381.1 MiB combined browser/application memory. The installer remains unsigned.

Physical speaker audibility, Android device behavior, 16-person sustained SFU capacity and Iran-only outage/DNS routing remain separate verification gates. The temporary hostname still relies on external DNS; this update does not certify national-outage availability.

## API additions

All mutation bodies require `requestId`; normal authentication, CSRF and authorization apply.

- `GET /api/v1/servers/:id/invites` returns `{ invites: [{ code, url, expiresAt, remaining }] }` to members with invitation permission.
- `DELETE /api/v1/servers/:id/invites/:code` revokes that server's matching link.
- `GET /api/v1/servers/:id/roles` returns `{ roles: [{ id, serverId, name, color, permissions }] }` to members.
- `POST /api/v1/servers/:id/roles` creates `{ name, color, permissions }`, edits with `roleId`, deletes with `{ roleId, delete: true }`, or assigns/removes with `{ roleId, userId, assigned }`. Owner/administrator only.
- `POST /api/v1/dms/:id/close` hides only the caller's DM; history remains.
- `POST /api/v1/users/:id/block` accepts `{ blocked }`; blocks are returned in bootstrap.
- `POST /api/v1/servers/:id/leave` leaves the caller's membership and revokes its voice session.
- Membership responses include `customRoles`; bootstrap servers include resolved `permissions`.

Build with `npm ci`, `npm run verify`, `npm run test:expansion` and `npm run deploy:bundle` on patched Node 24.22.1+. Windows/Android packaging uses the root package version. Back up database, uploads and private configuration before upgrading; keep the previous application and backup for coordinated rollback.

## Packages

- Windows: `artifacts/v0.3.0/windows/Dorham-0.3.0-Windows-x64.exe` (unsigned, installation tested).
- Compiled backend/web: `artifacts/Dorham-0.3.0-Server.zip`.
- Source: `artifacts/Dorham-0.3.0-Source.zip` from the matching Git commit.

The in-progress Android build completed before the operator deferred further Android work. Further Android builds, signing checks and device tests are deferred until requested; web and Windows are the current delivery focus.
