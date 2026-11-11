import { expect, it } from 'vitest';
import { act, depart, project, startEngine, timeout } from '../apps/api/src/games/engine';
import { gameCommand, gameCreate } from '../apps/api/src/games/service';
import { gameCatalog, quickGameCatalog, type GameSettings } from '../packages/contracts/src/games';
import { gameClientFeature, legacyFeatureNotices, supportsClientFeature } from '../packages/contracts/src/client-features';
import { version } from '../package.json';

const settings: GameSettings = { maxPlayers: 16, seconds: 60, rounds: 1, language: 'en', domino: 'draw', chips: 1000, blind: 20 };
const requestId = 'b6d00ced-ab01-47ba-b953-571d697b2ad9';

it('assigns every game added after the original catalog a client requirement', () => {
  const original = new Set(['chess', 'poker', 'domino', 'telephone', 'drawing', 'words', 'ludo', 'four']);
  for (const game of gameCatalog) {
    if (!original.has(game.id)) expect(gameClientFeature(game.id), game.id).toBeDefined();
  }
});

for (const { id, max } of quickGameCatalog) {
  it(`registers ${id} at its capacity and projects the correct opening for a spectator`, () => {
    const create = { requestId, kind: id, channelId: 'channel', settings: { maxPlayers: max } };
    expect(gameCreate.safeParse(create).success).toBe(true);
    expect(gameCreate.safeParse({ ...create, settings: { maxPlayers: max + 1 } }).success).toBe(false);
    const requirement = gameClientFeature(id)!;
    expect(requirement.id).toBe('arcade.quick-games');
    expect(supportsClientFeature(requirement, version)).toBe(true);
    for (const older of [undefined, '1.2.7', '1.2.8-beta', '1.02.8']) {
      expect(supportsClientFeature(requirement, older)).toBe(false);
    }
    const state = startEngine(id, max, settings, 0);
    const shown = project(id, state, -1);
    expect(shown.scores).toEqual(Array(max).fill(0));
    expect(shown).not.toHaveProperty('entries');
    expect(shown).not.toHaveProperty('secret');
    expect(shown).not.toHaveProperty('treasures');
    if (id === 'memory-match') expect(shown.cards).toEqual(Array(24).fill(null));
  });
}

it('uses the legacy announcement format for clients without feature placeholders', () => {
  expect(legacyFeatureNotices('android', '1.2.5')).toMatchObject([{ id: 'client-update:arcade.quick-games', en: expect.stringContaining('1.2.8'), fa: expect.stringContaining('1.2.8') }]);
  expect(legacyFeatureNotices('windows', version)).toEqual([]);
  expect(legacyFeatureNotices('web', '1.2.7')[0].en).toContain('Refresh Dorham');
});

it('locks all sixteen hands privately, reveals them together, and rejects a pick from a past round', () => {
  const kind = 'rps';
  const state = startEngine(kind, 16, settings, 0);
  const action = { type: 'quick-pick', token: state.token, choice: 0 };
  expect(gameCommand.safeParse({ requestId, revision: 1, kind: 'action', action }).success).toBe(true);
  act(kind, state, 0, action, settings, 1);
  expect(project(kind, state, 0).ownEntry).toBe(0);
  expect(project(kind, state, 1)).toMatchObject({ ownEntry: null, submitted: [true, ...Array(15).fill(false)] });
  expect(() => act(kind, state, 0, action, settings, 1)).toThrow();
  for (let seat = 1; seat < 16; seat++) act(kind, state, seat, { ...action, choice: 2 }, settings, 2);
  expect(project(kind, state, -1)).toMatchObject({ phase: 'quick-reveal', scores: [15, ...Array(15).fill(0)] });
  timeout(kind, state, settings, state.deadline);
  expect(() => act(kind, state, 0, action, settings, 1)).toThrow();
});

it('reveals the sequence during watch and after all active players submit', () => {
  const kind = 'color-sequence';
  const state = startEngine(kind, 3, settings, 0);
  const sequence = project(kind, state, -1).sequence;
  expect(sequence).toMatch(/^[1-4]{3}$/);
  const action = { type: 'quick-pick', token: state.token, text: sequence };
  expect(() => act(kind, state, 0, action, settings, 1)).toThrow();
  timeout(kind, state, settings, state.deadline);
  expect(project(kind, state, -1)).not.toHaveProperty('sequence');
  act(kind, state, 0, action, settings, 2);
  act(kind, state, 1, action, settings, 2);
  depart(kind, state, 2, settings, 3);
  expect(project(kind, state, -1)).toMatchObject({ sequence, phase: 'quick-reveal', scores: [1, 1, 0] });
});

it('shows only flipped and matched Memory Match cards and hides mismatches after the reveal', () => {
  const kind = 'memory-match';
  const state = startEngine(kind, 2, settings, 0);
  state.cards = [0, 0, 1, 1, ...state.cards.slice(4)];
  const pick = (seat: number, choice: number) => act(kind, state, seat, { type: 'quick-pick', choice }, settings, 1);
  pick(0, 0);
  expect(project(kind, state, -1).cards.slice(0, 4)).toEqual([0, null, null, null]);
  expect(() => pick(0, 0)).toThrow();
  pick(0, 1);
  timeout(kind, state, settings, state.deadline);
  pick(1, 2);
  const mismatch = state.cards.findIndex((value: number, i: number) => i > 3 && value !== 1);
  pick(1, mismatch);
  timeout(kind, state, settings, state.deadline);
  expect(project(kind, state, -1).cards.slice(0, 4)).toEqual([0, 0, null, null]);
  expect(project(kind, state, -1)).toMatchObject({ turn: 0, scores: [1, 0] });
});
