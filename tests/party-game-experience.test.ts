import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { act, project, startEngine } from '../apps/api/src/games/engine';
import { dominoTiles } from '../apps/api/src/games/boards';
import DominoPanel from '../apps/web/src/games/DominoPanel';
import LudoPanel from '../apps/web/src/games/LudoPanel';
import PokerPanel from '../apps/web/src/games/PokerPanel';
import type { PanelProps } from '../apps/web/src/game-ui';
import type { GameKind, GameSettings, GameView } from '../packages/contracts/src/games';

const settings: GameSettings = {
  maxPlayers: 4, seconds: 60, rounds: 1, language: 'en', domino: 'draw', chips: 1000, blind: 20,
};
const players = [
  { id: 'host', name: 'Dara', left: false, grace: 0, missingAt: 0 },
  { id: 'peer', name: 'Nila', left: false, grace: 0, missingAt: 0 },
  { id: 'friend', name: 'Mina', left: false, grace: 0, missingAt: 0 },
];

function render(Panel: ComponentType<PanelProps>, kind: GameKind, state: GameView['state'], self: number, count: number) {
  const status = state.phase === 'ended' ? 'finished' : 'playing';
  const view: GameView = {
    id: 'fixture', channelId: 'lounge', kind, hostId: players[0].id, hostName: players[0].name,
    status, players: count, minPlayers: 2, maxPlayers: 4, paused: false, seated: self >= 0,
    revision: 1, seats: players.slice(0, count), settings, self, canPlay: false, canStart: false,
    deadline: 60_000, serverNow: 0, pausedUntil: 0, result: null, state,
  };
  return renderToStaticMarkup(createElement(Panel, { view, state, disabled: self < 0 || status === 'finished', busy: false, act: async () => true }));
}

it('names Poker suits without leaking hidden cards, even when the other two players reach showdown', () => {
  const engine = startEngine('poker', 3, settings, 0);
  const folded = engine.turn;
  const first = (folded + 1) % 3;
  const second = (folded + 2) % 3;
  engine.holes[folded] = [10, 23];
  engine.holes[first] = [12, 25];
  engine.holes[second] = [38, 51];
  engine.deck = Array.from({ length: 52 }, (_, card) => card).filter(card => !engine.holes.flat().includes(card));

  act('poker', engine, folded, { type: 'fold' }, settings, 1);
  const playing = project('poker', engine, first);
  expect(playing.holes).toEqual(engine.holes.map((cards: number[], seat: number) => seat === first ? cards : [-1, -1]));
  const personalBefore = render(PokerPanel, 'poker', playing, first, 3);
  expect(personalBefore).toContain('Your cards');
  expect(personalBefore).toContain('aria-label="Ace of Spades"');
  expect(personalBefore).toContain('aria-label="Ace of Hearts"');
  expect(personalBefore.match(/aria-label="Hidden card"/g)).toHaveLength(4);
  expect(personalBefore).not.toContain('aria-label="Queen of Spades"');

  for (let turn = 0; engine.phase === 'betting' && turn < 12; turn++) {
    const { controls } = project('poker', engine, engine.turn);
    act('poker', engine, engine.turn, { type: controls.canCheck ? 'check' : 'call' }, settings, turn + 2);
  }
  expect(engine.phase).toBe('between');
  expect(engine.showdown).toBe(true);
  const publicCards = project('poker', engine, -1);
  expect(publicCards.holes).toEqual(engine.holes.map((cards: number[], seat: number) => seat === folded ? [-1, -1] : cards));
  expect(publicCards.handRanks[folded]).toBeNull();
  const markup = render(PokerPanel, 'poker', publicCards, -1, 3);
  expect(markup).toContain('aria-label="Ace of Diamonds"');
  expect(markup).toContain('aria-label="Ace of Clubs"');
  expect(markup.match(/aria-label="Hidden card"/g)).toHaveLength(2);
  expect(markup).not.toContain('aria-label="Queen of Spades"');
  expect(render(PokerPanel, 'poker', project('poker', engine, first), first, 3)).not.toContain('Your private cards');
});

it('finishes Ludo with the fourth token home and keeps overlapping tokens separately positioned', () => {
  const engine = startEngine('ludo', 2, settings, 0);
  Object.assign(engine, { phase: 'move', die: 1, tokens: [[56, 56, 56, 55], [8, 8, 8, 8]] });
  const playing = project('ludo', engine, 0);
  expect(playing.legal).toEqual([3]);
  const before = render(LudoPanel, 'ludo', playing, 0, 2);
  expect(before).toContain('Move token 4');
  expect(before).toContain('3/4 Home');
  const stack = [...before.matchAll(/style="([^"]+)"[^>]+aria-label="Player 2, token [1-4]"/g)].map(match => match[1]);
  expect(stack).toHaveLength(4);
  expect(new Set(stack).size).toBe(4);

  act('ludo', engine, 0, { type: 'token', piece: 3 }, settings, 1);
  expect(engine.result).toBe('Player 1 wins');
  expect(engine.winner).toBe(0);
  expect(engine.deadline).toBe(0);
  const finished = project('ludo', engine, 0);
  expect(finished.tokens[0]).toEqual([56, 56, 56, 56]);
  expect(finished.legal).toEqual([]);
  const ending = render(LudoPanel, 'ludo', finished, 0, 2);
  expect(ending).toMatch(/class="finished".*?4\/4 Home/);
  expect(ending).not.toContain('Move token 4');
  expect(ending).not.toContain('Roll dice');
});

it('Draw Dominoes keeps the turn through unsuccessful draws and offers the newly fitting tile', () => {
  const id = (a: number, b: number) => dominoTiles.findIndex(pair => pair[0] === a && pair[1] === b);
  const engine = startEngine('domino', 2, settings, 0);
  Object.assign(engine, { turn: 0, chain: [[6, 6]], hands: [[id(0, 0)], [id(2, 2)]], boneyard: [id(2, 6), id(1, 1)] });
  const before = project('domino', engine, 0);
  expect(before.legal).toEqual([]);
  expect(render(DominoPanel, 'domino', before, 0, 2)).toContain('Draw tile');
  act('domino', engine, 0, { type: 'draw' }, settings, 1);
  expect(engine.turn).toBe(0);
  expect(project('domino', engine, 0).legal).toEqual([]);
  expect(project('domino', engine, 0).boneyard).toBe(1);
  act('domino', engine, 0, { type: 'draw' }, settings, 2);
  const available = project('domino', engine, 0);
  expect(available.legal).toEqual([{ tile: id(2, 6), end: 'left' }, { tile: id(2, 6), end: 'right' }]);
  expect(available.boneyard).toBe(0);
  expect(render(DominoPanel, 'domino', available, 0, 2)).not.toContain('Draw tile');
  act('domino', engine, 0, { type: 'tile', tile: id(2, 6), end: 'right' }, settings, 3);
  expect(project('domino', engine, 1).chain).toEqual([[6, 6], [6, 2]]);
  expect(engine.turn).toBe(1);
});
