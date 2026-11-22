import { useLayoutEffect, useRef, useState } from 'react';
import type { PanelProps } from '../game-ui';
import { t } from '../i18n';
import { gameText } from '../game-text';
import './party-games.css';

type End = 'left' | 'right';
type Legal = { tile: number; end: End };
const tiles = Array.from({ length: 7 }, (_, a) => Array.from({ length: 7 - a }, (_, b) => [a, a + b])).flat();
const pipLayouts = [[], [5], [1, 9], [1, 5, 9], [1, 3, 7, 9], [1, 3, 5, 7, 9], [1, 3, 4, 6, 7, 9]];

function Tile({ pair }: { pair: number[] }) {
  return <span className="domino-tile party-domino-tile">
    {pair.map((count, half) => <span className="domino-pips" key={half} aria-hidden="true">
      {pipLayouts[count].map(place => <i key={place} style={{ gridArea: `${Math.ceil(place / 3)} / ${(place - 1) % 3 + 1}` }}/>)}
    </span>)}
  </span>;
}

export default function DominoPanel({ state, view, disabled, busy, act }: PanelProps) {
  const chain: number[][] = state.chain;
  const hand: number[] = state.hand;
  const legal: Legal[] = state.legal;
  const [selection, setSelection] = useState<{ tile: number; turn: string } | null>(null);
  const turn = `${view.id}:${state.round}:${state.turn}:${hand.join(',')}`;
  const selected = selection?.turn === turn ? selection.tile : null;
  const own = view.self === state.turn && state.phase === 'turn';
  const canPlay = own && !disabled && !busy;
  const canPlace = (end: End) => canPlay && legal.some(move => move.tile === selected && move.end === end);
  const canDraw = state.mode === 'draw' && state.boneyard > 0;
  const track = useRef<HTMLDivElement>(null);
  const previousChain = useRef(chain);

  useLayoutEffect(() => {
    const previous = previousChain.current;
    previousChain.current = chain;
    const rail = track.current;
    if (!rail || chain.length !== previous.length + 1) return;
    rail.scrollLeft = chain.at(-1)?.join(',') === previous.at(-1)?.join(',') ? 0 : rail.scrollWidth;
  }, [chain]);

  const hint = selected !== null
    ? 'Choose a highlighted end to place your tile.'
    : legal.length ? 'Pick a highlighted tile from your hand.'
      : canDraw ? 'No tile fits. Draw from the boneyard.' : 'No tile fits. Pass to the next player.';

  return <section className="party-panel domino-panel">
    <div className="party-panel-head">
      <h3>{t(state.mode === 'draw' ? 'Draw dominoes' : 'Block dominoes')}</h3>
      <span>{t('Round {number}', { number: state.round })} · {t('First to 100 points')}</span>
    </div>
    <div className="domino-table">
      <div className="domino-table-ends">
        {(['left', 'right'] as const).map(end => {
          const pips = end === 'left' ? chain[0]?.[0] : chain.at(-1)?.[1];
          return <div key={end} className="domino-end">
            <span>{t(end === 'left' ? 'Left end' : 'Right end')} {pips !== undefined && <strong>{pips}</strong>}</span>
            <button type="button" className={canPlace(end) ? 'primary' : 'secondary'} disabled={!canPlace(end)}
              onClick={() => { void act({ type: 'tile', tile: selected, end }); }}>
              {t(end === 'left' ? 'Play on left' : 'Play on right')}
            </button>
          </div>;
        })}
      </div>
      <div ref={track} className="domino-chain" aria-label={t('Domino chain')} role="group" tabIndex={chain.length > 0 ? 0 : undefined}>
        {chain.length ? chain.map(pair => <span key={`${Math.min(...pair)}:${Math.max(...pair)}`} role="img"
          aria-label={t('Tile {a}–{b}', { a: pair[0], b: pair[1] })}><Tile pair={pair}/></span>)
          : <p>{t('The highest double opens the round. If there is no double, the highest total opens.')}</p>}
      </div>
      {own && <p className="domino-hint" role="status">{t(hint)}</p>}
    </div>
    {view.self >= 0 && <div className="domino-player-hand">
      <div className="party-panel-head">
        <h3>{t('Your hand')}</h3>
        {own && legal.length === 0 && <button type="button" className="primary" disabled={!canPlay}
          onClick={() => { void act({ type: canDraw ? 'draw' : 'pass' }); }}>
          {canDraw ? t('Draw tile') : t('Pass')}
        </button>}
      </div>
      <div className="domino-hand">{hand.map(tile => {
        const playable = legal.some(move => move.tile === tile);
        const pair = tiles[tile];
        return <button key={tile} type="button" className={selected === tile ? 'selected' : ''} aria-pressed={selected === tile}
          aria-label={t('Tile {a}–{b}', { a: pair[0], b: pair[1] })} disabled={!canPlay || !playable}
          onClick={() => setSelection({ tile, turn })}><Tile pair={pair}/></button>;
      })}</div>
    </div>}
    <ul className="party-stats">
      {view.seats.map((player, i) => <li key={player.id + i}>
        <strong dir="auto">{player.name}</strong>
        <span>{t('{count} tiles', { count: state.counts[i] })} · {state.scores[i]} {t('points')}</span>
      </li>)}
      {state.mode === 'draw' && <li><strong>{t('Boneyard')}</strong><span>{t('{count} tiles', { count: state.boneyard })}</span></li>}
    </ul>
    {state.roundResult && <p className="party-result" role="status">{gameText(state.roundResult)}</p>}
    {state.phase === 'between' && view.seats[view.self]?.id === view.hostId && <button type="button" className="primary"
      disabled={disabled || busy} onClick={() => { void act({ type: 'next' }); }}>{t('Next round')}</button>}
  </section>;
}
