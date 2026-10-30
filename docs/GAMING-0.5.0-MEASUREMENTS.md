# 0.5.0 candidate verification and measurements

Subsequent rollout: the operator explicitly requested deploying 0.5.0 despite the failed capacity tests. See [release verification](RELEASE-0.5.0.md). The evidence below remains a historical candidate checkpoint; failures are not converted into passes.

Later on 30 October: [capacity retest](CAPACITY-RETEST-2026-10-30.md) also failed the required hold. It includes isolated VPS control-plane and two-browser diagnostics, exact cleanup and unchanged production state. The measurements below preserve the earlier candidate checkpoint.

Local work: 30 October 2026, Windows, pinned Node 24.22.1. The source version is 0.5.0; live remains 0.4.4. A failed required capacity run is not accepted as a pass.

## Recorded heavy workload

Ten Chrome contexts on one 16-logical-processor workstation, ten continuously active synthetic microphones, three 720p/15fps screen publishers, 27 deliberately watched remote video subscriptions and 90 voice subscriptions. Each publisher used the 450 kbps video target without shared sound. The control plane/database were isolated locally; signaling/API used private SSH loopback tunnels to the existing Iranian LiveKit server. Media traversed that server's TURN/TLS path. This does not certify the deployed public control plane or distributed physical devices.

| Measurement | Result |
| --- | --- |
| Required five-minute decoded hold | **Failed**; observed 110.153 seconds |
| Failure trigger | One video decoded no additional frames across a ten-second interval |
| Media decoded before failure | All 27 remote video and 90 voice subscriptions |
| Aggregate packet loss over observed hold | 1.09% |
| Combined Chrome/Edge peak working set | 4,669 MiB |
| Test-owned browser peak working set | 4,312 MiB |
| Browser guard | No memory stop; 6,144 MiB budget, 5,500 MiB conservative threshold |
| Browser CPU, mean | 273% of one core, approximately 17.1% across 16 logical processors |
| Isolated control-plane peak RSS | 155.7 MiB |
| Isolated local message acknowledgement p95 | 53.7 ms, 40 probes |
| Control-plane event-loop p95, highest recorded sample | 32.7 ms |
| Existing SFU peak RSS during observed hold | 166.2 MiB |
| Existing SFU peak CPU | 75.3% of one vCPU |

Data: `artifacts/evidence/v050-capacity-summary.json`, `v050-capacity-1793316181100/result.json`, `v050-capacity-tls-split-memory.json` and `artifacts/logs/v050-server-resources-hold.jsonl`. Per-stream loss, bytes, decoded frames and freeze counts are retained in the summary and raw samples. Lower aggregate loss does not imply good screen quality: freezes still failed the gate.

At the final failed interval, several clients received packets without decoding another complete video frame. Selected-pair RTT samples were approximately 3.9–6.7 seconds, and publisher target video bitrates fell to 30–54 kbps in the preceding sample and 30–35 kbps in the last sample. This supports investigating congestion on the tested path; it does not prove whether the bottleneck was the local uplink, relay routing, server network or another component. Browser memory and SFU CPU measurements alone cannot isolate that cause.

Earlier UDP runs showed much worse loss and missing/stalled screens. Some setup attempts also encountered SFU control errors through the private test tunnel. Those attempts and the subsequent TLS attempts remain preserved under `artifacts/logs/v050-capacity-*`; none is converted into a pass. Browser `totalAudioEnergy` stayed zero in this WebAudio playback path even while actual decoded stream analyzers measured sound. The corrected test matches each inbound track to its running WebAudio analyzer, requires nonzero decoded samples, and checks sample/frame progress over time.

## Optimization evidence and limits

The previous 0.4.4 initial JavaScript was 1,092,988 bytes raw / 302,293 bytes gzip. The candidate is about 556 kB raw / 166–169 kB gzip, depending on the final build hash. RTC adapters and the LiveKit SDK load on deliberate voice joining. This reduces initial parsing/loading; it does not reduce the total PWA precache transfer by the same amount. The service-worker precache deduplicates URLs, including deferred chunks and local Persian fonts, and excludes private APIs/history.

History uses a measured variable-height window, overscan and a 2,000-message loaded bound. Late attachment layout preserves following-latest behavior while older-history reading preserves its anchor. Windows idle rendering can throttle while active calls retain audio/signaling/background hotkeys.

There is **no matched old/new runtime CPU comparison** under identical media conditions in this release report. Do not infer a CPU reduction percentage from bundle size or compare the old four-share/12fps scenario against three shares/15fps. Higher-frame-rate eligibility is tested functionally, not certified as equal-cost capacity. A matched comparison and a successful full hold remain rollout gates.

## Capability matrix

| Capability | State | Evidence or remaining gate |
| --- | --- | --- |
| Revisioned saved channel overrides | Implemented, tested | Hydration, stale/legacy rejection, concurrent saves; SQLite and PostgreSQL adapter |
| Trusted-proxy/address/account budgets | Implemented, source tested | Spoofed/untrusted forwarding and independent trusted clients; live proxy reconfiguration awaits rollout |
| Three standard slots plus room-first fallback | Implemented, tested | Concurrent SQLite/PG allocation, second-fallback denial, expiry and promotion |
| Promotion does not silently raise fps | Implemented, tested | Real fallback publication; sender remains 15 until explicit selection of 30 |
| Protocol-2 share settings and audio authorization | Implemented, tested | Validation, revision/idempotency, SFU source grants and moderator removal |
| Deliberate watching, large viewer and chat drawer | Implemented, tested | Real decoded video, no automatic watching, Home retains voice, narrow Persian view |
| Stream audio gain/mute and deafen/PTT separation | Implemented, tested with synthetic sources | Actual decoded SFU output; 402 kbps video + 48 kbps audio sender limits |
| Browser capture sound and own-audio constraint | Implemented, partly tested | Capture constraints and decoded synthetic sound; real picker/physical feedback exclusion remains untested |
| Windows system-loopback sound | Safely disabled, untested | Must pass actual OS own-audio-exclusion regression before enabling |
| Output selection and device-change routing | Implemented, partly tested | Capability-gated UI and saved routing; physical unplug/Bluetooth/device matrix untested |
| Draft persistence, expiry, attachment restoration | Implemented, tested | Per-context restore, bounded store, expiry/account clearing, server attachment validation |
| Pending/failed/retry and late-response fencing | Implemented, tested | Lost committed response deduplicates; newer/other-channel draft survives retry/completion |
| Request deadlines/cancellation | Implemented, tested | Read/mutation/auth timeouts and explicit cancellation; separate upload cancellation/deadline |
| Visible focused unread state and bounded history | Implemented, tested | Unseen messages remain unread, Jump to latest, bounded rows and history navigation |
| PWA offline shell and Persian font | Implemented, tested | Offline browser reload; no private response caching |
| Mesh compatibility and failure feedback | Implemented, tested | Decoded media, initial-offer election, queued early signaling, unsubscribe, coordinator change and blocked ICE |
| Windows package, protected credentials and background PTT | Implemented, tested | Isolated installation, real OS key-state injection with another window focused and composer last focused, release/helper crash/lock mute, tray and decoded previews |
| Installed Windows plus Chrome over real SFU | Implemented, tested with synthetic capture | Bidirectional decoded voice/screens, deliberate watching, deafen silence, viewer close retains voice; TURN/TLS media with private isolated signaling |
| Compiled server ZIP runtime | Implemented, tested | Readiness, exact served web bundle, native registration, idempotent message commit, schema 1–4 and foreign-key integrity |
| Ten-user/three-share five-minute media capacity | **Failed; rollout blocked** | Video freeze after about 100 seconds; memory remained within authorized allowance |
| Reliable 16-user voice capacity | Untested | No distributed capacity certification |
| Unlimited fallback-room capacity | Untested | Allocation policy has no separate cap; hardware/network capacity remains finite |
| Iran-only international outage availability | Untested | No outage simulation or domestic DNS/certificate acceptance |
| Android | Deferred | No build or native-device changes in this release |

## Checks and deliverables

79 unit/API/contract tests pass, including PostgreSQL wire-adapter transactions and schema-3 backup migration/restoration. Lint/type checks and API/web/desktop production builds pass. Browser results: core 7/7, gaming 4/4, expansion 9/9, Persian 3/3, clipboard 1/1 and RTC prerequisite 1/1. Two focused real-SFU tests and the installed-Windows/Chrome SFU regression pass over TURN/TLS. The final NSIS installation passes decoded image/WebM/MP4/own-preview checks, native credential isolation, tray lifecycle and actual OS background hotkey injection. The compiled server bundle passes readiness, registration, retry deduplication and schema/FK checks. Production dependency audit reports zero known vulnerabilities and no new runtime dependencies. Full physical-device, acoustic cancellation and OS loopback tests remain untested.

Final evidence includes `v050-windows-complete.json`, `v050-windows-hotkeys-complete.json`, `v050-windows-sfu.json` and `v050-runtime-smoke.json`. Earlier intermediate failure logs remain for diagnosis; the release manifest identifies accepted checkpoints and the failed required capacity gate explicitly.

The unsigned installer, source ZIP and compiled server ZIP are candidate deliverables under `artifacts/v0.5.0` / `artifacts/Dorham-0.5.0-*`. Their hashes and exact gates belong to `artifacts/evidence/v050-release-candidate.json`. They are not a published production release. No GitHub push, live migration, paid upgrade, account reset or Android build was performed for this candidate.

## Cleanup and continuation

Fresh tests use nonce-owned local databases and exact UUID room manifests. The cleanup also removed 34 leftover accounts from this session's verified local fixtures; another seven were already removed by the guarded launcher. Only manifest-identified SFU test rooms were addressed. Production accounts were not created or deleted.

To continue: first measure uplink capacity, selected-pair RTT, per-publisher encoding progress and per-subscriber loss on a stable path. Reproduce using fewer distributed clients to distinguish one-workstation/uplink congestion from SFU behavior. Then repeat the identical ten-user/three-watched-share workload and full five-minute hold without weakening its assertions or memory guard. The required extra-room fallback/promotion is already covered by the focused real-SFU regression, but must also complete after the heavy hold in the combined scenario. Repeat the old/new CPU comparison at identical settings. Then validate the real proxy chain, retain an independent verified coordinated data/configuration backup and the previous application, migrate schema 4, apply the three-slot/30fps-ceiling/450kbps environment together, and verify public HTTPS/WSS/data preservation/restart behavior. Keep the current live release until these gates pass.
