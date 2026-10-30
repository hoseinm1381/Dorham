# Local performance evidence

Current v0.2 workload: p95 183.99 ms, peak 405.46 MiB and final 365.45 MiB RSS with 20 sockets/200 messages. See [complete v0.2 measurements and limits](UPGRADE-STATUS.md). Tables below preserve the previous release baseline.

Measured on Windows x64 with patched Node 24.22.1, one backend process, real SQLite/WAL and real Socket.IO clients. These numbers describe the local workstation, with other applications running, and do not establish Botkeep capacity.

| Workload or measurement | Observed result |
| --- | --- |
| Connected accounts | 20; account 21 denied |
| Primary voice-room membership | 16; participant 17 denied |
| Screen leases in three rooms | 16 + 2 + 2; fixed caps disabled; duplicate publication prevented |
| Messages | 200, sent by 20 concurrent sockets |
| Message acknowledgement | p50 92.52 ms; p95 110.49 ms; max 111.03 ms |
| Process memory | peak 348.86 MiB; final 348.80 MiB |
| CPU during measurement | 3578 ms; mean 82.75% of one core over 4.32 seconds |
| Event-loop delay | p95 82.51 ms |
| Database and WAL files | 4,665,045 bytes |

The short control-plane sample passes the initial 384 MiB RSS and 500 ms p95 goals. It does not establish long-duration steady state, a 640 MiB peak under every operation, native client memory use, or server media throughput. Mesh media travels between clients; the capacity scenario above reserves memberships and leases without generating media. See `artifacts/evidence/control-plane-load.json` for exact measurements.

The separate browser suite uses two actual Chrome contexts with synthetic microphones and canvas captures, exercising the real WebRTC implementation. It asserts received decoded audio samples and video frames, gain values, deafen, mute state, unsubscribe/resubscribe, two screen publishers and coordinator migration. The raw `getStats()` snapshots in `artifacts/evidence/webrtc.json` include RTP bytes, packet counts/loss, jitter, codec and decoded-frame/sample counters. This is local functional media evidence, not a calibrated speech-quality score or sustained 16-person benchmark.

The browser memory guard records every sample in `artifacts/evidence/browser-memory.json`. In the completed run, combined Chrome/Edge usage peaked at 3211.3 MiB, including unrelated existing tabs, and task-owned browser usage peaked at 1835.3 MiB. No unrelated browser process was closed. The revised budget is 4096 MiB with an early stop at 3500 MiB combined usage.

Latest control-plane measurement: 29 October 2026, 20 concurrent publisher leases. The previous five-lease measurement is preserved as `artifacts/evidence/control-plane-load-before-uncapped-20261029.json`. No media was generated in either load measurement.

The initial quiet-audio/screen-layout browser regression passed at 1908.3 MiB combined browser usage. A later three-scenario run passed the existing decoded WebRTC test, then stopped at 3539.9 MiB combined usage (1711.3 MiB owned) before completing the remaining tests. Its report is `artifacts/evidence/browser-memory-guard-stop-20261029.json`. A stopped suite is not a pass; the early guard preserved the 4 GiB budget.

Before a capacity claim, run the opt-in 16-person media test on a machine with an explicitly approved memory budget or distribute clients across machines. Record sustained workload, aggregate client CPU/RSS, bitrate and loss, speech intelligibility, the typical 1–2 screens, higher publisher counts with selective subscriptions, ICE restarts, and physical Android/cross-network results. The updated opt-in six-publisher browser scenario remains unrun. Never substitute a successful signaling connection for decoded media.

## External relay functional measurements

The configured free ExpressTURN relay passed both peers forced to relay-only ICE, bidirectional decoded audio with nonzero energy, two simultaneous non-black decoded screen streams and unsubscribe/resubscribe. These are short synthetic tests from the VPN-connected workstation, including fixture setup; they are not a voice-quality or throughput benchmark.

| Scenario | Peak combined browser/app MiB | Selected-pair RTT seconds | Decoded screen frames at sample |
| --- | --- | --- | --- |
| Isolated local backend, two Chrome clients | 2585.5 | 0.798–0.983 | 16 / 27 |
| Public Botkeep backend, two Chrome clients | 2742.5 | 0.407–0.423 | 28 / 27 |
| Public backend, installed Windows app and Chrome | 2607.9 | 0.648–0.769 | 24 / 37 |

Measurements include unrelated Chrome/Edge memory; the Windows run also counts the test's owned Dorham processes. All remained below the 4 GiB guard. Some samples showed packet loss and high RTT, so physical intelligibility and monitor fidelity remain acceptance gates. Sanitized RTP/loss/energy counters, screenshots and memory samples are preserved in `artifacts/evidence/relay-final.json` and the three per-scenario reports. No TURN password or account token is included.
