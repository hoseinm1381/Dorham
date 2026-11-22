import { describe, expect, it } from 'vitest';
import type { GameKind, GameView } from '../packages/contracts/src/games';
import { arcadeCue } from '../apps/web/src/game-cues';

function views(kind: GameKind, state: GameView['state'], fields: Partial<GameView> = {}) {
  const before = { kind, state, id: 'game', revision: 1, status: 'playing', pausedUntil: 0, self: 0, ...fields } as GameView;
  return [before, (changes: GameView['state'], fields: Partial<GameView> = {}) => ({
    ...before, revision: before.revision + 1, state: { ...before.state, ...changes }, ...fields,
  })] as const;
}

describe('game sounds for confirmed actions', () => {
  it('ignores repeated, paused and different-game snapshots', () => {
    const [before, next] = views('four', { last: 1 });
    expect(arcadeCue(before, next({ last: 2 }, { revision: 1 }))).toBeUndefined();
    expect(arcadeCue(before, next({ last: 2 }, { pausedUntil: 3000 }))).toBeUndefined();
    expect(arcadeCue(before, next({ last: 2 }, { id: 'other' }))).toBeUndefined();
    expect(arcadeCue(before, next({ last: 2 }))).toBe('move');
  });

  it('distinguishes private picks, missed picks and a successful shared reveal', () => {
    const [before, next] = views('rps', { phase: 'quick-pick', submitted: [false, false] });
    expect(arcadeCue(before, next({ submitted: [false, true] }))).toBeUndefined();
    expect(arcadeCue(before, next({ submitted: [true, false] }))).toBe('move');
    expect(arcadeCue(before, next({ phase: 'quick-reveal', gains: [1, 0], ownEntry: 0 }))).toBe('success');
    expect(arcadeCue(before, next({ phase: 'quick-reveal', gains: [0, 0], ownEntry: 0 }))).toBe('miss');
  });

  it('makes a failed pair sound different from a match and a gem sound different from a clue', () => {
    const [memory, flip] = views('memory-match', { phase: 'quick-turn', matched: [false, false, false], flipped: [0] });
    expect(arcadeCue(memory, flip({ phase: 'quick-pair', flipped: [0, 1], matched: [true, true, false] }))).toBe('success');
    expect(arcadeCue(memory, flip({ phase: 'quick-pair', flipped: [0, 2] }))).toBe('miss');
    const [treasure, dig] = views('treasure-grid', { last: 0, remaining: 5 });
    expect(arcadeCue(treasure, dig({ last: 1 }))).toBe('move');
    expect(arcadeCue(treasure, dig({ last: 1, remaining: 4 }))).toBe('success');
  });

  it('uses the public betting log for chip actions, and the visible grid for a word reveal', () => {
    const [poker, play] = views('poker', { board: [], log: ['Hand 1'], phase: 'betting', hand: 1 });
    expect(arcadeCue(poker, play({ log: ['Hand 1', 'Player 1 called'] }))).toBe('move');
    expect(arcadeCue(poker, play({ board: [4, 7, 12] }))).toBe('card');
    const [words, select] = views('words', { team: 0, phase: 'guess', revealed: [false, false] });
    expect(arcadeCue(words, select({ revealed: [true, false], team: 1, phase: 'clue' }))).toBe('card');
  });
});
