# Dorham

A small Discord-style application for a community of up to 100 accounts and 20 online users. React/PWA, Windows/Electron, Android/Capacitor, Fastify, Socket.IO, SQLite/Drizzle, and WebRTC. All branding and application artwork in this repository are original.

The Iranian SFU pilot is running at **https://dorham.45-135-242-146.nip.io/**. Its Windows pilot installer defaults to this address; saved custom server addresses remain available. Public API/socket checks, decoded SFU audio/video in Chrome and installed Windows, and separately forced local TURN/TLS pass with synthetic sources. The older Botkeep instance and its production data remain separate. See [pilot operations, packages and limitations](docs/NINECRAFT.md) and [verification status](docs/STATUS.md). Physical calls, domestic-only outage behavior and Android device tests remain open.

The v0.2 expansion adds invited guests, recovery codes, device sessions, safe links, expiring file attachments, Persian/RTL, tags and voice moderation. The reset tool is offline and explicit; upgrades preserve accounts. See [upgrade verification](docs/UPGRADE-STATUS.md), [account operations](docs/ACCOUNT-RESET.md), [upload policy](docs/ATTACHMENTS.md) and [domestic infrastructure](docs/DOMESTIC.md).

The v0.3 update adds notification sounds, compact voice controls, persistent invitation management, custom roles, and live profile/avatar refresh. See [changes and verification](docs/SOCIAL-UPDATE.md).

The v0.4 update adds inline image/video attachments, a much larger screen-viewing layout, collapsible members, optional own-screen preview and authoritative voice departure cues. See [media update and verification](docs/MEDIA-UPDATE.md). Android builds are deferred until requested.

Version 0.4.1 reduces voice control-plane work and adds configurable push-to-talk/toggle hotkeys, including background hotkeys in the Windows app. See [measurements, tests and unresolved ten-user/four-screen capacity limits](docs/OPTIMIZATION-0.4.1.md).

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
