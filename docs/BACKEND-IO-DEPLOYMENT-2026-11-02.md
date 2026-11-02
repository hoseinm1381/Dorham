# Backend I/O patch — 2026-11-02

Deployment status: deployed and verified in production. Backend SHA256: `bdf67e8a819eed0a9e2a101011249cc6ea015742ccfaf83790ed8467e46d61a9`. Base application/native version remains 1.1.0; `IO_RELEASE.json` identifies this backend patch.

The backend patch keeps SQLite voice memberships, share leases and coordinators in memory-backed TEMP tables on a pinned connection. The durable tables remain in schema 11 for historical backups and rollback tools. Parent deletion triggers, runtime parent guards, share cascades and transactional rollback remain enforced. Temporary state disappears on restart and voice clients rejoin as before. PostgreSQL retains its existing persistence path.

History assembly uses four SQL reads per 50-message page rather than up to 200, with authorization and pagination still inside the original transaction. Bootstrap unread queries are batched, HTTP session/user resolution uses one join, and read cursors update only when they advance; durable request receipts remain intact. Six additive indexes improve attachment, receipt, quota, session and DM lookups without changing historical migration versions.

Ordinary retention cleanup runs once per minute; liveness, timeout enforcement and speech retirement remain on the five-second schedule. Completed orphan-directory passes wait five minutes before another scan. Explicit cleanup still forces a scan, and upload admission retains immediate storage-pressure cleanup.

Linux downloads, previews, ranges and HEAD share bounded integrity-verification results: at most 64 entries with 60-second expiry. Keys include digest, size, modification time, device/inode and change time; hashing and serving use the same file descriptor. Authorization is still checked on every request. Platforms without a reliable change-time fingerprint reverify rather than reuse results. File bodies remain streamed. Verification is coalesced under a short-lived verification lock that is released before streaming.

The SQLite page-cache ceiling is 32 MiB when headroom permits and falls to 8 MiB when host available memory is under 384 MiB, inherited service headroom is under 192 MiB, or measurement fails. Recovery requires host availability above 512 MiB and service headroom above 256 MiB. This is demand-driven cache use, not a 32 MiB reservation or a whole-service memory guarantee. No cross-request authorization cache or duplicate model/file-body cache was added.

The user authorized a 1280 MiB service ceiling if needed. Tests have not demonstrated a need to raise the existing 1024 MiB soft/hard limits; keep both existing values. The speech-only 30% CPU cap, 180-second production idle retirement, original Persian Amir worker, web payload and native download manifests are preserved.

Admin metrics add database read/write-statement/commit counts, cumulative SQL/commit/mutex-wait time, runtime voice storage mode and page-cache budget. Attachment metrics add full verification and cache-hit counts. Statement counts are not physical disk I/O or fsync counts.

## Validation before deployment

- Standard Vitest suite: 211/211 passed.
- Current focused Go-backed attachment/API regression suite: 20/20 passed.
- Go package suite passed locally, including memory-backed core/media/game fixtures, rollback, parent cleanup, receipts and history equivalence.
- Isolated Linux Go suite passed with its game-contract fixture present. The first run lacked that fixture and failed that single fixture-dependent test; the completed run is preserved separately.
- Production-mode compatibility: 39 checks passed, covering SQLite, PostgreSQL and production security behavior.
- Isolated genuine Socket.IO/Piper run passed English cold speech, Farsi after idle-worker retirement/restart, same-room delivery, outside-room denial, epoch rejection, capped speech and heartbeat responsiveness. All eight public readiness samples succeeded. Production services and files were unchanged during this test.
- The broad legacy TypeScript suite forced through the Go fixture has 11 pre-existing adapter/mock incompatibilities (200/211 on the preserved baseline). A new orphan-cleanup failure in the candidate was corrected and its focused 20-test suite rerun successfully. Do not label that broad forced-adapter run wholly green.

New deterministic checks confirm 100 heartbeats leave the durable WAL at zero bytes after checkpoint, and a 50-message page uses four assembly reads with identical reactions, mentions, attachment metadata, ordering and tombstones. Linux verification tests detect same-size corruption even when modification time is restored. Cache-pressure thresholds have hysteresis tests.

Private pre-update archive `io-before-237160690864` was downloaded with explicit user approval and independently verified locally: archive SHA256, all 35 file hashes, database integrity and foreign keys passed. It contains 30 accounts, 272 messages and 9 attachment records at snapshot time. It is excluded from Git/public releases. New activity after that snapshot must not be overwritten by a rollback.

## Deliberate boundaries

This patch retains serialized database access. A separate read pool needs connection and consistency work; increasing connection count alone would also break the connection-local runtime tables. Drawing commands still use durable state writes and durable deduplication receipts. Delta persistence/group commit needs a separate recovery design. Neither acknowledged chat/game writes nor SQLite synchronous durability were weakened. No provider-storage latency cure or percentage reduction in physical drive traffic is claimed.

## Deployment and rollback

Restart only Dorham after the verified backup and isolated checks. Verify the staged binary SHA256, preserve configuration/worker/web/native hashes and other service identities, and arm a rollback timer before replacing the executable. Install only the backend and patch metadata/source bundle. `IO_RELEASE.json` records the patch executable and source hashes and supersedes the base `GO_RELEASE.json` executable hash for this patch; historical base release metadata is retained.

Rollback restores the prior backend executable and prior patch metadata while retaining the current durable database, uploads, configuration, web assets and downloads. The additive indexes are harmless to the previous runtime. Do not restore an older database over messages accepted after deployment. Post-deployment validation must check public readiness, live Socket.IO voice presence despite empty durable voice tables, real bilingual TTS and unchanged user/data/resource identities before cancelling the timer.

Evidence is under `artifacts/evidence/io-fix-*`; private rollback material remains under `.tools/io-backup-verified-237160690864` locally and `/var/lib/dorham-ops/backups/io-before-237160690864` on the server.

## Production outcome

Only Dorham restarted; stop-to-local-ready time was 1.257 seconds. Public HTTPS readiness passed. Real public Socket.IO presence exposed both test voice members while their durable voice rows were empty. English and Farsi TTS passed, using 28.55% and 28.67% of host CPU over the respective synthesis intervals. All 34 public heartbeat acknowledgements passed; the maximum was 247.4 ms. Temporary test accounts and their private room/messages were removed.

Final preservation checks retained all 30 original accounts, 272 messages and nine attachment records, original asset hashes, schema versions 1–11, private environment, speech worker/model metadata, all web files, all native manifest hashes and the LiveKit/Caddy/HAProxy process/resource identities. All six additive indexes are present. Database integrity and foreign-key checks passed. Automatic rollback was cancelled only after these checks; the backup and rollback executable/script remain available.

Whole-service memory measured 331.7 MiB after bilingual speech, with no memory-high/max/OOM event. Both service limits remain 1024 MiB; the authorized 1280 MiB ceiling was unnecessary. This short sample is not a peak or soak guarantee. A separate 12.47-second API-process interval recorded zero physical read/write bytes; that is an observation under the sampled activity, not a whole-host or matched before/after throughput result. Four public readiness probes took 33–351 ms.

The final local Go suite passed 108 tests/subtests; the standard Vitest suite passed 211, focused current Go-backed regressions passed 20, and production-mode compatibility passed 39 checks. Isolated Linux and real bilingual speech validation passed as described above. The broad legacy forced-Go adapter limitations remain documented rather than counted as a green suite.
