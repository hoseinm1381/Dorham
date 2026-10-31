Current release: **0.7.5**, deployed to the Iranian pilot. Recent DM conversations, invitation destinations, recovery onboarding, server icons, optional local voice clarity and +30 dB boost, and a screen-sharing setup popup. Lint, types, 145 unit/API tests, seven application regressions, six new UI/audio scenarios, direct/SFU gain and sharing checks, and public Chrome/installed-Windows media checks pass. Schema 9 is additive; data, files and runtime configuration are preserved. See [behavior and release verification](RELEASE-0.7.5.md). Android and physical-acoustic acceptance remain open.

Previous release: **0.7.4** adds visible quality and bandwidth controls beside Share screen, 300–1500 kbps ceilings, live updates and remembered preferences. See [screen-sharing behavior and verification](RELEASE-0.7.4.md) and `artifacts/v0.7.4`. Schema 8 and dependencies are unchanged; the pilot's only configuration change raises the screen ceiling from 450 to 1500 kbps. Existing media-capacity and Android limitations remain applicable.

Previous release: **0.7.2**, deployed to the Iranian pilot. All eight games receive experience improvements, including turn guidance, replay, drawing undo, mobile layouts and departure-rule fixes. Lint, types, 134 unit/API tests, production builds, individual game browser checks and public Chrome/installed-Windows game/media checks pass. All 40 installed web files and four shell files match. The independent backup verifies 38 tables and four files; deployment preserves 35 persistent table digests, three avatar/attachment files and exact configuration. See the [per-game changes and final release checks](RELEASE-0.7.2.md) and `artifacts/v0.7.2`.

Previous release: **0.7.1** added microphone-gain recovery and local voice playback. Its physical-microphone report remains unconfirmed; see [measurements and limitations](RELEASE-0.7.1.md). No new media-capacity certification, fresh advisory audit or Android build is included in this patch.

Previous release: **0.7.0**, deployed with seven games alongside Chess, supported-player badges and watch-first joining. See [RELEASE-0.7.0.md](RELEASE-0.7.0.md), [GAMES-0.7.0.md](GAMES-0.7.0.md) and `artifacts/evidence/v070-release.json` for its baseline game/media checks.

The 2026-10-30 [administrator game-access hotfix](GAME-ADMIN-ACCESS-FIX.md) also passes 16 focused API regressions and a two-account Chrome Poker/Chess scenario. It fixes an authorization mismatch for administrators without explicit membership; no client download is required.

Previous release: **0.6.1** — [voice-channel Games and watch-first Chess](RELEASE-0.6.1.md).

Previous release: **0.6.0**, deployed to the Iranian pilot. All 100 unit/API tests, eight core/chess Chrome scenarios, installed Windows/native talk keys, public Chrome/Windows shared chess and bidirectional SFU media checks pass. Backup verification, schema-6 migration and data/configuration preservation pass. See [RELEASE-0.6.0.md](RELEASE-0.6.0.md), [CHESS.md](CHESS.md) and `artifacts/evidence/v060-release.json`. Previous media/capacity limitations below remain applicable.

Current release: **0.5.4**, deployed through the authorized Iranian pilot workflow. Personal mute/unmute sounds work with the microphone button and talk hotkeys, remain local, respect the voice-sound setting, and avoid duplicates on unchanged state. Lint, types, 89 unit/API tests, production builds, seven core browser scenarios and the dedicated local-audio cue test pass. The installed Windows/background-hotkey test verifies cues while hidden. Public Chrome/Windows cue/media checks and deployment data/configuration preservation also pass. See [release verification](RELEASE-0.5.4.md). Existing capacity limitations remain open.

Previous release: **0.5.3** — [outgoing microphone gain](RELEASE-0.5.3.md).

Previous release: **0.5.0** — [release verification](RELEASE-0.5.0.md) and [features](GAMING-0.5.0.md). Paragraphs below retain historical checkpoints.

Previous update: **0.4.4** — [compact upload allowance](COMPACT-UPLOAD-0.4.4.md).

Current audio-controls update: **0.4.3**. See [AUDIO-FIX-0.4.3.md](AUDIO-FIX-0.4.3.md).

# Implementation and verification status

**Current 0.4.2:** Persian typography/translation/RTL improvements and authenticated chat-server RTT badges. The public shell includes its Persian font for offline use. See [scope and verification](PERSIAN-PING-0.4.2.md). The previous heavy SFU capacity failure is unchanged; Android remains deferred.

**Current 0.4.1:** deployed voice control-plane optimizations and configurable push/toggle hotkeys, including tested Windows background input. Lint, types, 58 unit/API tests, production builds, nine expansion browser checks, focused SFU screen/hotkey checks and installed Windows checks pass. The ten-user/four-share media capacity gate still fails with packet loss/timeouts; see [measurements and limitations](OPTIMIZATION-0.4.1.md). Android is deferred. Paragraphs below are historical checkpoints.

**Current v0.2.0 expansion:** deployed to the Iranian pilot with accounts/history preserved. Guests, recovery/device controls, attachments with the approved 512 MiB/1 GiB policy, Persian/RTL, tags/moderation and screen modes are implemented. See [current capability matrix, tests and remaining gates](UPGRADE-STATUS.md). All paragraphs below are historical checkpoints.

Iranian pilot update, 29 October 2026: the authorized one-month Ninecraft VPS was purchased for 348,000 toman. Web/API/SQLite and LiveKit 1.13.11 with integrated TURN/TLS are running on the new host. Public API/socket smoke and two-client decoded SFU audio/video pass, including a separately forced TURN/TLS-only run. Speaking outline, screen-first layout and 450 kbps/12 fps publishing limits pass there. Traffic monitoring runs every minute with local quota warnings. The Windows pilot installer installed successfully and the installed app passed SFU media with Chrome. Restart persistence and isolated backup restoration pass. Botkeep production data has not been migrated. See [Ninecraft operations, evidence and limitations](NINECRAFT.md). Older paragraphs below record prior local/Botkeep checkpoints, not the current pilot deployment.

Local follow-up, 29 October 2026 (not deployed): quiet decoded mesh audio now drives a green avatar outline independently of playback volume. Screen viewing takes priority over chat by default, with a saved opt-out and mobile layout. The two-client regression passed initially; a later rerun passed the existing decoded-media scenario, then the memory guard stopped the suite at 3539.9 MiB combined Chrome/Edge usage before the remaining checks completed. The added decoded-video screenshot assertion has not completed that rerun. Unit/integration tests: 20 passed; lint, type checking and API/web/desktop builds passed. Fixed screen publisher caps default to zero (disabled); lease ownership/expiry and 16-member rooms remain. The updated 20-socket load test passed with 20 screen leases and 200 messages: 110.49 ms p95 acknowledgements, 348.86 MiB peak RSS. This generates no media and certifies no SFU capacity.

Hosting decision: one Iranian VPS for web/API/database and self-hosted LiveKit with its own TURN fallback; budget up to 400,000 toman/month. Runflare's paid package list fails in upgrade/new-project flows; no purchase was made, and the operator declined support contact. No new host or SFU deployment is accepted. See [hosting comparison and continuation](RUNFLARE.md).

Release candidate, 28 October 2026. Source and a compiled deployment branch have been pushed to GitHub with authorization. The application is running at https://dorham.bot-keep.xyz/ on Botkeep's free allocation. The earlier backup operation cleared; the support ticket is closed at the user's request. VPN connectivity enabled live web/Windows testing. No service has been purchased. Implemented means source exists; tested applies only to the stated scenario. See [hosted verification](HOSTED-VERIFICATION.md).

Follow-up: observer voice membership and media-failure feedback are deployed; an actual hosted observer saw a test participant without joining voice, and normal leave cleared the list. A free external ExpressTURN relay is now configured and verified with forced-relay decoded audio and two screen shares through the public backend, in both Chrome/Chrome and installed Windows/Chrome tests. The operator confirmed the follow-up call worked. See [relay setup and evidence](EXPRESSTURN.md) and [voice/network follow-up](MEDIA-FOLLOWUP.md). The user explicitly deferred VPN-free access while choosing another host; Windows DNS remains unchanged.

Cloudflare TURN preparation: server-side credential integration, configuration validation and five controlled-response tests pass (19 unit/integration tests total). Live Cloudflare activation is blocked by the account's mandatory card/billing subscription page; no billing, subscription or key was activated. See [setup and limits](CLOUDFLARE-TURN.md).

Audio follow-up: the operator confirmed the relay-assisted call worked. Web/Windows now expose noise suppression and echo cancellation preferences, both enabled by default, with actual microphone settings and an explicit rejoin notice for pending changes. Browser capture tests verify defaults, saved/reloaded preferences, applied off/on after rejoin and mute preservation. Android continues requesting native automatic processing. See [audio processing](AUDIO-PROCESSING.md); acoustic attenuation on physical devices is not quantified.

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
| External TURN on the public backend and Windows client | Configured, tested with synthetic sources | Free ExpressTURN; both clients forced through relay, selected relay pairs, decoded audio and two non-black screen streams; physical remote call remains open |
| Perfect negotiation, trickle ICE and restart/reconnect paths | Implemented; partly tested | Ordinary real peer negotiation passes; forced ICE failure and long network interruption untested |
| Share allocation/expiry and coordinator fencing/election | Implemented, tested | Concurrent share requests, stale epochs, heartbeat-expiry election and lease cleanup |
| Historical pre-0.5 control-plane capacity | Implemented locally, control plane tested | 20 actual sockets and 20 screen leases; excess user/room member rejected and duplicate publication prevented; old deployments require environment changes; no media generated |
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

The latest local load run processed 200 messages across 20 sockets: **110.49 ms p95 acknowledgement**, **348.86 MiB peak RSS**, **348.80 MiB final RSS**, and **4,665,045 database/WAL bytes**. This short sample meets the initial local targets; sustained hosted resource use remains unverified. See [performance](PERFORMANCE.md).

The revised browser budget is 4 GiB. The final two-page suite peaked at **3211.3 MiB combined Chrome/Edge usage** and **1835.3 MiB task-owned usage**, including existing tabs in the combined figure. The guard stops its own processes at 3500 MiB combined usage. The large test remains disabled; no unrelated browser window was closed.

Packages are under `artifacts`: unsigned Windows installer, installable Android debug APK, unsigned Android release output, compiled Botkeep ZIP, source ZIP, logs/evidence and SHA256SUMS.txt. Android debug signing is for local testing. The unsigned release APK requires a private release key before distribution.

## Exact continuation gates

1. Connect an authorized Android 10+ device. Run `adb install -r <debug-apk>`. For local development, run `adb reverse tcp:3001 tcp:3001` and enter `http://localhost:3001`; otherwise use a real HTTPS instance. Exercise microphone/notification denial, Bluetooth permission/route changes, two native viewers, MediaProjection interruption, screen lock, a 30+ minute background call, task removal and force-stop. Save device/API/OEM details and decoded-media evidence.
2. On Windows, exercise physical microphone and the native source picker with another client, fullscreen, tray return/quit and installer upgrades. The automatic shell test does not certify physical capture/audio.
3. Repeat the physical cross-network call using the configured external TURN. Forced-relay Chrome and installed Windows media pass; long outage/recovery, credential expiry and real microphone/monitor quality remain open. SFU deployment, moderator API enforcement and SFU failure still require an operator host. Mesh cannot prevent modified clients from exchanging media independently.
4. Run the 16-person decoded-media workload on separate machines or a separately approved larger environment. Keep this workstation's 4 GiB guard enabled; do not restart the large test here. Record sustained CPU/RSS, bitrate/loss, intelligibility and the requested 1–2 sustained screens, then increase publishers with selective subscriptions. No fixed publisher cap is a policy change, not unlimited media capacity.
5. Complete the remaining [live hosting checks](DEPLOYMENT.md) and consult [current hosted evidence](HOSTED-VERIFICATION.md). Keep the data directory intact during source updates. Hosted load, long idle connections and cross-network media remain separate gates. Repeat private backup exports as real data grows.
6. Supply signing identities only for signed distribution. Keep the Windows certificate and Android release keystore outside source and preserve update identities independently.
