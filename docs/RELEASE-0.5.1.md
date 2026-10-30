# Dorham 0.5.1 — 30 October 2026

This maintenance release focuses on server efficiency and the reported push-to-talk and toggle-to-talk problems. See [changes and matched measurements](PERFORMANCE-0.5.1.md). Android, new hosting, search, mentions and inbox remain deferred.

Toggle-to-talk stays on when switching tabs or applications. Push-to-talk recovers on a fresh talk-key press after clicking the microphone control; it no longer leaves a hidden mute lock. Function-key bindings work while composing messages. Windows background input retains release, helper-failure and lock safety. Chat text, timestamps, focus outlines and mobile control targets are easier to read and use.

The matched ten-socket control workload reduced SQL reads from 10,598 to 4,656 and write statements from 1,065 to 369. Ordinary mute/PTT reports no longer invoke SFU permission reconciliation. Permission changes, moderation, expiry and share changes retain enforcement. These are statement counts, including no-op SQL, rather than disk bytes or a measured whole-server CPU/RAM reduction.

## Verification

- Lint, TypeScript, 84 unit/API/contract tests and API/web/desktop production builds pass.
- Installed Windows registration, inline image/video decoding, own-screen preview, protected credentials, sandbox, Persian font and tray behavior pass. Actual Windows key-state injection verifies PTT recovery after microphone clicks, background PTT, release, helper-crash mute, toggle while hidden and simulated lock mute.
- Focused browser talk-control, gaming navigation and real SFU decoded-media checks pass with synthetic sources. The SFU checks cover stream audio opt-in, independent volume, deafen/PTT, fallback promotion and moderator revocation through TURN/TLS.
- All seven core browser scenarios pass. Public HTTPS/WSS Windows/Chrome verification displays 0.5.1 and decodes voice and screen video in both directions through forced TURN/TLS; deafen, explicit watching, revisioned permissions and message deduplication pass. Its peak combined browser memory is 1631.3 MiB, with the 4 GiB guard enabled. Test-process DNS pinning retains certificate verification; normal system-resolver HTTPS/readiness checks also pass.
- The 20-socket messaging test processes 200 messages at 94.27 ms p95 acknowledgements and 315.54 MiB peak process RSS. It generates no media.

Web/backend are deployed at https://dorham.45-135-242-146.nip.io/ with schema 4. All 32 persistent table digests and three avatar/attachment file hashes were preserved across the application swap; transient voice/coordinator state resets on restart. Configuration is unchanged and all four services remain active. An independently downloaded backup verifies all 35 table digests and four stored data files. The previous application remains at `/opt/dorham-before-0.5.1`.

The two release-check accounts and their one server/media room were removed using exact manifest identity, timestamp and ownership checks. The original six accounts, one server and sixteen messages remain. An initial packaging attempt failed because C: was full; moving release temporary files/cache to D: allowed packaging and the media retry to pass. The failed attempt remains in the logs.

Release packages, checksums and deployment evidence are recorded under `artifacts/v0.5.1` and `artifacts/evidence/v051-release.json`. The Windows installer is unsigned.

## Limits

The failed 0.5.0 ten-user media hold remains failed. This release does not certify sustained ten-/sixteen-user media, Iran-only outage availability, physical acoustic behavior, OS loopback exclusion or hotkeys in protected/elevated games. Existing room limits, sharing allocation, encoding budgets and lease timeouts remain unchanged. Windows system-loopback sound stays disabled pending physical exclusion verification.

The authorized rollout preserves the existing data directory and configuration, downloads and verifies an independent private backup, and retains the previous application for code rollback. No data reset, paid upgrade, Android build or proxy/domain migration is part of this release.
