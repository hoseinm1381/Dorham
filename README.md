**Released web 1.0.8:** switching chats keeps one message composer. The compact voice view uses the sidebar for participants and keeps active screen shares visible without expandable participant cards. Personal voice volume and Mute/Unmute for me are now in the participant right-click menu. Backend and Windows stay 1.0.7; Android stays 1.0.6. No native builds or service restarts were performed. All 202 tests, lint, typechecking, web build and composer/decoded-audio browser checks pass; all 135 public web files match. The deployment preserves both 1024 MiB memory limits and all four native download manifests. See [1.0.8 verification](docs/RELEASE-1.0.8.md).

**Current Android release: 1.0.6** — louder mute/unmute cues and Copy message text, with the existing signing identity. See [Android release checks](docs/RELEASE-1.0.6-ANDROID.md).

**Current Windows release: 1.0.6** — more transparent voice overlay, microphone/headphone status icons and a dedicated Settings → Game overlay tab. Web remains 1.0.5; backend remains 1.0.4. See [release details](docs/RELEASE-1.0.6-WINDOWS.md).

**Previous release: web and Windows 1.0.5** — louder mute/unmute feedback and an optional native Windows voice overlay for windowed/borderless games. Android remains 1.0.4. See [release verification](docs/RELEASE-1.0.5.md).

**Previous web/server update: 1.0.4, live at https://dorhamapp.ir/** — all 64 emoji reactions, keep-open selection, larger single emojis and local Farsi/English voice-channel TTS. Windows and signed Android 1.0.4 installers are published with the existing update identities. See [release details](docs/RELEASE-1.0.4.md) and [native release checks](docs/RELEASE-1.0.4-NATIVE.md).

**Previous web update: 1.0.3** — 64 supplied Soft Bubble emojis, including nine Dorham exclusives, with a searchable message picker, Persian labels and offline artwork. See [web verification](docs/RELEASE-1.0.3.md).

**Previous web update: 1.0.2** — selected-window sound requests, clearer Chrome audio-picker instructions and verified native window audio through the SFU. Windows/Android releases remain deferred. See [web verification](docs/RELEASE-1.0.2.md).

**Previous web update: 1.0.1** — Chrome screen sound, fullscreen sound controls and visible Watch stream buttons. Applied without restarting voice services. Windows/Android stable downloads remain 1.0.0; native work is deferred. See [web verification](docs/RELEASE-1.0.1.md).

**Previous native release: 1.0.0** — deployed at **https://dorhamapp.ir/** with public Windows/Android downloads, a small Get apps menu and native update notices. See [release and update verification](docs/RELEASE-1.0.0.md).

**Previous release: 0.7.7** — simpler audio settings, local Strong noise removal, 16 built-in profile pictures and matching DM avatar colours. Deployed at **https://dorhamapp.ir/** after isolated SFU and verified rollback-backup checks. See [release verification](docs/RELEASE-0.7.7.md).

**Previous release: 0.7.6** — [dorhamapp.ir](https://dorhamapp.ir/), signed-in password reset, existing-conversation badges, private voice-test isolation and optional +45 dB boost with local noise reduction. See [behavior and verification](docs/RELEASE-0.7.6.md).

**Previous release: 0.7.5** — Recent DM conversations, invitation destinations, recovery onboarding, server icons, optional voice clarity and +30 dB boost, and a simpler screen-sharing setup popup. See [behavior and verification](docs/RELEASE-0.7.5.md).

**Previous release: 0.7.4** — Visible screen-sharing quality and bandwidth controls, from 300 to 1500 kbps, with live changes and remembered preferences. See [behavior and verification](docs/RELEASE-0.7.4.md).

Previous release: **0.7.2** — Improvements across all eight games: clearer turns and instructions, compact mobile layouts, drawing undo, replay lobbies, poker bet/hand feedback, Ludo move buttons and departure-rule fixes. See the [per-game review and verification](docs/RELEASE-0.7.2.md).

Previous release: **0.7.1** — Microphone-gain recovery and a private voice recording/playback test. See [behavior, measurements and verification](docs/RELEASE-0.7.1.md).

Previous release: **0.7.0** — Seven new voice-channel games alongside Chess, each identifying its supported player count. See [games and rules](docs/GAMES-0.7.0.md) and [release verification](docs/RELEASE-0.7.0.md).

Previous release: **0.6.1** — [voice-channel Games and watch-first Chess](docs/RELEASE-0.6.1.md).

Previous release: **0.6.0** — [Standard and Elixer Chess integration](docs/RELEASE-0.6.0.md).

**Earlier release: 0.5.4** — personal microphone feedback: a descending mute tone and a rising unmute tone, including talk hotkeys. The sounds play locally and follow the voice-sound setting. Lint, types, 89 unit/API tests, production builds, seven browser regression scenarios and the dedicated local-audio cue test pass. See [release verification](docs/RELEASE-0.5.4.md).

Previous release: **0.5.3** — [outgoing microphone gain from 50% to 250%](docs/RELEASE-0.5.3.md).

Earlier release: **0.5.0** — [gaming voice/viewer and reliability](docs/RELEASE-0.5.0.md).

Previous update: **0.4.4** — [compact upload allowance](docs/COMPACT-UPLOAD-0.4.4.md).

Earlier audio-controls update: **0.4.3**. See [audio fixes](docs/AUDIO-FIX-0.4.3.md).

# Dorham

A small Discord-style application for a community of up to 100 accounts and 20 online users. React/PWA, Windows/Electron, Android/Capacitor, Fastify, Socket.IO, SQLite/Drizzle, and WebRTC. All branding and application artwork in this repository are original.

The Iranian SFU pilot is running at **https://dorhamapp.ir/**. The previous nip.io address remains available; see [domain operations](docs/DOMAIN.md). Its Windows pilot installer defaults to this address; saved custom server addresses remain available. Public API/socket checks, decoded SFU audio/video in Chrome and installed Windows, and separately forced local TURN/TLS pass with synthetic sources. The older Botkeep instance and its production data remain separate. See [pilot operations, packages and limitations](docs/NINECRAFT.md) and [verification status](docs/STATUS.md). Physical calls, domestic-only outage behavior and Android device tests remain open.

The v0.2 expansion adds invited guests, recovery codes, device sessions, safe links, expiring file attachments, Persian/RTL, tags and voice moderation. The reset tool is offline and explicit; upgrades preserve accounts. See [upgrade verification](docs/UPGRADE-STATUS.md), [account operations](docs/ACCOUNT-RESET.md), [upload policy](docs/ATTACHMENTS.md) and [domestic infrastructure](docs/DOMESTIC.md).

The v0.3 update adds notification sounds, compact voice controls, persistent invitation management, custom roles, and live profile/avatar refresh. See [changes and verification](docs/SOCIAL-UPDATE.md).

The v0.4 update adds inline image/video attachments, a much larger screen-viewing layout, collapsible members, optional own-screen preview and authoritative voice departure cues. See [media update and verification](docs/MEDIA-UPDATE.md). Android builds are deferred until requested.

Version 0.4.1 reduces voice control-plane work and adds configurable push-to-talk/toggle hotkeys, including background hotkeys in the Windows app. See [measurements, tests and unresolved ten-user/four-screen capacity limits](docs/OPTIMIZATION-0.4.1.md).

Version 0.4.2 improves Persian typography, translations, mixed-language messages and mobile RTL navigation, and shows online users' chat-server ping. The font is bundled locally for offline use. See [features, measurements and tests](docs/PERSIAN-PING-0.4.2.md).

## Run locally

Requires patched Node.js 24 LTS (24.22.1 or newer within 24.x), npm, and Windows for Windows packaging. Python 3 is used only to create the deployment ZIP. Java 21 and Android SDK 36 are needed only for APK builds.

```powershell
npm ci
Copy-Item .env.example .env
npm run build
npm start
```

Open **http://localhost:3001**. Set `PUBLIC_URL=http://localhost:3001` in `.env` for local invite links. `START_DORHAM.cmd` provides the same local launch flow and uses the downloaded local Node runtime when present.

Registration is open by default. Create your own account, create a server, and invite other registered users from the server settings. No demo accounts or credentials are installed. Server ownership is separate from instance administration. To claim instance administration, set a random `BOOTSTRAP_ADMIN_SECRET`, restart the server, and enter that secret under Account settings → Instance administration. It can be claimed once.

For development, `npm run dev` starts the API on port 3001 and Vite on 5173. Set `PUBLIC_URL=http://localhost:5173` for development invite links. The production build runs frontend and backend through a single HTTP port.

## What is included

- Profiles, avatars, persistent login, presence, server ownership, role hierarchy, invitations, channel permissions, and moderation controls.
- Channel chat and private DMs with history, edits, tombstones, replies, reactions, typing, unread cursors, request deduplication, and durable reconnect replay.
- Direct Opus voice, microphone/deafen controls, speaking indicators, per-participant volume, local mute, screen subscriptions, and connection diagnostics.
- Transactional limits: 16 voice members per room, 20 online users and 100 identities (guests plus registered accounts) by default. Fixed room/global screen publisher caps default to disabled (`MAX_ROOM_SHARES=0`, `MAX_GLOBAL_SHARES=0`); one publication per account and expiring leases remain enforced. Existing deployments must update those environment values to remove their old caps.
- A separate external LiveKit transport, native Android media bridge, protected native credential storage, and Windows tray/capture integration.

Direct media needs working peer connectivity. Configure TURN for restrictive networks. Mesh moderation controls the official clients and signaling; it cannot stop modified clients from independently exchanging media. An external SFU provides the stronger enforcement path. See [media architecture](docs/ARCHITECTURE.md).

Noise suppression and echo cancellation default to on. Web/Windows expose their preferences and applied microphone settings under **Voice & connection → Microphone processing**. Saved changes apply when rejoining voice. See [audio processing and verification](docs/AUDIO-PROCESSING.md).

## Build and verify

```powershell
npm run verify
npm run test:e2e
npm run test:load
npm run package:windows
npm run android:build
npm run deploy:bundle
```

`test:e2e` runs the shorter chat/two-peer suite with a Windows browser-memory guard. It refuses to launch above 2800 MiB existing Chrome/Edge usage and stops its own browser processes above 3500 MiB combined usage, preserving headroom below the user's revised 4 GiB budget. It never closes unrelated browser windows. The larger media-capacity scenario is disabled by default and was not accepted as verified. The tests use real databases, sockets, and WebRTC; generated device inputs are identified in their reports.

Generated packages and evidence live under `artifacts/`; they are intentionally ignored by Git. The Windows installer is unsigned. Android debug APKs are installable test builds; release signing uses environment variables and a keystore outside the repository.

## Repository

| Area | Purpose |
| --- | --- |
| `apps/api` | Authentication, authorized HTTP/socket actions, persistence, signaling, and media leases |
| `apps/web` | Shared responsive React application and PWA shell |
| `apps/desktop` | Sandboxed Electron shell and NSIS packaging |
| `apps/android` | Capacitor project, Kotlin media/Keystore plugins, foreground service |
| `packages/contracts` | Shared validation, types, and permission rules |
| `packages/media` | Mesh, LiveKit, and native transport adapters |
| `tests` | Unit/integration, browser/media, and load tests |

Read [deployment](docs/DEPLOYMENT.md), [operations and recovery](docs/OPERATIONS.md), [API contracts](docs/API.md), [testing](docs/TESTING.md), and [current status](docs/STATUS.md) before hosting a community. The configured GitHub remote is not automatically pushed, and nothing is automatically published or purchased.
