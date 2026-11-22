import type { CSSProperties } from 'react';
import type { PanelProps } from '../game-ui';
import { seatName } from '../game-experience';
import { formatNumber, t } from '../i18n';
import './party-games.css';

export default function FourPanel({ state, view, disabled, busy, act }: PanelProps) {
  const board: number[] = state.board;
  const winning: number[] = state.winning || [];
  const canDrop = !disabled && !busy && view.self === state.turn;
  return <section className="party-panel four-panel">
    <div className="four-players" aria-label={t('Players')}>
      {view.seats.map((seat, player) => <div key={seat.id} className={state.turn === player && view.status === 'playing' ? 'active' : ''}>
        <span aria-hidden="true" className={`four-player-disc disc-${player}`}/>
        <strong dir="auto">{seat.name}</strong>
        <span>{t('{count} counters', { count: board.filter(value => value === player).length })}</span>
      </div>)}
    </div>
    <div className="four-board party-four-board" role="group" aria-label={t('Four in a Row board')}>
      {Array.from({ length: 7 }, (_, column) => {
        const open = board[column] === -1;
        return <div key={column} className="four-column">
          <button type="button" className={`four-drop ${state.last % 7 === column ? 'recent' : ''}`}
            aria-label={t('Drop in column {number}', { number: column + 1 })}
            disabled={!canDrop || !open} onClick={() => { void act({ type: 'drop', column }); }}>
            <span aria-hidden="true">↓</span><small aria-hidden="true">{formatNumber(column + 1)}</small>
          </button>
          {Array.from({ length: 6 }, (_, row) => {
            const index = row * 7 + column;
            const player = board[index];
            return <span key={index} role="img" className={`four-cell ${player >= 0 ? `counter-${player}` : ''} ${winning.includes(index) ? 'winning' : ''} ${state.last === index ? 'last' : ''}`}
              aria-label={t('Row {row}, column {column}: {value}', { row: row + 1, column: column + 1, value: player >= 0 ? seatName(view, player) : t('Empty') })}>
              {player >= 0 && <i className={`four-counter ${state.last === index ? 'just-dropped' : ''}`} style={{ '--drop-rows': row + 1 } as CSSProperties} />}
            </span>;
          })}
        </div>;
      })}
    </div>
    {winning.length > 0 && <p className="party-result" role="status">{t('{name} connected four!', { name: seatName(view, state.winner) })}</p>}
  </section>;
}
