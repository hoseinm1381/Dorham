Current 0.4.1 voice/hotkey acceptance, benchmark command and failed heavy-media gate: [optimization report](OPTIMIZATION-0.4.1.md). Earlier v0.2 expansion acceptance: [upgrade matrix](UPGRADE-STATUS.md). Run `npm run verify`, `npm run test:expansion`, and separately guarded media scenarios below. Expansion covers guests, conversion, attachments, Persian/RTL, compression preview, in-call quality, recovery and admin UI. Current unit/API suite: 58 tests. Heavy browser runs require a separately authorized RAM allowance and dedicated memory guard; normal runs retain the 4 GiB limit.

# Verification

Run `npm run verify` for ESLint, TypeScript, unit/integration tests, and production builds. `npm run test:load` runs a real SQLite/Socket.IO control-plane load scenario without spawning browsers. `npm run test:e2e` runs the chat and two-peer WebRTC suite through the browser memory guard.

## Browser memory policy

The user revised the Chrome testing budget from 3 GiB to **4 GiB**. Large browser tests remain disabled by default. The guarded Windows launcher checks all Chrome/Edge working sets before launch; above 2800 MiB it declines to start. During tests it monitors the test process tree and all Chrome/Edge usage, stopping only its own browsers at 3500 MiB combined browser memory or 2800 MiB task-owned browser memory. The lower threshold leaves headroom for sampling delay and existing user tabs. Existing unrelated browser windows are never closed. The completed two-page suite peaked at 3211.3 MiB combined and 1835.3 MiB task-owned; the guard did not need to stop it.

The ordinary suite uses two pages. `test:media-load` additionally requires `DORHAM_LARGE_MEDIA_TEST=1`, still respects the memory guard, and should not be enabled during routine development. The 20-browser/16-media-participant run was interrupted after the user reported memory pressure. It is **not a passed capacity result**. The 20-socket control-plane result is independent and passed without those browsers.

The installed Windows relay scenario additionally counts its owned Dorham processes toward the same guard. Current relay run peaks are 2585.5 MiB (isolated local backend), 2742.5 MiB (public backend/Chrome) and 2607.9 MiB (public backend/installed Windows plus Chrome); none triggered the guard. Separate per-run memory evidence is preserved beside each relay report.

Use `node scripts/browser-tests.mjs --grep 'microphone processing'` for the one-context capture/preference/rejoin test. The guard can also filter other ordinary scenarios with `--grep`; it still monitors/stops only its own test tree and now cleans up the fixture API on a memory stop. A broader audio follow-up run was stopped at the early threshold and is not a pass. The focused processing run passed below the budget. See [audio evidence and limits](AUDIO-PROCESSING.md).

## Evidence

`artifacts/evidence/control-plane-load.json` records the measured Node version, actual message timings, RSS, CPU time, event-loop delay, disk files, and enforced capacity outcomes. The current scenario uses 20 real Socket.IO clients, 16 primary-room voice memberships, and 20 screen leases with fixed publisher caps disabled, but does not generate media. It is not a one-vCPU container or hosted SFU certification.

The [Ninecraft pilot](NINECRAFT.md) adds a separate guarded hosted SFU test:

```powershell
$env:DORHAM_SFU_BASE_URL='https://dorham.45-135-242-146.nip.io'
node scripts/browser-tests.mjs --hosted-sfu
# Optional separate relay-only run; also constrains SDK ICE reconfiguration.
$env:DORHAM_SFU_TLS_ONLY='1'
node scripts/browser-tests.mjs --hosted-sfu
```

Unset `DORHAM_SFU_TLS_ONLY` for ordinary connectivity. Set `DORHAM_RELAY_ELECTRON_EXE` to the installed pilot executable for the Windows/Chrome scenario; it uses an isolated profile and verifies the new default endpoint. Set `DORHAM_SFU_MODERATION=1` for owner mute/unmute, stream subscriptions, share termination and voice-kick checks on the test's own room. These runs create clearly named fixture accounts/rooms in the pilot, disable traces containing credentials, and remain under the same memory guard. Never target an unrelated production instance.

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

## External relay verification

Prepare an ignored private environment file (for example `.tools/relay-test.env`) with `TURN_URLS`, `TURN_USERNAME` and `TURN_PASSWORD` from an authorized relay account. Use the operator's real values; browser tools may return `[redacted]` instead of credentials. Never commit this file or place secrets in command arguments. Run `node --env-file=.tools/relay-test.env scripts/browser-tests.mjs --relay` on Windows with Node 24.22.1. The normal 4 GiB guard applies; only two browser contexts run. Ordinary browser tests explicitly clear external relay configuration.

This opt-in test uses a fresh local database and real product signaling, forces relay-only ICE on both peers, requires a selected relay-to-relay candidate pair plus decoded audio samples, checks decoded non-black video from two simultaneous synthetic screen publishers, and tests unsubscribe/resubscribe. It writes sanitized RTP/candidate measurements to `artifacts/evidence/external-relay.json` or a separate failure report; network traces are disabled to avoid recording temporary TURN credentials. A pass proves relay media from this machine, not physical microphone quality or the remote friend's network. Repeat the real cross-network call after deploying credentials.

After authorized deployment, set `DORHAM_RELAY_BASE_URL` to the application's HTTPS origin and run `node scripts/browser-tests.mjs --hosted-relay`. This uses the hosted backend and its issued ICE configuration, creates two named relay test accounts plus one test server, and leaves normal accounts/conversations untouched. Results use `hosted-relay.json`/`.png`. It does not start a local backend or require local TURN secrets. The 4 GiB guard still applies.

Set `DORHAM_RELAY_ELECTRON_EXE` to an isolated installed `Dorham.exe` as well to substitute the Windows application for the second Chrome client. It uses a fresh temporary desktop profile, verifies renderer sandbox/isolation, joins through the native application UI, and writes `windows-hosted-relay` evidence. The guard includes its owned Dorham processes. Capture/microphone inputs remain synthetic; physical source selection and device quality require a person.

## Installed Windows live checks

With the isolated test installation available, set `DORHAM_SMOKE_SERVER_URL=https://dorham.bot-keep.xyz` and run `node_modules/.bin/tsx tests/desktop-smoke.ts`. It records explicit WSS/polling, protected credentials, sandbox settings and a test DM to the existing `Web deployment check` fixture. No resolver override was used in the final VPN run. After replying from that web account, run `node_modules/.bin/tsx tests/desktop-persistence.ts` to reopen the isolated profile, verify refresh rotation and the reply, and acknowledge it. These tests create only clearly named deployment test data and do not open the user's normal profile. Their screenshots/evidence are in `artifacts/evidence/windows-live-*`.

The unit/integration suite now has 19 tests, including active-socket shutdown/reconnect, observer voice-directory visibility/access controls and managed TURN request/validation/cache/failure handling. Ordinary browser scenarios cover membership before joining voice, initial snapshot after refresh, microphone-processing preferences/rejoin and deliberately blocked ICE with waiting-video/timeout feedback. Cloudflare provider tests use controlled API responses; they do not establish a live Cloudflare relay allocation. ExpressTURN has separate actual decoded-media evidence. `scripts/production-smoke.mjs <independent-runtime-directory>` verifies the deployed startup entry, native database/password modules and Socket.IO without resolving dependencies from this workspace.
