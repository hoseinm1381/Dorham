# Dorham 0.5.1 — server efficiency and talk controls

This patch prioritizes backend/control-plane work and the reported microphone bugs. Android, hosting changes, search, mentions and inbox remain deferred. The existing three-standard-slot/fallback sharing policy, 450 kbps encoding target and room/account limits are unchanged.

## Server changes

- SFU heartbeat processing refreshes only its own membership/share lease and coordinator. Global expiry/promotion stays on topology changes and the existing five-second maintenance path. No lease timeout was increased.
- A maintenance pass expires memberships/leases once, then visits only active rooms or coordinators that need clearing. Empty channels no longer cause repeated global deletes, election reads and coordinator writes. Unchanged coordinator rows are not rewritten; epoch fencing remains.
- Ordinary local mute/PTT/deafen changes refresh authorized rosters without enumerating SFU rooms/participants. Share grants, moderator mute/deafen, removals, permission changes and expiry retain confirmed SFU enforcement. Unchanged state reports do not broadcast another roster. SFU state acknowledgements return liveness; changed rooms are pushed once rather than also rebuilt for each acknowledgement.
- Bootstrap and realtime recipient authorization reuse identical reads only within one serialized transaction. Multi-device audiences check each account once per snapshot. No permission/audience/session cache survives a commit. Hidden channels, private DMs, banned users and changed permissions remain protected.
- Mesh/SFU state acknowledgements coalesce pending changes and deduplicate the applied state, including connection identity. Local microphone release is immediate, independent of a pending network acknowledgement.
- The existing admin-only metrics endpoint now includes bounded realtime action counts, failures, timing maxima/slow counts, disconnect reasons, maintenance duration/timer delay and SFU reconciliation counters. No new polling loop or detailed user trace is enabled.

## Talk behavior

Toggle-to-talk starts muted in a new call/mode, then stays latched when switching tabs/apps. A second talk press or microphone click switches it off. Leaving the call resets it. Windows lock, sleep and helper failure still release talk-key modes.

Push-to-talk opens only while its talk key is held. Page focus loss closes browser PTT; Windows background bindings continue in other apps when enabled. Clicking the mic while PTT is idle does not create a hidden mute lock or open continuous audio. Clicking while speaking mutes immediately; the next fresh talk-key press re-enables PTT. A short hint explains the selected binding. Changing modes clears obsolete manual locks.

Function keys and Ctrl/Alt combinations work while composing text. Plain letter/space/navigation bindings remain ignored in text inputs, and all talk bindings are suppressed during hotkey recording. Website hotkeys cannot receive presses from another app; use the Windows client for background PTT/toggle control.

The patch also enlarges chat text/timestamps, improves control focus/target sizes and respects reduced-motion preferences. It adds no media layer or visual timer.

## Matched local measurement

`scripts/server-performance-benchmark.ts` uses an isolated SQLite database, ten sockets in one room, three screen leases, fourteen channels, 100 heartbeats, 20 mute transitions, 20 unchanged state reports, ten bootstraps, five maintenance passes and ten topology refresh requests. Registration is outside timing. SFU synchronization is mocked/counted; no media is generated. Both measurements use Node 24.22.1 and the same workload. Baseline code is the deployed 0.5.0 source.

| Work | 0.5.0 | 0.5.1 |
| --- | ---: | ---: |
| Total SQL reads | 10,598 | 4,656 |
| Total SQL write statements | 1,065 | 369 |
| Heartbeat write statements | 600 | 210 |
| Bootstrap read statements | 1,512 | 840 |
| Maintenance write statements | 175 | 45 |
| SFU synchronization requests caused by 40 ordinary state reports | 40 | 0 |
| Final process RSS | 305.1 MiB | 305.5 MiB |

This workload uses about **56% fewer reads and 65% fewer write statements**. These counts include no-op SQL; they are not disk-write bytes. RAM did not materially improve. Raw phase CPU times are retained but short local samples do not establish a whole-VPS CPU reduction. The original baseline's total SFU counter includes setup; use the measured phase counters (50 baseline versus 10 after), not its setup-inclusive 63 total.

A separate real SQLite/20-socket messaging run processed 200 messages, enforced 16 members in the primary room, and allocated three standard plus two room-eligible fallback leases. It measured 94.27 ms p95 acknowledgements and 315.54 MiB peak process RSS. No media was generated; it is not an SFU capacity certificate.

Evidence: `artifacts/evidence/server-performance-before.json`, `server-performance-after.json`, `control-plane-load.json` and `artifacts/logs/v051-*`. All fixtures use isolated/manifest-owned data; no real accounts are deleted.

## Acceptance boundary

Unit/API, browser and Windows results are recorded in the release report. The failed 0.5.0 ten-user media hold remains failed. This patch does not certify sustained ten-/sixteen-user media, an Iran-only outage, physical acoustic behavior or elevated/protected-game hotkeys. Repeat the distributed decoded-media capacity test separately, correlating the new server counters with client scheduling/transport evidence. Do not lengthen leases to conceal failures.
