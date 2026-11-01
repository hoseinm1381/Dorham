# Server memory audit and local cleanup changes

On 2026-11-01, read-only SSH samples inspected the existing VPS. At that audit, the running backend was **1.0.4** and 1.0.7 was still local. It has since been released; see the deployment verification below. No service, configuration, kernel cache, database or file on the server was modified or restarted.

## Observed live memory

Three samples over approximately 10 seconds were stable:

| Measurement | Observed |
| --- | ---: |
| Host RAM | 1968 MiB |
| Available RAM | 1033–1036 MiB |
| Linux cached file data | 952.5 MiB |
| Swap used | 0 MiB |
| Dorham service cgroup, including child processes/cache | 604.4 MiB |
| Node backend RSS | 238.5 MiB |
| Speech worker RSS | 329.4 MiB |
| Speech worker private anonymous memory | 295.2 MiB |
| LiveKit RSS | 116.9 MiB |

Available memory already accounts for memory the kernel can reclaim; a high cache number does not establish that RAM is exhausted. See the [Linux proc memory definitions](https://docs.kernel.org/filesystems/proc.html) and [kernel cache guidance](https://docs.kernel.org/admin-guide/sysctl/vm.html#drop-caches). At sampling time there was no current Dorham memory pressure, no cgroup OOM/OOM-kill event, and no kernel OOM entry in the preceding 24 hours. Historical high-limit reclaim counters exist but did not advance across these samples. These short samples cannot exclude an earlier peak or a long-term leak.

The live Dorham service has **both `MemoryHigh=1073741824` and `MemoryMax=1073741824`**: 1024 MiB soft and hard limits. They were left unchanged. Preserve both during the next authorized deployment. [systemd distinguishes these controls](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html); the Node heap and whole-service memory are different measurements.

Full read-only evidence: `artifacts/evidence/v107-server-memory-before.json`. No message text, accounts, credentials or environment contents were collected.

## Implemented locally for 1.0.7

### Additional pre-deployment audit

A second read-only sample (`artifacts/evidence/v107-server-memory-followup.json`) found **1022–1030 MiB available**, about **629 MiB** in the Dorham cgroup, **242 MiB Node RSS** and **351 MiB Piper RSS**. Memory pressure averages were zero and Dorham's OOM/kill counters remained zero. Its historical high-limit counter did not advance. Both application limits remain **1024 MiB**. This is a short observation, not a leak soak test. The undeployed 180-second speech retirement remains the largest identified idle-memory opportunity.

Avatars and server icons previously started independent native decoders with no shared admission limit. They now share one decoder slot, with at most two waiting uploads. Admission happens before buffering the uploaded file; excess work receives `429 IMAGE_BUSY`, and queued work expires after 10 seconds. Read/decode failures release the slot, and shutdown rejects queued work. Authentication, image formats, 256 KiB compressed upload limit, 16-million-pixel decode limit, 128×128 WebP output and quality 80 are retained.

The libvips operation cache budget is **8 MB instead of the 50 MB default**, with 32 cached operations, no cached file handles and one native thread per image. Sharp documents these as [operation-cache and per-image thread controls](https://sharp.pixelplumbing.com/api-utility/), **not a total process-memory cap**. An active decoder can transiently allocate more. Administrator metrics now include image admission counts and actual Sharp cache state without image contents.

In two fresh local Windows process pairs, a synthetic 16 MP PNG (224,440 bytes) was resized in four three-upload bursts. Peak RSS growth was **47.6–47.8 MiB before** versus **17.7–17.9 MiB after**; all 12 thumbnail hashes matched in every run. Each run took 155–232 ms before versus 287–347 ms after because bursts are serialized. These measurements demonstrate a local spike reduction; they do not establish a fixed Linux production saving. Evidence: `artifacts/evidence/v107-image-memory-probe.json`.

The audit also checked attachment streams/admission, thumbnail tickets, authentication attempt maps, game limits, SQLite access and Socket.IO recovery. Their existing bounds were retained. Socket.IO retains missed packets for reconnect recovery; disabling it without a separate reconnect study would change reliability. No forced GC, OS cache flushing, lower speech quality, process restarts, database deletion or service removal was added. Fresh production verification remains a gate after publication is authorized.

Five new tests cover shared avatar/icon admission through real HTTP routes, bounded/unread queues, invalid/oversized images, disconnected uploads, queue expiry, shutdown, unchanged thumbnail output and administrator-only metrics. The current full test report is `artifacts/evidence/v107-memory-avatars-tests.json`; earlier memory reports below are historical.

The existing Piper worker retained its loaded voices for the lifetime of the application, even when TTS was quiet. Generated audio expired logically after two minutes but was only removed from its map when another TTS message arrived. A quiet server therefore retained unnecessary speech-model and expired-audio memory.

- Retire the speech-model child after **180 seconds idle**, checked by the existing five-second maintenance loop. Never retire it with active or queued speech. The next request launches it again; the first speech after idle can take longer while models load. Eligible listeners hear a pre-rendered English/Persian loading announcement in their interface language; this does not need another model or synthesis call.
- Wait for the retiring child to exit before launching its replacement, avoiding overlapping model processes. A child that does not terminate receives a kill signal after two seconds. This affects the speech worker only; it does not restart the application or disconnect voice.
- Sweep expired speech audio, deduplication entries and cooldown entries during maintenance even with no new requests. Reads also evict an expired clip immediately.
- Bound cached speech by **8 MiB** as well as the existing eight-clip ceiling and two-minute expiry. Individual worker responses remain bounded at 3,000,000 bytes; oversized base64 is rejected before decoding.
- Expose speech worker state, queue size, idle stops, audio bytes and cache counts in the existing administrator-only metrics endpoint. Do not include text or audio in diagnostics.
- Reject pending work during shutdown and prevent late synthesis results from touching the closed database or rebuilding a cache.

Optional configuration is documented in `.env.example`: `TTS_IDLE_SECONDS` defaults to 180, and `TTS_AUDIO_CACHE_MIB` defaults to 8. No new environment value is required for those defaults. Farsi/English models, speech routing, account data and normal message fallback are unchanged.

The observed worker's approximately 295 MiB of private anonymous memory is a concrete opportunity for idle reclamation. **Actual production savings are not yet measured**, because the new cleanup has not been deployed. RAM used for active speech will return while the models are needed. No periodic OS cache flushing, forced application-wide GC, scheduled server restart or deletion of persistent data is introduced.

## Verification

Lint, TypeScript, the API production build and all **190 unit/API tests in 39 files** pass. Seven new tests cover active-work protection, idle timing, replacement fencing, timeouts/late output, shutdown, byte-budget eviction, quiet expiry and late-result disposal. One test starts a real local child retaining a 32 MiB allocation, confirms its exit after idle, and synthesizes again through a new child. This is a lifecycle test with fixture WAV output; it is not a new production Piper/acoustic acceptance result.

Evidence: `artifacts/evidence/v107-memory-tests.json`, `artifacts/logs/v107-memory-tests.log`, and `artifacts/evidence/v107-memory-cleanup.json`. The compiled local server archive is rebuilt with these changes. The later loading-announcement change also updates the web/Windows player and bundled assets, so the current local Windows installer is rebuilt. Android remains 1.0.6. The original 190-test memory evidence is historical; the current suite and announcement checks are recorded in the 1.0.7 release notes.

After publication is authorized, preserve the existing limits and verify real Farsi/English TTS, idle worker exit, reduced service memory, continued voice connectivity, and the next cold TTS request. No production improvement is claimed before that check.


## Deployment verification

Version 1.0.7 is now released after independent backup verification, an isolated Linux migration and real Piper/LiveKit checks. Both live service limits remain 1024 MiB and configuration is unchanged. The isolated Linux test confirms real worker retirement/restart using a five-second fixture limit; production uses the 180-second default. The post-release read-only snapshot is `artifacts/evidence/v107-server-memory-released.json`. RSS immediately after an application restart is not a controlled measurement of 180-second idle savings. A kernel journal scan timed out during the follow-up; direct cgroup counters and pressure were read instead. No OS cache flushing or forced GC was performed.
