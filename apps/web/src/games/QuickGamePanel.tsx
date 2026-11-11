import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { t, formatNumber } from '../i18n';
import { gameGuide, seatName } from '../game-experience';
import type { PanelProps } from '../game-ui';
import { memoryFaces } from './memory-faces';
import music from './assets/quick-games-loop.wav?url';
import './quick-games.css';

const hands = [{ icon: '✊', label: 'Rock' }, { icon: '✋', label: 'Paper' }, { icon: '✌', label: 'Scissors' }];
const shapes = [
  { icon: '●', label: 'Circle' }, { icon: '◆', label: 'Diamond' }, { icon: '▲', label: 'Triangle' }, { icon: '■', label: 'Square' },
  { icon: '★', label: 'Star' }, { icon: '✚', label: 'Cross' }, { icon: '♥', label: 'Heart' }, { icon: '☾', label: 'Moon' },
];
const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const dice = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const colors = ['Red', 'Blue', 'Green', 'Yellow'];

function GameMusic({ suspended }: { suspended: boolean }) {
  const player = useRef<HTMLAudioElement>(null);
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const audio = player.current!;
    audio.volume = 0.12;
    function sync() {
      if (enabled && !suspended && !document.hidden) void audio.play().catch(() => {});
      else audio.pause();
    }
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      audio.pause();
      document.removeEventListener('visibilitychange', sync);
    };
  }, [enabled, suspended]);
  return <>
    <audio ref={player} src={music} preload="none" loop />
    <button type="button" aria-pressed={enabled} className="secondary quick-music" onClick={() => setEnabled(!enabled)}>
      <span aria-hidden="true">♫ </span>{t('Game music')}
    </button>
  </>;
}

function Pattern({ sequence, animate = false }: { sequence: string; animate?: boolean }) {
  return <ol className={`quick-pattern${animate ? ' quick-pattern-watch' : ''}`} dir="ltr">
    {[...sequence].map((color, i) => <li key={i} className={`quick-color-${color}`}
      style={{ '--step': i } as CSSProperties} aria-label={t('{color}, {number}', { color: t(colors[Number(color) - 1]), number: formatNumber(Number(color)) })}>
      {formatNumber(Number(color))}
    </li>)}
  </ol>;
}

function SequenceChoices({ state, locked, act }: Pick<PanelProps, 'state' | 'act'> & { locked: boolean }) {
  const [sequence, setSequence] = useState('');
  const shown = state.sequence as string | undefined;
  if (shown) return <div className="quick-pattern-area">
    <p>{t(state.phase === 'quick-watch' ? 'Remember this order' : 'The pattern was')}</p>
    <Pattern sequence={shown} animate={state.phase === 'quick-watch'} />
  </div>;
  if (state.phase !== 'quick-pick') return null;
  const entry = state.ownEntry ?? sequence;
  return <div className="quick-pattern-area">
    <p>{t('Repeat the pattern in order')} <bdi>{formatNumber(entry.length)}/{formatNumber(state.length)}</bdi></p>
    <Pattern sequence={entry} />
    <div className="quick-options">
      {colors.map((color, i) => <button key={color} type="button" className={`quick-color-${i + 1}`} disabled={locked || sequence.length >= state.length}
        onClick={() => setSequence(value => value + (i + 1))}>{formatNumber(i + 1)} · {t(color)}</button>)}
    </div>
    <div className="quick-options">
      <button type="button" disabled={locked || !sequence} onClick={() => setSequence(value => value.slice(0, -1))}>{t('Undo')}</button>
      <button type="button" className="primary" disabled={locked || sequence.length !== state.length}
        onClick={() => void act({ type: 'quick-pick', token: state.token, text: sequence })}>{t('Submit')}</button>
    </div>
  </div>;
}

function RoundBoard({ view, state, disabled, busy, act }: PanelProps) {
  const locked = disabled || busy || state.phase !== 'quick-pick' || state.ownEntry !== null;
  const choose = (choice: number) => void act({ type: 'quick-pick', token: state.token, choice });
  const choices = (options: { icon: string; label: string }[]) => <div className="quick-options">
    {options.map(({ icon, label }, index) => <button type="button" key={label} disabled={locked}
      aria-pressed={state.ownEntry === index} onClick={() => choose(index)}><span aria-hidden="true">{icon}</span> {t(label)}</button>)}
  </div>;
  switch (view.kind) {
    case 'rps':
      return choices(hands);
    case 'high-low':
      return <>
        <div className="quick-ranks">
          <div><span>{t('Starting card')}</span><strong dir="ltr">{ranks[state.rank - 1]}</strong></div>
          <div><span>{t('Next card')}</span><strong className={state.answer ? 'quick-face' : ''} dir="ltr">{state.answer ? ranks[state.answer - 1] : '?'}</strong></div>
        </div>
        {choices([{ icon: '↓', label: 'Lower' }, { icon: '↑', label: 'Higher' }])}
      </>;
    case 'target-dice': {
      const values = state.dice as number[];
      const base = values[0] + values[1];
      return <>
        <div className="quick-dice" dir="ltr">
          {values.map((die, i) => <span key={i} aria-label={t('Die {number}', { number: formatNumber(die) })}>{dice[die - 1]}</span>)}
          <strong>= {formatNumber(base)}</strong>
        </div>
        <p>{t('Target')} <strong>{formatNumber(12)}</strong></p>
        {choices([{ icon: '✓', label: 'Bank' }, { icon: '⚄', label: 'Roll one more' }])}
      </>;
    }
    case 'odd-one':
      return <div className="quick-grid quick-symbol-grid" dir="ltr">
        {(state.symbols as number[]).map((symbol, i) => <button type="button" key={i} disabled={locked}
          className={i === state.answer ? 'quick-correct quick-face' : ''} aria-pressed={state.ownEntry === i}
          aria-label={t('Tile {number}: {symbol}', { number: formatNumber(i + 1), symbol: t(shapes[symbol].label) })}
          onClick={() => choose(i)}>{shapes[symbol].icon}</button>)}
      </div>;
    case 'color-sequence':
      return <SequenceChoices key={state.token} state={state} locked={locked} act={act} />;
  }
}

function NumberBoard({ state, locked, act, view }: PanelProps & { locked: boolean }) {
  const [value, setValue] = useState('');
  const normalized = value.trim().replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 1632));
  const guess = Number(normalized);
  const valid = /^\d{1,2}$/.test(normalized) && guess >= state.low && guess <= state.high;
  const last = state.last;
  return <>
    <p>{t('Possible range')} <strong dir="ltr">{formatNumber(state.low)}–{formatNumber(state.high)}</strong></p>
    {last && <p className="quick-face" key={state.move}>
      {t('{name} guessed {number}', { name: seatName(view, last.seat), number: formatNumber(last.choice) })} · {t(last.hint === 'found' ? 'Found it!' : last.hint === 'higher' ? 'Higher' : 'Lower')}
    </p>}
    <form className="game-inline-form quick-number-form" onSubmit={e => {
      e.preventDefault();
      if (valid && !locked) void act({ type: 'quick-pick', choice: guess });
    }}>
      <label>{t('Your number')}<input type="text" inputMode="numeric" maxLength={2} value={value} dir="ltr"
        onChange={e => setValue(e.target.value)} disabled={locked} /></label>
      <button type="submit" className="primary" disabled={locked || !valid}>{t('Guess')}</button>
    </form>
  </>;
}

function TurnBoard(props: PanelProps) {
  const { view, state, disabled, busy, act } = props;
  const locked = disabled || busy || state.phase !== 'quick-turn' || state.turn !== view.self;
  const choose = (choice: number) => void act({ type: 'quick-pick', choice });
  switch (view.kind) {
    case 'number-hunt':
      return <NumberBoard key={`${state.turn}-${state.move}`} {...props} locked={locked} />;
    case 'memory-match':
      return <>
        <p>{t('Pairs found')} <strong dir="ltr">{formatNumber(state.matched.filter(Boolean).length / 2)}/{formatNumber(12)}</strong></p>
        <div className="quick-grid quick-memory-grid" dir="ltr">
          {(state.cards as (number | null)[]).map((card, i) => <button type="button" key={i}
            className={`quick-memory-card ${state.matched[i] ? 'quick-correct' : ''}`}
            disabled={locked || card !== null} onClick={() => choose(i)}
            aria-label={card === null ? t('Flip card {number}', { number: formatNumber(i + 1) }) : t('Card {number}: {symbol}', { number: formatNumber(i + 1), symbol: t(memoryFaces[card].label) })}>
            {card === null ? <span className="quick-card-back">✦</span> : <svg viewBox="0 0 48 48" fill="currentColor" className="quick-face" aria-hidden="true">{memoryFaces[card].art}</svg>}
          </button>)}
        </div>
      </>;
    case 'treasure-grid':
      return <>
        <p>{t('Gems remaining')} <strong>{formatNumber(state.remaining)}</strong></p>
        <div className="quick-grid quick-treasure-grid" dir="ltr">
          {(state.tiles as (number | null)[]).map((tile, i) => <button type="button" key={i} disabled={locked || tile !== null}
            className={tile === -1 ? 'quick-correct' : tile === null ? 'quick-dirt' : 'quick-dug'}
            aria-label={tile === null ? t('Dig tile {number}', { number: formatNumber(i + 1) }) : tile === -1
              ? t('Tile {number}: gem', { number: formatNumber(i + 1) })
              : t('Tile {number}: {count} neighboring gems', { number: formatNumber(i + 1), count: formatNumber(tile) })}
            onClick={() => choose(i)}>
            <span className={i === state.last ? 'quick-face' : ''}>{tile === null ? '·' : tile === -1 ? '💎' : formatNumber(tile)}</span>
          </button>)}
        </div>
      </>;
  }
}

function Scoreboard({ view, state }: Pick<PanelProps, 'view' | 'state'>) {
  const entries = state.entries as (string | number | null)[] | undefined;
  function result(i: number) {
    const entry = entries?.[i];
    if (entry === null || entry === undefined) return t('No choice');
    switch (view.kind) {
      case 'rps': return t(hands[Number(entry)].label);
      case 'high-low': return t(entry ? 'Higher' : 'Lower');
      case 'target-dice': {
        const total = state.totals[i] as number;
        const extra = state.rolls[i] as number | null;
        return <>
          {extra !== null && <span aria-label={t('Die {number}', { number: formatNumber(extra) })}>{dice[extra - 1]} </span>}
          {total > 12 ? t('{number} · over 12', { number: formatNumber(total) }) : formatNumber(total)}
        </>;
      }
      case 'color-sequence': return <bdi>{[...String(entry)].map(number => formatNumber(Number(number))).join(' ')}</bdi>;
      default: return t('Tile {number}', { number: formatNumber(Number(entry) + 1) });
    }
  }
  return <section className="quick-scores" aria-label={t('Scores')}>
    <h3>{t('Scores')}</h3>
    <ul>
      {view.seats.map((seat, i) => <li key={seat.id} className={seat.left ? 'quick-left' : ''}>
        <strong>{seat.name}</strong>
        {entries && !seat.left ? <span className="quick-face">{result(i)}{state.gains[i] > 0 && <bdi className="quick-points"> +{formatNumber(state.gains[i])}</bdi>}</span>
          : state.round && view.status === 'playing' && !seat.left ? <span>{t(state.submitted[i] ? 'Locked in' : 'Choosing')}</span> : null}
        <bdi className="quick-total">{formatNumber(state.scores[i])}</bdi>
      </li>)}
    </ul>
  </section>;
}

export default function QuickGamePanel(props: PanelProps) {
  const { view, state, audioSilenced } = props;
  const choosing = state.phase === 'quick-pick';
  const submitted = choosing ? state.submitted.filter(Boolean).length : 0;
  return <section className={`quick-game quick-${view.kind}`}>
    <div className="quick-header">
      {state.round && <strong>{t('Round {number} of {total}', { number: formatNumber(state.round), total: formatNumber(state.roundCount) })}</strong>}
      {choosing && <span role="status">{t('{count}/{total} locked in', { count: formatNumber(submitted), total: formatNumber(view.players) })}</span>}
      {view.status === 'playing' && <GameMusic suspended={Boolean(audioSilenced)} />}
    </div>
    <div className="quick-board">
      <p className="quick-goal">{t(gameGuide[view.kind].goal)}</p>
      {state.round ? <RoundBoard key={state.token} {...props} /> : <TurnBoard {...props} />}
    </div>
    {view.kind !== 'number-hunt' && <Scoreboard view={view} state={state} />}
    <a className="quick-credits" href="./licenses/quick-games.txt" target="_blank" rel="noreferrer">{t('Game asset credits')}</a>
  </section>;
}
