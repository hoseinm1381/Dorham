import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { colorOf, pieceNames, squareName, type ChessAction, type ChessPosition, type ChessView } from '../../../packages/contracts/src/chess';
import { t } from './i18n';

const pieceFiles: Record<string, string> = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };
export const chessPieceArt = (piece: string) =>
  new URL(`./chess/${colorOf(piece) === 0 ? 'W' : 'B'}${pieceFiles[piece.toLowerCase()]}.svg`, document.baseURI).href;

export function isChessCapture(position: ChessPosition, action: ChessAction) {
  if (action.buy || action.from === undefined) return false;
  return Boolean(position.board[action.to]) ||
    (position.board[action.from]?.toLowerCase() === 'p' && action.to === position.ep && action.from % 8 !== action.to % 8);
}

export type BoardMotion = {
  id: string;
  ply: number;
  arrivals: { to: number; from?: number; kind: 'move' | 'capture' | 'deploy' | 'promote' }[];
  cue: 'move' | 'capture' | 'deploy' | 'check' | 'promote' | 'finish';
};

type BoardSnapshot = Pick<ChessView, 'id' | 'status' | 'position' | 'check'>;
export function chessBoardMotion(before: BoardSnapshot | null, after: BoardSnapshot): BoardMotion | undefined {
  if (!before || before.id !== after.id) return undefined;
  const { last, ply } = after.position;
  const finished = before.status !== 'finished' && after.status === 'finished';
  const arrivals: BoardMotion['arrivals'] = [];
  let cue: BoardMotion['cue'] = 'move';
  if (last && ply === before.position.ply + 1) {
    const { from, to } = last;
    const kind = last.buy ? 'deploy' : last.promotion ? 'promote' : isChessCapture(before.position, last) ? 'capture' : 'move';
    arrivals.push({ to, from, kind });
    if (from !== undefined && before.position.board[from]?.toLowerCase() === 'k' && Math.abs(to - from) === 2) {
      arrivals.push({ from: to > from ? from + 3 : from - 4, to: (to + from) / 2, kind: 'move' });
    }
    cue = after.check ? 'check' : kind;
  }
  if (!finished && !arrivals.length) return undefined;
  return { id: `${ply}:${finished ? 'end' : 'move'}`, ply, arrivals, cue: finished ? 'finish' : cue };
}

type Props = {
  game: ChessView;
  flipped: boolean;
  disabled: boolean;
  selected: number | null;
  choices: ChessAction[];
  motion?: BoardMotion;
  onSquare: (square: number) => void;
  clearSelection: () => void;
};

export function ChessBoard({ game, flipped, disabled, selected, choices, motion, onSquare, clearSelection }: Props) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const [focused, setFocused] = useState<number | null>(null);
  const { position } = game;
  const tabStop = focused ?? selected ?? game.actions.find(action => action.from !== undefined)?.from ?? (flipped ? 4 : 60);
  const legal = new Map(choices.map(action => [action.to, action]));

  function onKey(event: KeyboardEvent<HTMLButtonElement>, displayed: number) {
    if (event.key === 'Escape' && (selected !== null || choices.length)) {
      event.preventDefault();
      event.stopPropagation();
      clearSelection();
      return;
    }
    const rank = Math.floor(displayed / 8);
    const file = displayed % 8;
    let to: number | undefined;
    switch (event.key) {
      case 'ArrowUp': to = Math.max(0, rank - 1) * 8 + file; break;
      case 'ArrowDown': to = Math.min(7, rank + 1) * 8 + file; break;
      case 'ArrowLeft': to = rank * 8 + Math.max(0, file - 1); break;
      case 'ArrowRight': to = rank * 8 + Math.min(7, file + 1); break;
      case 'Home': to = event.ctrlKey ? 0 : rank * 8; break;
      case 'End': to = event.ctrlKey ? 63 : rank * 8 + 7; break;
      default: return;
    }
    event.preventDefault();
    buttons.current[flipped ? 63 - to : to]?.focus();
  }

  return <div className="chess-board" role="group" aria-label={t('Chess board')} dir="ltr">
    {Array.from({ length: 64 }, (_, displayed) => {
      const square = flipped ? 63 - displayed : displayed;
      const piece = position.board[square];
      const name = squareName(square);
      const action = legal.get(square);
      const capture = action && isChessCapture(position, action);
      const last = position.last?.from === square || position.last?.to === square;
      const inCheck = game.check && piece === (position.turn === 0 ? 'K' : 'k');
      const arrival = motion?.ply === position.ply ? motion.arrivals.find(item => item.to === square) : undefined;
      const from = arrival?.from;
      const start = from === undefined ? displayed : flipped ? 63 - from : from;
      const slide = { '--chess-x': `${(start % 8 - displayed % 8) * 100}%`,
        '--chess-y': `${(Math.floor(start / 8) - Math.floor(displayed / 8)) * 100}%` } as CSSProperties;
      const label = [
        piece ? t('{square}, {color} {piece}', { square: name, color: t(colorOf(piece) === 0 ? 'White' : 'Black'), piece: t(pieceNames[piece.toLowerCase()]) }) : name,
        inCheck && t('Check'), action && t(action.buy ? 'Deployment square' : capture ? 'Capture square' : 'Legal move'), last && t('Last move'),
      ].filter(Boolean).join(', ');
      const style = [(Math.floor(square / 8) + square % 8) % 2 ? 'dark' : 'light', inCheck && 'in-check',
        selected === square && 'chosen', action && 'legal', capture && 'capture', action?.buy && 'deploy', last && 'last'].filter(Boolean).join(' ');
      return <button type="button" key={square} ref={element => { buttons.current[square] = element; }}
        aria-label={label} aria-pressed={selected === square || undefined} aria-disabled={disabled || undefined} data-square={name}
        className={`chess-square ${style}`} tabIndex={tabStop === square ? 0 : -1}
        onFocus={() => setFocused(square)} onKeyDown={event => onKey(event, displayed)} onClick={() => { if (!disabled) onSquare(square); }}>
        {piece && <img key={arrival ? `${motion?.id}:${piece}` : piece} src={chessPieceArt(piece)} alt="" draggable={false}
          style={arrival ? slide : undefined}
          className={arrival ? `piece-${arrival.kind === 'deploy' ? 'arrival' : 'slide'} piece-${arrival.kind}` : undefined}/>}
        {displayed % 8 === 0 && <span className="chess-rank" aria-hidden="true">{name[1]}</span>}
        {displayed >= 56 && <span className="chess-file" aria-hidden="true">{name[0]}</span>}
      </button>;
    })}
  </div>;
}
