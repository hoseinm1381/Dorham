import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { quickAction, quickProject, quickStart, quickTimeout } from '../apps/api/src/games/quick';
import QuickGamePanel from '../apps/web/src/games/QuickGamePanel';
import type { GameView, QuickGameKind } from '../packages/contracts/src/games';

const initialTime = 100;
const players = ['Dara', 'Nila'];

function game(kind: QuickGameKind) {
  const engine = quickStart(kind, players.length, initialTime);
  const pick = (seat: number, choice: number | string) => quickAction(kind, engine, seat, {
    type: 'quick-pick', token: engine.token, ...(typeof choice === 'number' ? { choice } : { text: choice }),
  }, initialTime);
  const advance = () => quickTimeout(kind, engine, engine.deadline);
  const render = (self = 0, omitEmptyChoice = false) => {
    const state = quickProject(kind, engine, self);
    if (omitEmptyChoice && 'ownEntry' in state && state.ownEntry === null) delete state.ownEntry;
    const view: GameView = {
      id: 'test-game', channelId: 'voice', kind, self, state, players: players.length,
      hostId: '0', hostName: players[0], minPlayers: 2, maxPlayers: 2, paused: false, seated: self >= 0,
      seats: players.map((name, i) => ({ id: `${i}`, name, left: false, grace: 0, missingAt: 0 })),
      settings: { maxPlayers: 2, seconds: 60, rounds: 5, language: 'en', domino: 'draw', chips: 1000, blind: 20 },
      revision: 1, deadline: engine.deadline, serverNow: initialTime, pausedUntil: 0,
      status: engine.result ? 'finished' : 'playing', result: engine.result, canPlay: false, canStart: false,
    };
    return renderToStaticMarkup(createElement(QuickGamePanel, { view, state, act: async () => true, busy: false, disabled: self < 0 }));
  };
  return { engine, pick, render, advance };
}

it('keeps rock-paper-scissors choices private while explaining the winning matchup and point', () => {
  const match = game('rps');
  expect(match.render()).toContain('aria-description="Beats Scissors"');
  match.pick(0, 0);
  expect(match.render(1)).not.toContain('Rock earned');
  match.pick(1, 2);
  expect(match.render()).toContain('Rock earned a point');
  expect(match.render(1)).toContain('Your hand was beaten');
  expect(match.render(-1)).not.toContain('Your hand was beaten');
});

it('distinguishes matching hands from a round where only one player picks', () => {
  const tie = game('rps');
  tie.pick(0, 1); tie.pick(1, 1);
  expect(tie.render()).toContain('Matching hands. No point.');
  const idle = game('rps');
  idle.pick(0, 1); idle.advance();
  expect(idle.render()).toContain('No opponent picked a hand');
});

it('leaves choices available when an older lobby delta omits the empty choice', () => {
  const match = game('rps');
  const rock = match.render(0, true).match(/<button[^>]*aria-label="Rock"[^>]*>/)?.[0];
  expect(rock).toBeDefined();
  expect(rock).not.toContain('disabled');
});

it('states whether the next card was higher or lower only after the reveal', () => {
  const match = game('high-low');
  match.engine.rank = 9;
  match.engine.answer = 4;
  expect(match.render(1)).toContain('Face-down card');
  expect(match.render(1)).not.toContain('The next card was lower.');
  match.pick(0, 0);
  match.pick(1, 1);
  expect(match.render(1)).not.toContain('Face-down card');
  expect(match.render(1)).toContain('The next card was lower.');
});

it('calculates the extra die risk and explains a banked win', () => {
  const match = game('target-dice');
  match.engine.dice = [6, 6];
  expect(match.render()).toContain('6 of 6 extra rolls go over 12.');
  match.pick(0, 0);
  match.pick(1, 1);
  expect(match.render()).toContain('Closest to 12!');
  expect(match.render(1)).toContain('Over 12');
});

it('marks the correct odd tile and an incorrect pick separately at reveal', () => {
  const match = game('odd-one');
  match.engine.symbols = [0, 0, 1];
  match.engine.answer = 2;
  expect(match.render()).not.toContain('quick-correct');
  match.pick(0, 1);
  match.pick(1, 2);
  expect(match.render()).toContain('quick-missed');
  expect(match.render()).toContain('quick-correct');
  expect(match.render()).toContain('Odd tile: 3');
});

it('marks tile one as the odd symbol when the projected answer index is zero', () => {
  const match = game('odd-one');
  match.engine.symbols = [1, 0, 0];
  match.engine.answer = 0;
  match.pick(0, 0); match.pick(1, 2);
  expect(match.render()).toContain('Odd tile: 1');
});

for (const kind of ['high-low', 'odd-one', 'rps', 'target-dice', 'color-sequence'] as const) {
  it(`does not invent a ${kind} round result when the match ends before the reveal`, () => {
    const match = game(kind);
    if (kind === 'color-sequence') match.advance();
    match.pick(0, kind === 'color-sequence' ? match.engine.sequence : 0);
    match.engine.phase = 'ended';
    match.engine.result = 'Player 1 wins';
    const html = match.render();
    expect(html).not.toContain('quick-feedback');
    expect(html).not.toContain('NaN');
  });
}

it('shows the sequence slots while picking and marks only wrong positions after reveal', () => {
  const match = game('color-sequence');
  match.engine.sequence = '123';
  match.advance();
  expect(match.render().match(/class="quick-pattern-slot"/g)).toHaveLength(3);
  match.pick(0, '133');
  match.pick(1, '123');
  expect(match.render().match(/quick-pattern-missed/g)).toHaveLength(1);
  expect(match.render(1)).toContain('Pattern matched!');
});

it('guides the first and second flip, then labels matched and mismatched memory pairs', () => {
  const match = game('memory-match');
  match.engine.cards = [0, 0, 1, 2, ...match.engine.cards.slice(4)];
  expect(match.render()).toContain('Flip your first card');
  match.pick(0, 0);
  expect(match.render()).toContain('Flip a second card');
  match.pick(0, 1);
  expect(match.render(1)).toContain('Pair found!');
  match.advance();
  match.pick(1, 2);
  match.pick(1, 3);
  expect(match.render()).toContain('Different cards');
});

it('provides number shortcuts only when the range narrows to a few candidates', () => {
  const match = game('number-hunt');
  match.engine.secret = 49;
  expect(match.render()).not.toContain('quick-number-shortcuts');
  match.pick(0, 47);
  const round = match.render(1);
  expect(round).toContain('48–50');
  expect(round).toContain('quick-number-shortcuts');
  expect(round).toContain('Dara guessed 47');
  expect(round).not.toContain('Found it!');
  match.pick(1, 49);
  expect(match.render()).toContain('Found it!');
});

it('highlights only actual neighbors of an edge clue and clears the hint when a gem is found', () => {
  const match = game('treasure-grid');
  match.engine.treasures = [1, 4, 12, 18, 24];
  match.pick(0, 0);
  expect(match.render(1).match(/quick-neighbor/g)).toHaveLength(3);
  expect(match.render(1)).toContain('Tile 1: 1 neighboring gems');
  match.pick(1, 1);
  expect(match.render()).not.toContain('quick-neighbor');
  expect(match.render()).toContain('Gem found!');
});

for (const kind of ['rps', 'high-low', 'target-dice', 'odd-one', 'color-sequence'] as const) {
  it(`finishes all five ${kind} rounds with a stable personal result and final score`, () => {
    const match = game(kind);
    for (let round = 1; round <= 5; round++) {
      switch (kind) {
        case 'rps': match.pick(0, 0); match.pick(1, 2); break;
        case 'high-low':
          match.engine.rank = 3; match.engine.answer = 12;
          match.pick(0, 1); match.pick(1, 0);
          break;
        case 'target-dice':
          match.engine.dice = [6, 6];
          match.pick(0, 0); match.pick(1, 1);
          break;
        case 'odd-one':
          match.pick(0, match.engine.answer);
          match.pick(1, (match.engine.answer + 1) % match.engine.symbols.length);
          break;
        case 'color-sequence':
          match.advance();
          match.engine.sequence = '1'.repeat(round + 2);
          match.pick(0, match.engine.sequence); match.pick(1, '2'.repeat(round + 2));
          break;
      }
      expect(match.render()).toContain('quick-feedback-success');
      match.advance();
    }
    expect(match.engine.result).toBe('Player 1 wins');
    expect(match.render()).toContain('Round 5 of 5');
    expect(match.render()).toContain('quick-feedback-success');
    expect(match.render(1)).toContain('class="quick-total">0</bdi>');
    expect(match.render(1)).toContain('class="quick-total">5</bdi>');
  });
}

it('completes Memory Match with all twelve pairs marked and no available cards', () => {
  const match = game('memory-match');
  match.engine.cards = Array.from({ length: 24 }, (_, i) => Math.floor(i / 2));
  for (let pair = 0; pair < 12; pair++) {
    match.pick(pair % 2, pair * 2);
    match.pick(pair % 2, pair * 2 + 1);
    match.advance();
  }
  expect(match.engine.result).toBe('Game tied');
  expect(match.render()).toContain('12/12');
  expect(match.render()).not.toContain('Flip card');
});

it('completes Treasure Grid with all five gems collected and the winning score visible', () => {
  const match = game('treasure-grid');
  match.engine.treasures = [0, 6, 12, 18, 24];
  match.engine.treasures.forEach((cell: number, i: number) => match.pick(i % 2, cell));
  expect(match.engine.result).toBe('Player 1 wins');
  expect(match.render()).toMatch(/Gems remaining <strong>0<\/strong>/);
  expect(match.render()).toContain('class="quick-total">3</bdi>');
});
