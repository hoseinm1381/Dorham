import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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

function BoardFeedback({ children, tone }: { children: ReactNode; tone?: 'success' | 'clue' }) {
  return <p className={`quick-feedback${tone ? ` quick-feedback-${tone}` : ''}`} role="status">{children}</p>;
}

function GameMusic({ suspended, volume = 100 }: { suspended: boolean; volume?: number }) {
  const player = useRef<HTMLAudioElement>(null);
  const [enabled, setEnabled] = useState(false);
  const level = 0.12 * Math.max(0, Math.min(100, volume)) / 100;
  const canPlay = enabled && !suspended && level > 0;
  useEffect(() => { if (player.current) player.current.volume = level; }, [level]);
  useEffect(() => {
    const audio = player.current!;
    function sync() {
      if (canPlay && !document.hidden) void audio.play().catch(() => {});
      else audio.pause();
    }
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      audio.pause();
      document.removeEventListener('visibilitychange', sync);
    };
  }, [canPlay]);
  return <>
    <audio ref={player} src={music} preload="none" loop />
    <button type="button" aria-pressed={enabled} className="secondary quick-music" onClick={() => setEnabled(!enabled)}>
      <span aria-hidden="true">♫ </span>{t('Game music')}
    </button>
  </>;
}

function Pattern({ sequence, animate = false, expected }: { sequence: string; animate?: boolean; expected?: string }) {
  return <ol className={`quick-pattern${animate ? ' quick-pattern-watch' : ''}`} dir="ltr" role="list">
    {[...sequence].map((color, i) => <li key={i} className={`quick-color-${color}${expected && expected[i] !== color ? ' quick-pattern-missed' : ''}`}
      style={{ '--step': i } as CSSProperties} aria-label={t('{color}, {number}', { color: t(colors[Number(color) - 1]), number: formatNumber(Number(color)) })}>
      {formatNumber(Number(color))}
    </li>)}
  </ol>;
}

function SequenceChoices({ state, locked, act }: Pick<PanelProps, 'state' | 'act'> & { locked: boolean }) {
  const [sequence, setSequence] = useState('');
  const shown = state.sequence as string | undefined;
  if (shown) return <div className="quick-pattern-area">
    <p className="quick-board-label">{t(state.phase === 'quick-watch' ? 'Remember this order' : 'The pattern was')}</p>
    <Pattern sequence={shown} animate={state.phase === 'quick-watch'} />
    {state.phase !== 'quick-watch' && typeof state.ownEntry === 'string' && <>
      <BoardFeedback tone={state.ownEntry === shown ? 'success' : 'clue'}>{t(state.ownEntry === shown ? 'Pattern matched!' : 'Your pattern')}</BoardFeedback>
      {state.ownEntry !== shown && <Pattern sequence={state.ownEntry} expected={shown} />}
    </>}
  </div>;
  if (state.phase !== 'quick-pick') return null;
  const entry = state.ownEntry ?? sequence;
  return <div className="quick-pattern-area">
    <p className="quick-board-label">{t('Repeat the pattern in order')} <bdi>{formatNumber(entry.length)}/{formatNumber(state.length)}</bdi></p>
    <div className="quick-entry-track" dir="ltr">
      <Pattern sequence={entry} />
      {Array.from({ length: state.length - entry.length }, (_, i) => <span key={i} className="quick-pattern-slot" aria-hidden="true" />)}
    </div>
    <div className="quick-options quick-color-options">
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
  const locked = disabled || busy || state.phase !== 'quick-pick' || state.ownEntry != null;
  const entries = state.entries as (number | string | null)[] | undefined;
  const revealed = Array.isArray(entries) && Array.isArray(state.gains);
  const scored = revealed && Number(state.gains?.[view.self]) > 0;
  const choose = (choice: number) => void act({ type: 'quick-pick', token: state.token, choice });
  const choices = (options: { icon: string; label: string; detail?: string }[], correct?: number) => <div className="quick-options quick-choice-set">
    {options.map(({ icon, label, detail }, index) => <button type="button" key={label} disabled={locked}
      className={index === correct ? 'quick-answer' : ''} aria-label={t(label)} aria-description={detail} aria-pressed={state.ownEntry === index} onClick={() => choose(index)}>
      <span className="quick-choice-icon" aria-hidden="true">{icon}</span>
      <strong>{t(label)}</strong>{detail && <small>{detail}</small>}
    </button>)}
  </div>;
  switch (view.kind) {
    case 'rps': {
      const hand = revealed && typeof state.ownEntry === 'number' ? hands[state.ownEntry] : undefined;
      const others = hand ? entries?.filter((entry, seat) => seat !== view.self && typeof entry === 'number') ?? [] : [];
      const outcome = !hand ? null : scored ?
        t(state.gains[view.self] === 1 ? '{hand} earned a point' : '{hand} earned {count} points', { hand: t(hand.label), count: formatNumber(state.gains[view.self]) }) :
        t(!others.length ? 'No opponent picked a hand' : others.every(entry => entry === state.ownEntry) ? 'Matching hands. No point.' : 'Your hand was beaten');
      return <>
        {choices(hands.map((hand, i) => ({ ...hand, detail: t('Beats {hand}', { hand: t(hands[(i + 2) % hands.length].label) }) })))}
        {outcome && <BoardFeedback key={state.token} tone={scored ? 'success' : 'clue'}>{outcome}</BoardFeedback>}
      </>;
    }
    case 'high-low': {
      const answer = typeof state.answer === 'number' ? ranks[state.answer - 1] : undefined;
      const higher = Number(state.answer) > Number(state.rank);
      return <>
        <div className="quick-ranks">
          <div><span>{t('Starting card')}</span><strong dir="ltr">{ranks[state.rank - 1]}</strong></div>
          <span className="quick-card-arrow" aria-hidden="true">›</span>
          <div><span>{t('Next card')}</span><strong className={answer ? 'quick-face' : 'quick-rank-back'} dir="ltr" aria-label={answer ? undefined : t('Face-down card')}>{answer ?? '✦'}</strong></div>
        </div>
        {choices([{ icon: '↓', label: 'Lower' }, { icon: '↑', label: 'Higher' }], answer ? Number(higher) : undefined)}
        {answer && <BoardFeedback tone={scored ? 'success' : 'clue'}>{t(higher ? 'The next card was higher.' : 'The next card was lower.')}</BoardFeedback>}
      </>;
    }
    case 'target-dice': {
      const values = state.dice as number[];
      const base = values[0] + values[1];
      const bust = Math.max(0, base - 6);
      const total = state.totals?.[view.self] as number | null | undefined;
      const extra = state.rolls?.[view.self] as number | null | undefined;
      return <>
        <div className="quick-dice" dir="ltr">
          {values.map((die, i) => <span key={i} aria-label={t('Die {number}', { number: formatNumber(die) })}>{dice[die - 1]}</span>)}
          {extra != null && <span className="quick-face" aria-label={t('Die {number}', { number: formatNumber(extra) })}>{dice[extra - 1]}</span>}
          <strong>= {formatNumber(total ?? base)}</strong>
        </div>
        <p className="quick-board-label">{t('Target')} <strong>{formatNumber(12)}</strong></p>
        <div className="quick-dice-meter" aria-hidden="true" dir="ltr">
          {Array.from({ length: 12 }, (_, i) => <i key={i} className={i < (total ?? base) ? 'quick-dice-filled' : undefined} />)}
        </div>
        {choices([{ icon: '✓', label: 'Bank' }, { icon: '⚄', label: 'Roll one more' }])}
        {revealed && total != null ? <BoardFeedback tone={scored ? 'success' : 'clue'}>
          {total > 12 ? t('Over 12') : scored ? t('Closest to 12!') : t('Final total: {number}', { number: formatNumber(total) })}
        </BoardFeedback> : state.phase === 'quick-pick' && <p className="quick-rule">{t('{count} of 6 extra rolls go over 12.', { count: formatNumber(bust) })}</p>}
      </>;
    }
    case 'odd-one': {
      const symbols = state.symbols as number[];
      const answer = Number.isInteger(state.answer) && state.answer >= 0 && state.answer < symbols.length ? state.answer : undefined;
      return <><div className="quick-grid quick-symbol-grid" dir="ltr">
        {symbols.map((symbol, i) => <button type="button" key={i} disabled={locked}
          className={i === answer ? 'quick-correct quick-face' : revealed && state.ownEntry === i ? 'quick-missed' : ''} aria-pressed={state.ownEntry === i}
          aria-label={t('Tile {number}: {symbol}', { number: formatNumber(i + 1), symbol: t(shapes[symbol].label) })}
          onClick={() => choose(i)}>{shapes[symbol].icon}{i === answer && <span className="quick-tile-mark" aria-hidden="true">✓</span>}</button>)}
      </div>{answer !== undefined && <BoardFeedback tone={scored ? 'success' : 'clue'}>
        {t('Odd tile: {number}', { number: formatNumber(answer + 1) })}
      </BoardFeedback>}</>;
    }
    case 'color-sequence':
      return <SequenceChoices key={state.token} state={state} locked={locked} act={act} />;
  }
}

function NumberBoard({ state, locked, act, view }: PanelProps & { locked: boolean }) {
  const [draft, setDraft] = useState({ move: state.move as number, value: '' });
  const value = draft.move === state.move ? draft.value : '';
  const setValue = (value: string) => setDraft({ move: state.move, value });
  const normalized = value.trim().replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 1632));
  const guess = Number(normalized);
  const valid = /^\d{1,2}$/.test(normalized) && guess >= state.low && guess <= state.high;
  const last = state.last;
  const range = t('Possible range');
  const shortRange = state.high - state.low < 5;
  const start = (state.low - 1) / 50 * 100;
  const width = (state.high - state.low + 1) / 50 * 100;
  return <>
    <div className="quick-range" dir="ltr">
      <p className="quick-board-label" dir="auto">{range} <strong><bdi>{state.low === state.high ? formatNumber(state.low) : `${formatNumber(state.low)}–${formatNumber(state.high)}`}</bdi></strong></p>
      <div className="quick-number-track" aria-hidden="true">
        <i style={{ insetInlineStart: `${start}%`, width: `${width}%` }} />
      </div>
      <div className="quick-number-endpoints" aria-hidden="true"><span>{formatNumber(1)}</span><span>{formatNumber(50)}</span></div>
    </div>
    {last && <BoardFeedback key={state.move} tone={last.hint === 'found' ? 'success' : 'clue'}>
      <span aria-hidden="true">{last.hint === 'found' ? '✦' : last.hint === 'higher' ? '↑' : '↓'}</span>{' '}
      {t('{name} guessed {number}', { name: seatName(view, last.seat), number: formatNumber(last.choice) })} · {t(last.hint === 'found' ? 'Found it!' : last.hint === 'higher' ? 'Higher' : 'Lower')}
    </BoardFeedback>}
    {shortRange && state.phase === 'quick-turn' && <div className="quick-options quick-number-shortcuts">
      {Array.from({ length: state.high - state.low + 1 }, (_, i) => state.low + i).map(number => <button type="button"
        key={number} disabled={locked} aria-pressed={valid && guess === number} onClick={() => setValue(String(number))}>{formatNumber(number)}</button>)}
    </div>}
    <form className="game-inline-form quick-number-form" onSubmit={e => {
      e.preventDefault();
      if (valid && !locked) void act({ type: 'quick-pick', choice: guess });
    }}>
      <label>{t('Your number')}<input type="text" inputMode="numeric" maxLength={2} value={value} dir="ltr"
        aria-invalid={Boolean(normalized && !valid)} onChange={e => setValue(e.target.value)} disabled={locked} /></label>
      <button type="submit" className="primary" disabled={locked || !valid}>{t('Guess')}</button>
    </form>
    {normalized && !valid && <p className="quick-rule">{t('Choose a number in the highlighted range.')}</p>}
  </>;
}

function TurnBoard(props: PanelProps) {
  const { view, state, disabled, busy, act } = props;
  const locked = disabled || busy || state.phase !== 'quick-turn' || state.turn !== view.self;
  const choose = (choice: number) => void act({ type: 'quick-pick', choice });
  switch (view.kind) {
    case 'number-hunt':
      return <NumberBoard {...props} locked={locked} />;
    case 'memory-match': {
      const matched = state.matched as boolean[];
      const flipped = state.flipped as number[];
      const pairs = matched.filter(Boolean).length / 2;
      const pairFound = flipped.length === 2 && flipped.every(i => matched[i]);
      return <>
        <p className="quick-board-label">{t('Pairs found')} <strong dir="ltr">{formatNumber(pairs)}/{formatNumber(matched.length / 2)}</strong></p>
        <div className="quick-grid quick-memory-grid" dir="ltr">
          {(state.cards as (number | null)[]).map((card, i) => <button type="button" key={i}
            className={`quick-memory-card ${matched[i] ? 'quick-correct' : card === null ? 'quick-memory-covered' : 'quick-memory-open'}`}
            disabled={locked || card !== null} onClick={() => choose(i)}
            aria-label={card === null ? t('Flip card {number}', { number: formatNumber(i + 1) }) : t('Card {number}: {symbol}', { number: formatNumber(i + 1), symbol: t(memoryFaces[card].label) })}>
            {card === null ? <span className="quick-card-back">✦</span> : <svg viewBox="0 0 48 48" fill="currentColor" className="quick-face" aria-hidden="true">{memoryFaces[card].art}</svg>}
            {matched[i] && <span className="quick-tile-mark" aria-hidden="true">✓</span>}
          </button>)}
        </div>
        <div className="quick-turn-feedback">
          {state.phase === 'quick-pair' && <BoardFeedback key={state.move} tone={pairFound ? 'success' : 'clue'}>{t(pairFound ? 'Pair found!' : 'Different cards')}</BoardFeedback>}
          {state.phase === 'quick-turn' && state.turn === view.self && <p className="quick-rule">{t(flipped.length ? 'Flip a second card' : 'Flip your first card')}</p>}
        </div>
      </>;
    }
    case 'treasure-grid': {
      const tiles = state.tiles as (number | null)[];
      const last = state.last as number;
      const lastValue = tiles[last];
      return <>
        <p className="quick-board-label">{t('Gems remaining')} <strong>{formatNumber(state.remaining)}</strong></p>
        <div className="quick-grid quick-treasure-grid" dir="ltr">
          {tiles.map((tile, i) => <button type="button" key={i} disabled={locked || tile !== null}
            className={`${tile === -1 ? 'quick-correct' : tile === null ? 'quick-dirt' : 'quick-dug'}${i === last ? ' quick-last-dig' : lastValue != null && lastValue >= 0 && isTreasureNeighbor(i, last) ? ' quick-neighbor' : ''}`}
            aria-label={tile === null ? t('Dig tile {number}', { number: formatNumber(i + 1) }) : tile === -1
              ? t('Tile {number}: gem', { number: formatNumber(i + 1) })
              : t('Tile {number}: {count} neighboring gems', { number: formatNumber(i + 1), count: formatNumber(tile) })}
            onClick={() => choose(i)}>
            <span className={i === last ? 'quick-face' : ''}>{tile === null ? '✧' : tile === -1 ? '💎' : formatNumber(tile)}</span>
          </button>)}
        </div>
        <div className="quick-turn-feedback">
          {lastValue === -1 ? <BoardFeedback key={state.move} tone="success">{t('Gem found!')}</BoardFeedback> : lastValue != null ?
            <BoardFeedback key={state.move} tone="clue">{t('Tile {number}: {count} neighboring gems', { number: formatNumber(last + 1), count: formatNumber(lastValue) })}</BoardFeedback> :
            <p className="quick-rule">{t('Numbers count gems around each tile.')}</p>}
        </div>
      </>;
    }
  }
}

function isTreasureNeighbor(cell: number, last: number) {
  return Math.abs(Math.floor(cell / 5) - Math.floor(last / 5)) <= 1 && Math.abs(cell % 5 - last % 5) <= 1;
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
  const { view, state, audioSilenced, audioVolume } = props;
  const choosing = state.phase === 'quick-pick';
  const submitted = choosing ? state.submitted.filter(Boolean).length : 0;
  return <section className={`quick-game quick-theme-${view.kind}`}>
    <div className="quick-header">
      {state.round && <strong>{t('Round {number} of {total}', { number: formatNumber(state.round), total: formatNumber(state.roundCount) })}</strong>}
      {choosing && <span role="status">{t('{count}/{total} locked in', { count: formatNumber(submitted), total: formatNumber(view.players) })}</span>}
      {view.status === 'playing' && <GameMusic suspended={Boolean(audioSilenced)} volume={audioVolume} />}
    </div>
    <div className="quick-board">
      <p className="quick-goal">{t(gameGuide[view.kind].goal)}</p>
      {state.round ? <RoundBoard key={state.token} {...props} /> : <TurnBoard {...props} />}
    </div>
    {view.kind !== 'number-hunt' && <Scoreboard view={view} state={state} />}
    <a className="quick-credits" href="./licenses/quick-games.txt" target="_blank" rel="noreferrer">{t('Game asset credits')}</a>
  </section>;
}
