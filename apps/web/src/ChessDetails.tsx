import { useEffect, useRef, useState } from 'react';
import { costs, pieceNames, squareName, type ChessAction, type ChessMode, type ChessView, type Color } from '../../../packages/contracts/src/chess';
import { chessPieceArt } from './ChessBoard';
import { formatNumber, t } from './i18n';
import { useGameCue, type GameSound } from './game-sound';

export function ChessRules({ mode }: { mode: ChessMode }) {
  return <details className="game-guide chess-rules">
    <summary>{t('How to play')}</summary>
    <ol>
      <li>{t('Protect your king and checkmate your opponent.')}</li>
      {mode === 'standard' ? <li>{t('Select a piece, then choose a marked square.')}</li> : <>
        <li>{t('Each side starts with a king and 3 coins. You earn 1 coin after each move or purchase.')}</li>
        <li>{t('Buy a piece or move an existing one. A purchase uses your turn.')}</li>
        <li>{t('Place purchased pieces on a marked square in your two home ranks.')}</li>
      </>}
      <li>{t('Human-match clocks start when someone takes the open seat. Closing the viewer keeps your match and voice connected.')}</li>
    </ol>
  </details>;
}

export function ChessSeat({ game, color, anchor, sound, own, canWarn }: {
  game: ChessView; color: Color; anchor: number; sound: GameSound; own: boolean; canWarn: boolean;
}) {
  const count = game.position.coins[color];
  const name = color === 0 ? game.whiteName : game.difficulty ? t(`${game.difficulty} AI`) : game.openSeat ? t('Open seat') : game.blackName;
  const active = game.position.turn === color && game.status === 'playing' && !game.pausedUntil;
  return <div className={`chess-seat ${active ? 'active' : ''}`} data-color={color}>
    <span className="chess-seat-piece" aria-hidden="true"><img src={chessPieceArt(color === 0 ? 'K' : 'k')} alt=""/></span>
    <div className="chess-seat-name">
      <strong><bdi>{name}</bdi></strong>
      <small>{t(color === 0 ? 'White' : 'Black')}{own && <> · {t('You')}</>}</small>
    </div>
    {game.position.mode === 'elixer' && <span className="chess-coins" title={t('{count} coins', { count: formatNumber(count) })}>
      <span aria-hidden="true">✦</span> {formatNumber(count)}<span className="chess-coin-label">{t('coins')}</span>
    </span>}
    <Clock game={game} color={color} anchor={anchor} sound={sound} active={active} canWarn={canWarn && own}/>
  </div>;
}

function Clock({ game, color, anchor, sound, active, canWarn }: {
  game: ChessView; color: Color; anchor: number; sound: GameSound; active: boolean; canWarn: boolean;
}) {
  const [, render] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { if (!document.hidden) render(value => value + 1); }, 250);
    return () => window.clearInterval(timer);
  }, [active]);
  const remaining = Math.max(0, game.remaining[color] - (active ? performance.now() - anchor : 0));
  const secs = Math.ceil(remaining / 1000);
  const urgent = active && secs > 0 && secs <= 10;
  useGameCue(sound, game.id, canWarn && urgent ? String(game.position.ply) : undefined, 'clock');
  return <span className={`chess-clock ${active ? 'active' : ''} ${urgent ? 'low-time' : ''}`}
    data-testid={`chess-clock-${color}`} aria-label={t(color === 0 ? 'White clock' : 'Black clock')}
  >{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span>;
}

export function ChessShop({ game, playerColor, playable, buy, choose }: {
  game: ChessView; playerColor?: Color; playable: boolean; buy: string | null;
  choose: (piece: string, keyboard: boolean, trigger: HTMLButtonElement) => void;
}) {
  const color = playerColor ?? game.position.turn;
  const coins = game.position.coins[color];
  const available = new Set(game.actions.flatMap(action => action.buy ? [action.buy] : []));
  return <section className="chess-shop" aria-label={t('Piece shop')}>
    <div className="chess-shop-header"><h3>{t('Piece shop')}</h3><span className="chess-coins">
      <span aria-hidden="true">✦</span> {t('{count} coins', { count: formatNumber(coins) })}
    </span></div>
    <p>{t('A purchase uses your turn. Place the piece on a marked home square.')}</p>
    <div className="chess-shop-options">
      {(Object.entries(costs) as [keyof typeof costs, number][]).map(([piece, cost]) => {
        const name = t(pieceNames[piece]);
        const reason = coins < cost ? t('Need {count} more coins', { count: formatNumber(cost - coins) })
          : !playable ? t('Available on your turn') : !available.has(piece) ? t('No legal deployment squares') : '';
        return <button type="button" key={piece} aria-label={`${t('Buy')} ${name} (${cost})`} aria-pressed={buy === piece}
          disabled={!playable || !available.has(piece)} className={buy === piece ? 'selected' : ''}
          title={reason || name} data-shortfall={coins < cost || undefined}
          onClick={event => choose(piece, event.detail === 0, event.currentTarget)}>
          <img src={chessPieceArt(color === 0 ? piece.toUpperCase() : piece)} alt=""/>
          <span>{name}</span><span className="chess-piece-cost"><span aria-hidden="true">✦</span> {formatNumber(cost)}</span>
        </button>;
      })}
    </div>
  </section>;
}

export function ChessPromotion({ choices, color, disabled, choose, cancel }: {
  choices: ChessAction[]; color: Color; disabled: boolean; choose: (action: ChessAction) => void; cancel: () => void;
}) {
  const prompt = useRef<HTMLDivElement>(null);
  useEffect(() => { prompt.current?.querySelector('button')?.focus(); }, []);
  return <div ref={prompt} className="chess-promotion" role="group" aria-label={t('Promote pawn')}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
    <strong>{t('Promote pawn')}</strong>
    <p>{t('Choose the piece your pawn becomes.')}</p>
    <div className="chess-promotion-options">
      {choices.map(action => {
        const piece = action.promotion!;
        return <button className="secondary" key={piece} type="button" disabled={disabled} onClick={() => choose(action)}>
          <img src={chessPieceArt(color === 0 ? piece.toUpperCase() : piece)} alt=""/>{t(pieceNames[piece])}
        </button>;
      })}
    </div>
    <button className="secondary" type="button" onClick={cancel}>{t('Cancel')}</button>
  </div>;
}

export function chessMoveLabel(game: ChessView) {
  const last = game.position.last;
  if (!last) return '';
  const to = squareName(last.to);
  if (last.buy) return t('{piece} placed on {square}', { piece: t(pieceNames[last.buy]), square: to });
  if (last.from === undefined) return '';
  const from = squareName(last.from);
  if (last.promotion) return t('{from} to {to}, promoted to {piece}', { from, to, piece: t(pieceNames[last.promotion]) });
  return t('{from} to {to}', { from, to });
}

export function ChessMoveLog({ game }: { game: ChessView }) {
  const [open, setOpen] = useState(false);
  return <details className="chess-log" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t('Move history')} ({formatNumber(game.log.length)})</summary>
    {open && (game.log.length ? <ol reversed start={game.log.length}>
      {[...game.log].reverse().map((entry, i) => {
        const deploy = entry.match(/^([PNBRQ]) @ ([a-h][1-8])$/);
        return <li key={game.log.length - i}>
          {deploy ? t('{piece} placed on {square}', { piece: t(pieceNames[deploy[1].toLowerCase()]), square: deploy[2] }) : <bdi>{entry}</bdi>}
        </li>;
      })}
    </ol> : <p>{t('No moves yet.')}</p>)}
  </details>;
}
