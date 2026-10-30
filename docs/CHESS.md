# Chess in Dorham 0.6.0

Open **Chess** using the pawn button in the server rail. On a phone, open navigation first. Choose a server, Standard chess or Elixer Chess, a person or Easy/Medium/Hard AI, a 3/5/10/15 minute clock and a 0/2/5/10 second increment. Challenges expire after two minutes. Both players must be online to accept. Closing the chess screen keeps the match and voice connection active; use Resign to concede.

## Rules and ownership

The server validates every action, owns both clocks and decides results. Standard mode uses the normal starting army, legal king-safe moves, castling, en passant and an atomic promotion choice. It supports checkmate, stalemate, insufficient material, agreed draws, claims in a position with threefold repetition or 50 moves, automatic fivefold repetition/75-move draws, and a bounded 1,000-ply game limit. Draw claims on an intended future move are not exposed. Games are casual; no rating or tournament certification is claimed.

Elixer ports the user's game from `E:\Godot\Games\Chess\Chess_godot_v4\elixer-chess-with-anti-gravity`. Each player starts with a king and three coins. A move or purchase consumes the turn and earns one coin. Pawns cost 1, knights/bishops 3, rooks 5 and queens 9. Buy onto an empty square in your home two ranks, subject to king safety. A virgin bought pawn retains its initial double move; a bought home-corner rook can castle with an unmoved king. Promotion remains free. Purchases can block check, so they participate in checkmate/stalemate detection. The two initial kings do not trigger the standard insufficient-material draw.

The twelve SVG pieces are copied from that user-provided project. The original Godot files remain untouched. The GDScript rules were ported to a pure TypeScript module shared by the server and presentation. Expert AI, Google Sheets, ENet, Tube and native WebRTC extensions are not shipped in Dorham. Easy, Medium and Hard are lightweight replacements for the original AI, not equivalent-strength ports. Hard performs a time-limited heuristic search; it is not a chess analysis engine.

## Multiplayer and clocks

Challenge someone in the chosen shared server. Other current members of that server can watch; spectators cannot change state. Permissions and membership are checked on every read and mutation. Blocking prevents new challenges. Each account has at most one active match and three pending challenges; the instance allows at most 60 pending/active games. Pruning on new-game creation keeps approximately the latest 1,000 finished games globally. The lobby returns at most 30 recent matches per server.

Moves use a revision and durable request identifier. Reusing an identifier cannot apply a move twice; a different payload with the same identifier is rejected. Game state and the deduplication receipt commit in one database transaction. A missed event or reconnect reloads a complete authorized snapshot. New chess events contain only a match identifier and shared-server metadata, not private board payloads.

The running server uses monotonic elapsed time, rather than counting client frames or trusting client timestamps. It stores clock deadlines with accepted state transitions. On server restart it reconstructs the persisted deadline, then pauses surviving games for player reconnection; server downtime before restart counts against the previously running clock. A disconnected player has a total 30-second pause allowance across the match, preventing repeated reconnects from creating unlimited pauses. Both players disconnecting until the deadline produces a draw. A single absent player forfeits. Ordinary tab closure/reload keeps the existing pause/rejoin path; multiple sockets do not pause the match while another connection remains.

Clients render corrected countdowns locally. Transit and rendering delays can cause small display differences between snapshots; the server's result is authoritative. Spectator access requires both players to remain members of the selected match server. Leaving that server removes access; it does not transfer the game to another server.

## Resource budget

The game is a lazy React screen. Its JavaScript/CSS are excluded from background PWA pre-caching; pieces load on demand. No engine download, new npm dependency, extra game process, video stream or HTTP polling is required. Existing Socket.IO connections carry change notifications. Clocks render at four updates per second while visible, separately from the board; hidden tabs do not redraw them. A single server timeout targets the nearest actual deadline. Idle games do no periodic chess database work.

AI runs only on its turn, with an 8 ms search budget and at most 144 reply evaluations in Hard. Small non-interruptible operations can slightly exceed the search budget; measured timings are recorded in the release evidence. The server revalidates AI moves before committing them. The local 20-socket/eight-game benchmark is not a voice/screen capacity certification.

## Persistence and operations

Schema 6 adds only `chess_games` and its indexes. Existing tables/data are retained. Back up the database and configuration before upgrading; the prior application can read schema 6 while ignoring the new table. Keep rollback application files and the independent backup. Do not restore an old database over newer user messages as an application rollback shortcut.

Verification lives in `tests/chess-rules.test.ts`, `tests/chess.test.ts`, `tests/browser/chess.spec.ts` and release artifacts under `artifacts/evidence/v060-*`. Existing media capacity limits and deferred Android builds remain unchanged.
