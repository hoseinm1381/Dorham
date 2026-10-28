# Local performance evidence

Measured on Windows x64 with patched Node 24.22.1, one backend process, real SQLite/WAL and real Socket.IO clients. These numbers describe the local workstation, with other applications running, and do not establish Botkeep capacity.

| Workload or measurement | Observed result |
| --- | --- |
| Connected accounts | 20; account 21 denied |
| Primary voice-room membership | 16; participant 17 denied |
| Screen leases in three rooms | 2 + 2 + 1; sixth publisher denied |
| Messages | 200, sent by 20 concurrent sockets |
| Message acknowledgement | p50 77.23 ms; p95 93.08 ms; max 93.95 ms |
| Process memory | peak 325.88 MiB; final 303.12 MiB |
| CPU during measurement | 2297 ms; mean 77.22% of one core over 2.97 seconds |
| Event-loop delay | p95 69.40 ms |
| Database and WAL files | 4,673,261 bytes |

The short control-plane sample passes the initial 384 MiB RSS and 500 ms p95 goals. It does not establish long-duration steady state, a 640 MiB peak under every operation, native client memory use, or server media throughput. Mesh media travels between clients; the capacity scenario above reserves memberships and leases without generating media. See `artifacts/evidence/control-plane-load.json` for exact measurements.

The separate browser suite uses two actual Chrome contexts with synthetic microphones and canvas captures, exercising the real WebRTC implementation. It asserts received decoded audio samples and video frames, gain values, deafen, mute state, unsubscribe/resubscribe, two screen publishers and coordinator migration. The raw `getStats()` snapshots in `artifacts/evidence/webrtc.json` include RTP bytes, packet counts/loss, jitter, codec and decoded-frame/sample counters. This is local functional media evidence, not a calibrated speech-quality score or sustained 16-person benchmark.

The browser memory guard records every sample in `artifacts/evidence/browser-memory.json`. In the completed run, combined Chrome/Edge usage peaked at 3211.3 MiB, including unrelated existing tabs, and task-owned browser usage peaked at 1835.3 MiB. No unrelated browser process was closed. The revised budget is 4096 MiB with an early stop at 3500 MiB combined usage.

Before a capacity claim, run the opt-in 16-person media test on a machine with an explicitly approved memory budget or distribute clients across machines. Record elapsed sustained workload, aggregate client CPU/RSS, per-peer bitrate and loss, speech intelligibility, two shared screens in one room and five globally, ICE restarts, and physical Android/cross-network results. Never substitute a successful signaling connection for decoded media.

## External relay functional measurements

The configured free ExpressTURN relay passed both peers forced to relay-only ICE, bidirectional decoded audio with nonzero energy, two simultaneous non-black decoded screen streams and unsubscribe/resubscribe. These are short synthetic tests from the VPN-connected workstation, including fixture setup; they are not a voice-quality or throughput benchmark.

| Scenario | Peak combined browser/app MiB | Selected-pair RTT seconds | Decoded screen frames at sample |
| --- | --- | --- | --- |
| Isolated local backend, two Chrome clients | 2585.5 | 0.798–0.983 | 16 / 27 |
| Public Botkeep backend, two Chrome clients | 2742.5 | 0.407–0.423 | 28 / 27 |
| Public backend, installed Windows app and Chrome | 2607.9 | 0.648–0.769 | 24 / 37 |

Measurements include unrelated Chrome/Edge memory; the Windows run also counts the test's owned Dorham processes. All remained below the 4 GiB guard. Some samples showed packet loss and high RTT, so physical intelligibility and monitor fidelity remain acceptance gates. Sanitized RTP/loss/energy counters, screenshots and memory samples are preserved in `artifacts/evidence/relay-final.json` and the three per-scenario reports. No TURN password or account token is included.
