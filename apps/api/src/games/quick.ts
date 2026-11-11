import { randomInt } from 'node:crypto';
import type { QuickGameKind } from '../../../../packages/contracts/src/games';
import { insist, integer, shuffle, type Engine } from './common';

const roundCount = 5;
const pickTime = 20_000;
const roundRevealTime = 5_000;
const watchTime = 6_000;
const pairRevealTime = 2_000;
const turnTime = 20_000;
const gridSize = 5;
const treasureCount = 5;

export const quickIsRoundGame = (kind: QuickGameKind) =>
  kind !== 'memory-match' && kind !== 'number-hunt' && kind !== 'treasure-grid';

export function quickStart(kind: QuickGameKind, n: number, now: number): Engine {
  const s: Engine = {
    phase: 'quick-turn', deadline: now + turnTime, result: null, active: Array(n).fill(true),
    scores: Array(n).fill(0), turn: 0, idle: 0, move: 0,
  };
  switch (kind) {
    case 'memory-match': {
      const faces = Array.from({ length: 12 }, (_, i) => i);
      Object.assign(s, { cards: shuffle([...faces, ...faces]), matched: Array(24).fill(false), flipped: [] });
      break;
    }
    case 'number-hunt':
      Object.assign(s, { low: 1, high: 50, secret: randomInt(1, 51), last: null });
      break;
    case 'treasure-grid': {
      const cells = Array.from({ length: gridSize ** 2 }, (_, i) => i);
      Object.assign(s, { treasures: shuffle(cells).slice(0, treasureCount), tiles: cells.map(() => null), remaining: treasureCount, last: -1 });
      break;
    }
    default:
      s.round = 0;
      nextRound(kind, s, now);
  }
  return s;
}

function nextRound(kind: QuickGameKind, s: Engine, now: number) {
  s.round++;
  s.token = `quick-${s.round}`;
  s.entries = Array(s.active.length).fill(null);
  s.gains = Array(s.active.length).fill(0);
  s.revealed = false;
  s.phase = 'quick-pick';
  s.deadline = now + pickTime;
  switch (kind) {
    case 'high-low': {
      const ranks = shuffle(Array.from({ length: 13 }, (_, i) => i + 1));
      [s.rank, s.answer] = ranks;
      break;
    }
    case 'target-dice':
      s.dice = [randomInt(1, 7), randomInt(1, 7)];
      break;
    case 'odd-one': {
      const [common, odd] = shuffle([0, 1, 2, 3, 4, 5, 6, 7]);
      s.symbols = Array(8 + 2 * s.round).fill(common);
      s.answer = randomInt(s.symbols.length);
      s.symbols[s.answer] = odd;
      break;
    }
    case 'color-sequence':
      s.sequence = Array.from({ length: s.round + 2 }, () => randomInt(1, 5)).join('');
      s.phase = 'quick-watch';
      s.deadline = now + watchTime;
      break;
  }
}

function end(s: Engine, result: string) {
  s.phase = 'ended';
  s.deadline = 0;
  s.result = result;
}

function finishScores(s: Engine) {
  const high = Math.max(...s.scores.filter((_: number, i: number) => s.active[i]));
  const winners = s.active.flatMap((active: boolean, i: number) => active && s.scores[i] === high ? [i] : []);
  end(s, high <= 0 ? 'No points scored' : winners.length === 1 ? `Player ${winners[0] + 1} wins` : 'Game tied');
}

function revealRound(kind: QuickGameKind, s: Engine, now: number) {
  const entries = s.entries.map((entry: string | number | null, i: number) => s.active[i] ? entry : null);
  s.entries = entries;
  if (kind === 'target-dice') {
    const base = s.dice[0] + s.dice[1];
    s.rolls = entries.map((entry: number | null) => entry === 1 ? randomInt(1, 7) : null);
    s.totals = entries.map((entry: number | null, i: number) => entry === null ? null : base + (s.rolls[i] ?? 0));
    const best = Math.max(0, ...s.totals.filter((total: number | null) => total !== null && total <= 12));
    s.gains = s.totals.map((total: number | null) => Number(total === best));
  } else {
    s.gains = entries.map((entry: number | string | null) => {
      if (entry === null) return 0;
      switch (kind) {
        case 'rps': return entries.filter((other: number | null) => other !== null && ((entry as number) - other + 3) % 3 === 1).length;
        case 'high-low': return Number(entry === Number(s.answer > s.rank));
        case 'odd-one': return Number(entry === s.answer);
        case 'color-sequence': return Number(entry === s.sequence);
        default: return 0;
      }
    });
  }
  s.scores = s.scores.map((score: number, i: number) => score + s.gains[i]);
  s.revealed = true;
  s.phase = 'quick-reveal';
  s.deadline = now + roundRevealTime;
}

function everyonePicked(s: Engine) {
  return s.active.every((active: boolean, i: number) => !active || s.entries[i] !== null);
}

function nextTurn(s: Engine, now: number) {
  do { s.turn = (s.turn + 1) % s.active.length; } while (!s.active[s.turn]);
  s.phase = 'quick-turn';
  s.deadline = now + turnTime;
}

function skipTurn(s: Engine, now: number) {
  s.idle++;
  if (s.idle >= s.active.filter(Boolean).length) end(s, 'Game ended after inactivity');
  else nextTurn(s, now);
}

export function quickAction(kind: QuickGameKind, s: Engine, seat: number, a: Record<string, unknown>, now: number) {
  insist(a.type === 'quick-pick' && s.active[seat]);
  if (quickIsRoundGame(kind)) {
    insist(s.phase === 'quick-pick' && a.token === s.token && s.entries[seat] === null);
    if (kind === 'color-sequence') {
      insist(typeof a.text === 'string' && a.text.length === s.sequence.length && /^[1-4]+$/.test(a.text));
      s.entries[seat] = a.text;
    } else {
      const max = kind === 'rps' ? 2 : kind === 'odd-one' ? s.symbols.length - 1 : 1;
      s.entries[seat] = integer(a.choice, 0, max);
    }
    if (everyonePicked(s)) revealRound(kind, s, now);
    return;
  }
  insist(s.phase === 'quick-turn' && s.turn === seat);
  switch (kind) {
    case 'memory-match': {
      const choice = integer(a.choice, 0, s.cards.length - 1);
      insist(!s.matched[choice] && !s.flipped.includes(choice));
      s.flipped.push(choice);
      if (s.flipped.length === 2) {
        const [first, second] = s.flipped;
        if (s.cards[first] === s.cards[second]) {
          s.matched[first] = s.matched[second] = true;
          s.scores[seat]++;
        }
        s.phase = 'quick-pair';
        s.deadline = now + pairRevealTime;
      }
      break;
    }
    case 'number-hunt': {
      const choice = integer(a.choice, s.low, s.high);
      const hint = choice < s.secret ? 'higher' : choice > s.secret ? 'lower' : 'found';
      s.last = { seat, choice, hint };
      if (hint === 'found') {
        s.scores[seat]++;
        end(s, `Player ${seat + 1} wins`);
      } else {
        if (hint === 'higher') s.low = choice + 1;
        else s.high = choice - 1;
        nextTurn(s, now);
      }
      break;
    }
    case 'treasure-grid': {
      const choice = integer(a.choice, 0, s.tiles.length - 1);
      insist(s.tiles[choice] === null);
      s.last = choice;
      if (s.treasures.includes(choice)) {
        s.tiles[choice] = -1;
        s.scores[seat]++;
        s.remaining--;
      } else {
        s.tiles[choice] = s.treasures.filter((tile: number) =>
          Math.abs(Math.floor(tile / gridSize) - Math.floor(choice / gridSize)) <= 1 &&
          Math.abs(tile % gridSize - choice % gridSize) <= 1
        ).length;
      }
      if (s.remaining === 0) finishScores(s);
      else nextTurn(s, now);
      break;
    }
  }
  s.idle = 0;
  s.move++;
}

export function quickTimeout(kind: QuickGameKind, s: Engine, now: number) {
  switch (s.phase) {
    case 'quick-watch':
      s.phase = 'quick-pick';
      s.deadline = now + pickTime;
      break;
    case 'quick-pick':
      revealRound(kind, s, now);
      break;
    case 'quick-reveal':
      if (s.round >= roundCount) finishScores(s);
      else nextRound(kind, s, now);
      break;
    case 'quick-pair':
      s.flipped = [];
      if (s.matched.every(Boolean)) finishScores(s);
      else nextTurn(s, now);
      break;
    case 'quick-turn':
      if (kind === 'memory-match') s.flipped = [];
      skipTurn(s, now);
      break;
  }
}

export function quickDepart(kind: QuickGameKind, s: Engine, seat: number, now: number) {
  if (s.phase === 'quick-pick' && everyonePicked(s)) revealRound(kind, s, now);
  if (s.phase === 'quick-turn' && s.turn === seat) {
    if (kind === 'memory-match') s.flipped = [];
    nextTurn(s, now);
  }
}

export function quickProject(kind: QuickGameKind, s: Engine, seat: number) {
  const common = { phase: s.phase, scores: s.scores };
  if (quickIsRoundGame(kind)) {
    const reveal = s.revealed;
    const view = {
      ...common, round: s.round, roundCount, token: s.token,
      submitted: s.entries.map((entry: unknown, i: number) => s.active[i] && entry !== null),
      ownEntry: s.entries[seat] ?? null,
      ...(reveal ? { entries: s.entries, gains: s.gains } : {}),
    };
    switch (kind) {
      case 'high-low': return { ...view, rank: s.rank, ...(reveal ? { answer: s.answer } : {}) };
      case 'target-dice': return { ...view, dice: s.dice, ...(reveal ? { rolls: s.rolls, totals: s.totals } : {}) };
      case 'odd-one': return { ...view, symbols: s.symbols, ...(reveal ? { answer: s.answer } : {}) };
      case 'color-sequence': return {
        ...view, length: s.sequence.length,
        ...(reveal || s.phase === 'quick-watch' ? { sequence: s.sequence } : {}),
      };
      default: return view;
    }
  }
  const view = { ...common, turn: s.turn, move: s.move };
  switch (kind) {
    case 'memory-match': return {
      ...view, matched: s.matched, flipped: s.flipped,
      cards: s.cards.map((card: number, i: number) => s.matched[i] || s.flipped.includes(i) ? card : null),
    };
    case 'number-hunt': return { ...view, low: s.low, high: s.high, last: s.last };
    case 'treasure-grid': return { ...view, tiles: s.tiles, remaining: s.remaining, last: s.last };
  }
}
