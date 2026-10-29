# Dorham v0.4.0 — inline media and screen-first calls

29 October 2026. This combined update supersedes the proposed v0.3.1. It preserves the existing schema v3 and all account, server, message, attachment and session data. Android builds and device testing remain deferred at the operator's request.

The update is deployed at https://dorham.45-135-242-146.nip.io/. Public readiness, WSS, explicit polling, preview/private-route denial and the frontend bundle checksum pass. All existing rows across 34 application tables were preserved before restart (5 accounts, 1 server and 12 messages at the checkpoint). Database integrity passes. The coordinated private backup was copied off-host and its SHA256 matched; no production fixture accounts were created. Existing public ports, admission header, SFU/TURN and HTTPS routes were retained.

## Features

- Uploaded PNG, JPEG, WebP and GIF images render inside chat, including old attachments. Click to open the keyboard-accessible in-app image viewer; Escape closes it. MP4/WebM attachments render with video controls, seeking and fullscreen support. Browser-supported codecs are required; unsupported or damaged media offers download instead. External website links retain their existing link behavior.
- Attachment previews load near the viewport, stop when moved away, pause video when the app is hidden, and allow only one attachment video to play at a time. They use streamed HTTP responses and single-byte-range support rather than buffering an entire video in JavaScript. The download option and existing upload/retention budgets remain available.
- Screen viewing defaults to the large central area, with participant cards collapsed and compact shared-stream controls. Chat is pushed below the video and its composer becomes compact. Voice controls can expand participant/volume/moderation controls, and Show more chat restores the previous layout choice.
- The members panel can collapse into a narrow 34px strip on desktop and be restored from the toolbar/strip. The preference persists on that device. Small-screen responsive behavior remains available.
- A publisher can enable Preview my screen, which displays the exact local captured video track. Hiding this preview does not stop capture, release the publishing lease or add another network subscription. The preview is muted and its setting persists locally. Browser/Electron mesh and LiveKit implement this; native Android work is deferred.
- Voice join/leave cues now follow immutable snapshots of the authoritative room directory, independently of media-adapter room callbacks. This covers normal Disconnect and closing a participant's tab without duplicate cues from heartbeat or profile updates. Previously granted browser audio permission can resume a suspended cue context; existing sound preferences and Do not disturb still apply.
- Concurrent web session renewals are coalesced, preventing simultaneous preview/download operations from rotating the cookie twice and discarding the session.

## Authorization and resources

`POST /api/v1/attachments/:id/preview` requires normal authentication and CSRF/native authorization plus `requestId`. It returns a five-minute opaque URL scoped to that attachment and the current session. This is a preview-only grant, not a login/access/refresh token. Grants are memory-only, hashed in the lookup map, bounded to 32/session and 512/process, and invalid after restart. Native credentials never enter media element URLs.

`GET`/`HEAD /api/v1/attachments/:id/media` accepts that scoped grant or ordinary authentication, checks the active session and current conversation permission on every request, and requires a ready, unexpired attachment on a nondeleted message. It verifies length, digest and an allowlisted file signature before serving a media MIME type with inline disposition, nosniff, private/no-store, no-referrer and sandbox headers. A 64-entry/60-second integrity cache is keyed by digest and file stat changes; permission checks are never cached. Media previews share the existing four outbound transfer slots with downloads, and maintenance avoids deleting files while readers are active.

Single ranges return 206/Content-Range; malformed, multiple or out-of-bounds ranges return 416. API request logs omit query values. The Caddy runtime logging filter also redacts `media_ticket`; see `deployment/Caddyfile.media.example`. Existing forced downloads stay `application/octet-stream` with attachment disposition.

## Verification

Passed: lint, TypeScript, 50 unit/API/database tests, 9 expansion browser scenarios, 2 inline-media/layout browser scenarios and the 5 existing application/media regression scenarios. The full legacy regression run had one cold ICE setup stall; its isolated decoded-media retry passed. The original failure log is retained as `v04-regression-browser.log`, with the successful retry in `v04-mesh-retry.log`.

Local unit/API, SQLite/PostgreSQL and browser checks cover preview isolation, wrong-file/session/expiry/revocation denial, byte integrity, MIME rejection, ranges/HEAD, image viewing, decoded video/seek/reload, screen geometry, optional own capture, membership sounds, and persisted member-panel collapse. The screen test uses actual decoded synthetic video, not just connection establishment. The measured 1440×1000 layout has a 624px video element and 64px chat history area before expanding/collapsing side panels.

The LiveKit scenario uses a temporary SSH loopback tunnel to the existing SFU, isolated local application databases and unique fixture rooms. It creates no production accounts and never changes public ports or bypasses the production admission gate for public users. Only fixture room UUIDs created by that test are removed afterward. Test credentials stay under ignored `.tools` and are removed when the tunnel closes.

A separate actual installed Windows 0.4.0 run passed PNG image viewing, decoded VP8 WebM and H.264 MP4 playback, optional own screen preview through LiveKit, preserved capture after closing that preview, protected credentials, renderer sandboxing and background-call window lifecycle. The installer returned exit 0 and remains unsigned. The first Windows attempt stopped at fixture navigation before uploads; after explicitly selecting the new server, the complete run passed.

Logs/results are under `artifacts/logs/v04-*` and `artifacts/evidence/v04-*` in the implementation workspace. Browser tests retain the 4 GiB memory guard; saved v0.4 checks peaked below 1.7 GiB combined browser/application memory, including the installed Windows run (798.8 MiB). Physical-device behavior, subjective speaker audibility, 16-person sustained media capacity and national Iran-only outage/DNS routing remain separate acceptance gates.

## Build and operations

Use patched Node 24.22.1+, `npm ci`, `npm run verify`, `node scripts/browser-tests.mjs --media-ui`, `npm run test:expansion`, and the guarded existing browser regression launcher. Build Windows with `DORHAM_PACKAGE_OUTPUT=artifacts/v0.4.0/windows node scripts/windows-package.mjs` after production builds. The NSIS installer remains unsigned. Do not invoke Android builds until the operator requests them.

Prepare a coordinated private backup and preserve the previous application before deploying the compiled server bundle. No database migration beyond existing v3 is needed. Update the Caddy query redaction before serving preview grants, validate configuration, and retain the existing media admission/HTTPS/TURN configuration. Preserve all real accounts and avoid public fixture registration.

## Packages

- `artifacts/v0.4.0/windows/Dorham-0.4.0-Windows-x64.exe` — tested unsigned Windows installer.
- `artifacts/Dorham-0.4.0-Server.zip` — production backend/web bundle.
- `artifacts/Dorham-0.4.0-Source.zip` — source at the matching release commit.

No Android build was started for v0.4.0.
