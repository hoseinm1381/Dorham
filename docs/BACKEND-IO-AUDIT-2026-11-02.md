# Backend I/O audit — 2026-11-02

The largest opportunities are removing durable writes for temporary voice liveness, reducing repeated work in maintenance, batching history reads, and avoiding repeated full-file hashing. A large general-purpose RAM cache is a lower priority. Start with a bounded 64 MiB additional cache allowance, subject to measured service and host headroom.

Scope: review of the current Go 1.1.0 backend, web heartbeat/read-cursor callers, SQLite schema, speech worker and deployment documentation. No backend implementation, database, server configuration or production service was changed. No fresh SSH observation or production load test was performed. The only executable diagnostic used a synthetic in-memory SQLite database constructed from all 81 current schema statements; it never opened application data. Findings describe code paths, not measured production savings.

## Storage context and memory constraints

The user reports about 400 MB normal usage and 750 MB with TTS on a 2 GB server. We need to establish whether these numbers are host usage, process RSS or service-cgroup usage before allocating memory. They are not interchangeable.

Current release documentation records both service memory limits at 1024 MiB. Reconfirm the live values before implementation. That service includes the API, its speech child and memory charged to the cgroup; the machine also needs Linux, LiveKit and proxies. The 1.1.0 release's isolated API/Piper memory figures are not a current whole-server baseline.

The existing [storage incident report](SERVER-IO-2026-11-02.md) records a 21.574-second post-reboot sample with no physical disk reads, about 1.10 MiB writes, and 31.79% root-disk busy time. Six disposable 4 KiB write-and-fsync probes took 68–1452 ms, including interpreter startup. These are prior observations, read from the repository during this audit, not new measurements. They make write latency the first target. An application SQL read or file read does not necessarily cause a physical drive read: Linux may already satisfy it from cache. Application changes cannot fix an unhealthy provider storage path.

## Prioritized findings

### 1. Voice liveness makes durable writes every five seconds — high priority

Sources: `apps/api-go/internal/backend/service_voice.go:184–225`, `http.go:74–77`, `packages/media/src/livekit.ts:77`, and corresponding mesh/native timers.

Every voice heartbeat calls `VoiceAction` in its own transaction. It updates `voice_members.heartbeat` and state fields, attempts a share-lease expiry update, and maintains coordinator state. A selected coordinator's advancing heartbeat also changes its persisted expiry. Even a stable room with no new speech, messages or membership changes therefore writes repeatedly.

At 20 continuously connected voice users across rooms, the five-second interval implies 240 heartbeat transactions per minute, or 345,600 per day. These are calculated transaction counts, not measured fsyncs, bytes or actual daily use. The share update can affect zero rows; do not count every SQL mutation as a physical disk write.

The startup path already deletes `voice_members` and `share_leases` and resets coordinators, so this runtime state is not currently preserved across restarts.

Recommendation: make a bounded in-process registry authoritative for heartbeat timestamps and lease renewals. Ultimately keep the complete temporary room/member/share/coordinator state there, while persisting channels, policy, bans and moderator restrictions. Restart should require voice rejoin, matching the existing reset behavior. If an intermediate design retains SQL membership, all expiry checks must consult the same RAM liveness source; simply stopping heartbeat UPDATEs would incorrectly expire healthy users.

This is a substantial consistency change: update SFU reconciliation, TTS audience checks, room caps, permission revocation, leave/kick/move, connection epochs and game voice-presence integration together. Keep single-instance assumptions explicit. Expected registry size at the current user limits is small, but measure allocations rather than promise an exact footprint.

### 2. One SQL connection and a global mutex spread disk stalls — high priority

Sources: `db.go:87–88`, `db.go:133–145`, `db.go:244–272`; `hub.go:191–201,345–388`.

All database work is serialized through a single connection and mutex, including reads. Transactions hold the mutex through commit. Consequently a slow durable commit can queue authentication, history, heartbeat session validation and maintenance behind it. WAL alone does not give this application read concurrency because the wrapper prevents it.

Recommendation: first remove unnecessary writes and shorten transactions. Then assess a dedicated serialized writer plus a small read pool, initially two readers. Establish WAL and required per-connection PRAGMAs, retain consistent snapshots for multi-query authorization, and keep revocation guarantees. Merely increasing `SetMaxOpenConns` will not remove the mutex bottleneck. PostgreSQL uses the same wrapper plus a global lock row, so migrating databases alone does not solve this design.

Add metrics for mutex queue time, SQL execution time and transaction commit time separately. Existing action and maintenance metrics cannot distinguish these causes.

### 3. History has an N+1 query pattern and an unindexed attachment lookup — high priority

Sources: `service_messages.go:133–164,278–305`; `schema_sql.go`.

For a normal non-deleted message, `MessageView` performs four SELECTs: message/author, reactions, mentions and attachments. A 50-message page therefore performs 200 message-assembly SELECTs, plus pagination and permission work. The attachment lookup is `WHERE message_id=?`, but the schema has no index on that column. This can scan the attachment table once per message, including messages with no attachments.

Recommendation: fetch the page with authors, then batch reactions, mentions and attachments for those message IDs. This reduces message assembly toward four SELECTs per page, with pagination and authorization still separate. Avoid one giant join that multiplies reaction/attachment rows. Add `attachments(message_id)` after checking real table sizes. Query batching saves CPU, allocations and mutex occupancy even when pages are already cached.

### 4. Maintenance repeats expensive housekeeping every five seconds — high priority

Sources: `http.go:356–380`, `service_voice.go:392–418`, `media_attachments.go:438–end`, `hub.go:257–296`.

Every pass runs attachment cleanup, service cleanup, socket-session validation, and a voice notification that triggers voice snapshots, game presence reconciliation and SFU synchronization. Output deduplication and single-flight guards exist, but underlying database/reconciliation work still occurs. Five-second scheduling means 17,280 passes per day if uninterrupted.

Service cleanup attempts expiry DELETEs against sessions, refresh tokens, invites, mutation receipts, events, messages and voice state. Attachment cleanup totals storage, fetches up to 100 candidate rows, scans up to 100 directory entries, and can do one database existence query per file. The directory cursor is bounded and useful, but repeats full passes as it reaches EOF. No-op DELETEs are not evidence of physical writes; the repeated scanning, locking and query cost is still real.

Recommendation: retain five-second liveness, timeout enforcement and speech retirement checks. Move ordinary retention cleanup to 1–5 minutes and orphan-directory reconciliation to 5–15 minutes, with bounded chunks. Enforce expiry in request/authorization paths so physical removal can lag safely. Keep immediate storage-pressure cleanup before upload admission. Trigger room/game/SFU work on actual topology or policy changes, supplemented by a slower repair pass. Preserve prompt ban/revocation handling and the existing 30-second liveness contract.

### 5. Downloads hash entire files before serving — medium/high, attachment-dependent

Sources: `media_attachments.go:356–437`, `media.go:118–135`.

Ordinary downloads always hash the entire file, then reopen and read it to send it. Preview integrity results are cached for 60 seconds in at most 64 entries, but ordinary downloads do not reuse that cache. A preview range request after cache expiry hashes the whole file before sending even a small range. HEAD also reaches integrity hashing before the body is skipped.

Recommendation: reuse bounded verification results across downloads and previews, keyed by immutable file identity and expected digest. Coalesce concurrent verification of the same file. Preserve the integrity threat model: size/mtime alone cannot prove an externally modified file is unchanged. Consider verifying and serving through the same open descriptor to reduce replacement races. Recheck authorization and expiry on every request, including cache hits. A HEAD fast path is possible only after deciding its integrity contract. Keep large attachment bodies streamed; do not buffer 100 MiB uploads/downloads in RAM.

This removes repeated logical reads and hashing CPU. Physical disk savings depend on the OS cache and workload.

### 6. Several useful query indexes are absent — medium priority

The isolated schema probe produced these plans:

| Query | Current plan | Candidate index |
| --- | --- | --- |
| Attachments for a message | SCAN attachments | attachments(message_id) |
| Mutation receipt expiry | SCAN mutations | mutations(created_at) |
| Global rolling upload usage and expiry | SCAN attachment_usage | attachment_usage(created_at) |
| Session expiry | SCAN sessions | sessions(expires_at) |
| Sessions for one user, newest first | SCAN sessions + temporary sort | sessions(user_id,created_at) |
| Visible DMs for one user | SCAN dm_members | dm_members(user_id,hidden,conversation_id) |

Adding those candidate indexes only in the synthetic in-memory database changed the tested plans to indexed SEARCH operations. Message pagination already uses `messages_page` correctly. This validates index eligibility, not production timing or the production Go driver's exact planner. Tiny bounded session tables may not justify all indexes; prioritize attachments and mutation expiry, measure the rest, and account for index write amplification. Use a new migration rather than editing generated `schema_sql.go` directly.

Evidence: [query plans](../artifacts/evidence/backend-io-audit-2026-11-02.json) and [reproducible diagnostic](../artifacts/evidence/backend-io-audit-2026-11-02.mjs).

### 7. Drawing commands rewrite the complete game state — high priority during drawing games

Sources: `games_service.go:225–240,310–325,400–424`.

Each accepted drawing command loads the full JSON state, updates it, serializes and writes the whole state again, and stores a durable mutation receipt. State can reach 768 KiB; commands are admitted up to 20 per user per second. Actual stored state size, drawing rate and resulting WAL bytes have not been measured. SQLite updates do not necessarily rewrite every byte physically, but this path creates substantial potential write and allocation amplification. The existing lightweight deadline cache avoids some scheduler decoding; it does not eliminate command persistence.

Recommendation: consider durable stroke/delta records with periodic compact snapshots, preserving request deduplication and replay. A small durable group-commit queue could amortize sync cost while acknowledging commands only after commit. RAM-only stroke batching would introduce a crash-loss window and needs an explicit product decision. Avoid silently changing saved-game guarantees.

### 8. Read cursors write even when they do not advance — medium/low priority

Sources: `service_messages.go:308–315`, `service.go:36–54`, `apps/web/src/App.tsx:139–148`.

The frontend already debounces visible read updates for 500 ms and avoids sequences it knows are read. However, stale tabs or other devices can still submit old positions. The backend always UPSERTs the cursor and creates a mutation receipt, even when the effective position is unchanged.

Recommendation: add an atomic advance-only predicate first. Preserve existing request-ID conflict semantics; skipping the cursor update alone does not remove the receipt write. Further server-side coalescing can persist the maximum per user/conversation, but acknowledging before persistence changes whether unread state can regress after a crash. Treat that as a separate behavior choice.

### 9. Repeated authorization/bootstrap reads and metrics — secondary opportunities

Sources: `http.go:268–281,384–398`, `hub.go:191–201`, `service_servers.go:5–72`, `storage.go`.

HTTP session resolution uses two SELECTs; socket actions and maintenance also query session validity. Bootstrap has per-channel permission/tag work and two unread queries per conversation. Some request-local snapshot memoization already exists and should be retained. Administrator metrics repeatedly scan avatar metadata and compute attachment usage/counts.

Recommendation: join session/user resolution, batch maintenance validation, batch unread queries, and cache inexpensive public metadata or derived counts with explicit invalidation. Cache metrics for 5–15 seconds if polling warrants it. Cross-request permission/session caches require immediate invalidation on bans, logout, token rotation, password changes, role/tag/channel changes and expiry; TTL alone would weaken current revocation behavior. Optimize batching before introducing that complexity. Cached serialized messages also need author-profile, reaction, edit, deletion and attachment-expiry handling.

## A RAM plan appropriate to this machine

Use RAM for disposable/rebuildable data and temporary liveness. Keep acknowledged messages, accounts, recovery/session changes, moderation policy and durable game actions on persistent storage.

Initial proposed incremental allocation, not measured allocation or guaranteed safety:

| Area | Initial ceiling | Strategy |
| --- | ---: | --- |
| SQLite page cache, existing writer | 32 MiB | Test `cache_size=-32768`; grows with actual page use |
| Public metadata and derived lookups | 8 MiB | Bounded entries, invalidation on committed changes |
| Hot message data, optional after batching | 16 MiB | Byte-bounded LRU; recheck access; handle edits/profile changes/expiry |
| Verification results and runtime bookkeeping | 8 MiB | Includes voice registry; cap entries and account for overhead |
| Total additional allowance | 64 MiB | Do not prefill; count real allocation and overhead |

The existing speech audio cache already defaults to 8 MiB, eight clips and two-minute expiry, and audio is passed through pipes/in-memory buffers. Models are lazy-loaded per language and the worker retires after 180 seconds idle. These improvements already exist. Increasing the audio cache mainly retains clips; it does not currently reuse synthesis for identical text. Extending worker idle life could reduce cold model loading, but retains hundreds of MiB and should be justified by measured TTS frequency and headroom. Do not put model files into another application RAM copy or tmpfs by default.

Dynamic policy proposal: start with optional caches capped at 64 MiB and allow growth toward 128 MiB only after a soak establishes headroom. Compare host MemAvailable, service `memory.current` and `memory.max`, pressure and OOM/high events. Reserve roughly 192 MiB inside the service limit and 384 MiB host availability as initial guardrails; tune against observed bilingual TTS/auth/image peaks. Those thresholds are proposed, not a proof of safety. Shrink optional caches at pressure/high-water events, and never evict authoritative active voice state. Released Go heap objects may not immediately reduce RSS. SQLite page caches are connection-local, so any new read pool needs an aggregate cache budget rather than 32 MiB per connection by accident.

Linux already caches file pages. The audit's earlier zero-physical-read observation suggests duplicating static assets or the entire database in application RAM may provide little disk benefit. A larger SQLite page cache may avoid some database page reloads, but must earn its memory cost in measurements. SQL batching remains useful even with fully warm disk caches.

References: [SQLite cache_size](https://www.sqlite.org/pragma.html#pragma_cache_size), [SQLite WAL](https://www.sqlite.org/wal.html), [Linux cgroup memory controller](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory).

## Durability and checkpointing

WAL is already enabled, with a 1000-page automatic checkpoint threshold and a journal-size limit. The code does not explicitly set `synchronous` or `cache_size`; inspect effective PRAGMAs in the actual Go connection before tuning. The journal-size limit is not a hard bound on an actively growing WAL. Checkpoint work can fall on request commits, so collect WAL size and checkpoint/commit latency before considering a bounded background checkpoint strategy. Do not disable automatic checkpointing without a WAL-growth safeguard.

Do not treat `synchronous=NORMAL` as a free optimization: WAL remains consistent, but acknowledged recent transactions can be lost after OS/power failure. Keep current durability while removing disposable writes. Similarly, do not place the persistent database in tmpfs with periodic copying. See [SQLite synchronous documentation](https://www.sqlite.org/pragma.html#pragma_synchronous).

## Suggested implementation order and proof

1. Add bounded SQL/commit/mutex and physical-I/O measurements. Capture a quiet baseline and normal chat/voice/TTS/drawing intervals; collect cgroup and host memory simultaneously. Avoid SQL text parameters or message contents in telemetry.
2. Batch history assembly; add the highest-value indexes; split slow cleanup from liveness; share attachment verification results. These are narrow changes with clear checks.
3. Move temporary voice liveness/leases to RAM with the consistency changes above. Keep restart/rejoin and moderation behavior verified.
4. Add the small adaptive cache budget only where hit-rate and I/O evidence justify it. Consider reader concurrency after the transaction model is reviewed.
5. Optimize drawing persistence if those games materially contribute to writes.

Compare identical workloads with quiet server, 20 connected users across rooms, message pagination, bilingual TTS cold/warm/idle cycles, concurrent repeated/range downloads and a drawing game. Record physical bytes/IOPS, latency/queueing, SQL counts, WAL growth, cache hit rate, peak service memory, pressure and voice acknowledgement tail latency. Crash/restart checks must preserve acknowledged durable mutations and request replay; access checks must pass after immediate revocation. No percentage improvement or fixed RAM saving is claimed by this audit.
