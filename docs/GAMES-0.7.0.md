# Voice-channel games in 0.7.0

Updated experience in **0.7.2**: [per-game improvements and fixes](RELEASE-0.7.2.md). The original rules and release baseline below remain useful; drawing undo, replay lobbies, richer feedback and departure fixes are described in that update.

Join voice, select **Games** beside **Share screen**, choose a game and its settings, then create a lobby. Each card and game header identifies its supported human player count. Lobbies and channel entries show actual occupancy, such as **3/8 joined**. Spectators do not consume player seats. Chess also retains its existing AI option.

| Game | Human players | Rules in this release |
| --- | --- | --- |
| Chess | 2 | Existing Standard/Elixer, clocks, Easy/Medium/Hard AI; Expert remains disabled. |
| Texas Hold'em | 2-8 | No-limit Hold'em with fixed blinds, private cards, side pots, split pots, minimum raises and short all-ins. Play chips only: no purchase, cash value, transfer or payout system. |
| Dominoes | 2-4 | Double-six Draw or Block. Seven tiles each. Highest double leads, otherwise highest pip total. Draw until playable, or pass in Block. Lowest pip total wins a blocked round; ties score nothing. First to 100 points wins. |
| Drawing Telephone | 3-8 | Everyone writes, then alternates drawing and describing. Each chain visits every seat once. Prompts and partial albums stay private until the final reveal. |
| Draw & Guess | 2-8 | Each player draws once per configured cycle. Correct guesses score 20-100 based on server elapsed time; each successful guess also gives the drawer 10 points. A five-second reveal separates turns. |
| Team Word Clues | 4-8 | Alternating seats form two teams. The first seat on each team is captain. Captains alone see the key. One-word clues with a number allow that number plus one guesses. Neutral/opposing cards end the turn; the danger card loses immediately. |
| Ludo | 2-4 | Four tokens each, six to enter, a bonus turn on six, three consecutive sixes lose the turn. Marked squares are safe. Other landings capture opposing tokens. Exact home finish; first to finish all four wins. Tokens can stack, without blockades. No additional capture/finish bonus. |
| Four in a Row | 2 | Seven columns, six rows, gravity, four connected horizontally/vertically/diagonally; a full board without a winner draws. |

The seven new games are human multiplayer games. The researched third-party projects were assessed as possible donors; this release implements the rules and UI directly in Dorham rather than embedding their sites or adding their servers/dependency trees. No third-party game code, art, audio or word lists were imported for these seven implementations. Drawing Telephone is Dorham's own game with this format, not the official Gartic Phone service or branding. Chess's existing user-provided artwork remains unchanged.

## Joining, leaving and recovery

Opening **Join [host]'s game** watches first. **Play** claims a seat transactionally. The host starts once the minimum number have joined. Only members of the original voice channel may claim seats or take actions; current channel members can watch. Blocking prevents seat claims. One account can occupy only one unfinished game across Chess and the new games. Stale/conflicting requests reload authorized state, and request identifiers prevent duplicate creation, seating, moves and submissions.

New players join a running poker table between hands. The host advances the next hand or domino round. Other games accept new seats before starting; someone arriving mid-round watches and joins a subsequent game. Closing a game screen leaves voice and the match connected. Leaving a game forfeits the seat. Leaving voice or disconnecting pauses with a total 30-second allowance per player. Returning resumes the server deadline without charging the pause. Expired absent seats are forfeited; the host transfers to a remaining player. Games continue when their rules allow it. Ludo/dominoes continue with remaining seats, drawing skips absent drawers, telephone automatically skips departed submissions, and a word team that can no longer field captain and guesser forfeits. Two-player games award the survivor a departure win.

Waiting lobbies expire after ten minutes. Poker actions allow 30 seconds: timeout checks if possible, otherwise folds. Four in a Row, Ludo and domino turns allow 60 seconds; an unattended turn ends the game. Drawing, telephone steps and word-team phases offer 45/60/90 seconds. Pending next hands/rounds close after five minutes. Timers and dice/deck generation belong to the server; browsers display countdowns locally. Restarted games pause for authorized voice reconnection using the remaining allowance. Phone albums remain readable in the existing game screen after completion.

## Private information and resource limits

The API constructs explicit player/spectator projections. It never sends decks, other poker hole cards, domino hands, telephone albums or the word-game key to unauthorized viewers. Poker showdown reveals only non-folded contenders. Spectators of Drawing Telephone see group progress until the reveal. Room/session events carry identifiers, not secret snapshots. Canvas subscriptions are authorized; telephone canvas deltas go only to their author, while draw-and-guess deltas go only to authorized watchers.

Game cards, screens, panels, canvas code and CSS load on demand and are excluded from eager PWA pre-caching. Existing authenticated sockets carry changes. Revisioned canvas deltas avoid fetching the entire drawing after each stroke; gaps/reconnects reload a complete authorized snapshot. Canvas paint runs only on input/state changes. There is no animation loop, extra media stream, external game server, paid API or new npm dependency. Idle game state does not poll; one timeout schedules the nearest deadline.

Limits: 60 unfinished games across Chess and the new games; each new game has at most eight seats; commands are capped at 16 KiB and 20 per second per account. Each picture allows 1,000 quantized points and 160 strokes; a stroke has at most 100 points. Each stored session is capped at 768 KiB of UTF-8 JSON. Creating a game prunes older completed arcade sessions to the latest 100. Existing one-day request-receipt cleanup remains in effect. These are bounded casual games, without a rating, wagering or professional tournament system.

Schema 8 adds `game_sessions` and `game_players` with indexes and cascading foreign keys. Schema-7 Chess records and existing application data are preserved. Keep the pre-upgrade backup and previous application; rollback the code without overwriting newer user messages with an old database.

## Verification

Rules tests exercise poker category/kicker ordering, best-five evaluation, unequal all-ins, odd split chips, raising restrictions, hundreds of complete hands and chip conservation. They also cover domino tile conservation, legal passes/draws, gravity/wins, Ludo safe squares/captures/exact finishes, private telephone chains, drawing limits and Persian normalization, clue permissions, departures and phase timeouts. API/socket tests cover all seven kinds, limits, authorization, simultaneous seats, cross-game exclusivity, blocking, idempotency, private projections, canvas subscriptions, host transfer, restart and reconnect budgets.

Browser scenarios cover every game, full Four in a Row and drawing rounds, complete telephone albums, poker betting/next hand, domino selection, Ludo dice/moves, team clues/guesses, English/Persian capacity identifiers, mobile overflow, canvas deltas, lost replies, reload and channel-change recovery. These checks do not certify additional voice/screen capacity, physical acoustics or an Android device build. Final release gates and measured artifacts are recorded in `RELEASE-0.7.0.md` and `artifacts/evidence/v070-*`.
