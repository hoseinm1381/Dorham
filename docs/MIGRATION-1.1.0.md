# Backend 1.1.0 migration gates

Status: Go 1.1.0 is deployed and verified on 2026-11-02. See
[release verification](RELEASE-1.1.0.md).

The replacement is a Go HTTP/Socket.IO application. LiveKit and the isolated
Python/Piper speech worker remain separate services. The TypeScript backend is
retained as the reference and rollback runtime. No database schema version or
native application identity is changed by this migration.

## Required evidence before release

- Preserve source at `8284591bc75da2553725f43a34e103801fc23e1d` and make an
  independent private database/uploads/configuration backup before promotion.
- Verify all 11 historical migrations, current schema, Argon2id passwords,
  session/refresh/recovery records, attachments, images and mutation receipts.
- Run the preserved TypeScript tests as a baseline, Go unit/domain tests,
  existing HTTP/Socket.IO regression tests against the actual Go process,
  and browser workflows against the Go backend.
- Exercise old Windows/Android protocol contracts without rebuilding them.
  Distinguish automated protocol checks from physical-device acceptance.
- Test Go-to-Node rollback after writes on an isolated data copy. Git recovery
  alone does not restore private database files, uploads, configuration or keys.
- Measure matching idle, chat, voice/control and TTS workloads; report API and
  whole-service memory separately. Do not infer savings from language choice.
- Run Linux startup, graceful shutdown/reconnect, real isolated LiveKit media
  and existing English/Farsi Piper tests before production promotion.
- Keep Windows 1.0.7, Android 1.0.6 and all four native manifests unchanged unless
  a proven incompatibility requires a separately tested native release.
- Preserve both service MemoryHigh and MemoryMax at 1073741824 bytes. Preserve
  `/opt/dorham-tts`, Caddy/HAProxy/LiveKit configuration, credentials and signing
  material. No download cleanup belongs to the backend migration.

## Current verified results

- Original 202 TypeScript unit/API tests pass: `v110-node-baseline.json`.
- Official Go 1.27.3 archive verified against published SHA-256:
  `f26081f438319757f8a1b46d7d0b2c5ec7583d4038e485e0aa725cfde7885fff`.
- Go backend implementation compiles for Windows and Linux without CGO. The
  Socket.IO dependency startup defect was resolved using maintained v3.0.6.
- All 86 historical HTTP/Socket.IO regressions pass against the Go process,
  including the rerun after transaction-local caching and voice coalescing.
  Evidence: `v110-go-existing-api-final-after-optimization.json`.
- Independent snapshot, image budget, revision fencing and shutdown tests pass;
  see `v110-independent-final-review.json` and subsequent test logs. These
  regressions exposed and fixed parent/sibling cache invalidation, transaction
  lifetime, SQL argument-type collisions and multipart budget handling.
- Node-to-Go-to-Node writes, old passwords/tokens, receipts, schema 11 and file
  bytes survive rollback: `v110-node-go-node-rollback.json`.
- Real isolated LiveKit microphone and screen-audio browser tests pass. Further
  browser checks pass for moderation, mentions, custom emojis, avatars, direct
  messages, invitations and recovery. No physical Android acceptance claimed.
- Matched local production-process benchmarks after voice coalescing measured
  approximately 59 MiB loaded Go RSS versus 310-312 MiB Node, 1.97-1.98 seconds
  versus 3.28-3.49 seconds for the mixed control workload, with comparable total
  CPU. This excludes Piper inference and physical media; it is not a VPS savings
  claim. See `v110-backend-benchmark.json` and preserved earlier measurements.
- Govulncheck found zero called-symbol or imported-package vulnerabilities using
  the official Go database mirror pinned at commit
  `8f7e390a0ff7345d74ecd7a056a1073214466db9` (2026-10-27). All 4,712 OSV blobs
  were verified and a positive control detected known vulnerabilities. Canonical
  endpoints return HTTP 403, so current canonical freshness is unverified. Three
  module-only advisories affect packages not imported by this backend.
- A preliminary private online backup is independently verified: 41 tables,
  schema 11, 362 file hashes. A fresh coordinated promotion backup is still
  required; this snapshot does not cover later production writes.
- Read-only SSH reaches the existing Linux x86-64 VPS; service is active and
  both 1024 MiB limits remain unchanged. No production changes performed.

## Completed promotion gates

- Final current-source Linux executable and Go/web inventory verified; a fresh
  coordinated private rollback backup is independently verified off-host.
- Public HTTPS/authenticated WSS, native origins, chat, voice membership, SFU
  credentials and real English/Farsi TTS pass. All 135 public web files match.
- Core data, private configuration, old hashed assets, both 1024 MiB service
  limits, LiveKit/proxies and all four native manifests are preserved.

## Resolved Linux gates

The earlier ext4 journal/fsync stall reproduced with independent Python, with
27% disk usage; no durability setting was changed. The current durable recheck
passes (approximately 3 ms fsync and 13 ms SQLite), as does real Go/Piper startup
on fresh durable data using genuine Socket.IO voice members. English cold/warm,
Farsi, recipient/privacy/epoch enforcement, loading announcements, worker reuse,
idle reclamation, restart and graceful shutdown pass. Ready API RSS was 20.56
MiB; peak API plus bilingual Piper RSS was 470.31 MiB. All owned test processes
and temporary state were removed. Production services/config remained unchanged.
See `v110-go-linux-piper-live.json` and `v110-media-consolidated.json`.

The earlier SQL-seeded speech fixture was inconclusive; its failure is retained
as historical evidence and superseded by the genuine Socket.IO test. Child RSS
sampling now enumerates all Go OS threads rather than just the main thread.

Independent fresh production/PostgreSQL checks pass 39 cases, including native
origins, CSRF/cookies, fixture exclusion, pgx TCP/PGlite migrations, rollback and
concurrent writes. See `v110-independent-production-pg-review.json` and the
reusable `tests/go-production-compat.mjs`.

Windows remains 1.0.7 and Android remains 1.0.6; neither was rebuilt. Physical
Android acceptance and new full media-capacity certification are not claimed.
