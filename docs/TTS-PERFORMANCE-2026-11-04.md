# TTS performance update — 2026-11-04

**Later 1.1.1 delivery revision:** whole-message preparation with private inline
progress replaces the two-half delivery described below. Retention, pressure
eviction/recovery, models, optimized graphs and cache remain in place. See
[current source/tests/live samples](RELEASE-1.1.1.md). Chunking statements and
measurements below preserve the earlier deployment's evidence.

Status: deployed and verified on `https://dorhamapp.ir` on 2026-11-04 after explicit upload/deployment approval. Production finalization and stopping the automatic rollback timer were separately approved and completed. Amir, the 30% TTS CPU cap, existing 1 GiB service limits, application data, public web payload and native download manifests are preserved. Optional web-player queue/translation source changes remain local for a coordinated client/web release; existing clients receive the ordinary private WAV events without a reinstall.

## Worker and memory policy

`TTS_KEEP_WARM=true` is the Go backend default. One Python worker preloads both Amir and LJSpeech in the background and retains those ONNX sessions. It does not synthesize dummy speech. The first background attempt is after five seconds; failed preparation backs off for one minute. A crashed process is retired and retried with a thirty-second delay. Requests and prewarming share a single serialized worker, preventing overlapping inference/model loading.

Linux samples host `MemAvailable` and the smallest inherited cgroup `memory.max` headroom, including the service parent. Every five-second maintenance pass and each real synthesis checks the reserve. The worker is sacrificed, including active synthesis, below 384 MiB host availability or 192 MiB service headroom. Optional text-reuse audio is also cleared. Restart requires another 448 MiB of headroom (832 MiB host, 640 MiB service) for both models, preventing rapid unload/reload cycles. Existing service memory limits and the TTS cgroup CPU quota are unchanged.

Requests during insufficient memory retain the normal text message and send: “TTS was unloaded to free server memory. Speech will resume when enough memory is available. Your text message was sent normally.” The updated web-player source translates this warning into Persian when appropriate; the unchanged deployed clients still show the server's English warning. When memory recovers, the worker preloads again automatically. Linux telemetry failure prevents worker loading/retention; non-Linux development can run without the Linux memory reader.

Set `TTS_KEEP_WARM=false` to restore `TTS_IDLE_SECONDS` retirement. The existing 180-second setting remains accepted but does not expire a persistent worker.

## Partial delivery and reuse

Messages with at least two whitespace-separated words split near the midpoint into two ordered WAVs, preserving original text, punctuation and Persian ZWNJ. The first half is published once generated and at least three seconds after request acceptance; the second is generated and delivered next. Three seconds is a minimum buffering delay, not a promise that synthesis always completes within three seconds. One-word messages use one clip. Splitting can introduce a pause or change prosody at the boundary.

Each half receives the existing authenticated private/no-store audio route and a fresh recipient/voice-epoch snapshot; the sender, message, speak permission and audience are checked again before each half. Old clients can play the ordinary WAV events. Optional `messageId`, `chunkIndex` and `chunkCount` describe grouping to newer clients. The updated player holds up to twelve pending clips; the server retains up to sixteen delivery clips within the byte budget.

Identical exact text can reuse the two generated WAVs for two minutes. The lookup stores SHA-256 text keys, not a second plaintext transcript. It reuses only audio: every new message gets fresh authorization and IDs. Delivery and reuse share the existing 8 MiB aggregate accounting budget; duplicate references are conservatively counted. Reuse is capped at sixteen entries and expires/evicts before delivery audio when the budget is needed. There is no disk speech cache or text logging.

## Install-time ONNX preparation

`deployment/install-tts.py` now invokes `deployment/optimize-tts.py` after verifying the original pinned files. Existing installations can invoke only:

```sh
/opt/dorham-tts/venv/bin/python deployment/optimize-tts.py --models /opt/dorham-tts/voices
```

Prepare these files on the destination CPU in a separate capped installation/test process. The original model/config files are never overwritten. Optimization uses ONNX Runtime's existing graph transformations, without quantization or a voice replacement. Sidecars record original/optimized SHA-256 plus runtime, OS, CPU flags and processor identity. Preparation is idempotent and publishes files via temporary siblings. Runtime validates the sidecars, loads a compatible prepared graph with repeat optimization disabled, and falls back to the original graph on missing, stale, corrupt or unloadable optional artifacts. Startup never downloads or writes model files. `DORHAM_TTS_DISABLE_OPTIMIZED=1` explicitly selects the original models.

Primary reference: [ONNX Runtime offline graph optimization](https://onnxruntime.ai/docs/performance/model-optimizations/graph-optimizations.html). Hardware-specific output must not be shipped between arbitrary hosts.

## Verification and operations

The Go suite covers persistent/prewarmed reuse, idle opt-out, pressure eviction during active synthesis, restart hysteresis, shutdown cancellation, midpoint preservation, first-half delivery while the second is blocked, exact-text reuse, expiration/bounds, and fresh room/epoch/deafen authorization. The one-browser Go test verifies actual decoded ordered PCM, minimum three-second delay, outsider denial for both audio routes and deafening. The existing thirteen speech tests, TypeScript checking, focused lint, web build and Linux/Windows backend builds pass.

Local ONNX checks use the exact public pinned models and verify installation idempotence, unchanged originals, deterministic inference equivalence and incompatible-sidecar fallback. Measured model-loading times and real speech evidence are stored under `artifacts/evidence/tts-optimized-models-local.json` and `artifacts/evidence/tts-performance-real/`. Local Windows timings do not certify VPS latency or Linux cgroup behavior.

Repeat the real speech check explicitly against a prepared local runtime:

```powershell
$env:DORHAM_TTS_PYTHON='D:\Dorham\.tools\tts-test-venv\Scripts\python.exe'
$env:DORHAM_TTS_MODELS='D:\Dorham\.tools\tts-test-voices'
node tests/tts-real-performance.mjs
```

This starts a fresh loopback-only release backend, uses disposable accounts/database, checks genuine Persian/English/mixed WAVs, exact-text cache hits and hash identity, room/rejoin isolation, and persistence beyond a one-second test idle setting. It removes the owned database and stops its worker tree afterward. Browser fixture checks run with `node scripts/browser-tests.mjs --tts-performance`; set `DORHAM_GO_FIXTURE_BINARY` to a freshly built fixture executable.

The tested candidate is retained separately at `/tmp/dorham-v110-tts-performance-20261104-1`. The passing isolated Linux integration used its own delegated 1 GiB service and lowered only that disposable service's memory limit. It verified actual eviction, the warning, restart hysteresis and automatic preloading/recovery. All seventeen readiness probes passed; production process identities and configuration were unchanged during the test. Its first attempt is retained on-server separately: speech, cache and eviction passed, but excessive test polling reached the normal API rate limit. Slower polling completed the full retry. This was a test-harness failure, not a bypass of the production limit.

## Production results

Only Dorham was restarted. The live private-room probe generated real Persian, English and mixed audio and verified both halves through public HTTPS and genuine Socket.IO membership. Outside-room requests were denied, and leaving/rejoining invalidated previous audio. One preloaded worker PID remained throughout. Repeated Persian text returned byte-identical cached audio with zero measured worker CPU time. Test accounts, room and messages were removed; database integrity, foreign keys and original account preservation passed. All heartbeat checks passed (maximum 141.3 ms).

| Public probe | First half available | Both halves available | Worker CPU time |
| --- | ---: | ---: | ---: |
| Persian | 5.83 s | 11.29 s | 3.09 s |
| English | 4.34 s | 7.28 s | 1.99 s |
| Mixed | 4.98 s | 7.78 s | 2.29 s |
| Repeated Persian | 3.17 s | 3.27 s | 0.00 s |

These are short representative tests, not upper latency bounds. Three seconds remains a minimum buffering delay. Unique-text inference averaged 27.2–29.2% total-host CPU in the public probe; the existing cgroup remained `cpu.max=3000 10000` with zero burst and an uncapped API parent/child. Full bilingual preloading still takes roughly fifty seconds under this cap after an actual cold restart, but it now runs once in the background and is retained until memory pressure. The isolated test measured 56.8 seconds for that cold background warmup. Recovery after memory eviction can therefore still take time.

On the destination CPU, saved graphs matched deterministic original-model inference exactly (maximum absolute difference zero). Model-loading CPU time fell from 7.76 to 6.74 seconds for Amir and from 6.99 to 6.13 seconds for LJSpeech, about 12–13%. The corresponding throttled wall measurements were 26.09→22.50 seconds and 23.30→20.41 seconds. This is a modest cold-loading improvement; retention and audio reuse avoid that work altogether on subsequent requests. These measurements do not claim faster unique-text neural inference.

Verified backup: `/var/lib/dorham-ops/backups/tts-performance-before-d52bd9e0f7c7`. It contains original code/model sidecars and a checked on-server SQLite backup; no production database backup was downloaded. The automatic rollback timer is stopped after successful live verification and explicit approval. For a later manual code rollback, remove its `deployment-committed` guard only as part of an authorized rollback and run the retained `rollback.py`; it preserves the current database rather than restoring the snapshot.

Evidence: `artifacts/evidence/tts-performance-linux.json`, `tts-optimized-models-linux.json`, `tts-performance-production.json`, `tts-performance-final.json`, `tts-performance-browser.json`, and `tts-performance-real/report.json`. The Linux executable SHA-256 is `b00e31eae827460adf4f4b192906116d65099d8aaa920bcd0cb5a8927d67c3e0`. Local code and documentation are not committed or pushed as part of this task.
