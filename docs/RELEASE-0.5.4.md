# Dorham 0.5.4 — personal microphone sounds

Muting your microphone plays a short descending tone; unmuting plays a rising tone. The sounds play only on your device and use the existing local notification graph, which is separate from outgoing microphone audio. No new files are downloaded and no notification event is sent to other members.

Feedback follows actual changes in the local microphone-control state from the microphone button, push-to-talk, toggle-to-talk, browser focus release and Windows native hotkeys. Repeated key events that leave the state unchanged do not repeat a sound. Joining and leaving do not add an extra microphone cue. An unmute failure that returns the control to muted produces mute feedback.

**Settings → Notifications → Voice join, leave, mute and unmute sounds** controls these cues and is enabled by default. Do not disturb continues to suppress incoming notifications; feedback for your own microphone action remains available. Browser audio requires an earlier interaction with the app. English and Persian settings text are updated.

## Verification

Lint, TypeScript, all 89 unit/API tests and API/web/desktop builds pass. A two-client Chrome test measures nonzero local output for both tones, verifies their opposite pitch order, confirms silence at the peer while muted, and covers the sound preference, button, push-to-talk, toggle-to-talk, repeated keys and disconnect behavior. All seven existing browser regression scenarios pass.

The Windows installer exits 0 and its payload matches the final build. Installed Windows checks verify native registration, sandbox/tray behavior, inline media, Persian text and background talk-key safety, including exactly one unmute and mute cue while the app is hidden. Public HTTPS/WSS Chrome/Windows checks pass for local mute/unmute cues, outgoing microphone gain, per-person volume, playback recovery, invitations and bidirectional media through forced TURN/TLS. These checks use process-only DNS pinning with normal certificate validation; normal-system-DNS HTTPS readiness and exact deployed HTML also pass. Deployment preserves all 32 persistent table digests, stored avatar/attachment files and configuration; all four services are active. An independently downloaded backup verifies all 35 tables and four stored data files. Package hashes and evidence are recorded in `artifacts/evidence/v054-release.json` and `artifacts/v0.5.4`. Synthetic decoded/local graph checks do not measure physical speakers or acoustic echo.

No database, dependency, hosting, media-budget or Android changes are included. Schema remains 5. Prior release packages, the previous application and the independent data/configuration backup are retained. The Windows installer remains unsigned. Earlier capacity limitations remain as documented in the preceding releases.
