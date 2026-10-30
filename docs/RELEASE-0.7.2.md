# Dorham 0.7.2 — game experience improvements

Reviews all eight games with changes to instructions, turn feedback, mobile layout, recovery and replay. Game cards retain their human player ranges and gain category labels. The catalog also lists ongoing games in the current voice channel. Spectators still watch first and explicitly choose Play; a replay creates a new lobby without forcing previous players into seats.

| Game | Improvements |
| --- | --- |
| Chess | Standard/Elixer instructions, clearer player/spectator guidance, a visible checked king, accessible promotion controls and Play again with the previous settings. Human seats still require voluntary joining; Expert AI remains disabled. |
| Texas Hold’em | Street names, private hand-category labels after the flop, minimum/half-pot/pot raise shortcuts and confirmation before an all-in raise. Hidden cards and hand categories remain private until authorized showdown. Mobile controls no longer cover the board or cards. Play chips only. |
| Dominoes | Visible chain-end numbers, clearer selected-tile guidance and selection that survives unrelated updates. Fixes a stalled mandatory opening when its tile owner leaves and resets the consecutive-pass count after a departure. |
| Drawing Telephone | Private drawing undo, fresh text fields each step, and Previous/Next album navigation for the final reveal. |
| Draw & Guess | Authorized drawing undo, visible ink budget, confirmation before clearing, fresh guesses each round and a sorted score table. Fixes premature/missing reveal after a successful or pending guesser leaves. |
| Team Word Clues | Explicit team/role labels, clue history and client validation for single-word clues and legal counts. The captain-only secret key is preserved. |
| Ludo | Large legal-move buttons for touch devices and stacked tokens, color-consistent progress counters and removal of departed tokens from the board. Existing documented rules remain unchanged. |
| Four in a Row | Winning-line and last-drop markers, named turn prompts, accessible cell coordinates and a complete replay/watch/Play flow. |

All games have collapsible English/Persian instructions and contextual turn prompts. Lobby start remains visible but disabled until enough players join. Countdown displays use minutes and seconds. Compact match headers leave more space for the actual game. Server validation/stale-state errors reload the authorized state without unnecessarily locking otherwise valid controls; uncertain network outcomes retain idempotent Retry recovery. Drawing resource limits and private projections are unchanged.

## Verification

Lint, types, 134 unit/API tests across 24 files and production API/web/desktop builds pass. New regressions cover domino opening departure, active-guess accounting, drawing undo authorization/budget, horizontal/vertical/diagonal win markers and private poker hand categories. Browser journeys exercise every arcade game, complete drawing and telephone rounds, poker betting, Ludo moves, word-key privacy, voluntary replay joining, stale-state recovery, lost replies and voice-channel changes. Final layout and release checks are recorded in `artifacts/evidence/v072-*` and `artifacts/logs/v072-*`.

The first combined browser batch stopped at the existing memory threshold. Subsequent runs use a fresh browser for one game at a time, as requested; the shared 4 GiB budget and stop thresholds remain unchanged. Visual inspection prompted a more compact header and removal of the mobile poker control overlay. Test screenshots wait for the lazy game panel to load.

No dependency, schema, external game engine, animation loop, additional media stream or polling loop is added. Game screens, drawing tools and the new shared guide module load on demand and are excluded from eager PWA caching. Existing media limits remain; these tests do not certify greater call capacity, physical acoustics or subjective enjoyment for a group of human players. Windows remains unsigned; Android and a fresh dependency advisory audit are outside this patch.

## Released build and public checks

The installed Windows payload matches all 40 web files and four desktop shell files. The compiled standalone server passes registration, message deduplication, all seven arcade lobbies, schema 8 and exact web delivery. Normal-system-DNS, certificate-validated HTTPS matches the final HTML. The public Chrome/installed-Windows scenario passes every arcade game plus Standard/Elixer Chess, with decoded SFU voice throughout, forced TURN/TLS voice/screens, private spectator views, replay/watch/Play, drawing undo and album navigation. Its combined browser-memory peak is 1,836.3 MiB. English/Persian capacity badges, mobile overflow, Chess reconnects/clocks/hotkeys and preserved replay settings also pass local browser checks.

The longer public scenario exposed test-fixture issues before the complete passing run: headless voice actors needed acknowledged heartbeats, raw test API reads needed a bounded retry when racing normal cookie renewal, one Node WebSocket connection timed out, and two scripted seat joins raced a revision. The corrected helper uses the same known-IP routing as the test browsers while retaining certificate verification, bounded connection recovery, acknowledged heartbeats and an explicit wait for each seat to commit. Production authorization, liveness and revision checks were retained. Each failed attempt's evidence is separate, and only its own manifest resources were removed before retrying.

The independent downloaded backup verifies 38 tables and four files. Restored-copy migration and compatibility with previous code pass. Deployment preserves all 35 persistent table digests, three avatar/attachment files and exact configuration; Dorham, LiveKit, Caddy and HAProxy are active. The previous application remains at `/opt/dorham-before-0.7.2`, alongside the retained private backup. Final cleanup removes only four test accounts, their test server and media room; 12 real accounts, three servers and 36 messages remain. Real users/messages added during testing were preserved.

All game screens and shared guides total 28,500 gzip bytes, loaded on demand. Main startup JavaScript grows by 3,207 gzip bytes from 0.7.1, primarily the new Persian text. No game module is in the eager service-worker cache. The 0.7.1 release archives and historical administrator-hotfix browser evidence remain unchanged; new evidence is versioned separately. Source, server, verification and unsigned Windows packages and SHA-256 hashes are under `artifacts/v0.7.2`; the release manifest is `artifacts/evidence/v072-release.json`.
