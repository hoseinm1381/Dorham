# Implementation and verification status

Release candidate, 28 October 2026. Source and a compiled deployment branch have been pushed to GitHub with authorization. The application is running at https://dorham.bot-keep.xyz/ on Botkeep's free allocation. The earlier backup operation cleared; the support ticket is closed at the user's request. VPN connectivity enabled live web/Windows testing. No service has been purchased. Implemented means source exists; tested applies only to the stated scenario. See [hosted verification](HOSTED-VERIFICATION.md).

Follow-up: the user's actual Chrome/VPN/Sweden call failed despite working chat. No TURN relay is configured. Observer voice membership and media-failure feedback are fixed in source and tested locally; their live rollout and a real relay-assisted call remain outstanding. See [voice/network follow-up](MEDIA-FOLLOWUP.md). Chrome-only Secure DNS was authorized but could not be applied by automation; Windows DNS remains unchanged.

| Capability | State | Evidence and limits |
| --- | --- | --- |
| TypeScript workspaces, contracts and production bundles | Implemented, tested | ESLint, type checking and builds pass |
| Registration, transactional account cap, Argon2id, CSRF and sessions | Implemented, tested | Concurrent registration, cookie/CSRF, hashing and refresh-reuse checks |
| Separate single-use instance administration | Implemented, tested | Public registration grants no administration; one secret claim succeeds |
| Profiles, avatars, presence | Implemented; partly tested | Hosted avatar upload and native rendering pass; complete presence transitions remain untested |
| Servers, invitations, role hierarchy and channel overrides | Implemented, tested | Invite exhaustion, unauthorized access, hierarchy, removal and live demotion checks |
| Channel chat, DMs, editing, reactions and unread state | Implemented, tested | Real backend/database/browser scenarios; participant restrictions and retries |
| Replies, deletion, pagination and replay | Implemented; partly tested | API deletion/replay/cursors pass; pagination/reply UI acceptance remains untested |
| Browser mesh audio, volume, mute/deafen and screen subscriptions | Implemented, tested | Actual WebRTC decoded audio/video, gain assertions, two publishers and unsubscribe/resubscribe |
| Perfect negotiation, trickle ICE and restart/reconnect paths | Implemented; partly tested | Ordinary real peer negotiation passes; forced ICE failure and long network interruption untested |
| Share allocation/expiry and coordinator fencing/election | Implemented, tested | Concurrent share requests, stale epochs, heartbeat-expiry election and lease cleanup |
| 20 online clients, 16 primary-room members, five global shares | Implemented, control plane tested | 20 actual Socket.IO clients; excess user, room member and lease rejected; no media generated in load test |
| Sustained 16-person media quality | Untested, blocked | Large browser run interrupted for memory pressure; distributed or larger test environment required |
| PWA application-shell caching | Implemented, tested | First-install offline reload works; private API, socket and avatar responses excluded |
| Windows x64 NSIS installation and app shell | Implemented, tested | Install/uninstall exit 0; installed rendering/registration, encrypted credentials, sandbox/isolation and tray-close checks |
| Windows physical microphone/capture, long calls and upgrades | Untested | Interactive hardware/capture and upgrade acceptance required |
| Android native mesh/SFU, Keystore, audio routing and capture/service | Implemented; builds tested | Release/debug builds pass; debug APK signature verifies; minSdk 29/targetSdk 36 |
| Android physical installation/background behavior | Untested, blocked | No connected ADB device/emulator; permission, Bluetooth, lock, capture interruption and OEM tests required |
| SQLite WAL, foreign keys, migrations and backup/restore | Implemented, tested | Online backup, live-restore refusal, offline restore and usable history/session after restart |
| PostgreSQL repository/migrations | Implemented, locally tested | PGlite PostgreSQL SQL engine over TCP through node-postgres/Drizzle; hosted concurrency/recovery untested |
| Retention, quotas and storage pressure | Implemented; partly tested | Warning against committed WAL pages passes; long retention/storage-pressure soak untested |
| External LiveKit API enforcement | Implemented; untested, blocked | Operator SFU host/credentials and networking required; no external service purchased |
| Standalone production deployment bundle | Implemented, tested on Windows | Fresh independent runtime install; compiled startup, readiness, native modules, registration, snapshot and local WebSocket pass |
| Linux runtime and native dependencies | Deployed; partly tested | SQLite, Argon2 registration and Sharp avatar upload work on Botkeep; verified Node bootstrap supplies the pinned patched runtime |
| Botkeep ingress, HTTPS/WSS, polling and durable allocation | Deployed; partly tested | Web/native chat, avatars, WSS opening and explicit polling pass. Existing SQLite data survived a Git fast-forward update/restart; long-idle and hosted load tests remain open |
| Active-socket shutdown/reconnect | Implemented, tested | Fastify preClose closes transports before HTTP drain; authenticated same-database restart regression and hosted automatic reconnect/message commit pass |
| Hosted backup restoration | Tested in isolated local instance | Downloaded stopped-instance backup: SQLite integrity, accounts/message and avatar presence, readiness and authorized avatar CORS pass; no production restore performed |
| Dependency review | npm tested | Zero npm advisory findings in source and standalone runtime trees; no full security audit or Android advisory certification |

The final local load run processed 200 messages across 20 sockets: **93.08 ms p95 acknowledgement**, **325.88 MiB peak RSS**, **303.12 MiB final RSS**, and **4,673,261 database/WAL bytes**. This short sample meets the initial local targets; sustained hosted resource use remains unverified. See [performance](PERFORMANCE.md).

The revised browser budget is 4 GiB. The final two-page suite peaked at **3211.3 MiB combined Chrome/Edge usage** and **1835.3 MiB task-owned usage**, including existing tabs in the combined figure. The guard stops its own processes at 3500 MiB combined usage. The large test remains disabled; no unrelated browser window was closed.

Packages are under `artifacts`: unsigned Windows installer, installable Android debug APK, unsigned Android release output, compiled Botkeep ZIP, source ZIP, logs/evidence and SHA256SUMS.txt. Android debug signing is for local testing. The unsigned release APK requires a private release key before distribution.

## Exact continuation gates

1. Connect an authorized Android 10+ device. Run `adb install -r <debug-apk>`. For local development, run `adb reverse tcp:3001 tcp:3001` and enter `http://localhost:3001`; otherwise use a real HTTPS instance. Exercise microphone/notification denial, Bluetooth permission/route changes, two native viewers, MediaProjection interruption, screen lock, a 30+ minute background call, task removal and force-stop. Save device/API/OEM details and decoded-media evidence.
2. On Windows, exercise physical microphone and the native source picker with another client, fullscreen, tray return/quit and installer upgrades. The automatic shell test does not certify physical capture/audio.
3. Configure external TURN/SFU credentials through environment variables. Test cross-network/forced-relay peers, ICE failure, token expiry, moderator mute/kick/share-stop, subscription changes and SFU API failure. Mesh cannot prevent modified clients from exchanging media independently.
4. Run the 16-person decoded-media workload on separate machines or a separately approved larger environment. Keep this workstation's 4 GiB guard enabled; do not restart the large test here. Record sustained CPU/RSS, bitrate/loss, intelligibility, two room screens and five globally.
5. Complete the remaining [live hosting checks](DEPLOYMENT.md) and consult [current hosted evidence](HOSTED-VERIFICATION.md). Keep the data directory intact during source updates. Hosted load, long idle connections and cross-network media remain separate gates. Repeat private backup exports as real data grows.
6. Supply signing identities only for signed distribution. Keep the Windows certificate and Android release keystore outside source and preserve update identities independently.
