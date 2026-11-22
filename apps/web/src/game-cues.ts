import type { GameView } from '../../../packages/contracts/src/games';
import { isQuickGame } from '../../../packages/contracts/src/games';
import type { GameCue } from './game-sound';

export function arcadeCue(previous: GameView, view: GameView): GameCue | undefined {
  if (previous.id !== view.id || previous.revision >= view.revision || previous.pausedUntil || view.pausedUntil) return;
  if (view.status === 'finished' && previous.status === 'playing') return 'finish';
  if (view.status !== 'playing') return;
  if (previous.status === 'waiting') return 'turn';
  const before = previous.state, next = view.state;
  switch (view.kind) {
    case 'four':
      if (before.last !== next.last) return 'move';
      break;
    case 'domino':
      if (before.round !== next.round) return 'turn';
      if (before.chain.length !== next.chain.length) return 'card';
      break;
    case 'ludo':
      if (before.tokens.flat().join(',') !== next.tokens.flat().join(',')) {
        return next.tokens.some((tokens: number[], seat: number) => tokens.some((token, i) => token === -1 && before.tokens[seat]?.[i] >= 0))
          ? 'capture' : 'move';
      }
      if (next.die && (before.die !== next.die || before.phase !== next.phase || before.turn !== next.turn)) return 'roll';
      break;
    case 'poker':
      if (next.hand !== before.hand || next.board.length !== before.board.length) return 'card';
      if (next.phase === 'between' && before.phase !== 'between') return 'success';
      if (before.log?.length !== next.log?.length || before.log?.at(-1) !== next.log?.at(-1)) return 'move';
      break;
    case 'telephone':
      if (before.step !== next.step) return 'turn';
      if (view.self >= 0 && !before.submitted && next.submitted) return 'success';
      break;
    case 'drawing':
      if (next.guessed.length > before.guessed.length) return 'success';
      if (next.token !== before.token || next.phase !== before.phase) return 'turn';
      break;
    case 'words':
      if (next.revealed.filter(Boolean).length > before.revealed.filter(Boolean).length) return 'card';
      if (next.team !== before.team || next.phase !== before.phase) return 'turn';
      break;
    case 'memory-match':
      if (next.matched.filter(Boolean).length > before.matched.filter(Boolean).length) return 'success';
      if (next.phase === 'quick-pair' && before.phase !== 'quick-pair') return 'miss';
      if (next.flipped.length > before.flipped.length) return 'card';
      if (view.self === next.turn && before.turn !== next.turn) return 'turn';
      break;
    case 'treasure-grid':
      if (next.remaining < before.remaining) return 'success';
      if (next.last !== before.last) return 'move';
      break;
    case 'number-hunt':
      if (next.low !== before.low || next.high !== before.high) return 'move';
      break;
    default:
      if (!isQuickGame(view.kind)) return;
      if (next.phase === 'quick-reveal' && before.phase !== 'quick-reveal') {
        if (next.gains?.[view.self] > 0) return 'success';
        if (view.kind === 'target-dice' && next.rolls?.[view.self]) return next.totals?.[view.self] > 12 ? 'miss' : 'roll';
        return view.self >= 0 && next.ownEntry != null ? 'miss' : 'card';
      }
      if (next.phase !== before.phase || next.round !== before.round) return 'turn';
      if (view.self >= 0 && next.submitted?.[view.self] && !before.submitted?.[view.self]) return 'move';
  }
}
