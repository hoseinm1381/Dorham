# Verification

Run `npm run verify` for ESLint, TypeScript, unit/integration tests, and production builds. `npm run test:load` runs a real SQLite/Socket.IO control-plane load scenario without spawning browsers. `npm run test:e2e` runs the chat and two-peer WebRTC suite through the browser memory guard.

## Browser memory policy

The user revised the Chrome testing budget from 3 GiB to **4 GiB**. Large browser tests remain disabled by default. The guarded Windows launcher checks all Chrome/Edge working sets before launch; above 2800 MiB it declines to start. During tests it monitors the test process tree and all Chrome/Edge usage, stopping only its own browsers at 3500 MiB combined browser memory or 2800 MiB task-owned browser memory. The lower threshold leaves headroom for sampling delay and existing user tabs. Existing unrelated browser windows are never closed. The completed two-page suite peaked at 3211.3 MiB combined and 1835.3 MiB task-owned; the guard did not need to stop it.

The ordinary suite uses two pages. `test:media-load` additionally requires `DORHAM_LARGE_MEDIA_TEST=1`, still respects the memory guard, and should not be enabled during routine development. The 20-browser/16-media-participant run was interrupted after the user reported memory pressure. It is **not a passed capacity result**. The 20-socket control-plane result is independent and passed without those browsers.

## Evidence

`artifacts/evidence/control-plane-load.json` records the measured Node version, actual message timings, RSS, CPU time, event-loop delay, disk files, and enforced capacity outcomes. That scenario uses 20 real Socket.IO clients, 16 primary-room voice memberships, and five screen leases, but does not generate media. It is not a one-vCPU container or Botkeep certification.

`tests/browser/application.spec.ts` exercises actual browser accounts, server/channel chat, direct messages, edit/reaction propagation, unread state, and XSS-safe plain-text rendering. Its WebRTC scenario feeds synthetic microphone and canvas screen inputs into the actual product implementation and checks decoded audio samples and decoded video frames. It also exercises volume controls, mute, individual stream unsubscribe/resubscribe, two simultaneous publishers, and coordinator migration. Synthetic devices do not prove physical microphone quality, monitor capture permissions, cross-network NAT traversal, or native mobile behavior.

Generated screenshots, Playwright traces/reports, compiler logs, audit reports, and package measurements belong under `artifacts`, `playwright-report`, and `test-results`. Reports must distinguish source implementation, build success, local automated behavior, physical-device results, and verified hosting. Rebuild relevant packages after source changes.

## Remaining acceptance scenarios

- Native Android microphone, route switching, MediaProjection consent, background duration, screen locking, OEM battery controls, and OS termination on physical devices.
- Windows physical microphone/capture, interactive tray lifecycle, and installer upgrades; isolated install/uninstall and automatic tray-close tests already pass.
- Cross-network voice/capture using configured TURN, restrictive firewalls, and different client platforms.
- External LiveKit publication permissions, moderator revocation, expired credentials, SFU/API failure, and subscription behavior.
- Botkeep sustained connections and representative hosted load; HTTPS/WSS/polling, native Linux modules, data persistence through update/restart and isolated backup restoration already pass.
- Full 16-person media quality under the user's memory budget on an appropriate test environment.

Do not turn an unavailable test environment or an interrupted process into a success claim.

## Installed Windows live checks

With the isolated test installation available, set `DORHAM_SMOKE_SERVER_URL=https://dorham.bot-keep.xyz` and run `node_modules/.bin/tsx tests/desktop-smoke.ts`. It records explicit WSS/polling, protected credentials, sandbox settings and a test DM to the existing `Web deployment check` fixture. No resolver override was used in the final VPN run. After replying from that web account, run `node_modules/.bin/tsx tests/desktop-persistence.ts` to reopen the isolated profile, verify refresh rotation and the reply, and acknowledge it. These tests create only clearly named deployment test data and do not open the user's normal profile. Their screenshots/evidence are in `artifacts/evidence/windows-live-*`.

The unit/integration suite now has 13 tests, including shutdown while an authenticated WebSocket remains connected. `scripts/production-smoke.mjs <independent-runtime-directory>` verifies the deployed startup entry, native database/password modules and Socket.IO without resolving dependencies from this workspace.
