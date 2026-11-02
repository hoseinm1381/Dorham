# Backend migration 1.1.0

Deployed and verified at https://dorhamapp.ir/ on 2026-11-02. This
release replaces the Node HTTP/Socket.IO backend with Go. Existing accounts,
password hashes, sessions, refresh tokens, message history, receipts, media,
moderation and games use the same schema 11 and wire protocol. LiveKit and the
separate Python/Piper speech worker remain. Windows stays 1.0.7 and Android
stays 1.0.6 at the backend switch; no native installer rebuild is required for
compatibility. The subsequent [Android and Windows 1.1.0 release](RELEASE-1.1.0-NATIVE.md)
rebuilds the current clients with their existing update identities.

## Verification

- All 202 historical Node tests establish the reference baseline. The existing
  86 API/socket regressions pass against Go with strict assertions retained.
- Go domain, engine, HTTP/media, security, snapshot, lifecycle and scheduler
  tests pass. Game fixtures compare 440 chess positions, 237 transitions,
  1,015 private projections and 400 poker rankings, plus standard perft cases.
- Node-Go-Node process tests preserve old credentials/tokens, retry receipts,
  uploads, history, schema integrity and new Go writes after rollback.
- Independent production/PostgreSQL compatibility passes 39 checks, including
  actual pgx TCP against PGlite PostgreSQL, fresh migrations 1-11, transaction
  rollback, concurrent sequence allocation, CSRF/cookies, exact native origins
  and absence of fixture routes in an untagged production build. This is not a
  full external PostgreSQL service or load acceptance test.
- Browser checks pass for chat switching, avatars/uploads, DMs/invitations,
  recovery, mentions/notifications, emoji/reactions, moderation and screen
  viewing. Isolated real LiveKit microphone and screen-audio checks pass.
- Real Linux Piper passes English cold/warm and Farsi synthesis with genuine
  Socket.IO voice membership, same-channel delivery, outsider/stale-epoch
  denial, loading notifications, worker reuse, idle exit and cold restart.
  The normal idle setting remains 180 seconds; a separate 3-second test proves
  reclamation without waiting for the production timeout.
- No new Android physical-device acceptance is claimed. Existing native token,
  refresh, origin and Socket.IO contracts are exercised automatically.
- The exact published Windows 1.0.7 runtime passes login persistence,
  bidirectional English/Farsi chat, decoded listen-only voice, deafen, actual
  native owned-window capture and share cancel/stop/restart against Go. All 77
  package files match the public runtime; no native rebuild or user profile was
  used. Peak guarded browser memory was 2,373.7 MiB, below the 3,500 MiB stop.

All evidence is under `artifacts/evidence/v110-*` and corresponding logs. The
reusable production/PostgreSQL check is `npm run test:api:compat`; Go compilation
and unit tests are available through `build:api:go` and `test:api:go`.

## Performance and limits

Two matched local Windows process pairs simulate 20 users, 160 bootstraps,
100 messages, 100 voice heartbeats and 100 state changes. Go measured 59-60 MiB
RSS immediately after load versus 310-312 MiB Node, and completed the workload
in 1.97-1.98 seconds versus 3.28-3.49 seconds. CPU was comparable at 3.41-3.58
versus 3.55-3.86 CPU-seconds. These are short synthetic API/control measurements,
not peak-memory or whole-VPS/media-load claims.

In the Linux bilingual Piper test, API ready RSS was 20.56 MiB; peak API plus
Piper RSS was 470.31 MiB. Both production systemd memory limits remain 1024 MiB.
The tests do not certify a new simultaneous media-capacity ceiling or eliminate
the need for production monitoring.

The earlier isolated Linux startup issue also affected an independent Python
4 KiB fsync. A later durable recheck passed (approximately 3 ms fsync and 13 ms
SQLite), followed by successful Go/Piper durable-database tests. No journal,
durability or kernel-cache setting was relaxed.

The vulnerability scan reports zero reachable or imported-package advisories
using the verified official Go database mirror at commit
`8f7e390a0ff7345d74ecd7a056a1073214466db9`, dated 2026-10-27 and rechecked as
the mirror HEAD on 2026-11-02. Canonical endpoints returned HTTP 403, so canonical
freshness could not be compared. Three module-only advisories concern packages
the application does not import; positive controls confirmed detection works.

## Promotion and rollback

The final coordinated private backup was downloaded and independently verified:
5,959,666 bytes, 41 tables, schema 11 and 430 file hashes. Node and its compiled
API/dependencies remain for rollback. Production runs Go directly under systemd;
private configuration, Piper models, proxies, LiveKit, both 1024 MiB limits and
all four native download manifests are unchanged. All 135 public HTTPS web files
match the build hashes; prior hashed assets remain available.

Public native-origin authentication, English/Farsi chat, authenticated WSS,
listen-only voice membership, production SFU credentials, actual English/Farsi
speech and recipient privacy pass. The automatic rollback timer was stopped
after successful checks. The three temporary test accounts and their private
server/messages were removed, with database integrity verified afterward.

Implementation source: `3d0d2a2ae94e5abcf64bb583c7f65e8997363f43`.
Deployed Linux executable SHA-256:
`b363c00fddab8395d9b5ed92ff09f107411a4aa7514d263a0f921cb6b5db79c6`.
Deployment and public checks: `v110-production-promotion.json`,
`v110-public-verification.json`, `v110-public-web-files.json` and
`v110-public-fixture-cleanup.json` under `artifacts/evidence`.

Revert binary regressions to Node against current data, preserving accepted
writes. Restore database/uploads only when recovery requires it, after saving
the post-upgrade state. See [deployment](DEPLOYMENT.md),
[operations](OPERATIONS.md) and [migration gates](MIGRATION-1.1.0.md).
