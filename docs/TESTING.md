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
- Windows installation, microphone/capture, tray lifecycle, and upgrades against the built installer.
- Cross-network voice/capture using configured TURN, restrictive firewalls, and different client platforms.
- External LiveKit publication permissions, moderator revocation, expired credentials, SFU/API failure, and subscription behavior.
- Actual Botkeep HTTPS/WSS ingress, sustained connection behavior, restart/redeploy persistence, native Linux dependencies, and measured shared-plan resource use.
- Full 16-person media quality under the user's memory budget on an appropriate test environment.

Do not turn an unavailable test environment or an interrupted process into a success claim.
