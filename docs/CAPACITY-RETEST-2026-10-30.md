# Dorham 0.5.0 capacity retest — 30 October 2026

**Retest result: the required capacity gate failed. No push or deployment occurred during the retest. The operator subsequently explicitly authorized the 0.5.0 rollout; see [release verification](RELEASE-0.5.0.md).**

The operator requested another test and freed memory twice. The executed application was the existing 0.5.0 candidate, commit `0d0e39013b9ff4106605aedc3b898beeea71c721`; no application feature or codec changed during these tests. The final diagnostic also used two Chrome processes, five isolated account contexts each. That topology is explicitly different from the original single-browser run.

## Workload and protections

Ten users in one voice room, ten continuously active synthetic microphones, three 720p/15fps moving-canvas screen publishers at the 450 kbps video target, sound off, 27 explicitly watched remote screen subscriptions, 90 voice subscriptions and three optional local previews. All clients ran on this one Windows workstation. The test required a complete five-minute decoded hold, then an extra room's fallback publication and promotion.

Media was forced through the existing Iranian SFU's TURN/TLS path. Control/signaling used private SSH forwarding. An initial local control-plane test was followed by a compiled candidate running privately on the same VPS, with a fresh separate database, loopback-only port, the existing installed runtime/dependencies and no production route/environment changes. The live application's schema and database were not migrated.

The browser ceiling remained 6,144 MiB with a conservative 5,500 MiB stop threshold. The private diagnostic guard additionally stopped for less than 768 MiB of available system RAM. It counted unrelated regular Chrome in the combined browser total, and never closed unrelated windows. One stop sample reached 5,718 MiB before termination, still below the authorized ceiling.

## Attempts

| Attempt | Result | Combined browser peak |
| --- | --- | --- |
| Initial local backend startup | Timed out before load; not a media test | 0 MiB |
| Local control plane, one browser | All ten joined, decoded warm-up failed; API recorded a 23-second event-loop pause | 4,116 MiB |
| Isolated VPS candidate, one browser | Guard stopped before the hold; 3,584 MiB test-owned plus about 2,134 MiB other Chrome | 5,718 MiB |
| Fresh VPS candidate, one browser | Full 27-video/90-voice decoded warm-up succeeded; ten-member observation last passed at sample start 70.419 seconds, then membership failed | 5,089 MiB |
| Fresh VPS candidate, two browsers | Full decoded warm-up succeeded; membership last passed at sample start 20.208 seconds, then failed | 5,112 MiB |

These sample-start times are not certified continuous holds. Snapshot collection and message probes sometimes delayed progress substantially. The single-browser failure snapshot started at 154.364 seconds and the two-browser failure snapshot at 74.070 seconds; their later completion is not counted as successful media time. The final one-browser test took about 7.2 minutes overall, including warm-up, blocked monitoring and cleanup; that duration does not satisfy the five-minute hold.

The required combined extra-room fallback/promotion stage was never reached. Its earlier focused two-client regression remains a separate pass.

## Measurements and interpretation

| Measurement | VPS / one browser | VPS / two browsers |
| --- | --- | --- |
| Candidate API peak RSS, setup plus test | 233.7 MiB | 223.3 MiB |
| SFU peak RSS | 167.2 MiB | 169.9 MiB |
| Candidate API peak CPU, one-core basis | 19.7% | 22.9% |
| SFU peak CPU, one-core basis | 65.0% | 68.7% |
| Maximum sampled API event-loop p95 | 26.82 ms | 28.54 ms |
| Message probe round-trip p95 | 356.61 ms / 30 probes | 12,378.96 ms / 20 probes |
| Last selected-pair maximum RTT | 406 ms | 210 ms |
| Observed packet-loss counter window | 1.270% | 4.626% |

Message round trips include the private SSH test path and client scheduling; they are not backend execution times. Loss values are RTP counter deltas from the observed sample window, not a completed quality hold. Raw per-stream packets, bytes, decoded frames and freeze counters are retained. Earlier snapshots lack per-track collection timestamps, so delayed collection makes derived FPS/bitrate imprecise; the harness now records those timestamps and snapshot completion time for future runs.

Browser CPU aggregates and valid same-PID sampling coverage are in the summary JSON. They are not a matched old/new application comparison: browser process topology and test paths differ. No CPU improvement percentage is claimed.

The VPS backend remained responsive during the isolated failures. In the final run, its control metrics still showed nine connected accounts while several clients showed only eight or nine voice members. One client reported a realtime timeout followed by `NOT_IN_VOICE`. Both isolated attempts therefore failed the room-retention requirement. Low sampled media RTT does not rule out packet loss, control-path delays or client scheduling stalls. Server RSS/CPU alone does not establish the cause.

## Lasting harness changes and next investigation

- Optional `DORHAM_CAPACITY_BROWSERS=2` uses two guarded Chrome processes instead of ten contexts in one browser. It does not reduce the account/subscription count or encoding target.
- Statistics reads have a 15-second deadline, and failure capture runs concurrently, so stalled diagnostics cannot wait indefinitely.
- Future runs additionally check exact audio/video subscription counts throughout the hold and record per-track timestamps and snapshot completion time. These stricter checks were added after the failed attempts; no pass is claimed for an unexecuted revision.

Next, instrument per-client heartbeat send/ack times, Socket.IO disconnect reasons and JavaScript timer lateness, and correlate them with server-side membership expiry. Check the private forwarding path against a production-like encrypted path without changing lease expiry merely to hide disconnects. Repeat across multiple physical machines to distinguish one-laptop/probe effects from an application or network defect. Then repeat the unchanged full hold and combined fallback/promotion stage, followed by the still-pending matched old/new CPU comparison. No reliable 16-user capacity, unlimited fallback capacity or Iran-only outage availability is certified.

## Cleanup and evidence

Removed all 40 test accounts and four test servers/databases created in these attempts, plus their manifest-identified SFU rooms, synthetic messages and private staging payloads. No files were uploaded into conversations. All private test tunnels and observers were stopped, and ephemeral credential files removed. Test-created bootstrap administration existed only in the isolated databases.

A final read-only production check confirmed version 0.4.4, schema 1–3, the same six accounts, one server and sixteen messages, zero foreign-key violations, and all four production services active. Existing source/server/installer candidate archives remain unchanged; this retest has its own source/evidence checkpoint.

Primary evidence: `artifacts/evidence/v050-retest-1793341245-summary.json`; raw results under the run IDs listed there; corresponding memory logs and `artifacts/logs/v050-retest-1793341245-*`. Exact stage cleanup manifests and the post-test live check are included in the retest verification archive. Lint and type checking cover the final harness changes; the prior 79 application tests/build evidence remains associated with the unchanged application candidate.
