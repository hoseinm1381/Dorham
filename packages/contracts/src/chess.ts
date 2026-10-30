// Elixer rules ported from the user's Godot project. Pure data, shared by server and UI.
export type Color = 0 | 1;
export type ChessMode = 'standard' | 'elixer';
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type ChessAction = { from?: number; to: number; promotion?: 'q' | 'r' | 'b' | 'n'; buy?: Exclude<PieceType, 'k'> };
export type ChessPosition = { mode: ChessMode; board: string[]; turn: Color; rights: string; ep: number; virgin: number[]; coins: [number, number]; half: number; ply: number; repeats: string[]; last?: ChessAction };
export const costs = { p: 1, n: 3, b: 3, r: 5, q: 9 };
export const pieceNames: Record<string, string> = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };
export const colorOf = (p: string): Color => p === p.toUpperCase() ? 0 : 1;
export const squareName = (i: number) => 'abcdefgh'[i % 8] + (8 - Math.floor(i / 8));
const inside = (x: number, y: number) => x >= 0 && x < 8 && y >= 0 && y < 8;
const bishop = [[1, 1], [1, -1], [-1, 1], [-1, -1]], rook = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const knight = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
export function initialPosition(mode: ChessMode): ChessPosition {
  const board = Array<string>(64).fill('');
  if (mode === 'standard') {
    [...'rnbqkbnrpppppppp'].forEach((p, i) => board[i] = p);
    [...'PPPPPPPPRNBQKBNR'].forEach((p, i) => board[i + 48] = p);
  } else { board[4] = 'k'; board[60] = 'K'; }
  const s: ChessPosition = { mode, board, turn: 0, rights: mode === 'standard' ? 'KQkq' : '', ep: -1, virgin: mode === 'elixer' ? [4, 60] : [], coins: [3, 3], half: 0, ply: 0, repeats: [] };
  s.repeats = [positionKey(s)]; return s;
}
export function attacked(s: ChessPosition, target: number, by: Color): boolean {
  const x = target % 8, y = Math.floor(target / 8);
  for (const dx of [-1, 1]) {
    const py = y + (by === 0 ? 1 : -1), px = x + dx;
    if (inside(px, py) && s.board[py * 8 + px] === (by === 0 ? 'P' : 'p')) return true;
  }
  for (const [dx, dy] of knight) if (inside(x + dx, y + dy) && s.board[(y + dy) * 8 + x + dx] === (by === 0 ? 'N' : 'n')) return true;
  for (const [dx, dy] of [...bishop, ...rook]) {
    for (let d = 1; inside(x + dx * d, y + dy * d); d++) {
      const p = s.board[(y + dy * d) * 8 + x + dx * d]; if (!p) continue;
      if (colorOf(p) === by && (p.toLowerCase() === 'q' || p.toLowerCase() === (dx && dy ? 'b' : 'r') || (d === 1 && p.toLowerCase() === 'k'))) return true;
      break;
    }
  }
  return false;
}
export function inCheck(s: ChessPosition, color = s.turn): boolean { const i = s.board.indexOf(color === 0 ? 'K' : 'k'); return i < 0 || attacked(s, i, (1 - color) as Color); }
function pseudo(s: ChessPosition): ChessAction[] {
  const actions: ChessAction[] = [], add = (from: number, to: number) => {
    if (s.board[to]?.toLowerCase() === 'k') return;
    if (s.board[from].toLowerCase() === 'p' && (to < 8 || to >= 56)) for (const promotion of ['q', 'r', 'b', 'n'] as const) actions.push({ from, to, promotion });
    else actions.push({ from, to });
  };
  for (let from = 0; from < 64; from++) {
    const p = s.board[from]; if (!p || colorOf(p) !== s.turn) continue;
    const type = p.toLowerCase(), x = from % 8, y = Math.floor(from / 8);
    if (type === 'p') {
      const dy = s.turn === 0 ? -1 : 1, next = from + dy * 8;
      if (inside(x, y + dy) && !s.board[next]) {
        add(from, next);
        if ((s.mode === 'elixer' ? s.virgin.includes(from) : y === (s.turn === 0 ? 6 : 1)) && inside(x, y + 2 * dy) && !s.board[from + 16 * dy]) add(from, from + 16 * dy);
      }
      for (const dx of [-1, 1]) if (inside(x + dx, y + dy)) {
        const to = next + dx, target = s.board[to];
        if ((target && colorOf(target) !== s.turn) || (to === s.ep && s.board[to - dy * 8]?.toLowerCase() === 'p')) add(from, to);
      }
    } else {
      const directions = type === 'n' ? knight : type === 'b' ? bishop : type === 'r' ? rook : [...bishop, ...rook];
      for (const [dx, dy] of directions) for (let d = 1; inside(x + d * dx, y + d * dy); d++) {
        const to = (y + d * dy) * 8 + x + d * dx, target = s.board[to];
        if (target && colorOf(target) === s.turn) break;
        add(from, to); if (target || type === 'n' || type === 'k') break;
      }
      if (type === 'k' && from === (s.turn === 0 ? 60 : 4) && !inCheck(s)) for (const [right, corner, step] of [[s.turn === 0 ? 'K' : 'k', from + 3, 1], [s.turn === 0 ? 'Q' : 'q', from - 4, -1]] as const) {
        const eligible = s.mode === 'elixer' ? s.virgin.includes(from) && s.virgin.includes(corner) : s.rights.includes(right);
        if (!eligible || s.board[corner] !== (s.turn === 0 ? 'R' : 'r')) continue;
        if (s.board[from + step] || s.board[from + step * 2] || (step < 0 && s.board[from - 3])) continue;
        if (!attacked(s, from + step, (1 - s.turn) as Color) && !attacked(s, from + step * 2, (1 - s.turn) as Color)) add(from, from + step * 2);
      }
    }
  }
  if (s.mode === 'elixer') for (const buy of Object.keys(costs) as (keyof typeof costs)[]) if (s.coins[s.turn] >= costs[buy]) {
    const start = s.turn === 0 ? 48 : 0;
    for (let to = start; to < start + 16; to++) if (!s.board[to]) actions.push({ buy, to });
  }
  return actions;
}
// Internal transition deliberately skips validation; callers use legalActions/applyAction.
function transition(s: ChessPosition, a: ChessAction): ChessPosition {
  const board = s.board.slice(), color = s.turn, captured = board[a.to];
  let rights = s.rights, virgin = s.virgin.filter(i => i !== a.to && i !== a.from), ep = -1;
  const coins: [number, number] = [...s.coins]; let half = s.half + 1;
  if (a.buy) { board[a.to] = color === 0 ? a.buy.toUpperCase() : a.buy; coins[color] -= costs[a.buy]; virgin.push(a.to); half = 0; }
  else {
    const from = a.from!, p = board[from], type = p.toLowerCase(); board[from] = ''; board[a.to] = p;
    if (type === 'p') {
      half = 0; if (Math.abs(a.to - from) === 16) ep = (a.to + from) / 2;
      if (a.to === s.ep && !captured && from % 8 !== a.to % 8) { const victim = a.to + (color === 0 ? 8 : -8); board[victim] = ''; virgin = virgin.filter(i => i !== victim); }
      if (a.promotion) board[a.to] = color === 0 ? a.promotion.toUpperCase() : a.promotion;
    }
    if (type === 'k') {
      rights = rights.replace(color === 0 ? /[KQ]/g : /[kq]/g, '');
      if (Math.abs(a.to - from) === 2) { const corner = a.to > from ? from + 3 : from - 4, dest = a.to > from ? from + 1 : from - 1; board[dest] = board[corner]; board[corner] = ''; virgin = virgin.filter(i => i !== corner); }
    }
    if (captured) half = 0;
    for (const [i, right] of [[0, 'q'], [7, 'k'], [56, 'Q'], [63, 'K']] as const) if (from === i || a.to === i) rights = rights.replace(right, '');
  }
  if (s.mode === 'elixer') coins[color]++;
  return { ...s, board, rights, virgin, coins, ep, half, turn: (1 - color) as Color, ply: s.ply + 1, last: a };
}
export function legalActions(s: ChessPosition): ChessAction[] { return pseudo(s).filter(a => !inCheck(transition(s, a), s.turn)); }
export function sameAction(a: ChessAction, b: ChessAction): boolean { return a.from === b.from && a.to === b.to && a.buy === b.buy && a.promotion === b.promotion; }
export function positionKey(s: ChessPosition): string {
  // En-passant is relevant to repetition only when a legal capture exists.
  const ep = s.ep >= 0 && pseudo({ ...s, coins: [0, 0] }).some(a => a.from !== undefined && a.to === s.ep && s.board[a.from].toLowerCase() === 'p' && a.from % 8 !== a.to % 8 && !inCheck(transition(s, a), s.turn)) ? s.ep : -1;
  return `${s.board.map(p => p || '.').join('')}/${s.turn}/${s.rights}/${ep}${s.mode === 'elixer' ? `/${s.coins}/${s.virgin.slice().sort((a, b) => a - b)}` : ''}`;
}
export function applyAction(s: ChessPosition, action: ChessAction): ChessPosition {
  const a = legalActions(s).find(a => sameAction(a, action)); if (!a) throw new Error('Illegal chess action');
  return advanceLegalAction(s, a);
}
// Only for search nodes already returned by legalActions. Network input always
// uses applyAction; avoiding a second move generation keeps AI work bounded.
export function advanceLegalAction(s: ChessPosition, a: ChessAction): ChessPosition { const next = transition(s, a); next.repeats = [...(next.half === 0 && s.mode === 'standard' ? [] : s.repeats), positionKey(next)].slice(-1001); return next; }
export function insufficient(s: ChessPosition): boolean {
  if (s.mode !== 'standard') return false;
  const rest = s.board.flatMap((p, i) => p && p.toLowerCase() !== 'k' ? [{ p: p.toLowerCase(), i }] : []);
  if (!rest.length) return true;
  if (rest.length === 1 && ['b', 'n'].includes(rest[0].p)) return true;
  return rest.every(v => v.p === 'b') && rest.every(v => (v.i % 8 + Math.floor(v.i / 8)) % 2 === (rest[0].i % 8 + Math.floor(rest[0].i / 8)) % 2);
}
export function repetitionCount(s: ChessPosition): number { const key = positionKey(s); return s.repeats.filter(k => k === key).length; }
export function canMateOnTimeout(s: ChessPosition, color: Color): boolean {
  const own = s.board.filter(p => p && colorOf(p) === color && p.toLowerCase() !== 'k');
  if (!own.length) return false;
  if (own.length === 1 && ['b', 'n'].includes(own[0].toLowerCase()) && s.board.filter(p => p && colorOf(p) !== color && p.toLowerCase() !== 'k').length === 0) return false;
  return !insufficient(s);
}
export function outcome(s: ChessPosition): string | null {
  if (!legalActions(s).length) return inCheck(s) ? (s.turn === 0 ? 'Black wins by checkmate' : 'White wins by checkmate') : 'Draw by stalemate';
  if (insufficient(s)) return 'Draw by insufficient material';
  if (s.mode === 'standard' && (s.half >= 150 || repetitionCount(s) >= 5)) return 'Draw by automatic rule';
  return s.ply >= 1000 ? 'Draw by game length limit' : null;
}
export type ChessGame = { channelId?: string | null; openSeat?: boolean; id: string; serverId: string; whiteId: string; blackId: string | null; whiteName: string; blackName: string; difficulty: 'Easy' | 'Medium' | 'Hard' | null; status: 'pending' | 'playing' | 'finished'; position: ChessPosition; revision: number; minutes: number; increment: number; remaining: [number, number]; runningSince: number; pausedUntil: number; missing: string[]; missingAt: Record<string, number>; grace: [number, number]; result: string | null; drawBy: string | null; createdAt: number; updatedAt: number; log: string[] };
export type ChessView = ChessGame & { serverNow: number; actions: ChessAction[]; check: boolean; canClaimDraw: boolean; canPlay: boolean };
export type VoiceGame = { id: string; channelId: string; hostName: string; whiteId: string; blackId: string | null; status: ChessGame['status']; openSeat: boolean; mode: ChessMode; minutes: number; increment: number; paused: boolean; legacy?: boolean };
