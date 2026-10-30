import { it, expect } from 'vitest';
import { applyAction, initialPosition, legalActions, inCheck, outcome, repetitionCount, type ChessPosition } from '../packages/contracts/src/chess';
import { chooseAi } from '../apps/api/src/chess';
const sq = (s: string) => (8 - Number(s[1])) * 8 + 'abcdefgh'.indexOf(s[0]);
const move = (s: ChessPosition, from: string, to: string, promotion?: 'q' | 'n') => applyAction(s, { from: sq(from), to: sq(to), ...(promotion ? { promotion } : {}) });
function perft(s: ChessPosition, depth: number): number { return depth ? legalActions(s).reduce((n, a) => n + perft(applyAction(s, a), depth - 1), 0) : 1; }
it('matches standard chess perft through depth three and rejects illegal/king-exposing moves', () => {
  const s = initialPosition('standard'); expect(perft(s, 1)).toBe(20); expect(perft(s, 2)).toBe(400); expect(perft(s, 3)).toBe(8902);
  expect(() => move(s, 'e2', 'e5')).toThrow(); expect(s.board[sq('e2')]).toBe('P');
});
it('handles en passant, castling and atomic underpromotion', () => {
  let s = initialPosition('standard'); for (const [a, b] of [['e2','e4'],['a7','a6'],['e4','e5'],['d7','d5']]) s = move(s,a,b);
  s = move(s,'e5','d6'); expect(s.board[sq('d5')]).toBe(''); expect(s.board[sq('d6')]).toBe('P');
  s = initialPosition('standard'); for (const [a,b] of [['e2','e4'],['e7','e5'],['g1','f3'],['b8','c6'],['f1','c4'],['g8','f6'],['e1','g1']]) s=move(s,a,b);
  expect(s.board[sq('f1')]).toBe('R'); expect(s.board[sq('h1')]).toBe(''); expect(s.rights).toBe('kq');
  s = initialPosition('standard'); s.board=Array(64).fill(''); s.board[sq('e1')]='K'; s.board[sq('e8')]='k'; s.board[sq('a7')]='P'; s.rights='';
  expect(() => move(s,'a7','a8')).toThrow(); s=move(s,'a7','a8','n'); expect(s.board[0]).toBe('N'); expect(s.turn).toBe(1);
});
it('matches the castling-heavy Kiwipete reference position', () => {
  const s=initialPosition('standard'), fen='r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R'; s.board=[];
  for(const c of fen) { if(c==='/')continue; if(/[1-8]/.test(c))s.board.push(...Array(Number(c)).fill(''));else s.board.push(c); }
  expect(perft(s,1)).toBe(48);expect(perft(s,2)).toBe(2039);
});
it('detects mate, repetition and draw rules without drawing the initial Elixer kings', () => {
  let s=initialPosition('standard'); for(const [a,b] of [['f2','f3'],['e7','e5'],['g2','g4'],['d8','h4']]) s=move(s,a,b);
  expect(inCheck(s)).toBe(true); expect(outcome(s)).toBe('Black wins by checkmate');
  s=initialPosition('standard'); for(let i=0;i<2;i++) for(const [a,b] of [['g1','f3'],['g8','f6'],['f3','g1'],['f6','g8']]) s=move(s,a,b);
  expect(repetitionCount(s)).toBe(3); expect(outcome(initialPosition('elixer'))).toBeNull();
});
it('preserves Elixer purchases, home ranks, coins, virgin pawn and bought-rook castling', () => {
  let s=initialPosition('elixer'); expect(s.board.filter(Boolean)).toHaveLength(2); expect(s.coins).toEqual([3,3]);
  expect(() => applyAction(s,{buy:'q',to:sq('a1')})).toThrow(); expect(() => applyAction(s,{buy:'p',to:sq('a4')})).toThrow();
  s=applyAction(s,{buy:'p',to:sq('a1')}); expect(s.coins).toEqual([3,3]); s=applyAction(s,{buy:'p',to:sq('a8')}); s=move(s,'a1','a3'); expect(s.ep).toBe(sq('a2'));
  s=initialPosition('elixer'); s.coins=[9,9]; s=applyAction(s,{buy:'r',to:sq('h1')}); s=applyAction(s,{buy:'p',to:sq('a7')}); s=move(s,'e1','g1'); expect(s.board[sq('f1')]).toBe('R');
});
it('keeps all supported AI moves legal with bounded search', () => {
  for(const mode of ['standard','elixer'] as const) for(const level of ['Easy','Medium','Hard']) { const s=initialPosition(mode), start=performance.now(), a=chooseAi(s,level)!; expect(()=>applyAction(s,a)).not.toThrow(); expect(performance.now()-start).toBeLessThan(150); }
});
