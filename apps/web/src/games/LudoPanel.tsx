import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { PanelProps } from '../game-ui';
import { seatName } from '../game-experience';
import { t } from '../i18n';
import './party-games.css';

const path = [[6,1],[6,2],[6,3],[6,4],[6,5],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],[0,8],[1,8],[2,8],[3,8],[4,8],[5,8],[6,9],[6,10],[6,11],[6,12],[6,13],[6,14],[7,14],[8,14],[8,13],[8,12],[8,11],[8,10],[8,9],[9,8],[10,8],[11,8],[12,8],[13,8],[14,8],[14,7],[14,6],[13,6],[12,6],[11,6],[10,6],[9,6],[8,5],[8,4],[8,3],[8,2],[8,1],[8,0],[7,0],[6,0]];
const safe = new Set([0,8,13,21,26,34,39,47]);
const yards = [[1,1],[1,10],[10,10],[10,1]];
const lane = (color: number, step: number) => [[7,step],[step,7],[7,14-step],[14-step,7]][color];

function tokenCell(offset: number, value: number, index: number) {
  if (value >= 51) return lane(offset / 13, value - 50);
  if (value >= 0) return path[(value + offset) % path.length];
  const [row, column] = yards[offset / 13];
  return [row + Math.floor(index / 2) * 2, column + (index % 2) * 2];
}

type Token = { seat: number; piece: number; row: number; column: number; color: number; position: number };

export default function LudoPanel({ state, view, disabled, busy, act }: PanelProps) {
  const tokens: number[][] = state.tokens;
  const offsets: number[] = state.offsets;
  const current = state.turn === view.self;
  const canPlay = current && !disabled && !busy;
  const previous = useRef(tokens);
  const [capture, setCapture] = useState<string | null>(null);
  const positions = tokens.flatMap((hand, seat) => view.seats[seat]?.left ? [] : hand.map((position, piece) => {
    const offset = offsets[seat];
    const [row, column] = tokenCell(offset, position, piece);
    return { seat, piece, row, column, color: offset / 13, position };
  }));
  const stacks = new Map<string, Token[]>();
  for (const token of positions) {
    const cell = `${token.row}:${token.column}`;
    const stack = stacks.get(cell) || [];
    stack.push(token);
    stacks.set(cell, stack);
  }

  useEffect(() => {
    const last = previous.current;
    if (tokens === last) return;
    const moved = positions.some(token => token.position >= 0 && token.position !== last[token.seat]?.[token.piece]);
    const captured = moved && positions.find(token => token.position < 0 && last[token.seat]?.[token.piece] >= 0);
    if (captured) setCapture(seatName(view, captured.seat));
    else if (moved) setCapture(null);
    previous.current = tokens;
  }, [tokens]);

  return <section className="party-panel ludo-panel">
    <div className="ludo-turn party-ludo-turn">
      <div className="ludo-roll-readout">
        <span>{t(state.phase === 'move' ? 'Dice' : 'Last roll')}</span>
        <strong key={`${state.die}-${state.phase}-${state.turn}`} className={`ludo-die ${state.die ? 'rolled' : ''}`}
          role="img" aria-label={state.die ? t('Rolled {number}', { number: state.die }) : t('Waiting for first roll')}>
          {state.die ? '⚀⚁⚂⚃⚄⚅'[state.die - 1] : '–'}
        </strong>
      </div>
      {state.phase === 'roll' && <button type="button" className="primary" disabled={!canPlay}
        onClick={() => { void act({ type: 'roll' }); }}>{t('Roll dice')}</button>}
      {current && state.phase === 'move' && <div className="ludo-moves game-actions" role="group" aria-label={t('Choose a token')}>
        {state.legal.map((piece: number) => <button key={piece} type="button" className="secondary" disabled={!canPlay}
          onClick={() => { void act({ type: 'token', piece }); }}>{t('Move token {number}', { number: piece + 1 })}</button>)}
      </div>}
    </div>
    {current && state.phase === 'roll' && tokens[view.self].every(value => value < 0) &&
      <p className="game-notice">{t('Roll a six to bring your first token onto the board.')}</p>}
    <div className="ludo-board party-ludo-board" role="group" aria-label={t('Ludo board')}>
      {offsets.map((offset, seat) => {
        const color = offset / 13;
        const [row, column] = yards[color];
        return <div key={seat} className={`ludo-yard seat-${color}`} aria-hidden="true"
          style={{ gridRow: `${row} / span 5`, gridColumn: `${column} / span 5` }}/>;
      })}
      {path.map(([row, col], index) => <span key={index} className={`ludo-track ${safe.has(index) ? 'safe' : ''}`}
        aria-hidden="true" style={{ gridRow: row + 1, gridColumn: col + 1 }}>{safe.has(index) ? '★' : ''}</span>)}
      {offsets.map((offset, seat) => <div className="ludo-seat-layer" key={seat}>
        {Array.from({ length: 6 }, (_, index) => {
          const [row, column] = lane(offset / 13, index + 1);
          return <span className={`ludo-lane seat-${offset / 13}`} key={index} aria-hidden="true"
            style={{ gridRow: row + 1, gridColumn: column + 1 }}>{index === 5 ? '◆' : ''}</span>;
        })}
      </div>)}
      {positions.map(token => {
        const stack = stacks.get(`${token.row}:${token.column}`)!;
        const slot = stack.indexOf(token);
        const across = Math.ceil(Math.sqrt(stack.length));
        const size = .9 / across;
        const playable = current && state.phase === 'move' && token.seat === view.self && state.legal.includes(token.piece);
        const style = {
          top: `${(token.row + .05 + Math.floor(slot / across) * size) * 100 / 15}%`,
          left: `${(token.column + .05 + (slot % across) * size) * 100 / 15}%`,
          '--ludo-token-size': `${size * 100 / 15}%`,
        } as CSSProperties;
        return <button key={`${token.seat}:${token.piece}`} type="button" style={style}
          className={`ludo-token seat-${token.color} ${playable ? 'can-move' : ''}`}
          aria-label={t('Player {player}, token {token}', { player: token.seat + 1, token: token.piece + 1 })}
          disabled={!canPlay || !playable} onClick={() => { void act({ type: 'token', piece: token.piece }); }}>
          {token.piece + 1}
        </button>;
      })}
    </div>
    {capture && <p className="party-result" role="status">{t('{name} had a token sent back to its yard.', { name: capture })}</p>}
    <ul className="party-stats ludo-race">
      {tokens.map((hand, seat) => {
        const home = hand.filter(value => value === 56).length;
        return <li key={seat} className={home === 4 ? 'finished' : state.turn === seat && view.status === 'playing' ? 'active' : ''}>
          <strong><i className={`seat-dot seat-${offsets[seat] / 13}`} aria-hidden="true"/><bdi>{seatName(view, seat)}</bdi></strong>
          <span>{home}/4 {t('Home')}</span>
        </li>;
      })}
    </ul>
    {view.status === 'playing' && <p className="game-muted">{t('Stars are safe. Reach home with an exact roll.')}</p>}
  </section>;
}
