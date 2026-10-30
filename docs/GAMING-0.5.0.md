# Dorham 0.5.0 release candidate

This is a local candidate. The Iranian pilot remains 0.4.4. Do not deploy or push this release as accepted while the required five-minute decoded-media capacity gate is failing. Existing accounts, files, messages and saved server addresses remain intact. Android work, hosting/domain migration, search, mentions, webcams, recording and transcription are deferred.

## Interaction changes

Voice membership stays beneath each channel. The persistent dock contains microphone, deafen, screen sharing, connection diagnostics and Disconnect. Selecting the joined channel does not reconnect. Streams have a LIVE badge and an explicit Watch stream action. Joining, Home and community navigation never implicitly subscribe to a screen. Home/community navigation closes stream subscriptions while preserving voice.

One stream is watched by default. Multi-view explicitly permits up to three remote streams from the joined room. A large central viewer has an optional chat drawer which follows the selected text channel. Closing it releases screen video and screen audio. Own-screen preview is optional. Member lists collapse independently. Settings are grouped into Profile, Audio, Notifications, Privacy and Advanced; version remains visible, and language selection is in Profile.

Audio settings include saved input/output choices, device-change fallback, per-person voice levels, local microphone/speaker tests and existing processing/PTT options. Screen sound has independent volume and mute. Deafen overrides both voice and screen sound immediately. Microphone mute/PTT does not mute screen sound.

## Sharing policy, schema and compatibility

Schema 4 adds override revisions and lease allocation metadata without replacing existing data tables. Three standard slots are global. They are eligible for 720p/30fps, but every new share starts at 720p/15fps. Once those slots fill, a room with no current publisher can obtain one fallback lease capped at 15fps. A room with a publisher cannot obtain another fallback. No separate global fallback cap is claimed. Existing 20-online-user, 16-room-member, one-voice-session and one-share-per-account rules still apply.

Reconciliation runs inside serialized database transactions through the existing five-second maintenance path and membership/mutation paths. Standard slots go to the oldest fallback, ordered by start time and lease ID. Promotion increments the policy revision and notifies the owner; it leaves capture and requested fps at 15 until explicitly changed.

Use these deployment settings together:

```dotenv
STANDARD_SHARE_SLOTS=3
MAX_ROOM_SHARES=0
MAX_GLOBAL_SHARES=0
SCREEN_MAX_BITRATE=450000
SCREEN_MAX_FRAME_RATE=30
```

Screen-media encoding reserves up to 48 kbps for opted-in audio and approximately 402 kbps for video. Video without sound can use 450 kbps. Lower resolution modes remain available. Transport overhead is additional. These official-client settings are not a bandwidth billing firewall or an enforcement guarantee against modified clients.

New publications require sharing protocol 2. Old clients can retain supported chat/voice functions but must upgrade before sharing. Existing Android packages are not protocol-2 sharing clients; their upgrade and device acceptance remain deferred. Do not use the candidate against a schema-3 server for permission administration or optional screen audio.

## Optional sound and platform limits

Sound is off by default. Browser capture requests tab audio, excludes system audio, and requests own-audio exclusion. A source that returns no audio continues sharing video and reports that limitation. SFU grants authorize screen audio only while an opted-in lease exists; stop, expiry, permission removal and moderation revoke it with video.

Windows system audio is deliberately disabled (`systemAudioSafe=false`) until an actual OS loopback regression proves that Dorham's received audio is excluded. Video sharing remains enabled. No claim is made that capture can isolate one game's sound. The installed Electron path retains sandboxing, context isolation, protected credentials and the narrow hotkey bridge. Idle windows can throttle rendering; active calls disable that throttling to preserve audio/signaling/PTT.

## Reliability changes

- Saved permission documents load before editing. Saves require the expected revision and reject stale administrators instead of overwriting their work.
- Proxy trust defaults to none. Configure only the actual reverse-proxy source range, overwrite forwarding metadata at the proxy, and retain loopback-only backend ingress. Authentication has separate address and normalized-account attempt budgets. General authenticated requests have per-account budgets plus an independent, higher source-address ceiling. See [proxy configuration](PROXY-0.5.0.md).
- Drafts keep text, reply/edit IDs and authorized uploaded attachment references per account/origin/conversation. Storage has a 1 MiB serialized ceiling, 200-record bound and seven-day expiry. It excludes blobs and quoted private message history, clears on logout/revocation/lost access, and checks attachment availability when restored.
- Pending/failed/retry states retain the original request ID. Lost responses can be retried explicitly without duplicate database commits. Late completions cannot clear another channel or a newer draft. Reconnection never silently sends. Retries are disabled after the server's 24-hour receipt window.
- Ordinary reads, mutations and authentication use 15-, 20- and 30-second deadlines respectively. Upload transfers have their own 15-minute limit and explicit cancellation.
- Visible, focused message rows drive coalesced read acknowledgement. Replay progress remains separate. Unread dividers and Jump to latest are available. Variable-height history has bounded rendered rows, scroll anchors and a 2,000-message loaded bound.

## Verification and current limitations

The candidate adds lasting regressions for saved overrides, proxy isolation, drafts and focused unread state. SQLite and the PostgreSQL wire test adapter exercise versioned permissions and share allocation/promotion. Migration/backup restoration checks preserve existing ownership, history, overrides and attachment metadata. Exact current command results and resource measurements are recorded in [candidate measurements](GAMING-0.5.0-MEASUREMENTS.md).

Browser-to-browser and installed-Windows-to-Chrome real SFU checks cover decoded screen/voice audio, independent gain/deafen/PTT, watched-only subscription, fallback video, promotion at unchanged 15fps, explicit 30fps sender settings and moderator revocation. Synthetic capture proves protocol behavior, not physical acoustic cancellation or OS loopback exclusion.

The ten-user, three-watched-share run reached all participants and all 27 remote video subscriptions with decoded audio, but failed when a video failed to advance across a ten-second interval about 100 seconds into the five-minute hold. UDP also showed severe packet loss; TURN/TLS reduced loss but did not complete the hold. A failure is not an acceptance pass. No reliable 16-person capacity, unlimited fallback capacity or Iran-only outage availability is claimed.

## Reproduction and continuation

Use the pinned Node 24.22.1 runtime and committed npm lock. Run `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, then the guarded browser launcher. `--gaming` checks layout/drafts/permissions/unread. `--gaming-audio` requires an isolated configured LiveKit fixture. `--windows-sfu` additionally requires `DORHAM_WINDOWS_EXE` pointing to the installed candidate; the test uses its own temporary desktop profile. The isolated fixture uses fresh temporary accounts/data and cleans only its nonce-owned database and UUID media rooms.

The heavy run requires `DORHAM_GAMING_CAPACITY=1`, `DORHAM_SFU_ISOLATED_TEST=1`, configured private SFU credentials and `node scripts/browser-tests.mjs --gaming-capacity`. It uses the authorized 6 GiB ceiling with a conservative 5,500 MiB combined-browser stop threshold. Small runs retain the normal 4 GiB guard. Never close unrelated browser windows. Evidence must distinguish private signaling tunnels, public media transport, physical devices and distributed/outage tests.

Before rollout: complete the five-minute decoded hold on a stable path, rerun the matched optimization comparison at identical media settings, verify the proxy chain, and repeat final builds/installed checks if source changes. Keep independent verified data/configuration backups and the previous application. Apply schema 4 and the tier policy together. Verify readiness, public WSS, files/auth, preserved rows and restart persistence before declaring the pilot upgraded. Do not restore an older database over newer user messages.
