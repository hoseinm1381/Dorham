# Mana Persian TTS trial and rollback

Current status: reverted to Amir on 2026-11-02 at the operator's explicit request after listening feedback. Automated synthesis/delivery checks passed, but the operator rejected Mana's sound. This is historical trial evidence, not an active model recommendation.

The trial worker replaced Amir with Mana Persian Piper in the existing standalone Piper worker. English remains LJSpeech. The model, configuration and model card are pinned to upstream revision `ad9dd8518bedf517bd7cbc9f63b8e5c844bf5bc0`, byte counts and SHA-256 in `deployment/tts-models.json`. The model card is preserved in `docs/licenses/piper-fa-mana-MODEL-CARD.md`.

Both voices produce 22,050 Hz mono PCM16, preserving the mixed-language WAV protocol and client player. Configuration is explicitly read as UTF-8. The current Persian eSpeak phonemizer is retained; the separate context-aware phonemization service suggested by upstream is outside this replacement. Pronunciation quality, especially names and ezafe, remains a listening judgment.

The existing loading recordings retain their original voices. This replacement does not require rebuilding native clients. CPU isolation, timeouts, lazy model loading, idle retirement, queue/cache limits and voice authorization are unchanged.

## Verification on 2026-11-02

- The downloaded model, configuration and card match the pinned checksums and sizes.
- Focused Go speech/worker tests pass.
- The existing Go-backed browser TTS regression passes: decoded playing audio, slash command/checkbox, room isolation and deafen.
- Focused lint and TypeScript checks pass.
- Isolated production Go executable plus the candidate Piper worker passed six real speech requests: English cold/warm, Persian, mixed Persian-English, and English/Persian across idle retirement/restart. Same-room authenticated audio and Socket.IO events passed; outside-room audio/events and previous-membership audio after rejoining were denied. Loading notifications reached the same room. Test accounts/data were isolated and removed; all owned workers exited.
- The speech cgroup retained `cpu.max=3000 10000` on the one-vCPU host with a 300-second deadline. Warm reuse used the production 180-second idle configuration; reclamation/restart used an isolated three-second idle configuration. Both production 1024 MiB application memory limits and service process identities/configuration remained unchanged.
- All 88 voice heartbeats passed (maximum 172.1 ms), as did all 19 public readiness probes. Combined isolated API/worker RSS peaked at 465.8 MiB in the bilingual phase; host available memory stayed above 1128.8 MiB. These are observed test results, not capacity guarantees.
- First English/Persian requests took 35.8/37.9 seconds under the cap; warm English took 5.9 seconds and the warm mixed request 7.5 seconds. Persian and mixed WAV durations were 4.613/5.366 seconds. Cold model loading remains noticeable.
- The Go-backed browser replay passed with the exact hash-verified Persian/mixed WAVs from that run. Both decoded into a running AudioContext and started in the ordinary voice player; the outside voice-room client played neither, and deafening prevented subsequent speech. This is automated browser playback, not physical-device listening acceptance.

Evidence: `artifacts/evidence/mana-socketio-evidence.tar.gz`, extracted `mana-socketio/outer-report.json` and `mana-socketio/socketio/report.json`, `mana-voice-playback.json`, and `mana-voice-playback.png`. The temporary VPS candidate is `/tmp/dorham-v110-mana-stage`; it contains the verified files used for the live deployment.

## Live deployment on 2026-11-02

The operator explicitly approved activation after the isolated checks. Mana was installed on the live server for this trial. There was no active speech worker at activation, so no API or media/proxy service restart was needed. Version remains 1.1.0; native installers/manifests are unchanged. Original Amir models remain available for rollback.

A temporary private room with two temporary accounts verified Persian, mixed Persian-English and English using the public HTTPS API and genuine Socket.IO membership. Both listeners retrieved identical WAVs. All 38 voice heartbeats succeeded (maximum 340.0 ms); the loading announcement arrived. The test accounts and room were removed, database integrity/foreign keys passed and original account IDs were preserved.

Observed generation: Persian 36.95 seconds / 29.10% host CPU, mixed 36.84 seconds / 29.16%, English 4.70 seconds / 27.88%. This run loaded Persian first, then loaded English on the mixed request; both cold model loads remain noticeable under the cap. The 30% quota, zero burst, 180-second idle retention, 300-second timeout and existing application memory limits are preserved. API/executable/environment/CPU drop-in and all service process identities are unchanged.

Rollback backup: `/var/lib/dorham-ops/backups/mana-before-a40f539fd5e6`. It contains checked copies of the original worker/manifests/model card and a verified online SQLite backup. `state.json` maps originals to their target paths with hashes and ownership; restore the TTS files for rollback without replacing the live database. Newly added Mana files can remain unused. A worker already running during a later rollback retains its loaded voice until retirement. The backup is retained on-server; automatic approval review rejected downloading the production database backup, so no local copy was made.

Evidence: `artifacts/evidence/mana-production-report.json` and `artifacts/logs/mana-activate.log`, `mana-production-probe.log`, `mana-finalize.log`. Live acceptance covers delivery/retrieval; real-clip browser playback was tested separately above. Physical phone/speaker listening and subjective pronunciation acceptance remain separate.

`node scripts/browser-tests.mjs --mana-tts-replay` runs the opt-in real-clip replay check with `DORHAM_BACKEND_ENGINE=go` and `DORHAM_MANA_SAMPLES` pointing to the extracted isolated test's `socketio` directory. The test checks sample hashes against that run's successful report, replays the Persian/mixed clips through the ordinary voice player, and checks room/deafen controls. Synthesis and authenticated Socket.IO delivery are verified separately on the isolated Linux backend; replay does not claim live remote synthesis inside the browser test.

## Reverted to Amir

Restored the exact previous worker, deployment/runtime model manifests and Persian model card from `/var/lib/dorham-ops/backups/mana-before-a40f539fd5e6`, verifying original hashes. The original Amir model files were already preserved and their pinned hashes were checked. Retired only the loaded speech worker so the next request starts Amir. API/media/proxy process identities, limits, native manifests and the live database were preserved. No database snapshot was restored. Mana files and historical evidence remain retained. Rollback record: `/var/lib/dorham-ops/backups/mana-reverted-d295e8d849b2`. Live Amir Persian and mixed-language speech verification passed through the public HTTPS API and genuine same-room Socket.IO membership. All 34 voice heartbeats passed (188.1 ms maximum); TTS measured 28.98% and 29.30% host CPU under the preserved 30% cap. Test accounts/room were removed, database integrity/foreign keys and original-account preservation passed. Evidence: `artifacts/evidence/amir-restored-production-report.json` and `artifacts/logs/mana-revert-amir.log`.
