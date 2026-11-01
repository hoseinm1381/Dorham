# 1.0.8 — web chat and personal voice controls

Web-only patch. Backend and Windows remain 1.0.7; Android remains 1.0.6. No native application is rebuilt, synced or repackaged, and native download/update manifests stay unchanged. Released to https://dorhamapp.ir/ after the checks below.

## One composer when switching chats

The mention input and emoji picker were sibling components with the same conversation-ID React key. Switching conversations could leave an old input in the form, creating several placeholders and a stale input reference. They now have separate key namespaces while still resetting their own state when the conversation changes.

A real Chrome regression reproduced two textareas on 1.0.7. The fixed build keeps exactly one input and emoji trigger through six cycles of English/Persian channels, different servers and a DM. It also sends Persian text to the correct conversation, selects a mention after switching and sends at mobile width. No duplicate-key/DOM errors occur. Evidence: `v108-composer-browser.json` and `v108-composer-before-fix.log`.

## Right-click personal voice volume

The per-person slider moves from the expanded voice cards to the existing user context menu. Right-click a participant in your current voice channel from their voice card, sidebar row, member entry or message author. It offers 0–200% volume and Mute/Unmute for me. These controls are available to ordinary members and affect only their own playback; role-protected server moderation remains separate. The menu stays open while adjusting volume, and range-input Home/End/arrow keys retain their normal behavior. Existing saved levels, output routing and TTS speaker levels are retained. A temporary mute restores the last audible level while the app remains open; saved zero remains muted after reload.

The real two-client WebRTC regression uses generated microphone audio and measures decoded playback at 0/50/100/200%, including actual 2× amplitude, local mute/unmute, suspended-context recovery, deafen, rejoin, reload and persistence. It confirms no sliders remain on voice cards and an ordinary member gets personal volume controls without server-mute authority. Screenshot: `v108-personal-volume-menu.png`.

## Verification and deployment boundary

- All 202 unit/API tests pass, along with lint, TypeScript and the web production build. Backend/native code and schema are unchanged.
- Composer and real-audio browser checks pass under the unchanged 4 GiB combined browser budget, with a 3500 MiB stop threshold. Only owned fixtures are cleaned up. Managed Windows cleanup required elevated termination for the earlier composer fixture; the audio run completed its own cleanup.
- Deploy only the web payload after a verified web rollback backup. Retain existing hashed assets for already-open clients. Do not restart Dorham, LiveKit or proxies; preserve the 1024 MiB service limits, backend files, database, accounts, uploads and native manifests.

The previously released Windows 1.0.7 contains the earlier composer code; the operator explicitly deferred native builds for this patch. Refresh the browser tab after web publication to load 1.0.8.

## Published release evidence

The source change is `0551fc5f5b37698d5fc1eedc7a018ea7b3505457`. The source and compiled branches were pushed with explicit operator approval. A separate web rollback backup was downloaded and independently verified before promotion (SHA-256 `4a2cb5842e5c99b2f6d3634c38902f9e4ef53ed6f9f1636f04bb8f0722b7688c`). It contains web files and public release metadata, with no database, uploads or private configuration contents.

The promoted web ZIP SHA-256 is `b2caa68903775c09a234e493775447154dfe18027589264868a0f27f5541e211`. Localhost and independent public HTTPS checks match all 135 web files. Twenty web files changed; previous content-hashed assets remain available for open clients. Dorham, LiveKit, Caddy and HAProxy retained their exact service identities. Backend/configuration hashes, both memory limits and all four native manifests are unchanged; database integrity and foreign-key checks pass. Evidence: `v108-rollout.json`, `v108-backup-verification.json` and `v108-public-verification.json`.

## Compact voice follow-up

The expanded participant cards and Voice controls / Minimize voice toggle are removed. Participants and speaking/mute indicators remain in the voice sidebar, with personal volume and moderation in the user context menu. The compact channel header and visible Watch stream actions remain. Own-preview, fullscreen, multi-view, chat drawer and stream sound controls are retained.

Fresh two-client Chrome checks pass on the simplified web build: actual mesh screen decoding, all live bandwidth choices without recapture, same lease, preview close without broadcast stop, rewatch, mobile Watch stream visibility, saved settings and cancellation cleanup. A separate isolated LiveKit room verifies actual decoded screen audio, fullscreen controls, 50%/0%/100% stream gain, mute/unmute, deafen, rewatch, revocation and independent microphone/PTT behavior. The audio test now measures a stable baseline after foregrounding/fullscreen resumes the AudioContext, while retaining strict ratio checks. Sources are synthetic; this does not replace physical device or Chrome system-audio-picker acceptance. Only owned local fixtures and SFU rooms are cleaned up. Evidence: `voice-stage-screen-sharing.json`, `voice-stage-screen-audio.json` and `voice-stage-*.log`. Typecheck, lint and web build pass. Native applications and backend are unchanged.

## Quick own-microphone gain follow-up

Right-click your own account/profile or your own participant entry for a 0–200% microphone-volume slider. It works before joining voice and shares the existing saved microphone gain with Settings → Audio. Values above 200% and the opt-in +45 dB boost slider are under Advanced audio. Opening the quick menu preserves a higher advanced value until the user changes it; the actual percentage and a hint stay visible. Zero now produces genuine outgoing silence, and adjusting gain never bypasses microphone mute. No native application is rebuilt.

Fresh unit/API checks pass (202 tests), plus typechecking, lint and the web build. An isolated LiveKit test measures actual remote decoded output at 0%, 25% and 200%, verifies keyboard endpoints, saved zero and 150% after reload/rejoin, settings synchronization, 250% advanced preservation, self menus on the account and sidebar, and mute gating. A separate existing +30/+45 dB boost check passes. Opus amplitude uses the established 5% relative tolerance; the new test normalizes each ratio before comparing. Synthetic sources and same-workstation browser clients do not replace physical microphone acceptance. Evidence: `quick-mic-browser.json`, `quick-mic-sfu.log`, `quick-mic-sfu-first-attempt.log` (including the successful boost check), and `quick-mic-tests.json`. The compact channel header also retains its intended spacing without the removed expansion class.
