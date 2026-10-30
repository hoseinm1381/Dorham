# Dorham 0.6.0 — shared chess

Adds Standard chess and the user's Elixer Chess variant inside the existing website/Windows UI. Users can challenge a fellow server member, accept/decline/cancel challenges, watch shared-server matches, resign, agree draws and reconnect. Clocks offer 3, 5, 10 or 15 minutes with 0/2/5/10 second increments. The server owns moves, purchases, clocks and results. A total 30-second pause allowance per disconnected player precedes forfeiture.

Expert AI is disabled in both UI and API. Easy, Medium and Hard remain as bounded lightweight opponents. English and Persian UI, keyboard-accessible square buttons, promotion selection, move history, board flip and the original user-provided chess piece artwork are included. The original Godot project is preserved.

This release uses a lightweight rules/UI port rather than an embedded Godot runtime, as selected by the user. It introduces no npm dependencies or external service. The game loads on demand and uses existing sockets; idle games do not poll. See [rules, limits, persistence and architecture](CHESS.md).

## Validation

The release checks include rules reference counts (initial-position perft 20/400/8,902 and Kiwipete 48/2,039), special moves, king safety, Elixer purchases and coins, server authorization, spectator denial, stale/idempotent requests, exact elapsed-time clocks, increments, pause/reconnect budgets, restart recovery, challenge expiry, draw consent and all supported AI levels.

Real Chrome tests cover lazy loading, user challenges, two-way moves, spectators, clock agreement, page reload, voice talk keys while the board has focus, and Persian phone layout. Initial browser attempts exposed exact-label test resolution and incorrect mobile navigation/language setup; these were corrected and their failure record is retained. The final scenario passes. Resource measurements and final release gates are recorded separately in `artifacts/evidence/v060-*`.

Schema advances from 5 to 6 with one additive table. The release workflow retains the prior application and independently verifies the data/configuration backup before rollout. Windows remains unsigned; Android packaging and earlier unresolved large-call capacity gates remain deferred. No new hosting, accounts, proxy services or paid infrastructure are required.

The final local checks pass lint, TypeScript, all 100 unit/API tests, API/web/desktop builds, the dedicated chess browser scenario and all seven existing core browser scenarios. The compiled production bundle passes a fresh schema-6 runtime smoke check; its 136 production dependencies audit with zero vulnerabilities. The NSIS installer exits 0 and all 27 installed web files plus four shell files match the final build. Installed Windows checks pass native credentials, sandbox/tray, inline media and actual OS background talk keys.

In the local 20-socket/eight-match synthetic run, 32 move requests measured 2.37 ms median and 3.74 ms p95; idle games issued zero chess queries in the three-second sample. Hard AI measured 1.25 ms median, 2.15 ms p95 and 2.96 ms maximum across 60 initial-position samples. The lazy game screen is 5,271 bytes compressed JS/CSS, plus 14,632 bytes of SVG artwork. These are local scope-limited results, not whole-server savings or media-capacity guarantees.

The independently downloaded pre-upgrade backup verifies all 35 existing tables and four data files. Restored-copy migration and previous-code schema-6 compatibility pass. Rollout preserves 32 persistent table digests, all three avatar/attachment files and the exact configuration; all four services are active. The prior application is retained at `/opt/dorham-before-0.6.0`.

Public HTTPS/WSS Chrome/installed-Windows verification passes shared Standard chess, original SVG decoding in the installed app, Elixer against Hard AI, resignation and continued decoded voice with chess open. The same run verifies bidirectional SFU voice/screens through forced TURN/TLS, mute cues, per-person volume and playback recovery, outgoing microphone gain, invitations and revisioned permissions. DNS pinning is process-local with normal certificate validation; a separate normal-system-DNS HTTPS readiness/exact-HTML check passes. Only the two manifest-owned test accounts, one test server and its media room were removed. Final pilot counts remain seven accounts, three servers and 25 messages.

Final package hashes, source and deployment commits, installed payload integrity, backup/rollout reports and test evidence are recorded in `artifacts/evidence/v060-release.json` and `artifacts/v0.6.0`. Original-source hashing confirms all 199 reviewed Godot files remain unchanged. The normal main script increases by 2,323 gzip bytes for the launcher and translations; the larger game screen/artwork remain on demand. Physical acoustics and elevated-game keyboard behavior remain untested, as in prior releases.
